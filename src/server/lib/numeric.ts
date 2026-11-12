/**
 * Numeric helper to avoid binary float errors on money/qty paths.
 * Rounds to a fixed number of decimal places after normalizing input.
 */

export function toDecimal(value: unknown, scale = 4): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }

  // Round with decimal-safe method
  // Using Math.round on the scaled value to avoid float imprecision at the target decimal
  const factor = Math.pow(10, scale);
  return Math.round(n * factor) / factor;
}

export function toMoney(value: unknown): number {
  return toDecimal(value, 2);
}
