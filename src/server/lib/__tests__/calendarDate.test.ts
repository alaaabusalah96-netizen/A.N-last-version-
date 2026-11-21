import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  isValidCalendarDate,
  assertValidCalendarDate,
  assertOptionalCalendarDate,
  toCalendarDate,
  getBusinessDateToday,
  resolveCompanyTimeZone,
  resolveCompanyToday,
  diffCalendarDays,
} from '../calendarDate.js';
import { getLocalTodayDateString } from '../../../lib/calendarDate.js';
import { ValidationError } from '../../http/errors.js';

describe('R01 Calendar Date Utilities', () => {
  it('validates strict calendar dates including leap days and rejects impossible dates', () => {
    expect(isValidCalendarDate('2026-01-01')).toBe(true);
    expect(isValidCalendarDate('2026-03-31')).toBe(true);
    expect(isValidCalendarDate('2026-12-31')).toBe(true);
    expect(isValidCalendarDate('2028-02-29')).toBe(true);

    expect(isValidCalendarDate('2026-02-29')).toBe(false);
    expect(isValidCalendarDate('2026-04-31')).toBe(false);
    expect(isValidCalendarDate('2026-13-01')).toBe(false);
    expect(isValidCalendarDate('2026-00-10')).toBe(false);
    expect(isValidCalendarDate('2026-3-1')).toBe(false);
    expect(isValidCalendarDate('not-a-date')).toBe(false);

    expect(assertValidCalendarDate(' 2028-02-29 ', 'testDate')).toBe('2028-02-29');
    expect(() => assertValidCalendarDate('2026-02-29', 'testDate')).toThrow(ValidationError);
    expect(() => assertValidCalendarDate('2026-04-31', 'testDate')).toThrow(ValidationError);
    expect(() => assertValidCalendarDate('2026-13-01', 'testDate')).toThrow(ValidationError);
    expect(() => assertValidCalendarDate('', 'testDate')).toThrow(ValidationError);

    expect(assertOptionalCalendarDate(undefined, 'optDate')).toBeNull();
    expect(assertOptionalCalendarDate(null, 'optDate')).toBeNull();
    expect(assertOptionalCalendarDate('   ', 'optDate')).toBeNull();
    expect(assertOptionalCalendarDate('2026-03-01', 'optDate')).toBe('2026-03-01');
    expect(() => assertOptionalCalendarDate('2026-02-29', 'optDate')).toThrow(ValidationError);
  });

  it('maps pg-parsed local midnight Date objects without shifting day via UTC', () => {
    const localMarch1 = new Date(2026, 2, 1);
    const localFeb29Leap = new Date(2028, 1, 29);
    const localDec31 = new Date(2026, 11, 31);

    expect(toCalendarDate(localMarch1)).toBe('2026-03-01');
    expect(toCalendarDate(localFeb29Leap)).toBe('2028-02-29');
    expect(toCalendarDate(localDec31)).toBe('2026-12-31');
    expect(toCalendarDate('2026-03-01')).toBe('2026-03-01');
    expect(toCalendarDate('2026-03-01T00:00:00.000Z')).toBe('2026-03-01');
    expect(toCalendarDate(null)).toBe('');
  });

  it('resolves business calendar date according to company IANA timezone across UTC midnight', () => {
    const lateUtc = new Date('2026-03-01T22:30:00.000Z');
    // 22:30Z on March 1 is 00:30 next day in Africa/Cairo (UTC+2)
    expect(getBusinessDateToday('Africa/Cairo', lateUtc)).toBe('2026-03-02');
    // Still March 1 in UTC and America/New_York
    expect(getBusinessDateToday('UTC', lateUtc)).toBe('2026-03-01');
    expect(getBusinessDateToday('America/New_York', lateUtc)).toBe('2026-03-01');

    const earlyUtc = new Date('2026-03-02T03:30:00.000Z');
    expect(getBusinessDateToday('Africa/Cairo', earlyUtc)).toBe('2026-03-02');
    expect(getBusinessDateToday('America/New_York', earlyUtc)).toBe('2026-03-01');

    expect(getBusinessDateToday(null, lateUtc)).toBe('2026-03-02');
    expect(getBusinessDateToday('Invalid/Zone', lateUtc)).toBe('2026-03-02');
  });

  it('reads company_settings timezone and falls back safely to Africa/Cairo', async () => {
    const txNy = {
      query: vi.fn().mockResolvedValue({ rows: [{ timezone: 'America/New_York' }] }),
    } as any;
    expect(await resolveCompanyTimeZone('comp-1', txNy)).toBe('America/New_York');
    expect(
      await resolveCompanyToday('comp-1', txNy, new Date('2026-03-02T03:30:00.000Z'))
    ).toBe('2026-03-01');

    const txEmpty = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as any;
    expect(await resolveCompanyTimeZone('comp-2', txEmpty)).toBe(DEFAULT_BUSINESS_TIMEZONE);
    expect(
      await resolveCompanyToday('comp-2', txEmpty, new Date('2026-03-01T22:30:00.000Z'))
    ).toBe('2026-03-02');
  });

  it('computes exact integer calendar day differences and local browser today string', () => {
    expect(diffCalendarDays('2026-03-10', '2026-03-01')).toBe(9);
    expect(diffCalendarDays('2026-03-01', '2026-03-10')).toBe(-9);
    expect(diffCalendarDays('2028-03-01', '2028-02-28')).toBe(2);

    expect(getLocalTodayDateString(new Date(2026, 2, 1, 23, 59, 0))).toBe('2026-03-01');
    expect(getLocalTodayDateString(new Date(2028, 1, 29, 0, 5, 0))).toBe('2028-02-29');
  });
});
