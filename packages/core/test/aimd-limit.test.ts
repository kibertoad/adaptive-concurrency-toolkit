import { describe, expect, it, vi } from 'vitest';
import { AimdLimit } from '../src/limit/aimd-limit.ts';

const MS = 1_000_000;

describe('AimdLimit', () => {
  it('uses sensible defaults', () => {
    const lim = new AimdLimit();
    expect(lim.limit).toBe(10);
    expect(lim.minLimit).toBe(1);
    expect(lim.maxLimit).toBe(1000);
    expect(lim.backoffRatio).toBe(0.9);
  });

  it('additively increases when in-flight meets the utilization threshold', () => {
    const lim = new AimdLimit({ initialLimit: 10, utilizationThreshold: 0.5 });
    // 5 in-flight at limit=10 → at threshold, should grow
    lim.onSample(0, 5 * MS, 5, false);
    expect(lim.limit).toBe(11);
    lim.onSample(0, 5 * MS, 6, false);
    expect(lim.limit).toBe(12);
  });

  it('holds when in-flight is below the utilization threshold', () => {
    const lim = new AimdLimit({ initialLimit: 100, utilizationThreshold: 0.5 });
    lim.onSample(0, 5 * MS, 10, false);
    expect(lim.limit).toBe(100);
  });

  it('multiplicatively decreases on a drop sample', () => {
    const lim = new AimdLimit({ initialLimit: 100, backoffRatio: 0.5 });
    lim.onSample(0, 5 * MS, 100, true);
    expect(lim.limit).toBe(50);
  });

  it('treats rtt > rttTimeoutNanos as a drop signal', () => {
    const lim = new AimdLimit({
      initialLimit: 100,
      backoffRatio: 0.5,
      rttTimeoutNanos: 100 * MS,
    });
    lim.onSample(0, 200 * MS, 50, false); // success but slow
    expect(lim.limit).toBe(50);
  });

  it('honors minLimit and maxLimit bounds', () => {
    const lim = new AimdLimit({ initialLimit: 2, minLimit: 2, maxLimit: 3, backoffRatio: 0.5 });
    lim.onSample(0, MS, 2, true);
    expect(lim.limit).toBe(2); // floor

    lim.onSample(0, MS, 2, false);
    expect(lim.limit).toBe(3); // grew to max
    lim.onSample(0, MS, 3, false);
    expect(lim.limit).toBe(3); // pinned at max
  });

  it('notifies change listeners only when the limit actually moves', () => {
    const lim = new AimdLimit({ initialLimit: 10, utilizationThreshold: 0.5 });
    const cb = vi.fn();
    lim.onChange(cb);
    lim.onSample(0, MS, 1, false); // below threshold, no change
    expect(cb).not.toHaveBeenCalled();
    lim.onSample(0, MS, 5, false); // change
    expect(cb).toHaveBeenCalledWith(11);
  });

  it('validates options', () => {
    expect(() => new AimdLimit({ minLimit: 0 })).toThrow(RangeError);
    expect(() => new AimdLimit({ maxLimit: 5, minLimit: 10 })).toThrow(RangeError);
    expect(() => new AimdLimit({ initialLimit: 100, maxLimit: 50 })).toThrow(RangeError);
    expect(() => new AimdLimit({ backoffRatio: 1 })).toThrow(RangeError);
    expect(() => new AimdLimit({ backoffRatio: 0 })).toThrow(RangeError);
    expect(() => new AimdLimit({ utilizationThreshold: 1.5 })).toThrow(RangeError);
    expect(() => new AimdLimit({ rttTimeoutNanos: 0 })).toThrow(RangeError);
  });
});
