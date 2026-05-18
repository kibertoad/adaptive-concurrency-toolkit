import { describe, expect, it, vi } from 'vitest';
import { FixedLimit } from '../src/limit/fixed-limit.ts';

describe('FixedLimit', () => {
  it('exposes the configured limit', () => {
    expect(new FixedLimit({ limit: 42 }).limit).toBe(42);
  });

  it('never changes the limit regardless of samples', () => {
    const lim = new FixedLimit({ limit: 5 });
    const changed = vi.fn();
    lim.onChange(changed);
    lim.onSample(0, 1_000_000, 5, true);
    lim.onSample(0, 10_000_000, 1, false);
    expect(lim.limit).toBe(5);
    expect(changed).not.toHaveBeenCalled();
  });

  it('rejects non-positive or non-integer limits', () => {
    expect(() => new FixedLimit({ limit: 0 })).toThrow(RangeError);
    expect(() => new FixedLimit({ limit: -1 })).toThrow(RangeError);
    expect(() => new FixedLimit({ limit: 1.5 })).toThrow(RangeError);
  });
});
