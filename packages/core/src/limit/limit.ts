import type { LimitChangeListener, Nanos, Unsubscribe } from '../types.ts';

/**
 * Concurrency limit algorithm. Implementations consume completion samples and
 * expose the current inferred ceiling on in-flight work.
 *
 * The {@link onSample} signature is intentionally positional so the call site
 * never allocates a sample object on the hot path.
 */
export interface Limit {
  /** Current inferred concurrency ceiling. Always >= 1. */
  readonly limit: number;

  /**
   * Report a completed operation.
   *
   * @param startTimeNanos Monotonic timestamp when the permit was issued.
   *   Algorithms may use it for windowing.
   * @param rttNanos       Observed round-trip time (now − startTimeNanos).
   * @param inflight       In-flight count when the permit was issued
   *   (or peak in-flight observed during the sample's lifetime — see limiter).
   * @param didDrop        True if the caller reported the request as dropped
   *   (timeout, 5xx, overload). Algorithms typically treat this as the
   *   strongest decrease signal.
   */
  onSample(startTimeNanos: Nanos, rttNanos: Nanos, inflight: number, didDrop: boolean): void;

  /**
   * Subscribe to limit changes. Returns an unsubscribe function. The callback
   * is invoked synchronously from `onSample` when the limit changes.
   */
  onChange(listener: LimitChangeListener): Unsubscribe;
}
