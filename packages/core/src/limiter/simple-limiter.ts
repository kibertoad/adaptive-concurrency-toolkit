import { defaultClock, type Clock } from '../clock.ts';
import type { Limit } from '../limit/limit.ts';
import type { Listener, Nanos } from '../types.ts';
import type { Limiter } from './limiter.ts';

export interface SimpleLimiterOptions {
  /** Time source. Defaults to {@link defaultClock} (monotonic, nanosecond). */
  readonly clock?: Clock;
}

/**
 * Minimal {@link Limiter}: tracks an in-flight counter and gates new permits
 * against the underlying {@link Limit}'s ceiling. No queueing — over-limit
 * calls return `undefined` immediately so the caller can shed load.
 *
 * Sample reporting on the hot path is allocation-free aside from the listener
 * itself: each listener carries its own start state and calls a positional
 * method on the limiter to release.
 */
export class SimpleLimiter implements Limiter {
  readonly algorithm: Limit;
  readonly clock: Clock;
  private _inflight = 0;

  constructor(algorithm: Limit, opts: SimpleLimiterOptions = {}) {
    this.algorithm = algorithm;
    this.clock = opts.clock ?? defaultClock;
  }

  get inflight(): number {
    return this._inflight;
  }

  get limit(): number {
    return this.algorithm.limit;
  }

  acquire(): Listener | undefined {
    const next = this._inflight + 1;
    if (next > this.algorithm.limit) return undefined;
    this._inflight = next;
    return new SimpleListener(this, this.clock.nowNanos(), next);
  }

  /** @internal */
  _release(startNanos: Nanos, startInflight: number, didDrop: boolean, ignore: boolean): void {
    this._inflight--;
    if (ignore) return;
    const rtt = this.clock.nowNanos() - startNanos;
    this.algorithm.onSample(startNanos, rtt, startInflight, didDrop);
  }
}

class SimpleListener implements Listener {
  private readonly limiter: SimpleLimiter;
  private readonly startNanos: Nanos;
  private readonly startInflight: number;
  private done = false;

  constructor(limiter: SimpleLimiter, startNanos: Nanos, startInflight: number) {
    this.limiter = limiter;
    this.startNanos = startNanos;
    this.startInflight = startInflight;
  }

  onSuccess(): void {
    if (this.done) return;
    this.done = true;
    this.limiter._release(this.startNanos, this.startInflight, false, false);
  }

  onDropped(): void {
    if (this.done) return;
    this.done = true;
    this.limiter._release(this.startNanos, this.startInflight, true, false);
  }

  onIgnore(): void {
    if (this.done) return;
    this.done = true;
    this.limiter._release(this.startNanos, this.startInflight, false, true);
  }
}
