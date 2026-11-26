import { describe, it, expect } from 'vitest';
import { buildCustodyVoucherHtml } from '../custodyVoucherPrint.js';

const v = { voucherNo: 'V-1', status: 'approved', totalAmount: 1500.5, memo: null, lines: [{ expenseAccountName: 'وقود <b>', amount: 1500.5, memo: 'x&y' }] };
describe('custody voucher print', () => {
  it('includes number, total, words and escapes text', () => {
    const h = buildCustodyVoucherHtml(v, 'شركة <س>', new Date('2026-11-26T00:00:00Z'));
    expect(h).toContain('V-1');
    expect(h).toContain('1500.50');
    expect(h).toContain('فقط ألف وخمسمائة جنيهاً مصرياً وخمسون قرشاً لا غير');
    expect(h).toContain('وقود &lt;b&gt;');
    expect(h).toContain('x&amp;y');
    expect(h).not.toContain('<b>وقود');
    expect(h).toContain('2026-11-26');
  });
  it('refuses a voucher that is not approved', () => {
    expect(() => buildCustodyVoucherHtml({ ...v, status: 'submitted' }, 'ش')).toThrow();
    expect(() => buildCustodyVoucherHtml({ ...v, status: 'rejected' }, 'ش')).toThrow();
    expect(() => buildCustodyVoucherHtml({ ...v, status: 'reversed' }, 'ش')).toThrow();
  });
});
