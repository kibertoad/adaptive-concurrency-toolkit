# @adaptive-concurrency-toolkit/core

[![npm version](https://img.shields.io/npm/v/@adaptive-concurrency-toolkit/core.svg)](https://www.npmjs.com/package/@adaptive-concurrency-toolkit/core)
[![npm downloads](https://img.shields.io/npm/dm/@adaptive-concurrency-toolkit/core.svg)](https://www.npmjs.com/package/@adaptive-concurrency-toolkit/core)
[![license](https://img.shields.io/npm/l/@adaptive-concurrency-toolkit/core.svg)](../../LICENSE)

Core adaptive concurrency algorithms inspired by Netflix's
[`concurrency-limits`](https://github.com/Netflix/concurrency-limits).

This package gives you `Limit` algorithms that infer a healthy in-flight
ceiling from observed round-trip latency and drop signals, plus a `Limiter`
that gates work against the inferred ceiling. Higher-level wrappers (HTTP,
RPC, queues) live in sibling packages.

## What problem does this solve?

Fixed concurrency limits (semaphores, connection pools) are hard to tune:
too low and you waste capacity, too high and the downstream collapses under
queue-induced latency. Adaptive concurrency observes latency and failure
signals at runtime and adjusts the limit so the system runs at the knee of
the latency curve - high throughput, low queueing.

The trade-off vs. a fixed semaphore: there is a control loop with state,
warm-up cost, and parameters to understand. For homogeneous traffic against
a known dependency, a fixed limit often suffices. For heterogeneous traffic
or shared dependencies, adaptive limits pay off.

## Quick start

```ts
import { Gradient2Limit, SimpleLimiter } from '@adaptive-concurrency-toolkit/core';

const limit = new Gradient2Limit({
  initialLimit: 20,
  minLimit: 1,
  maxLimit: 200,
});
const limiter = new SimpleLimiter(limit);

async function call(req: Request): Promise<Response> {
  const listener = limiter.acquire();
  if (!listener) {
    // No permit available - shed load. Typical responses: 429, fallback path,
    // bounded retry queue. The point is to fail fast rather than pile on.
    return new Response('Too Many Requests', { status: 429 });
  }
  try {
    const res = await fetch(req);
    // 5xx and timeouts indicate the upstream is overloaded. We report these
    // as drops so the algorithm contracts. 4xx are caller errors - they
    // shouldn't influence the limit, so we ignore them.
    if (res.status >= 500) listener.onDropped();
    else if (res.status >= 400) listener.onIgnore();
    else listener.onSuccess();
    return res;
  } catch (err) {
    // Network errors / aborts are also overload signals in most setups.
    listener.onDropped();
    throw err;
  }
}
```

Exactly one of `onSuccess` / `onDropped` / `onIgnore` must be called per
acquired listener. Subsequent calls are no-ops, so it's safe to wrap the
release in a `finally`.

## Algorithms

All four implement the same `Limit` interface, so you can swap them with one
line of code.

### `FixedLimit`

Constant ceiling - does not adapt.

**Use when:** you have a known-good limit (e.g. a connection pool size), or
you're rolling out adaptive concurrency gradually and want a baseline to
compare against.

**Pros:** zero cognitive overhead, predictable, no warm-up.
**Cons:** doesn't react to changes in upstream capacity, traffic mix, or
dependency health.

### `AimdLimit` - Additive Increase, Multiplicative Decrease

Same control loop family as TCP Reno. On every sample:

```
drop or rtt > timeout  →  limit ← max(min, ⌊limit · backoffRatio⌋)
success at high util.  →  limit ← min(max, limit + 1)
otherwise              →  hold
```

**Use when:** you have a clean drop signal (a request that fails is a clear
overload indicator - e.g. 5xx, 429, or a strict latency SLA used as
`rttTimeoutNanos`), and you want a simple, well-understood algorithm.

**Pros:** simple, fast to react to drops, no windowing, easy to reason
about. Good default when drops dominate the signal.
**Cons:** no notion of latency gradient - won't preemptively back off when
RTT is creeping up but requests haven't started failing yet. Increases one
unit at a time, so warm-up to high concurrency is slow. Per-sample updates
can be jittery under bursty traffic.

### `VegasLimit` - TCP Vegas-style queue-size estimation

Per window (default 1 s) compute:

```
queue = limit · (1 − rttNoLoad / windowMinRtt)
queue ≤ α(limit)  →  limit + log10(limit)
queue ≥ β(limit)  →  limit − log10(limit)
otherwise         →  hold
```

`rttNoLoad` is a rolling minimum RTT (the "no queueing" floor), periodically
re-probed so it adapts to baseline drift. Drops cause an immediate
multiplicative back-off.

**Use when:** you care about latency, not just failures - e.g. an upstream
that silently queues requests instead of rejecting them. Vegas reduces the
limit as soon as queueing inflates RTT, before drops appear.

**Pros:** reacts to latency, not just drops. Logarithmic step keeps the
limit stable at high concurrency. Self-calibrates the latency floor.
**Cons:** needs enough samples per window to be reliable (default 10 per
1 s). Sensitive to a stuck `rttNoLoad` if the probe interval is too long
relative to baseline shifts. Math is less intuitive than AIMD.

### `Gradient2Limit` - long/short RTT ratio with queue-size hedge

Per window:

```
shortRtt  = window min RTT
longRtt   = EMA over windows of shortRtt
gradient  = clamp(tolerance · longRtt / shortRtt, minGradient, 1)
queue     = 4 · √limit                       (configurable)
newLimit  = limit · gradient + queue
if newLimit < limit:  smooth toward old limit
```

The gradient is capped at 1, so `limit · gradient` alone never grows the
ceiling - growth comes from the queue-size hedge. Decreases are smoothed to
avoid collapsing on a single bad window.

**Use when:** you want Vegas-style latency sensitivity but smoother behavior
and a more predictable scaling curve. This is the algorithm Netflix
recommends as a general-purpose default.

**Pros:** smoother than AIMD/Vegas, scales gracefully across orders of
magnitude (the `√limit` hedge keeps relative growth steady), tolerant of
single-window outliers.
**Cons:** more parameters to understand (`tolerance`, `smoothing`,
`minGradient`, queue-size function). Warm-up of `longRtt` EMA takes
~100 windows to stabilize.

## Choosing between them

| Signal you trust most           | Pick                             |
| ------------------------------- | -------------------------------- |
| Static, known-good capacity     | `FixedLimit`                     |
| Drops / failures                | `AimdLimit`                      |
| Latency, with clear drop signal | `Gradient2Limit` (default)       |
| Latency, mostly silent queueing | `VegasLimit` or `Gradient2Limit` |

If you're not sure, start with `Gradient2Limit` at `initialLimit ≈ p99
in-flight from current production`, `maxLimit ≈ 2–4× initial`. Watch the
limit time series - if it pegs at `maxLimit` continuously, raise the cap; if
it oscillates wildly, increase `smoothing` or lengthen `windowNanos`.

## Sample semantics

The `Limiter` reports each completed acquisition to its `Limit` algorithm
via:

```ts
onSample(startTimeNanos, rttNanos, inflight, didDrop);
```

- `inflight` is the in-flight count at the moment the permit was issued -
  algorithms use it to gate growth (don't grow if you weren't using the
  current limit).
- `didDrop` is `true` only when the caller called `onDropped()`. A 4xx that
  ended in `onIgnore()` does not appear as a drop.
- `onIgnore()` releases the permit but produces no sample - RTT is
  discarded. This is the right choice for client-side errors, cancellations,
  and short-circuited paths that don't represent real upstream work.

## Picking parameters

- **`initialLimit`** - start near your current steady-state in-flight.
  Too low wastes warm-up time; too high risks overshoot on cold caches.
- **`minLimit`** - should always allow at least one request through so
  health probes succeed. `1` is a safe default; raise it only if you
  _know_ the downstream can handle higher concurrency at all times.
- **`maxLimit`** - a safety cap, not a target. Pick well above your
  expected steady state but below what would overload a healthy downstream.
- **`windowNanos`** (Vegas, Gradient2) - long enough to collect a useful
  RTT distribution (≥ 10 × p99 latency), short enough to react. 1 s is a
  reasonable default for HTTP-scale latencies.
- **`backoffRatio`** - 0.9 is gentle, 0.5 is aggressive. Aggressive
  back-off is appropriate for upstreams that genuinely collapse under
  load; gentle is better when drops can be transient.

## Performance notes

- Sample reporting is allocation-free on the algorithm's hot path -
  `onSample` takes positional `number` / `boolean` args.
- The `Limiter` allocates exactly one `Listener` object per `acquire()`.
- Time is read once per acquire and once per release via `performance.now()`
  scaled to nanoseconds (a `number`, not `bigint`, to keep arithmetic fast).
- No timers, no background tasks. Adjustments happen synchronously when
  samples cross a window boundary.

## Testing with `ManualClock`

Every component that reads time goes through the `Clock` interface:

```ts
interface Clock {
  nowNanos(): Nanos;
}
```

The default is `defaultClock`, which wraps `performance.now()`. For tests,
swap in `ManualClock` — a `Clock` whose value only changes when you tell it
to. That gives you exact, repeatable control over RTT measurements and over
when the algorithms cross their internal time boundaries.

### Why you need it

The algorithms in this package are time-sensitive in two ways:

1. **RTT is measured as `clock.nowNanos()` at release minus `clock.nowNanos()`
   at acquire.** With the real clock, "50 ms RTT" means actually waiting
   50 ms (slow) or fighting timer jitter (flaky). With `ManualClock`, you
   call `advanceMillis(50)` between acquire and release and the sample is
   exactly 50 ms.
2. **`VegasLimit` and `Gradient2Limit` only adjust at window boundaries**
   (default `windowNanos: 1_000_000_000`, i.e. 1 second). The limit will not
   move until the clock has crossed into the next window. If your test
   doesn't advance the clock past the boundary, the algorithm looks broken
   when it's actually working as designed.

`AimdLimit` is per-sample rather than windowed, but its drop logic also
depends on RTT vs. `rttTimeoutNanos`, so the same control matters.

### API

```ts
new ManualClock(initialNanos?: number);  // defaults to 0

clock.nowNanos();                  // current value
clock.advanceNanos(deltaNanos);    // current += delta
clock.advanceMillis(deltaMillis);  // current += delta * 1_000_000
clock.setNanos(value);             // hard override (fault injection)
```

Time is held as a `number` (nanoseconds), not `bigint`, matching the rest of
the package. `advanceNanos` and `advanceMillis` only accept non-negative
deltas in spirit — the algorithms assume monotonic time, so don't go
backwards with `setNanos` unless you're specifically testing that path.

### Wiring it in

`ManualClock` is plumbed in through the `SimpleLimiter` options:

```ts
import {
  Gradient2Limit,
  SimpleLimiter,
  ManualClock,
} from '@adaptive-concurrency-toolkit/core';

const clock = new ManualClock();
const limit = new Gradient2Limit({ initialLimit: 10, windowNanos: 1_000_000_000 });
const limiter = new SimpleLimiter(limit, { clock });

const l = limiter.acquire()!;  // reads clock.nowNanos() as start time
clock.advanceMillis(50);
l.onSuccess();                 // reports a sample with rtt = 50_000_000 ns
```

The limiter passes the same `Clock` instance into every listener it issues,
so all RTT measurements share one time source.

### Crossing a window boundary

This is the pattern for testing window-based algorithms. Feed enough
samples to fill a window, advance past the boundary, then feed one more
sample to trigger the recompute:

```ts
const clock = new ManualClock();
const limit = new Gradient2Limit({
  initialLimit: 10,
  windowNanos: 1_000_000_000, // 1 s
  // ...
});
const limiter = new SimpleLimiter(limit, { clock });

// Fill window 0 with fast samples — should suggest growing the limit.
for (let i = 0; i < 20; i++) {
  const l = limiter.acquire()!;
  clock.advanceMillis(5); // 5 ms RTT, well under any queueing signal
  l.onSuccess();
}

// Cross the window boundary. Until we do this, the algorithm has not yet
// "seen" the end of window 0.
clock.advanceNanos(1_000_000_000);

// The next sample lands in window 1 and triggers the window-0 recompute.
const trigger = limiter.acquire()!;
clock.advanceMillis(5);
trigger.onSuccess();

expect(limit.limit).toBeGreaterThan(10);
```

### Bypassing the limiter

If you're unit-testing a `Limit` directly (not through a `Limiter`) you can
build samples by hand. `onSample(startNanos, rttNanos, inflight, didDrop)`
is positional and clock-free — `ManualClock` is only needed when something
else (a `Limiter`, your own wrapper) is reading the clock for you.
