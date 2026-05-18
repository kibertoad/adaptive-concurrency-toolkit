import type { Nanos } from './types.ts';

/**
 * Monotonic time source. The default implementation uses
 * `performance.now()` scaled to nanoseconds — fast, allocation-free, monotonic.
 *
 * A custom clock is useful for deterministic tests and for embedding in
 * environments without `performance` (workers, etc).
 */
export interface Clock {
  nowNanos(): Nanos;
}

const NS_PER_MS = 1_000_000;

export const defaultClock: Clock = {
  nowNanos: () => performance.now() * NS_PER_MS,
};

export class ManualClock implements Clock {
  private current: Nanos;
  constructor(initial: Nanos = 0) {
    this.current = initial;
  }
  nowNanos(): Nanos {
    return this.current;
  }
  advanceNanos(delta: Nanos): void {
    this.current += delta;
  }
  advanceMillis(delta: number): void {
    this.current += delta * NS_PER_MS;
  }
  setNanos(value: Nanos): void {
    this.current = value;
  }
}
