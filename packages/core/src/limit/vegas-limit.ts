import type { LimitChangeListener, Nanos, Unsubscribe } from '../types.ts';
import { clamp } from '../util/math.ts';
import { ChangeListeners } from '../util/listeners.ts';
import type { Limit } from './limit.ts';

export interface VegasLimitOptions {
  readonly initialLimit?: number;
  readonly minLimit?: number;
  readonly maxLimit?: number;

  /**
   * Window duration in nanoseconds. Samples within a window are aggregated and
   * the limit is updated at most once per window. Defaults to 1 s.
   */
  readonly windowNanos?: number;
  /** Minimum samples required to update at the end of a window. Defaults to 10. */
  readonly minWindowSamples?: number;

  /**
   * Lower queue-size target as a function of limit. Default: `3·log10(limit)`.
   * Below this, the limit is increased.
   */
  readonly alpha?: (limit: number) => number;
  /**
   * Upper queue-size target as a function of limit. Default: `6·log10(limit)`.
   * Above this, the limit is decreased.
   */
  readonly beta?: (limit: number) => number;
  /** Increase step. Default: `log10(limit)`. */
  readonly increase?: (limit: number) => number;
  /** Decrease step. Default: `log10(limit)`. */
  readonly decrease?: (limit: number) => number;

  /** Multiplicative back-off on a drop sample. Default 0.9. */
  readonly backoffRatio?: number;

  /**
   * After this many windows without observing a new minimum RTT, the noload
   * estimate is reset to the current window's min RTT — re-probing the floor.
   * Default 10.
   */
  readonly probeIntervalWindows?: number;
}

const DEFAULT_ALPHA = (limit: number): number => 3 * Math.log10(limit);
const DEFAULT_BETA = (limit: number): number => 6 * Math.log10(limit);
const DEFAULT_STEP = (limit: number): number => Math.log10(limit);

/**
 * TCP-Vegas inspired adaptive limit.
 *
 * Per window (≈ 1 s by default) compute:
 *
 *   queue = limit · (1 − rttNoLoad / rttWindowMin)
 *
 * and adjust:
 *
 *   queue ≤ α(limit) → grow  (limit + log10 limit)
 *   queue ≥ β(limit) → shrink
 *   else            → hold
 *
 * `rttNoLoad` is the rolling minimum RTT, periodically re-probed so the floor
 * adapts to legitimate baseline shifts.
 */
export class VegasLimit implements Limit {
  private _limit: number;
  readonly minLimit: number;
  readonly maxLimit: number;
  readonly windowNanos: number;
  readonly minWindowSamples: number;
  readonly backoffRatio: number;
  readonly probeIntervalWindows: number;
  private readonly alphaFn: (limit: number) => number;
  private readonly betaFn: (limit: number) => number;
  private readonly increaseFn: (limit: number) => number;
  private readonly decreaseFn: (limit: number) => number;
  private readonly listeners = new ChangeListeners();

  private rttNoLoadNanos: number = Number.POSITIVE_INFINITY;
  private windowStartNanos = -1;
  private windowMinRttNanos = Number.POSITIVE_INFINITY;
  private windowMaxInflight = 0;
  private windowSamples = 0;
  private windowDropped = false;
  private windowsSinceNewMin = 0;

  constructor(opts: VegasLimitOptions = {}) {
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
    this.backoffRatio = opts.backoffRatio ?? 0.9;
    this.probeIntervalWindows = opts.probeIntervalWindows ?? 10;
    this.alphaFn = opts.alpha ?? DEFAULT_ALPHA;
    this.betaFn = opts.beta ?? DEFAULT_BETA;
    this.increaseFn = opts.increase ?? DEFAULT_STEP;
    this.decreaseFn = opts.decrease ?? DEFAULT_STEP;
  }

  get limit(): number {
    return this._limit;
  }

  /** Current rtt-no-load estimate (ns). `+Infinity` until the first sample. */
  get rttNoLoad(): number {
    return this.rttNoLoadNanos;
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
    const minRtt = this.windowMinRttNanos;
    const maxInflight = this.windowMaxInflight;
    const dropped = this.windowDropped;

    // Reset window state up-front so we always start a clean window even if
    // we early-return below.
    this.windowStartNanos = -1;
    this.windowMinRttNanos = Number.POSITIVE_INFINITY;
    this.windowMaxInflight = 0;
    this.windowSamples = 0;
    this.windowDropped = false;

    let next = current;

    if (dropped) {
      next = Math.max(this.minLimit, Math.floor(current * this.backoffRatio));
    } else {
      // Track rtt-noload as a rolling minimum, re-probed periodically.
      if (minRtt < this.rttNoLoadNanos) {
        this.rttNoLoadNanos = minRtt;
        this.windowsSinceNewMin = 0;
      } else if (++this.windowsSinceNewMin >= this.probeIntervalWindows) {
        // Re-baseline so a transient one-off low sample doesn't pin us forever.
        this.rttNoLoadNanos = minRtt;
        this.windowsSinceNewMin = 0;
      }

      // Don't grow if we aren't using the limit we have.
      if (maxInflight * 2 < current) return;

      const queue = current * (1 - this.rttNoLoadNanos / minRtt);
      const alpha = this.alphaFn(current);
      const beta = this.betaFn(current);

      if (queue <= alpha) {
        next = current + this.increaseFn(current);
      } else if (queue >= beta) {
        next = current - this.decreaseFn(current);
      }
    }

    next = Math.round(clamp(next, this.minLimit, this.maxLimit));
    if (next !== current) {
      this._limit = next;
      this.listeners.emit(next);
    }
  }
}
