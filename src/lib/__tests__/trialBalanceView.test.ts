import { describe, it, expect } from 'vitest';
import { normalizeTrialBalance } from '../trialBalanceView.js';

describe('normalizeTrialBalance', () => {
  it('maps the real API reply (status + summary.rows with accountCode/accountNameAr)', () => {
    const v = normalizeTrialBalance({
      status: 'ok',
      summary: {
        rows: [
          { accountId: 'a1', accountCode: '1100', accountNameAr: 'الصندوق', accountType: 'asset', totalDebit: 100, totalCredit: 0, netBalance: 100 },
          { accountId: 'a2', accountCode: '4100', accountNameAr: 'إيراد', accountType: 'revenue', totalDebit: 0, totalCredit: 100, netBalance: -100 },
        ],
        grandTotalDebit: 100, grandTotalCredit: 100, isBalanced: true,
      },
    });
    expect(v.accounts).toHaveLength(2);
    expect(v.accounts[0].code).toBe('1100');
    expect(v.accounts[0].nameAr).toBe('الصندوق');
    expect(v.grandTotalDebit.toFixed(2)).toBe('100.00');
    expect(v.isBalanced).toBe(true);
  });
  it('never yields undefined amounts (the toFixed crash)', () => {
    for (const body of [undefined, null, {}, { status: 'ok' }, { summary: {} }, { summary: { rows: [{ accountId: 'x' }] } }]) {
      const v = normalizeTrialBalance(body);
      expect(typeof v.grandTotalDebit.toFixed(2)).toBe('string');
      expect(typeof v.grandTotalCredit.toFixed(2)).toBe('string');
      for (const r of v.accounts) {
        expect(typeof r.totalDebit.toFixed(2)).toBe('string');
        expect(typeof r.netBalance.toFixed(2)).toBe('string');
      }
    }
  });
  it('computes totals from rows when the grand totals are missing', () => {
    const v = normalizeTrialBalance({ summary: { rows: [{ totalDebit: 5, totalCredit: 0 }, { totalDebit: 0, totalCredit: 5 }] } });
    expect(v.grandTotalDebit).toBe(5);
    expect(v.grandTotalCredit).toBe(5);
    expect(v.isBalanced).toBe(true);
  });
});
