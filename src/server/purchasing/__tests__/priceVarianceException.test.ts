import { describe, it, expect, vi } from 'vitest';
import { defaultPriceVarianceExceptionRepository } from '../priceVarianceExceptionRepository.js';
import { PriceVarianceExceptionService } from '../priceVarianceExceptionService.js';
import { ValidationError } from '../../http/errors.js';

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn((_companyId, callback) => callback({} as any)),
}));

describe('Price Variance Exception Unit Tests', () => {
  it('computes stable deterministic fingerprint for invoice lines', () => {
    const lines1 = [
      { itemId: 'item-1', grnLineId: 'grn-l-1', qty: 10, unitCost: 110 },
      { itemId: 'item-2', grnLineId: 'grn-l-2', qty: 5, unitCost: 220 },
    ];
    const lines2 = [
      { itemId: 'item-2', grnLineId: 'grn-l-2', qty: 5, unitCost: 220 },
      { itemId: 'item-1', grnLineId: 'grn-l-1', qty: 10, unitCost: 110 },
    ];

    const fp1 = defaultPriceVarianceExceptionRepository.computeFingerprint('comp-1', 'inv-1', 'sup-1', lines1);
    const fp2 = defaultPriceVarianceExceptionRepository.computeFingerprint('comp-1', 'inv-1', 'sup-1', lines2);

    expect(fp1).toBe(fp2);
    expect(typeof fp1).toBe('string');
    expect(fp1.length).toBe(64); // SHA-256 hex
  });

  it('enforces SoD check (approver cannot be requester)', async () => {
    const mockRepo = {
      findByIdForUpdate: async () => ({
        id: 'exc-1',
        companyId: 'comp-1',
        invoiceId: 'inv-1',
        supplierId: 'sup-1',
        status: 'pending',
        requestedBy: 'user-alice',
        approvedBy: null,
        rejectedBy: null,
        reason: 'Price test',
        fingerprint: 'fp-1',
        snapshot: {},
        maxVariancePc: 5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      updateStatus: async () => ({}),
    } as any;

    const mockInvoiceRepo = {} as any;
    const mockThreeWay = {} as any;
    const mockAudit = { record: async () => {} } as any;

    const service = new PriceVarianceExceptionService(mockRepo, mockInvoiceRepo, mockThreeWay, mockAudit);

    await expect(
      service.approveException('comp-1', 'exc-1', 'Approved', 'user-alice')
    ).rejects.toThrow(ValidationError);
  });
});
