import { describe, expect, it } from 'vitest';
import { Ema } from '../src/util/ema.ts';

describe('Ema', () => {
  it('seeds with the first value (no zero-bias warm-up)', () => {
    const ema = new Ema(0.5);
    expect(ema.update(100)).toBe(100);
    expect(ema.value).toBe(100);
    expect(ema.initialized).toBe(true);
  });

  it('blends new values according to alpha', () => {
    const ema = new Ema(0.5);
    ema.update(100);
    expect(ema.update(200)).toBe(150);
    expect(ema.update(0)).toBe(75);
  });

  it('withWindow(n) produces alpha = 2/(n+1)', () => {
    const ema = Ema.withWindow(9);
    expect(ema.alpha).toBeCloseTo(0.2, 10);
  });

  it('rejects invalid alpha', () => {
    expect(() => new Ema(0)).toThrow(RangeError);
    expect(() => new Ema(-0.1)).toThrow(RangeError);
    expect(() => new Ema(1.1)).toThrow(RangeError);
    expect(() => Ema.withWindow(0)).toThrow(RangeError);
  });

  it('reset() returns to un-initialized state', () => {
    const ema = new Ema(0.5);
    ema.update(100);
    ema.reset();
    expect(ema.initialized).toBe(false);
    expect(ema.update(50)).toBe(50);
  });
});
