import type { LimitChangeListener, Nanos, Unsubscribe } from '../types.ts';
import { ChangeListeners } from '../util/listeners.ts';
import type { Limit } from './limit.ts';

export interface AimdLimitOptions {
  /** Initial limit. Defaults to 10. */
  readonly initialLimit?: number;
  /** Lower bound. Defaults to 1. */
  readonly minLimit?: number;
  /** Upper bound. Defaults to 1000. */
  readonly maxLimit?: number;
  /**
   * Multiplicative decrease factor applied to the limit on a drop or RTT
   * timeout. Defaults to 0.9. Must be in (0, 1).
   */
  readonly backoffRatio?: number;
  /**
   * RTT (in ns) above which a sample is treated as a drop signal even if the
   * caller reported success. Defaults to +∞ (never).
   */
  readonly rttTimeoutNanos?: number;
  /**
   * Fraction of the current limit that must be in flight before additive
   * increases take effect. Defaults to 0.5 — i.e. we only grow when we are
   * actually using at least half the headroom.
   */
  readonly utilizationThreshold?: number;
}

/**
 * Additive Increase / Multiplicative Decrease.
 *
 * Inspired by TCP congestion control:
 *
 *  - on drop or `rtt > rttTimeoutNanos`:  limit ← max(minLimit, ⌊limit · backoffRatio⌋)
 *  - on success while utilization ≥ θ:     limit ← min(maxLimit, limit + 1)
 *  - otherwise:                            no-op
 *
 * Reacts immediately to every sample (no internal windowing); this gives fast
 * decreases but can be noisy. For smoother behavior prefer {@link Gradient2Limit}.
 */
export class AimdLimit implements Limit {
  private _limit: number;
  readonly minLimit: number;
  readonly maxLimit: number;
  readonly backoffRatio: number;
  readonly rttTimeoutNanos: number;
  readonly utilizationThreshold: number;
  private readonly listeners = new ChangeListeners();

  constructor(opts: AimdLimitOptions = {}) {
    const initial = opts.initialLimit ?? 10;
    const min = opts.minLimit ?? 1;
    const max = opts.maxLimit ?? 1000;
    const backoff = opts.backoffRatio ?? 0.9;
    const utilization = opts.utilizationThreshold ?? 0.5;
    const timeout = opts.rttTimeoutNanos ?? Number.POSITIVE_INFINITY;

    if (!(min >= 1) || !Number.isFinite(min)) {
      throw new RangeError(`minLimit must be >= 1, got ${min}`);
    }
    if (!(max >= min)) {
      throw new RangeError(`maxLimit must be >= minLimit, got ${max} < ${min}`);
    }
    if (!(initial >= min && initial <= max)) {
      throw new RangeError(`initialLimit must be in [${min}, ${max}], got ${initial}`);
    }
    if (!(backoff > 0 && backoff < 1)) {
      throw new RangeError(`backoffRatio must be in (0, 1), got ${backoff}`);
    }
    if (!(utilization > 0 && utilization <= 1)) {
      throw new RangeError(`utilizationThreshold must be in (0, 1], got ${utilization}`);
    }
    if (!(timeout > 0)) {
      throw new RangeError(`rttTimeoutNanos must be > 0, got ${timeout}`);
    }

    this._limit = initial;
    this.minLimit = min;
    this.maxLimit = max;
    this.backoffRatio = backoff;
    this.utilizationThreshold = utilization;
    this.rttTimeoutNanos = timeout;
  }

  get limit(): number {
    return this._limit;
  }

  onSample(_start: Nanos, rttNanos: Nanos, inflight: number, didDrop: boolean): void {
    const current = this._limit;
    let next = current;

    if (didDrop || rttNanos > this.rttTimeoutNanos) {
      next = Math.max(this.minLimit, Math.floor(current * this.backoffRatio));
    } else if (inflight >= current * this.utilizationThreshold) {
      next = Math.min(this.maxLimit, current + 1);
    }

    if (next !== current) {
      this._limit = next;
      this.listeners.emit(next);
    }
  }

  onChange(listener: LimitChangeListener): Unsubscribe {
    return this.listeners.add(listener);
  }
}
