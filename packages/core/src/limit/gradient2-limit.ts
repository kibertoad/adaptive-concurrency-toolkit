import type { LimitChangeListener, Nanos, Unsubscribe } from '../types.ts';
import { Ema } from '../util/ema.ts';
import { clamp } from '../util/math.ts';
import { ChangeListeners } from '../util/listeners.ts';
import type { Limit } from './limit.ts';

export interface Gradient2LimitOptions {
  readonly initialLimit?: number;
  readonly minLimit?: number;
  readonly maxLimit?: number;

  /** Window duration in nanoseconds. Default 1 s. */
  readonly windowNanos?: number;
  /** Minimum samples per window. Default 10. */
  readonly minWindowSamples?: number;

  /**
   * Long-window memory in windows. The long RTT EMA acts as the baseline.
   * Default 100 (i.e. ~100 windows of memory).
   */
  readonly longWindowCount?: number;

  /**
   * Queue-size hedge as a function of the current limit. Default:
   * `4·√limit` — the same form Netflix uses, which keeps a small absolute
   * buffer at low concurrencies and a larger one at high concurrencies.
   */
  readonly queueSize?: (limit: number) => number;

  /**
   * Multiplier on `longRtt / shortRtt`. Values > 1 make the algorithm
   * tolerate small latency inflations before reducing the limit. Default 1.5.
   */
  readonly tolerance?: number;

  /**
   * Smoothing for limit *decreases* — newLimit = α·newLimit + (1−α)·oldLimit.
   * Prevents single-window spikes from collapsing the limit. Default 0.2.
   */
  readonly smoothing?: number;

  /** Floor for the gradient. Default 0.5 — limit never halves in one step. */
  readonly minGradient?: number;

  /** Multiplicative back-off on a drop sample. Default 0.9. */
  readonly backoffRatio?: number;
}

const DEFAULT_QUEUE_SIZE = (limit: number): number => 4 * Math.sqrt(limit);

/**
 * Gradient2 — adaptive limit based on the ratio of long-window RTT baseline to
 * the current short-window RTT.
 *
 * Per window:
 *
 *   shortRtt  = window min RTT
 *   longRtt   = EMA over windows of shortRtt
 *   gradient  = clamp(tolerance · longRtt / shortRtt, minGradient, 1)
 *   queue     = queueSize(limit)
 *   newLimit  = limit · gradient + queue
 *   if newLimit < limit:  newLimit ← smoothing · newLimit + (1−smoothing) · limit
 *
 * The `gradient ≤ 1` constraint means we only grow via the queue-size hedge —
 * `limit · gradient` alone can never increase the limit. This matches the
 * intuition that a fast response window is permission to add a probe, not to
 * scale up multiplicatively.
 */
export class Gradient2Limit implements Limit {
  private _limit: number;
  readonly minLimit: number;
  readonly maxLimit: number;
  readonly windowNanos: number;
  readonly minWindowSamples: number;
  readonly tolerance: number;
  readonly smoothing: number;
  readonly minGradient: number;
  readonly backoffRatio: number;
  private readonly queueSizeFn: (limit: number) => number;
  private readonly longRtt: Ema;
  private readonly listeners = new ChangeListeners();

  private windowStartNanos = -1;
  private windowMinRttNanos = Number.POSITIVE_INFINITY;
  private windowMaxInflight = 0;
  private windowSamples = 0;
  private windowDropped = false;

  constructor(opts: Gradient2LimitOptions = {}) {
    const initial = opts.initialLimit ?? 20;
    const min = opts.minLimit ?? 1;
    const max = opts.maxLimit ?? 1000;
    if (!(min >= 1)) throw new RangeError(`minLimit must be >= 1`);
    if (!(max >= min)) throw new RangeError(`maxLimit must be >= minLimit`);
    if (!(initial >= min && initial <= max)) {
      throw new RangeError(`initialLimit must be in [${min}, ${max}]`);
    }

    this._limit = initial;
    this.minLimit = min;
    this.maxLimit = max;
    this.windowNanos = opts.windowNanos ?? 1_000_000_000;
    this.minWindowSamples = opts.minWindowSamples ?? 10;
    this.tolerance = opts.tolerance ?? 1.5;
    this.smoothing = opts.smoothing ?? 0.2;
    this.minGradient = opts.minGradient ?? 0.5;
    this.backoffRatio = opts.backoffRatio ?? 0.9;
    this.queueSizeFn = opts.queueSize ?? DEFAULT_QUEUE_SIZE;
    this.longRtt = Ema.withWindow(opts.longWindowCount ?? 100);

    if (!(this.tolerance > 0)) throw new RangeError(`tolerance must be > 0`);
    if (!(this.smoothing > 0 && this.smoothing <= 1)) {
      throw new RangeError(`smoothing must be in (0, 1]`);
    }
    if (!(this.minGradient > 0 && this.minGradient <= 1)) {
      throw new RangeError(`minGradient must be in (0, 1]`);
    }
    if (!(this.backoffRatio > 0 && this.backoffRatio < 1)) {
      throw new RangeError(`backoffRatio must be in (0, 1)`);
    }
  }

  get limit(): number {
    return this._limit;
  }

  /** Long-window RTT baseline (ns). 0 until the first window commits. */
  get longRttNanos(): number {
    return this.longRtt.value;
  }

  onSample(startNanos: Nanos, rttNanos: Nanos, inflight: number, didDrop: boolean): void {
    if (this.windowStartNanos < 0) this.windowStartNanos = startNanos;
    if (rttNanos < this.windowMinRttNanos) this.windowMinRttNanos = rttNanos;
    if (inflight > this.windowMaxInflight) this.windowMaxInflight = inflight;
    if (didDrop) this.windowDropped = true;
    this.windowSamples++;

    const elapsed = startNanos - this.windowStartNanos;
    if (elapsed >= this.windowNanos && this.windowSamples >= this.minWindowSamples) {
      this.commitWindow();
    }
  }

  onChange(listener: LimitChangeListener): Unsubscribe {
    return this.listeners.add(listener);
  }

  private commitWindow(): void {
    const current = this._limit;
    const shortRtt = this.windowMinRttNanos;
    const maxInflight = this.windowMaxInflight;
    const dropped = this.windowDropped;

    this.windowStartNanos = -1;
    this.windowMinRttNanos = Number.POSITIVE_INFINITY;
    this.windowMaxInflight = 0;
    this.windowSamples = 0;
    this.windowDropped = false;

    let next: number;

    if (dropped) {
      next = Math.max(this.minLimit, Math.floor(current * this.backoffRatio));
    } else {
      // Skip the very first window — the long-RTT EMA seeds from it, so the
      // gradient would be 1.0 trivially with no real signal yet.
      const wasInitialized = this.longRtt.initialized;
      const longRtt = this.longRtt.update(shortRtt);
      if (!wasInitialized) return;

      const gradient = clamp((this.tolerance * longRtt) / shortRtt, this.minGradient, 1);
      const queue = this.queueSizeFn(current);
      let candidate = current * gradient + queue;

      // Only grow when we are actually using the limit; otherwise hold.
      if (candidate > current && maxInflight * 2 < current) return;

      if (candidate < current) {
        candidate = this.smoothing * candidate + (1 - this.smoothing) * current;
      }
      next = candidate;
    }

    next = Math.round(clamp(next, this.minLimit, this.maxLimit));
    if (next !== current) {
      this._limit = next;
      this.listeners.emit(next);
    }
  }
}
