import type { Listener } from '../types.ts';

/**
 * Gate work against an adaptive concurrency ceiling. Acquire a permit before
 * starting work; call exactly one of `onSuccess` / `onDropped` / `onIgnore` on
 * the returned {@link Listener} when work completes.
 */
export interface Limiter {
  /**
   * Attempt to acquire a permit. Returns `undefined` if the current in-flight
   * count is at or above the algorithm's limit, in which case the caller is
   * expected to shed load (e.g. respond 429, route to a fallback, queue).
   */
  acquire(): Listener | undefined;

  /** Current in-flight count. */
  readonly inflight: number;
  /** Current algorithm limit. */
  readonly limit: number;
}
