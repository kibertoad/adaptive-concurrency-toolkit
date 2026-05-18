import type { LimitChangeListener, Unsubscribe } from '../types.ts';

/**
 * Tiny multi-listener registry. Optimized for the common case of zero or one
 * subscriber — avoids allocating an array in that case.
 */
export class ChangeListeners {
  private single: LimitChangeListener | undefined;
  private many: LimitChangeListener[] | undefined;

  add(listener: LimitChangeListener): Unsubscribe {
    if (this.many !== undefined) {
      this.many.push(listener);
    } else if (this.single === undefined) {
      this.single = listener;
    } else {
      this.many = [this.single, listener];
      this.single = undefined;
    }
    return () => this.remove(listener);
  }

  emit(newLimit: number): void {
    if (this.single !== undefined) {
      this.single(newLimit);
      return;
    }
    const list = this.many;
    if (list !== undefined) {
      for (let i = 0; i < list.length; i++) list[i]!(newLimit);
    }
  }

  private remove(listener: LimitChangeListener): void {
    if (this.single === listener) {
      this.single = undefined;
      return;
    }
    const list = this.many;
    if (list === undefined) return;
    const idx = list.indexOf(listener);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 1) {
      this.single = list[0];
      this.many = undefined;
    }
  }
}
