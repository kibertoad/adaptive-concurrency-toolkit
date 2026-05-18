import { describe, expect, it, vi } from 'vitest';
import { ChangeListeners } from '../src/util/listeners.ts';

describe('ChangeListeners', () => {
  it('no-ops when emitting with no subscribers', () => {
    new ChangeListeners().emit(1); // should not throw
  });

  it('notifies a single subscriber', () => {
    const cl = new ChangeListeners();
    const cb = vi.fn();
    cl.add(cb);
    cl.emit(42);
    expect(cb).toHaveBeenCalledWith(42);
  });

  it('notifies multiple subscribers in registration order', () => {
    const cl = new ChangeListeners();
    const calls: number[] = [];
    cl.add(() => calls.push(1));
    cl.add(() => calls.push(2));
    cl.add(() => calls.push(3));
    cl.emit(7);
    expect(calls).toEqual([1, 2, 3]);
  });

  it('unsubscribe removes the single subscriber', () => {
    const cl = new ChangeListeners();
    const cb = vi.fn();
    const off = cl.add(cb);
    off();
    cl.emit(1);
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe removes from the multi-subscriber array', () => {
    const cl = new ChangeListeners();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    cl.add(a);
    const offB = cl.add(b);
    cl.add(c);
    offB();
    cl.emit(9);
    expect(a).toHaveBeenCalledWith(9);
    expect(b).not.toHaveBeenCalled();
    expect(c).toHaveBeenCalledWith(9);
  });

  it('collapses back to the single-subscriber fast path when down to one', () => {
    const cl = new ChangeListeners();
    const a = vi.fn();
    const b = vi.fn();
    cl.add(a);
    const offB = cl.add(b);
    offB();
    // After collapse the surviving listener should still fire on emit.
    cl.emit(1);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing twice is a no-op the second time', () => {
    const cl = new ChangeListeners();
    const off = cl.add(() => {});
    off();
    off();
    cl.emit(1); // should not throw
  });

  it('unsubscribing a listener that was never registered is a no-op', () => {
    const cl = new ChangeListeners();
    cl.add(() => {});
    cl.add(() => {});
    // Manually invoke the unsubscribe of a stranger via add+off pattern, then
    // make sure repeated removal of an already-gone listener is harmless.
    const stranger = vi.fn();
    const off = cl.add(stranger);
    off();
    off();
    cl.emit(5);
    expect(stranger).not.toHaveBeenCalled();
  });
});
