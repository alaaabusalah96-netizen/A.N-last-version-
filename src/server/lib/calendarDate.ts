import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { ValidationError } from '../http/errors.js';

export const DEFAULT_BUSINESS_TIMEZONE = 'Africa/Cairo';
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates whether a value is a strict calendar date string ('YYYY-MM-DD')
 * representing a real calendar date (accepts leap days like '2028-02-29',
 * rejects impossible dates like '2026-02-29', '2026-04-31', '2026-13-01').
 */
export function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!YMD_RE.test(trimmed)) return false;
  const [yStr, mStr, dStr] = trimmed.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/**
 * Asserts a required calendar date in 'YYYY-MM-DD' format and returns trimmed string.
 * Throws ValidationError if missing or invalid.
 */
export function assertValidCalendarDate(value: unknown, fieldLabel: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${fieldLabel}: التاريخ مطلوب بصيغة YYYY-MM-DD`);
  }
  const trimmed = value.trim();
  if (!isValidCalendarDate(trimmed)) {
    throw new ValidationError(
      `${fieldLabel}: تاريخ غير صالح (${trimmed}). يجب أن يكون تاريخاً تقويمياً صحيحاً بصيغة YYYY-MM-DD`
    );
  }
  return trimmed;
}

/**
 * Asserts an optional calendar date: returns null if undefined/null/empty string,
 * otherwise validates strictly and returns 'YYYY-MM-DD'.
 */
export function assertOptionalCalendarDate(
  value: unknown,
  fieldLabel: string
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return assertValidCalendarDate(value, fieldLabel);
}

/**
 * Maps a DB DATE column value (string or pg-parsed local-midnight Date)
 * to a pure calendar string 'YYYY-MM-DD' WITHOUT using .toISOString()
 * so process TZ offsets never shift the calendar day by +/- 1.
 */
export function toCalendarDate(val: unknown): string {
  if (!val) return '';
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return '';
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  return s;
}

/**
 * Formats an instant `now` as calendar 'YYYY-MM-DD' in the given IANA timezone.
 * Falls back safely to DEFAULT_BUSINESS_TIMEZONE ('Africa/Cairo') if missing/invalid.
 */
export function getBusinessDateToday(
  timeZone?: string | null,
  now: Date = new Date()
): string {
  const safeInstant = Number.isNaN(now.getTime()) ? new Date() : now;
  const candidateTz =
    typeof timeZone === 'string' && timeZone.trim()
      ? timeZone.trim()
      : DEFAULT_BUSINESS_TIMEZONE;

  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: candidateTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(safeInstant);
  } catch {
    // Fallback to DEFAULT_BUSINESS_TIMEZONE if company timezone string is invalid
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_BUSINESS_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(safeInstant);
  }
}

/**
 * Resolves the configured IANA timezone for a company from `company_settings`,
 * falling back to DEFAULT_BUSINESS_TIMEZONE ('Africa/Cairo').
 */
export async function resolveCompanyTimeZone(
  companyId: string,
  tx?: DbExecutor
): Promise<string> {
  if (!companyId) return DEFAULT_BUSINESS_TIMEZONE;

  const queryTz = async (executor: DbExecutor): Promise<string> => {
    try {
      const res = await executor.query<{ timezone: string | null }>(
        `SELECT timezone FROM company_settings WHERE company_id = $1 LIMIT 1`,
        [companyId]
      );
      const tz = res.rows[0]?.timezone;
      if (typeof tz === 'string' && tz.trim().length > 0) {
        return tz.trim();
      }
      return DEFAULT_BUSINESS_TIMEZONE;
    } catch {
      // Fallback to default timezone if company_settings is absent in a unit context
      return DEFAULT_BUSINESS_TIMEZONE;
    }
  };

  if (tx) {
    return await queryTz(tx);
  }
  return await withTenantTransaction(companyId, queryTz);
}

/**
 * Resolves today's business calendar date ('YYYY-MM-DD') in the company's timezone.
 */
export async function resolveCompanyToday(
  companyId: string,
  tx?: DbExecutor,
  now: Date = new Date()
): Promise<string> {
  const tz = await resolveCompanyTimeZone(companyId, tx);
  return getBusinessDateToday(tz, now);
}

/**
 * Computes exact integer calendar day difference (laterYmd - earlierYmd).
 */
export function diffCalendarDays(laterYmd: string, earlierYmd: string): number {
  const parseUtc = (ymd: string): number | null => {
    const clean = toCalendarDate(ymd);
    if (!isValidCalendarDate(clean)) return null;
    const [y, m, d] = clean.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const a = parseUtc(laterYmd);
  const b = parseUtc(earlierYmd);
  if (a === null || b === null) return 0;
  return Math.round((a - b) / 86_400_000);
}
