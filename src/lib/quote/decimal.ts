// Exact decimal arithmetic for money, using BigInt fixed-point (no floats).
// Values are stored as integers scaled by 10^SCALE.

const SCALE = 8;
const FACTOR = 10n ** BigInt(SCALE);

export class Dec {
  readonly raw: bigint;
  private constructor(raw: bigint) { this.raw = raw; }

  /** Parse "1234.56", "-0.5", 12, etc. Rejects anything ambiguous. */
  static from(v: string | number | bigint | Dec): Dec {
    if (v instanceof Dec) return v;
    if (typeof v === 'bigint') return new Dec(v * FACTOR);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error(`Invalid number: ${v}`);
      // Numbers are accepted only via their shortest decimal string form.
      v = String(v);
      if (/e/i.test(v)) throw new Error(`Number out of supported range: ${v}`);
    }
    const s = v.trim().replace(/,/g, '');
    const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) throw new Error(`Invalid decimal: "${v}"`);
    const [, sign, int, frac = ''] = m;
    if (frac.length > SCALE) throw new Error(`Too many decimal places: "${v}"`);
    const raw = BigInt(int) * FACTOR + BigInt(frac.padEnd(SCALE, '0') || '0');
    return new Dec(sign === '-' ? -raw : raw);
  }

  static zero = new Dec(0n);

  add(o: Dec) { return new Dec(this.raw + o.raw); }
  sub(o: Dec) { return new Dec(this.raw - o.raw); }
  mul(o: Dec) { return new Dec(divRound(this.raw * o.raw, FACTOR)); }
  div(o: Dec) {
    if (o.raw === 0n) throw new Error('Division by zero');
    return new Dec(divRound(this.raw * FACTOR, o.raw));
  }
  /** Round half away from zero to `dp` decimal places. */
  round(dp = 2) {
    const q = 10n ** BigInt(SCALE - dp);
    return new Dec(divRound(this.raw, q) * q);
  }
  isNeg() { return this.raw < 0n; }
  isZero() { return this.raw === 0n; }
  cmp(o: Dec) { return this.raw < o.raw ? -1 : this.raw > o.raw ? 1 : 0; }

  toFixed(dp = 2): string {
    const r = this.round(dp).raw;
    const neg = r < 0n;
    const abs = neg ? -r : r;
    const int = abs / FACTOR;
    const frac = (abs % FACTOR).toString().padStart(SCALE, '0').slice(0, dp);
    return (neg ? '-' : '') + int.toString() + (dp > 0 ? '.' + frac : '');
  }
  toString() { return this.toFixed(SCALE).replace(/\.?0+$/, '') || '0'; }
}

function divRound(n: bigint, d: bigint): bigint {
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  if ((an % ad) * 2n >= ad) q += 1n; // half away from zero
  return neg ? -q : q;
}
