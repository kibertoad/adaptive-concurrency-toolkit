/**
 * Time durations are represented as `number` nanoseconds carried in IEEE-754
 * doubles. This keeps arithmetic on the hot path zero-allocation while still
 * giving sub-microsecond precision for any realistic process uptime.
 */
export type Nanos = number;

/**
 * Returned by {@link Limiter.acquire} when a permit was successfully reserved.
 * Exactly one of `onSuccess` / `onDropped` / `onIgnore` must be called for each
 * permit; subsequent calls on the same listener are no-ops.
 *
 * Semantics:
 *  - `onSuccess` — work completed within expected bounds. RTT is informative.
 *  - `onDropped` — work failed in a way that indicates the upstream is
 *                  overloaded (timeout, 5xx, queue-full). Strongest decrease
 *                  signal for adaptive algorithms.
 *  - `onIgnore`  — work completed but the sample should not influence the
 *                  limit (e.g. client cancellation, 4xx validation error,
 *                  cache hit). The permit is released; RTT is discarded.
 */
export interface Listener {
  onSuccess(): void;
  onDropped(): void;
  onIgnore(): void;
}

export type LimitChangeListener = (newLimit: number) => void;
export type Unsubscribe = () => void;
