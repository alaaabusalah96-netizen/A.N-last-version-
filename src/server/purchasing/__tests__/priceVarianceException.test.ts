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

    // Sensitive to price/qty change
    const linesModified = [
      { itemId: 'item-1', grnLineId: 'grn-l-1', qty: 10, unitCost: 115 },
      { itemId: 'item-2', grnLineId: 'grn-l-2', qty: 5, unitCost: 220 },
    ];
    const fpModified = defaultPriceVarianceExceptionRepository.computeFingerprint('comp-1', 'inv-1', 'sup-1', linesModified);
    expect(fpModified).not.toBe(fp1);
  });

  it('enforces SoD check on approve (approver cannot be requester)', async () => {
    const mockRepo = {
      findById: async () => ({
        id: 'exc-1',
        companyId: 'comp-1',
        invoiceId: 'inv-1',
        supplierId: 'sup-1',
        status: 'pending',
        requestedBy: 'user-alice',
      }),
      findByIdForUpdate: async () => ({
        id: 'exc-1',
        companyId: 'comp-1',
        invoiceId: 'inv-1',
        supplierId: 'sup-1',
        status: 'pending',
        requestedBy: 'user-alice',
        fingerprint: 'fp-1',
      }),
      updateStatus: async () => ({}),
    } as any;

    const mockInvoiceRepo = {
      findByIdForUpdate: async () => ({
        id: 'inv-1',
        companyId: 'comp-1',
        status: 'draft',
        lines: [],
      }),
    } as any;
    const mockThreeWay = {} as any;
    const mockAudit = { record: async () => {} } as any;

    const service = new PriceVarianceExceptionService(mockRepo, mockInvoiceRepo, mockThreeWay, mockAudit);

    await expect(
      service.approveException('comp-1', 'exc-1', 'Approved', 'user-alice')
    ).rejects.toThrow(ValidationError);
  });

  it('enforces SoD check on reject (requester cannot reject their own request)', async () => {
    const mockRepo = {
      findById: async () => ({
        id: 'exc-1',
        companyId: 'comp-1',
        invoiceId: 'inv-1',
        supplierId: 'sup-1',
        status: 'pending',
        requestedBy: 'user-alice',
      }),
      findByIdForUpdate: async () => ({
        id: 'exc-1',
        companyId: 'comp-1',
        invoiceId: 'inv-1',
        supplierId: 'sup-1',
        status: 'pending',
        requestedBy: 'user-alice',
      }),
      updateStatus: async () => ({}),
    } as any;

    const mockInvoiceRepo = {
      findByIdForUpdate: async () => ({
        id: 'inv-1',
        companyId: 'comp-1',
        status: 'draft',
      }),
    } as any;
    const mockThreeWay = {} as any;
    const mockAudit = { record: async () => {} } as any;

    const service = new PriceVarianceExceptionService(mockRepo, mockInvoiceRepo, mockThreeWay, mockAudit);

    await expect(
      service.rejectException('comp-1', 'exc-1', 'Rejected', 'user-alice')
    ).rejects.toThrow(ValidationError);
  });

  it('enforces unified lock order: invoice first, then exception second', async () => {
    const lockOrder: string[] = [];

    const mockRepo = {
      findById: async () => ({
        id: 'exc-1',
        companyId: 'comp-1',
        invoiceId: 'inv-1',
        supplierId: 'sup-1',
        status: 'pending',
        requestedBy: 'user-alice',
      }),
      findByIdForUpdate: async () => {
        lockOrder.push('lock-exception');
        return {
          id: 'exc-1',
          companyId: 'comp-1',
          invoiceId: 'inv-1',
          supplierId: 'sup-1',
          status: 'pending',
          requestedBy: 'user-alice',
        };
      },
      updateStatus: async () => ({ id: 'exc-1', status: 'rejected' }),
    } as any;

    const mockInvoiceRepo = {
      findByIdForUpdate: async () => {
        lockOrder.push('lock-invoice');
        return {
          id: 'inv-1',
          companyId: 'comp-1',
          status: 'draft',
        };
      },
    } as any;

    const mockThreeWay = {} as any;
    const mockAudit = { record: async () => {} } as any;

    const service = new PriceVarianceExceptionService(mockRepo, mockInvoiceRepo, mockThreeWay, mockAudit);

    // Run reject with a different actor (user-bob)
    await service.rejectException('comp-1', 'exc-1', 'Reason', 'user-bob');

    expect(lockOrder).toEqual(['lock-invoice', 'lock-exception']);
  });

  it('durable supersede: persists superseded status and throws ValidationError without rolling back', async () => {
    let persistedStatus: string | null = null;
    let persistedReason: string | null = null;
    let auditRecorded = false;

    const mockRepo = {
      findById: async () => ({
        id: 'exc-1',
        companyId: 'comp-1',
        invoiceId: 'inv-1',
        supplierId: 'sup-1',
        status: 'pending',
        requestedBy: 'user-alice',
      }),
      findByIdForUpdate: async () => ({
        id: 'exc-1',
        companyId: 'comp-1',
        invoiceId: 'inv-1',
        supplierId: 'sup-1',
        status: 'pending',
        requestedBy: 'user-alice',
        fingerprint: 'stale-fingerprint',
      }),
      computeFingerprint: () => 'fresh-fingerprint',
      updateStatus: async (_comp: string, _excId: string, status: string, _actor: string, reason: string) => {
        persistedStatus = status;
        persistedReason = reason;
        return { id: 'exc-1', status };
      },
    } as any;

    const mockInvoiceRepo = {
      findByIdForUpdate: async () => ({
        id: 'inv-1',
        companyId: 'comp-1',
        supplierId: 'sup-1',
        status: 'draft',
        lines: [{ id: 'line-1', itemId: 'it-1', grnLineId: 'grn-1', qty: 10, unitCost: 120 }],
      }),
    } as any;

    const mockThreeWay = {
      evaluateInvoice: async () => ({
        hasQtyExceeded: false,
        lines: [{ grnLineId: 'grn-1', invoiceQty: 10, grnQty: 10, qtyExceeded: false, priceExceeded: true, priceVariancePct: 10 }],
      }),
    } as any;

    const mockAudit = {
      record: async (payload: any) => {
        if (payload.action === 'PURCHASING_VARIANCE_SUPERSEDE') {
          auditRecorded = true;
        }
      },
    } as any;

    const service = new PriceVarianceExceptionService(mockRepo, mockInvoiceRepo, mockThreeWay, mockAudit);

    await expect(
      service.approveException('comp-1', 'exc-1', 'Approve reason', 'user-bob')
    ).rejects.toThrow(ValidationError);

    expect(persistedStatus).toBe('superseded');
    expect(persistedReason).toBe('تغيرت بنود الفاتورة أو أسعارها بعد تقديم طلب الاستثناء');
    expect(auditRecorded).toBe(true);
  });
});
