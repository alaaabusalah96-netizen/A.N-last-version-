export interface VoucherLineDraft { account: string; amount: string; memo: string }

export const emptyLine = (): VoucherLineDraft => ({ account: '', amount: '', memo: '' });

/** Sum of valid amounts in cents to avoid float drift. Invalid or non-positive amounts count as 0. */
export function sumLinesMoney(lines: VoucherLineDraft[]): number {
  let cents = 0;
  for (const l of lines) {
    const n = Number(String(l.amount).trim());
    if (Number.isFinite(n) && n > 0) cents += Math.round(n * 100);
  }
  return cents / 100;
}

/** True when every line has an account and a positive amount with at most 2 decimals. */
export function linesReady(lines: VoucherLineDraft[]): boolean {
  if (lines.length === 0) return false;
  return lines.every((l) => {
    const raw = String(l.amount).trim();
    const n = Number(raw);
    const dec = raw.split('.')[1];
    return l.account !== '' && raw !== '' && Number.isFinite(n) && n > 0 && (!dec || dec.length <= 2);
  });
}

export function toPayloadLines(lines: VoucherLineDraft[]) {
  return lines.map((l) => ({ expenseAccountId: l.account, amount: l.amount.trim(), memo: l.memo.trim() || null }));
}

/** Copy the lines of a rejected voucher into a new draft so the user can fix and resubmit. */
export function draftFromVoucher(lines: { expenseAccountId: string; amount: number; memo: string | null }[]): VoucherLineDraft[] {
  return lines.map((l) => ({ account: l.expenseAccountId, amount: l.amount.toFixed(2), memo: l.memo || '' }));
}
