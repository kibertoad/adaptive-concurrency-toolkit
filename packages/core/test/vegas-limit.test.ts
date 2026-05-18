import { describe, expect, it, vi } from 'vitest';
import { VegasLimit } from '../src/limit/vegas-limit.ts';

const MS = 1_000_000;
const WINDOW = 1_000_000_000; // 1 s default

/**
 * Drive enough samples to close a window, then return what the limit became.
 * Each sample's `startNanos` is monotonically incremented inside the window
 * so the window-close condition (elapsed ≥ windowNanos) trips.
 */
function runWindow(
  lim: VegasLimit,
  opts: { rttNanos: number; inflight: number; samples: number; didDrop?: boolean },
): void {
  const span = WINDOW + MS;
  for (let i = 0; i < opts.samples; i++) {
    const t = Math.floor((i * span) / Math.max(1, opts.samples - 1));
    lim.onSample(t, opts.rttNanos, opts.inflight, opts.didDrop ?? false);
  }
}

describe('VegasLimit', () => {
  it('uses sensible defaults', () => {
    const lim = new VegasLimit();
    expect(lim.limit).toBe(20);
    expect(lim.minLimit).toBe(1);
    expect(lim.maxLimit).toBe(1000);
    expect(lim.windowNanos).toBe(WINDOW);
  });

  it('does not update before a window completes', () => {
    const lim = new VegasLimit({ initialLimit: 20, minWindowSamples: 5 });
    for (let i = 0; i < 4; i++) lim.onSample(i * MS, MS, 20, false);
    expect(lim.limit).toBe(20);
  });

  it('grows when the estimated queue size is below alpha', () => {
    const lim = new VegasLimit({ initialLimit: 20, minWindowSamples: 10 });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 20, samples: 20 });
    expect(lim.limit).toBeGreaterThan(20);
  });

  it('shrinks when the estimated queue size is above beta', () => {
    const lim = new VegasLimit({ initialLimit: 100, minWindowSamples: 10 });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 100, samples: 20 });
    const afterFirst = lim.limit;
    runWindow(lim, { rttNanos: 20 * MS, inflight: 100, samples: 20 });
    expect(lim.limit).toBeLessThan(afterFirst);
  });

  it('multiplicatively backs off on any drop within the window', () => {
    const lim = new VegasLimit({
      initialLimit: 100,
      backoffRatio: 0.5,
      minWindowSamples: 10,
    });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 100, samples: 20, didDrop: true });
    expect(lim.limit).toBe(50);
  });

  it('does not grow when in-flight is not utilizing the limit', () => {
    const lim = new VegasLimit({ initialLimit: 20, minWindowSamples: 10 });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 5, samples: 20 });
    expect(lim.limit).toBe(20);
  });

  it('emits change events only when the integer limit moves', () => {
    const lim = new VegasLimit({ initialLimit: 20, minWindowSamples: 10 });
    const cb = vi.fn();
    lim.onChange(cb);
    runWindow(lim, { rttNanos: 5 * MS, inflight: 20, samples: 20 });
    expect(cb).toHaveBeenCalled();
  });

  it('exposes rttNoLoad getter (Infinity before any sample, finite after)', () => {
    const lim = new VegasLimit({ initialLimit: 20, minWindowSamples: 10 });
    expect(lim.rttNoLoad).toBe(Number.POSITIVE_INFINITY);
    runWindow(lim, { rttNanos: 5 * MS, inflight: 20, samples: 20 });
    expect(lim.rttNoLoad).toBe(5 * MS);
  });

  it('re-probes rttNoLoad after probeIntervalWindows of no-new-min windows', () => {
    const lim = new VegasLimit({
      initialLimit: 20,
      minWindowSamples: 10,
      probeIntervalWindows: 2,
    });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 20, samples: 20 });
    expect(lim.rttNoLoad).toBe(5 * MS);
    // Windows whose min is *higher* than rttNoLoad — should not lower it.
    runWindow(lim, { rttNanos: 8 * MS, inflight: 20, samples: 20 });
    runWindow(lim, { rttNanos: 9 * MS, inflight: 20, samples: 20 });
    // After 2 consecutive windows without a new min, re-baseline to latest min.
    expect(lim.rttNoLoad).toBe(9 * MS);
  });

  it('accepts custom alpha / beta / increase / decrease functions', () => {
    const alphaSpy = vi.fn((l: number) => 1 + l);
    const betaSpy = vi.fn((l: number) => 2 + l);
    const incSpy = vi.fn(() => 5);
    const decSpy = vi.fn(() => 3);
    const lim = new VegasLimit({
      initialLimit: 20,
      minWindowSamples: 10,
      alpha: alphaSpy,
      beta: betaSpy,
      increase: incSpy,
      decrease: decSpy,
    });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 20, samples: 20 });
    expect(alphaSpy).toHaveBeenCalled();
    expect(betaSpy).toHaveBeenCalled();
    // queueSize = 0, below alpha → increase fn called
    expect(incSpy).toHaveBeenCalled();
  });

  it('validates options', () => {
    expect(() => new VegasLimit({ minLimit: 0 })).toThrow(RangeError);
    expect(() => new VegasLimit({ minLimit: 10, maxLimit: 5 })).toThrow(RangeError);
    expect(() => new VegasLimit({ initialLimit: 5000, maxLimit: 100 })).toThrow(RangeError);
  });
});
