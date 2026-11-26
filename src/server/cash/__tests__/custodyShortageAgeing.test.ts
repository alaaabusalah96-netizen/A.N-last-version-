import { describe, it, expect } from 'vitest';
import { buildShortageAgeing, daysBetween } from '../custodyShortageAgeing.js';

const asOf = new Date('2026-11-26T00:00:00Z');
const c = (emp: string, id: string, created: string, outstanding: number) => ({ employeeUserId: emp, employeeUsername: emp, claimId: id, createdAt: created, outstanding });

describe('shortage ageing', () => {
  it('buckets by age and ignores fully paid claims', () => {
    const r = buildShortageAgeing([
      c('a', '1', '2026-11-20T00:00:00Z', 100),
      c('a', '2', '2026-10-10T00:00:00Z', 50.5),
      c('a', '3', '2026-09-20T00:00:00Z', 25),
      c('a', '4', '2026-06-01T00:00:00Z', 10),
      c('a', '5', '2026-06-01T00:00:00Z', 0),
      c('b', '6', '2026-11-25T00:00:00Z', 1000),
    ], asOf);
    const a = r.rows.find((x) => x.employeeUserId === 'a')!;
    expect(a.b0_30).toBe(100);
    expect(a.b31_60).toBe(50.5);
    expect(a.b61_90).toBe(25);
    expect(a.over90).toBe(10);
    expect(a.total).toBe(185.5);
    expect(a.claims).toBe(4);
    expect(r.rows[0].employeeUserId).toBe('b');
    expect(r.total).toBe(1185.5);
  });
  it('boundaries: day 30 is in 0-30, day 31 in 31-60, day 91 over 90; future claim is age 0', () => {
    expect(daysBetween('2026-10-27T00:00:00Z', asOf)).toBe(30);
    const r = buildShortageAgeing([c('a', '1', '2026-10-27T00:00:00Z', 1), c('a', '2', '2026-10-26T00:00:00Z', 2), c('a', '3', '2026-08-27T00:00:00Z', 4), c('a', '4', '2027-01-01T00:00:00Z', 8)], asOf);
    const a = r.rows[0];
    expect(a.b0_30).toBe(9);
    expect(a.b31_60).toBe(2);
    expect(a.over90).toBe(4);
  });
});
