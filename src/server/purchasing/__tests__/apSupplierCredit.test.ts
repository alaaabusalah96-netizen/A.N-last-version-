import { describe, it, expect } from 'vitest';
import { computeApOpenAmounts } from '../apOpenItemsService.js';

describe('AP open items supplier credit', () => {
  it('reports a supplier credit when a return follows full payment', () => {
    const r = computeApOpenAmounts('100.00', '30.00', '100.00');
    expect(r.remainingOpenAmount).toBe(0);
    expect(r.supplierCreditAmount).toBe(30);
    expect(r.paymentStatus).toBe('paid');
  });
  it('reports no credit for a partially paid invoice', () => {
    const r = computeApOpenAmounts('100.00', '0', '40.00');
    expect(r.supplierCreditAmount).toBe(0);
    expect(r.remainingOpenAmount).toBe(60);
  });
});
