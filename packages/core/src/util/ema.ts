/**
 * Exponential moving average with lazy initialization. The first value seeds
 * the average so the EMA does not bias toward zero during warm-up.
 *
 * Update formula (after init):
 *   v ← α·x + (1 − α)·v
 *
 * Hot path is one multiply + one fused-multiply-add equivalent; no allocations.
 */
export class Ema {
  readonly alpha: number;
  private _value = 0;
  private _initialized = false;

  /**
   * @param alpha smoothing factor in (0, 1]. Higher α reacts faster, lower α
   * smooths more. Equivalent time constant ≈ 1/α samples.
   */
  constructor(alpha: number) {
    if (!(alpha > 0 && alpha <= 1)) {
      throw new RangeError(`alpha must be in (0, 1], got ${alpha}`);
    }
    this.alpha = alpha;
  }

  /**
   * Construct an EMA whose smoothing factor approximates `n` samples of memory.
   */
  static withWindow(n: number): Ema {
    if (!(n >= 1)) throw new RangeError(`n must be >= 1, got ${n}`);
    return new Ema(2 / (n + 1));
  }

  update(x: number): number {
    if (this._initialized) {
      this._value = this.alpha * x + (1 - this.alpha) * this._value;
    } else {
      this._value = x;
      this._initialized = true;
    }
    return this._value;
  }

  get value(): number {
    return this._value;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  reset(): void {
    this._value = 0;
    this._initialized = false;
  }
}
