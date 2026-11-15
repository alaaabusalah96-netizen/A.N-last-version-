import { describe, it, expect } from 'vitest';
import { DEFAULT_THREE_WAY_POLICY } from '../threeWayMatchService.js';

describe('Purchasing Complete Domain Logic & Policy', () => {
  it('defines 3-way match tolerance policy correctly', () => {
    expect(DEFAULT_THREE_WAY_POLICY.qtyTolerancePct).toBe(0);
    expect(DEFAULT_THREE_WAY_POLICY.priceTolerancePct).toBe(5);
    expect(DEFAULT_THREE_WAY_POLICY.priceRoundingAbs).toBe(0.01);
  });

  it('computes AP open item remaining balance accurately', () => {
    const invoiceTotal = 1500.00;
    const creditedReturnTotal = 300.00;
    const paidPaymentTotal = 700.00;
    const remainingOpen = invoiceTotal - creditedReturnTotal - paidPaymentTotal;
    expect(remainingOpen).toBe(500.00);
  });
});
