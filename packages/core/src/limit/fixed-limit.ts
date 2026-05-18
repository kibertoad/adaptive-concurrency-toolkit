import type { LimitChangeListener, Nanos, Unsubscribe } from '../types.ts';
import { ChangeListeners } from '../util/listeners.ts';
import type { Limit } from './limit.ts';

export interface FixedLimitOptions {
  /** Constant concurrency ceiling. Must be a positive integer. */
  readonly limit: number;
}

/**
 * Constant {@link Limit}. Useful as a baseline, for tests, and as the default
 * when adaptive behavior is undesirable.
 */
export class FixedLimit implements Limit {
  readonly limit: number;
  private readonly listeners = new ChangeListeners();

  constructor(opts: FixedLimitOptions) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new RangeError(`limit must be a positive integer, got ${opts.limit}`);
    }
    this.limit = opts.limit;
  }

  onSample(_start: Nanos, _rtt: Nanos, _inflight: number, _didDrop: boolean): void {
    /* no-op */
  }

  onChange(listener: LimitChangeListener): Unsubscribe {
    return this.listeners.add(listener);
  }
}
