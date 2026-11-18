import { ValidationError } from '../http/errors.js';

export const MONEY_SCALE = 2;
export const QTY_SCALE = 4;
export const COST_SCALE = 4;

const POW10_CACHE = new Map<number, bigint>();

export function pow10(exp: number): bigint {
  if (exp <= 0) return 1n;
  const cached = POW10_CACHE.get(exp);
  if (cached !== undefined) return cached;
  const val = 10n ** BigInt(exp);
  POW10_CACHE.set(exp, val);
  return val;
}

/**
 * Expands finite decimal or scientific notation strings into plain fixed-sign decimal strings without floating-point arithmetic.
 */
function expandDecimalLiteral(rawInput: string): string | null {
  const s = rawInput.trim();
  if (!s) return null;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!match) return null;

  const sign = match[1] === '-' ? '-' : '';
  const intDigits = match[2] || '0';
  const fracDigits = match[3] || match[4] || '';
  const exp = match[5] ? parseInt(match[5], 10) : 0;
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 100) return null;

  const combined = intDigits + fracDigits;
  const pointPos = intDigits.length + exp;

  if (pointPos <= 0) {
    return `${sign}0.${'0'.repeat(-pointPos)}${combined}`;
  }
  if (pointPos >= combined.length) {
    return `${sign}${combined}${'0'.repeat(pointPos - combined.length)}`;
  }
  return `${sign}${combined.slice(0, pointPos)}.${combined.slice(pointPos)}`;
}

/**
 * Strict exact parser for financial/quantity/cost inputs. Rejects NaN, Infinity, or malformed strings.
 */
export function parseExactUnits(
  value: unknown,
  scale: number = COST_SCALE,
  fieldLabel = 'value'
): bigint {
  if (value === null || value === undefined || value === '') {
    throw new ValidationError(`قيمة رقمية غير صالحة للحقل (${fieldLabel})`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`قيمة رقمية غير محدودة للحقل (${fieldLabel})`);
    }
  }
  const raw = typeof value === 'bigint' ? value.toString() : String(value);
  const expanded = expandDecimalLiteral(raw);
  if (!expanded) {
    throw new ValidationError(`صيغة رقمية غير صالحة للحقل (${fieldLabel}): ${raw}`);
  }
  return toMinorUnits(expanded, scale);
}

/**
 * Exact BigInt half-up division: rounds half away from zero.
 */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new ValidationError('Division by zero in exact decimal arithmetic');
  }
  const neg = (numerator < 0n) !== (denominator < 0n);
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;

  const q = absNum / absDen;
  const r = absNum % absDen;
  const rounded = r * 2n >= absDen ? q + 1n : q;
  return neg && rounded !== 0n ? -rounded : rounded;
}

/**
 * Multiplies two scaled BigInt values and rounds half-up to targetScale without touching JS floats.
 */
export function mulExactUnits(
  aUnits: bigint,
  scaleA: number,
  bUnits: bigint,
  scaleB: number,
  targetScale: number
): bigint {
  const product = aUnits * bUnits;
  const totalScale = scaleA + scaleB;
  if (totalScale === targetScale) return product;
  if (totalScale > targetScale) {
    return divideRoundHalfUp(product, pow10(totalScale - targetScale));
  }
  return product * pow10(targetScale - totalScale);
}

/**
 * Divides two scaled BigInt values and rounds half-up to targetScale without touching JS floats.
 */
export function divExactUnits(
  numUnits: bigint,
  scaleNum: number,
  denUnits: bigint,
  scaleDen: number,
  targetScale: number
): bigint {
  if (denUnits === 0n) {
    throw new ValidationError('Division by zero in exact valuation calculation');
  }
  const shift = targetScale + scaleDen - scaleNum;
  if (shift >= 0) {
    return divideRoundHalfUp(numUnits * pow10(shift), denUnits);
  }
  return divideRoundHalfUp(numUnits, denUnits * pow10(-shift));
}

/**
 * Re-scales a BigInt from one decimal scale to another with half-up rounding.
 */
export function rescaleUnits(units: bigint, fromScale: number, toScale: number): bigint {
  if (fromScale === toScale) return units;
  if (fromScale < toScale) return units * pow10(toScale - fromScale);
  return divideRoundHalfUp(units, pow10(fromScale - toScale));
}

/**
 * Allocates totalUnits proportionally across non-negative weights so SUM(allocations) === totalUnits strictly.
 * Uses deterministic largest-remainder (Hamilton method) in exact BigInt arithmetic.
 */
export function allocateProportionalUnits(totalUnits: bigint, weights: bigint[]): bigint[] {
  if (weights.length === 0) return [];
  const totalWeight = weights.reduce((acc, w) => acc + (w > 0n ? w : 0n), 0n);
  if (totalWeight === 0n) {
    return weights.map((_, i) => (i === 0 ? totalUnits : 0n));
  }
  if (totalUnits === 0n) {
    return weights.map(() => 0n);
  }

  const sign = totalUnits < 0n ? -1n : 1n;
  const absTotal = totalUnits < 0n ? -totalUnits : totalUnits;

  const shares = weights.map((w, idx) => {
    const posW = w > 0n ? w : 0n;
    const prod = absTotal * posW;
    const base = prod / totalWeight;
    const rem = prod % totalWeight;
    return { idx, base, rem };
  });

  const baseSum = shares.reduce((s, x) => s + x.base, 0n);
  let leftover = absTotal - baseSum;

  const sortedByRem = [...shares].sort((a, b) => {
    if (b.rem > a.rem) return 1;
    if (b.rem < a.rem) return -1;
    return a.idx - b.idx;
  });

  const extras = new Array<bigint>(weights.length).fill(0n);
  for (let i = 0; i < sortedByRem.length && leftover > 0n; i++) {
    if (weights[sortedByRem[i].idx] > 0n) {
      extras[sortedByRem[i].idx] += 1n;
      leftover -= 1n;
    }
  }

  return shares.map((s) => sign * (s.base + extras[s.idx]));
}

export function unitsToSafeNumber(units: bigint, scale: number = COST_SCALE): number {
  const s = fromMinorUnits(units, scale);
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * تحويل دقيق إلى وحدات صغرى (bigint) بالتقريب النصفي لأعلى (half-up).
 * بيقرأ القيمة كنص عشري، ومابيمرّش على Number في أي خطوة.
 */
export function toMinorUnits(value: unknown, scale: number = MONEY_SCALE): bigint {
  if (value === null || value === undefined || value === '') return BigInt(0);
  const rawInput = typeof value === 'bigint' ? value.toString() : String(value).trim();
  const expanded = expandDecimalLiteral(rawInput) ?? rawInput;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(expanded);
  if (!m) return BigInt(0);
  const sign = m[1] === '-' ? BigInt(-1) : BigInt(1);
  const intPart = m[2] && m[2].length > 0 ? m[2] : '0';
  const fracRaw = m[3] || '';
  const padded = (fracRaw + '0'.repeat(scale + 1)).slice(0, scale + 1);
  const roundDigit = padded.charAt(scale);
  let digits = BigInt(intPart + padded.slice(0, scale));
  if (Number(roundDigit) >= 5) digits += BigInt(1);
  return sign * digits;
}

export function fromMinorUnits(units: bigint, scale: number = MONEY_SCALE): string {
  const neg = units < BigInt(0);
  const abs = neg ? -units : units;
  const s = abs.toString().padStart(scale + 1, '0');
  const intPart = s.slice(0, s.length - scale);
  const frac = scale > 0 ? s.slice(s.length - scale) : '';
  return scale > 0 ? `${neg ? '-' : ''}${intPart}.${frac}` : `${neg ? '-' : ''}${intPart}`;
}

export function sumMoney(values: unknown[], scale: number = MONEY_SCALE): string {
  let total = BigInt(0);
  for (const v of values) total += toMinorUnits(v, scale);
  return fromMinorUnits(total, scale);
}

export function isMoneyBalanced(a: unknown[], b: unknown[], scale: number = MONEY_SCALE): boolean {
  let left = BigInt(0);
  for (const v of a) left += toMinorUnits(v, scale);
  let right = BigInt(0);
  for (const v of b) right += toMinorUnits(v, scale);
  return left === right;
}

/*
 * ملاحظة حدود (مقبولة ومكتوبة صريحة):
 * NUMERIC(15,2) أقصى قيمة = 9,999,999,999,999.99
 * وبعد scale=2 -> 999,999,999,999,999 وحدة صغرى (< 2^53).
 * لذلك التحويل إلى number بعد التقريب النصفي آمن للمبالغ المحاسبية.
 * لكن أي تجميع مالي لازم يتم عبر sumMoney/isMoneyBalanced (bigint)،
 * مش بجمع أرقام number.
 */
export function toDecimal(value: unknown, scale = 4): number {
  if (value === null || value === undefined || value === '') return 0;
  const exact = fromMinorUnits(toMinorUnits(value, scale), scale);
  const n = Number(exact);
  return Number.isFinite(n) ? n : 0;
}

export function toMoney(value: unknown): number {
  return toDecimal(value, MONEY_SCALE);
}
