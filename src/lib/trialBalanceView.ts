/**
 * Maps the trial balance API reply ({ status, summary: { rows, grandTotalDebit, ... } })
 * to the shape the screen renders. Missing or non-numeric amounts become 0, so the
 * screen can never crash on a missing field.
 */
export interface TrialBalanceViewRow {
  accountId: string;
  code: string;
  nameAr: string;
  accountType: string;
  totalDebit: number;
  totalCredit: number;
  netBalance: number;
}

export interface TrialBalanceView {
  accounts: TrialBalanceViewRow[];
  grandTotalDebit: number;
  grandTotalCredit: number;
  isBalanced: boolean;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function normalizeTrialBalance(body: any): TrialBalanceView {
  const src = body && typeof body === 'object' ? (body.summary && typeof body.summary === 'object' ? body.summary : body) : {};
  const rawRows: any[] = Array.isArray(src.rows) ? src.rows : Array.isArray(src.accounts) ? src.accounts : [];
  const accounts = rawRows.map((r) => ({
    accountId: String(r?.accountId ?? ''),
    code: String(r?.accountCode ?? r?.code ?? ''),
    nameAr: String(r?.accountNameAr ?? r?.nameAr ?? ''),
    accountType: String(r?.accountType ?? ''),
    totalDebit: num(r?.totalDebit),
    totalCredit: num(r?.totalCredit),
    netBalance: num(r?.netBalance),
  }));
  const sumD = accounts.reduce((s, r) => s + r.totalDebit, 0);
  const sumC = accounts.reduce((s, r) => s + r.totalCredit, 0);
  const gd = src.grandTotalDebit === undefined ? sumD : num(src.grandTotalDebit);
  const gc = src.grandTotalCredit === undefined ? sumC : num(src.grandTotalCredit);
  return {
    accounts,
    grandTotalDebit: gd,
    grandTotalCredit: gc,
    isBalanced: typeof src.isBalanced === 'boolean' ? src.isBalanced : Math.round(gd * 100) === Math.round(gc * 100),
  };
}
