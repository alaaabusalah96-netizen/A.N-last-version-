export const MONEY_SCALE = 2;

/**
 * تحويل دقيق إلى وحدات صغرى (bigint) بالتقريب النصفي لأعلى (half-up).
 * بيقرأ القيمة كنص عشري، ومابيمرّش على Number في أي خطوة.
 */
export function toMinorUnits(value: unknown, scale: number = MONEY_SCALE): bigint {
  if (value === null || value === undefined || value === '') return BigInt(0);
  const raw = typeof value === 'bigint' ? value.toString() : String(value).trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
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
  const frac = s.slice(s.length - scale);
  return `${neg ? '-' : ''}${intPart}.${frac}`;
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
