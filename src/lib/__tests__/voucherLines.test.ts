import { describe, it, expect } from 'vitest';
import { sumLinesMoney, linesReady, toPayloadLines, draftFromVoucher, emptyLine } from '../voucherLines.js';

describe('voucher lines draft', () => {
  it('sums in cents without float drift', () => {
    expect(sumLinesMoney([{ account: 'a', amount: '0.1', memo: '' }, { account: 'b', amount: '0.2', memo: '' }])).toBe(0.3);
    expect(sumLinesMoney([{ account: 'a', amount: 'x', memo: '' }, { account: 'b', amount: '-5', memo: '' }])).toBe(0);
  });
  it('is ready only with account and a positive 2-decimal amount on every line', () => {
    expect(linesReady([])).toBe(false);
    expect(linesReady([emptyLine()])).toBe(false);
    expect(linesReady([{ account: 'a', amount: '10.5', memo: '' }])).toBe(true);
    expect(linesReady([{ account: 'a', amount: '10.555', memo: '' }])).toBe(false);
    expect(linesReady([{ account: 'a', amount: '10', memo: '' }, { account: '', amount: '5', memo: '' }])).toBe(false);
    expect(linesReady([{ account: 'a', amount: '0', memo: '' }])).toBe(false);
  });
  it('builds the payload and copies a rejected voucher back into a draft', () => {
    expect(toPayloadLines([{ account: 'a', amount: ' 7 ', memo: ' ' }])).toEqual([{ expenseAccountId: 'a', amount: '7', memo: null }]);
    expect(draftFromVoucher([{ expenseAccountId: 'a', amount: 7, memo: null }, { expenseAccountId: 'b', amount: 2.5, memo: 'x' }]))
      .toEqual([{ account: 'a', amount: '7.00', memo: '' }, { account: 'b', amount: '2.50', memo: 'x' }]);
  });
});
