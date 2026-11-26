/**
 * Custody period report and point-in-time balance.
 * Read-only and derived from the append-only custody_movements rows. Nothing here writes or posts.
 * Rule: closing = opening + in - out, for any period and after any reversal.
 */
import type { CustodyMovement } from './cashTypes.js';

type MovementType = CustodyMovement['movementType'];

/** Effect of each movement type on the custody balance still in the employee's hands. */
const SIGN: Record<MovementType, 1 | -1> = {
  disburse: 1,
  topup: 1,
  reverse: 1, // reversing an approved expense gives the amount back to the custody
  settle_expense: -1,
  settle_return: -1,
  shortage_repay: -1,
};

export interface PeriodReportRow {
  movementType: MovementType;
  signedAmount: number;
  createdAt: string;
  memo: string | null;
  runningBalance: number;
}

export interface CustodyPeriodReport {
  from: string;
  to: string;
  opening: number;
  totalIn: number;
  totalOut: number;
  closing: number;
  byType: Partial<Record<MovementType, number>>;
  rows: PeriodReportRow[];
}

const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function signedAmount(m: Pick<CustodyMovement, 'movementType' | 'amount'>): number {
  return cents(SIGN[m.movementType] * m.amount);
}

/** Balance of the custody at an instant: every movement created at or before `asOf`. */
export function balanceAsOf(movements: CustodyMovement[], asOf: Date): number {
  const t = asOf.getTime();
  let sum = 0;
  for (const m of movements) {
    if (new Date(m.createdAt).getTime() <= t) sum += signedAmount(m);
  }
  return cents(sum);
}

/** Period is [from, to] inclusive. Opening is the balance just before `from`. */
export function buildPeriodReport(movements: CustodyMovement[], from: Date, to: Date): CustodyPeriodReport {
  if (!(from.getTime() <= to.getTime())) throw new Error('from must not be after to');
  const sorted = [...movements].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id)
  );
  const f = from.getTime();
  const t = to.getTime();
  let opening = 0;
  let totalIn = 0;
  let totalOut = 0;
  const byType: Partial<Record<MovementType, number>> = {};
  const rows: PeriodReportRow[] = [];
  let running = 0;
  for (const m of sorted) {
    const ts = new Date(m.createdAt).getTime();
    const s = signedAmount(m);
    if (ts < f) {
      opening += s;
      running += s;
      continue;
    }
    if (ts > t) continue;
    running = cents(running + s);
    if (s >= 0) totalIn += s;
    else totalOut += -s;
    byType[m.movementType] = cents((byType[m.movementType] || 0) + s);
    rows.push({ movementType: m.movementType, signedAmount: s, createdAt: m.createdAt, memo: m.memo, runningBalance: running });
  }
  opening = cents(opening);
  totalIn = cents(totalIn);
  totalOut = cents(totalOut);
  return { from: from.toISOString(), to: to.toISOString(), opening, totalIn, totalOut, closing: cents(opening + totalIn - totalOut), byType, rows };
}

/** Available = remaining - amount reserved by vouchers still waiting for approval. Display only: no accounting entry. */
export function availableAfterReservation(remaining: number, pendingVoucherTotal: number): { remaining: number; reserved: number; available: number } {
  const reserved = cents(Math.max(0, pendingVoucherTotal));
  return { remaining: cents(remaining), reserved, available: cents(remaining - reserved) };
}
