import { describe, expect, it } from 'vitest';
import { ManualClock, defaultClock } from '../src/clock.ts';

describe('defaultClock', () => {
  it('returns a monotonically non-decreasing nanosecond timestamp', () => {
    const a = defaultClock.nowNanos();
    const b = defaultClock.nowNanos();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe('ManualClock', () => {
  it('starts at 0 by default', () => {
    expect(new ManualClock().nowNanos()).toBe(0);
  });

  it('accepts an initial value', () => {
    expect(new ManualClock(1_000).nowNanos()).toBe(1_000);
  });

  it('advances by nanos', () => {
    const c = new ManualClock();
    c.advanceNanos(500);
    c.advanceNanos(250);
    expect(c.nowNanos()).toBe(750);
  });

  it('advances by millis', () => {
    const c = new ManualClock();
    c.advanceMillis(2);
    expect(c.nowNanos()).toBe(2_000_000);
  });

  it('setNanos overrides the current value (for fault-injection in tests)', () => {
    const c = new ManualClock(1_000);
    c.setNanos(42);
    expect(c.nowNanos()).toBe(42);
  });
});
