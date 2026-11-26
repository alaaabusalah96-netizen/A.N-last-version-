/**
 * Ageing of outstanding custody shortage claims, per employee. Read-only, derived.
 * Buckets by days since the claim was created: 0-30, 31-60, 61-90, over 90.
 */
export interface AgeingClaimInput {
  employeeUserId: string;
  employeeUsername: string;
  claimId: string;
  createdAt: string;
  outstanding: number;
}

export interface AgeingRow {
  employeeUserId: string;
  employeeUsername: string;
  b0_30: number;
  b31_60: number;
  b61_90: number;
  over90: number;
  total: number;
  claims: number;
  oldestDays: number;
}

const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function daysBetween(fromIso: string, to: Date): number {
  const d = Math.floor((to.getTime() - new Date(fromIso).getTime()) / 86400000);
  return d < 0 ? 0 : d;
}

export function buildShortageAgeing(claims: AgeingClaimInput[], asOf: Date): { rows: AgeingRow[]; total: number } {
  const byEmp = new Map<string, AgeingRow>();
  for (const c of claims) {
    if (!(c.outstanding > 0)) continue;
    const days = daysBetween(c.createdAt, asOf);
    let r = byEmp.get(c.employeeUserId);
    if (!r) {
      r = { employeeUserId: c.employeeUserId, employeeUsername: c.employeeUsername, b0_30: 0, b31_60: 0, b61_90: 0, over90: 0, total: 0, claims: 0, oldestDays: 0 };
      byEmp.set(c.employeeUserId, r);
    }
    if (days <= 30) r.b0_30 = cents(r.b0_30 + c.outstanding);
    else if (days <= 60) r.b31_60 = cents(r.b31_60 + c.outstanding);
    else if (days <= 90) r.b61_90 = cents(r.b61_90 + c.outstanding);
    else r.over90 = cents(r.over90 + c.outstanding);
    r.total = cents(r.total + c.outstanding);
    r.claims += 1;
    r.oldestDays = Math.max(r.oldestDays, days);
  }
  const rows = [...byEmp.values()].sort((a, b) => b.total - a.total || a.employeeUsername.localeCompare(b.employeeUsername));
  return { rows, total: cents(rows.reduce((s, r) => s + r.total, 0)) };
}
