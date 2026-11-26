import { describe, it, expect } from 'vitest';
import { balanceAsOf, buildPeriodReport, availableAfterReservation, signedAmount } from '../custodyPeriodReport.js';
import type { CustodyMovement } from '../cashTypes.js';

let n = 0;
const mv = (movementType: CustodyMovement['movementType'], amount: number, at: string): CustodyMovement => ({
  id: `m${++n}`, companyId: 'c', custodyId: 'k', registerId: 'r', movementType, direction: 'none', amount,
  expenseAccountId: null, journalEntryId: null, memo: null, createdBy: null, createdAt: at,
});
const base = [
  mv('disburse', 50000, '2026-11-01T09:00:00Z'),
  mv('topup', 10000, '2026-11-03T09:00:00Z'),
  mv('settle_expense', 3500, '2026-11-05T09:00:00Z'),
  mv('reverse', 3500, '2026-11-06T09:00:00Z'),
  mv('settle_expense', 8000, '2026-11-08T09:00:00Z'),
  mv('shortage_repay', 500, '2026-11-09T09:00:00Z'),
  mv('settle_return', 1000, '2026-11-10T09:00:00Z'),
];

describe('custody period report', () => {
  it('signs each movement type', () => {
    expect(signedAmount(base[0])).toBe(50000);
    expect(signedAmount(base[2])).toBe(-3500);
    expect(signedAmount(base[3])).toBe(3500);
  });
  it('closing equals opening + in - out for the whole history', () => {
    const r = buildPeriodReport(base, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-30T00:00:00Z'));
    expect(r.opening).toBe(0);
    expect(r.totalIn).toBe(63500);
    expect(r.totalOut).toBe(13000);
    expect(r.closing).toBe(50500);
    expect(r.rows[r.rows.length - 1].runningBalance).toBe(r.closing);
  });
  it('a consume followed by its reversal leaves closing unchanged (CustodyFlow bug case)', () => {
    const only = [mv('disburse', 50000, '2026-11-01T00:00:00Z'), mv('settle_expense', 3500, '2026-11-02T00:00:00Z'), mv('reverse', 3500, '2026-11-03T00:00:00Z')];
    const r = buildPeriodReport(only, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-30T00:00:00Z'));
    expect(r.totalIn).toBe(53500);
    expect(r.totalOut).toBe(3500);
    expect(r.closing).toBe(50000);
  });
  it('opening of a later period is the closing of the earlier one', () => {
    const a = buildPeriodReport(base, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-05T23:59:59Z'));
    const b = buildPeriodReport(base, new Date('2026-11-06T00:00:00Z'), new Date('2026-11-30T00:00:00Z'));
    expect(b.opening).toBe(a.closing);
    expect(b.closing).toBe(50500);
  });
  it('balanceAsOf matches the report closing at the same instant', () => {
    const at = new Date('2026-11-08T12:00:00Z');
    const r = buildPeriodReport(base, new Date('2026-11-01T00:00:00Z'), at);
    expect(balanceAsOf(base, at)).toBe(r.closing);
    expect(balanceAsOf(base, new Date('2026-10-31T00:00:00Z'))).toBe(0);
  });
  it('rejects an inverted period and avoids float drift', () => {
    expect(() => buildPeriodReport(base, new Date('2026-12-01'), new Date('2026-11-01'))).toThrow();
    const f = [mv('disburse', 0.1, '2026-11-01T00:00:00Z'), mv('topup', 0.2, '2026-11-01T00:00:01Z')];
    expect(balanceAsOf(f, new Date('2026-11-02'))).toBe(0.3);
  });
  it('reservation reduces available without touching remaining', () => {
    expect(availableAfterReservation(50500, 8000)).toEqual({ remaining: 50500, reserved: 8000, available: 42500 });
    expect(availableAfterReservation(100, -5).reserved).toBe(0);
  });
});
