import { describe, expect, it, vi } from 'vitest';
import { Gradient2Limit } from '../src/limit/gradient2-limit.ts';

const MS = 1_000_000;
const WINDOW = 1_000_000_000;

function runWindow(
  lim: Gradient2Limit,
  opts: { rttNanos: number; inflight: number; samples: number; didDrop?: boolean },
): void {
  const span = WINDOW + MS;
  for (let i = 0; i < opts.samples; i++) {
    const t = Math.floor((i * span) / Math.max(1, opts.samples - 1));
    lim.onSample(t, opts.rttNanos, opts.inflight, opts.didDrop ?? false);
  }
}

describe('Gradient2Limit', () => {
  it('uses sensible defaults', () => {
    const lim = new Gradient2Limit();
    expect(lim.limit).toBe(20);
    expect(lim.tolerance).toBe(1.5);
    expect(lim.smoothing).toBe(0.2);
    expect(lim.minGradient).toBe(0.5);
    expect(lim.longRttNanos).toBe(0);
  });

  it('does not update on the very first window (longRtt seed)', () => {
    const lim = new Gradient2Limit({ initialLimit: 20, minWindowSamples: 10 });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 20, samples: 20 });
    expect(lim.limit).toBe(20);
    expect(lim.longRttNanos).toBe(5 * MS);
  });

  it('grows via the queue-size hedge when latency is stable', () => {
    const lim = new Gradient2Limit({ initialLimit: 20, minWindowSamples: 10 });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 20, samples: 20 });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 20, samples: 20 });
    expect(lim.limit).toBeGreaterThan(20);
  });

  it('contracts when short-window RTT inflates beyond the baseline', () => {
    const lim = new Gradient2Limit({
      initialLimit: 100,
      minWindowSamples: 10,
      tolerance: 1.0,
    });
    for (let w = 0; w < 50; w++) {
      runWindow(lim, { rttNanos: 5 * MS, inflight: 100, samples: 20 });
    }
    const baseline = lim.limit;
    runWindow(lim, { rttNanos: 20 * MS, inflight: 100, samples: 20 });
    expect(lim.limit).toBeLessThan(baseline);
  });

  it('does not grow when not utilizing current limit', () => {
    const lim = new Gradient2Limit({ initialLimit: 100, minWindowSamples: 10 });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 10, samples: 20 });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 10, samples: 20 });
    expect(lim.limit).toBe(100);
  });

  it('multiplicatively backs off on a drop sample', () => {
    const lim = new Gradient2Limit({
      initialLimit: 100,
      minWindowSamples: 10,
      backoffRatio: 0.5,
    });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 100, samples: 20, didDrop: true });
    expect(lim.limit).toBe(50);
  });

  it('floors the gradient so a single bad window cannot collapse the limit', () => {
    const lim = new Gradient2Limit({
      initialLimit: 100,
      minWindowSamples: 10,
      minGradient: 0.5,
      smoothing: 1,
      tolerance: 1.0,
    });
    for (let w = 0; w < 20; w++) {
      runWindow(lim, { rttNanos: 5 * MS, inflight: 100, samples: 20 });
    }
    runWindow(lim, { rttNanos: 10_000 * MS, inflight: 100, samples: 20 });
    expect(lim.limit).toBeGreaterThanOrEqual(80);
  });

  it('accepts a custom queueSize function', () => {
    const queueSize = vi.fn(() => 0);
    const lim = new Gradient2Limit({
      initialLimit: 50,
      minWindowSamples: 10,
      queueSize,
    });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 50, samples: 20 });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 50, samples: 20 });
    expect(queueSize).toHaveBeenCalled();
    // With queueSize=0 and stable RTT, gradient=1 and queue=0 → candidate=limit → no change
    expect(lim.limit).toBe(50);
  });

  it('emits a change notification on limit movement', () => {
    const lim = new Gradient2Limit({ initialLimit: 20, minWindowSamples: 10 });
    const cb = vi.fn();
    const off = lim.onChange(cb);
    runWindow(lim, { rttNanos: 5 * MS, inflight: 20, samples: 20 });
    runWindow(lim, { rttNanos: 5 * MS, inflight: 20, samples: 20 });
    expect(cb).toHaveBeenCalled();
    off();
  });

  it('validates options', () => {
    expect(() => new Gradient2Limit({ minLimit: 0 })).toThrow(RangeError);
    expect(() => new Gradient2Limit({ minLimit: 10, maxLimit: 5 })).toThrow(RangeError);
    expect(() => new Gradient2Limit({ initialLimit: 5000, maxLimit: 100 })).toThrow(RangeError);
    expect(() => new Gradient2Limit({ tolerance: 0 })).toThrow(RangeError);
    expect(() => new Gradient2Limit({ smoothing: 0 })).toThrow(RangeError);
    expect(() => new Gradient2Limit({ smoothing: 1.1 })).toThrow(RangeError);
    expect(() => new Gradient2Limit({ minGradient: 0 })).toThrow(RangeError);
    expect(() => new Gradient2Limit({ minGradient: 1.1 })).toThrow(RangeError);
    expect(() => new Gradient2Limit({ backoffRatio: 1 })).toThrow(RangeError);
    expect(() => new Gradient2Limit({ backoffRatio: 0 })).toThrow(RangeError);
  });
});
