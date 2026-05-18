import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../src/clock.ts';
import { FixedLimit } from '../src/limit/fixed-limit.ts';
import { SimpleLimiter } from '../src/limiter/simple-limiter.ts';
import type { Limit } from '../src/limit/limit.ts';

class RecordingLimit implements Limit {
  limit = 5;
  readonly samples: Array<{
    start: number;
    rtt: number;
    inflight: number;
    didDrop: boolean;
  }> = [];

  onSample(start: number, rtt: number, inflight: number, didDrop: boolean): void {
    this.samples.push({ start, rtt, inflight, didDrop });
  }

  onChange(): () => void {
    return () => {};
  }
}

describe('SimpleLimiter', () => {
  it('issues permits up to the limit then returns undefined', () => {
    const limiter = new SimpleLimiter(new FixedLimit({ limit: 2 }));
    const a = limiter.acquire();
    const b = limiter.acquire();
    const c = limiter.acquire();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeUndefined();
    expect(limiter.inflight).toBe(2);
  });

  it('releases a permit on onSuccess and reports a sample with measured RTT', () => {
    const algo = new RecordingLimit();
    const clock = new ManualClock();
    const limiter = new SimpleLimiter(algo, { clock });

    const l = limiter.acquire()!;
    clock.advanceMillis(50);
    l.onSuccess();

    expect(limiter.inflight).toBe(0);
    expect(algo.samples).toHaveLength(1);
    expect(algo.samples[0]).toMatchObject({
      rtt: 50_000_000,
      inflight: 1,
      didDrop: false,
    });
  });

  it('marks a sample as dropped on onDropped', () => {
    const algo = new RecordingLimit();
    const limiter = new SimpleLimiter(algo, { clock: new ManualClock() });
    limiter.acquire()!.onDropped();
    expect(algo.samples[0]?.didDrop).toBe(true);
  });

  it('releases the permit without reporting a sample on onIgnore', () => {
    const algo = new RecordingLimit();
    const limiter = new SimpleLimiter(algo, { clock: new ManualClock() });
    limiter.acquire()!.onIgnore();
    expect(limiter.inflight).toBe(0);
    expect(algo.samples).toHaveLength(0);
  });

  it('makes the listener idempotent — subsequent calls are no-ops', () => {
    const algo = new RecordingLimit();
    const limiter = new SimpleLimiter(algo, { clock: new ManualClock() });
    const l = limiter.acquire()!;
    l.onSuccess();
    l.onSuccess();
    l.onDropped();
    l.onIgnore();
    expect(limiter.inflight).toBe(0);
    expect(algo.samples).toHaveLength(1);
  });

  it('reports the start-time inflight value in the sample', () => {
    const algo = new RecordingLimit();
    algo.limit = 5;
    const limiter = new SimpleLimiter(algo, { clock: new ManualClock() });
    const a = limiter.acquire()!;
    const b = limiter.acquire()!;
    const c = limiter.acquire()!;
    // c was issued when inflight became 3 — that's what the sample should record.
    expect(limiter.inflight).toBe(3);
    a.onSuccess();
    expect(algo.samples[0]?.inflight).toBe(1);
    c.onSuccess();
    expect(algo.samples[1]?.inflight).toBe(3);
    b.onSuccess();
    expect(algo.samples[2]?.inflight).toBe(2);
  });

  it('exposes inflight and limit getters live', () => {
    const algo = new RecordingLimit();
    algo.limit = 7;
    const limiter = new SimpleLimiter(algo);
    expect(limiter.limit).toBe(7);
    expect(limiter.inflight).toBe(0);
    algo.limit = 3;
    expect(limiter.limit).toBe(3);
  });

  it('integrates with FixedLimit cleanly', () => {
    const limiter = new SimpleLimiter(new FixedLimit({ limit: 3 }));
    const ls = [limiter.acquire()!, limiter.acquire()!, limiter.acquire()!];
    expect(limiter.acquire()).toBeUndefined();
    ls[0]!.onSuccess();
    expect(limiter.acquire()).toBeDefined();
  });

  it('does not double-call the limiter when the listener returns to a clean state', () => {
    const algo = new RecordingLimit();
    const limiter = new SimpleLimiter(algo, { clock: new ManualClock() });
    const spy = vi.spyOn(algo, 'onSample');
    const l = limiter.acquire()!;
    l.onSuccess();
    l.onSuccess();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
