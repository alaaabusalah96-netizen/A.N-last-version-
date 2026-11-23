import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  defaultPriceVarianceExceptionRepository,
  PriceVarianceExceptionRepository,
} from '../priceVarianceExceptionRepository.js';
import { PriceVarianceExceptionService } from '../priceVarianceExceptionService.js';
import { InvoiceService } from '../invoiceService.js';
import { NotFoundError, ValidationError } from '../../http/errors.js';
import * as transactionManager from '../../db/transactionManager.js';

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn(async (_companyId: string, callback: (tx: any) => Promise<any>) => {
    return await callback({} as any);
  }),
}));

describe('Price Variance Exception Unit & Regression Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(transactionManager.withTenantTransaction).mockImplementation(
      async (_companyId: string, callback: (tx: any) => Promise<any>) => await callback({} as any)
    );
  });

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

  it('rejects missing or empty actorId on requestException, approveException, and rejectException', async () => {
    const service = new PriceVarianceExceptionService(
      {} as any,
      {} as any,
      {} as any,
      { record: async () => {} } as any
    );

    await expect(service.requestException('comp-1', 'inv-1', 'Reason', '')).rejects.toThrow(ValidationError);
    await expect(service.requestException('comp-1', 'inv-1', 'Reason', undefined)).rejects.toThrow(ValidationError);
    await expect(service.approveException('comp-1', 'exc-1', 'Ok', '')).rejects.toThrow(ValidationError);
    await expect(service.approveException('comp-1', 'exc-1', 'Ok', undefined)).rejects.toThrow(ValidationError);
    await expect(service.rejectException('comp-1', 'exc-1', 'No', '')).rejects.toThrow(ValidationError);
    await expect(service.rejectException('comp-1', 'exc-1', 'No', undefined)).rejects.toThrow(ValidationError);
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

  it('rejects approve/reject if requestedBy is null so SoD cannot be bypassed', async () => {
    const mockRepo = {
      findById: async () => ({
        id: 'exc-1',
        companyId: 'comp-1',
        invoiceId: 'inv-1',
        supplierId: 'sup-1',
        status: 'pending',
        requestedBy: null,
      }),
    } as any;
    const service = new PriceVarianceExceptionService(
      mockRepo,
      {} as any,
      {} as any,
      { record: async () => {} } as any
    );

    await expect(service.approveException('comp-1', 'exc-1', 'Ok', 'user-bob')).rejects.toThrow(ValidationError);
    await expect(service.rejectException('comp-1', 'exc-1', 'No', 'user-bob')).rejects.toThrow(ValidationError);
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

  it('blocks rejectException when linked invoice is already posted or cancelled', async () => {
    const mockRepo = {
      findById: async () => ({
        id: 'exc-1',
        companyId: 'comp-1',
        invoiceId: 'inv-1',
        supplierId: 'sup-1',
        status: 'pending',
        requestedBy: 'user-alice',
      }),
    } as any;

    const postedInvoiceRepo = {
      findByIdForUpdate: async () => ({ id: 'inv-1', companyId: 'comp-1', status: 'posted' }),
    } as any;
    const cancelledInvoiceRepo = {
      findByIdForUpdate: async () => ({ id: 'inv-1', companyId: 'comp-1', status: 'cancelled' }),
    } as any;

    const audit = { record: async () => {} } as any;
    await expect(
      new PriceVarianceExceptionService(mockRepo, postedInvoiceRepo, {} as any, audit).rejectException(
        'comp-1',
        'exc-1',
        'Too late',
        'user-bob'
      )
    ).rejects.toThrow(ValidationError);

    await expect(
      new PriceVarianceExceptionService(mockRepo, cancelledInvoiceRepo, {} as any, audit).rejectException(
        'comp-1',
        'exc-1',
        'Too late',
        'user-bob'
      )
    ).rejects.toThrow(ValidationError);
  });

  it('durable supersede: persists superseded status and throws ValidationError without rolling back', async () => {
    let committed = false;
    let persistedStatus: string | null = null;
    let persistedReason: string | null = null;
    let auditRecorded = false;

    vi.mocked(transactionManager.withTenantTransaction).mockImplementationOnce(async (_c, cb) => {
      const result = await cb({} as any);
      committed = true;
      return result;
    });

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

    expect(committed).toBe(true);
    expect(persistedStatus).toBe('superseded');
    expect(persistedReason).toBe('تغيرت بنود الفاتورة أو أسعارها بعد تقديم طلب الاستثناء');
    expect(auditRecorded).toBe(true);
  });

  it('prevents approve vs reject race by locking row and rejecting second concurrent decision', async () => {
    let excRow = {
      id: 'exc-race-1',
      companyId: 'comp-1',
      invoiceId: 'inv-1',
      supplierId: 'sup-1',
      status: 'pending' as 'pending' | 'approved' | 'rejected',
      requestedBy: 'user-requester',
      fingerprint: 'fp-match',
    };

    // Simple async mutex simulating PostgreSQL FOR UPDATE serialization on invoice/exception
    let mutexPromise = Promise.resolve();
    const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      const prev = mutexPromise;
      let release!: () => void;
      mutexPromise = new Promise<void>((res) => {
        release = res;
      });
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    };

    vi.mocked(transactionManager.withTenantTransaction).mockImplementation(async (_c, cb) => {
      return await withLock(() => cb({} as any));
    });

    const mockRepo = {
      findById: async () => ({ ...excRow }),
      findByIdForUpdate: async () => ({ ...excRow }),
      computeFingerprint: () => 'fp-match',
      updateStatus: async (_comp: string, _id: string, status: 'approved' | 'rejected') => {
        excRow = { ...excRow, status };
        return { ...excRow };
      },
    } as any;

    const mockInvoiceRepo = {
      findByIdForUpdate: async () => ({
        id: 'inv-1',
        companyId: 'comp-1',
        supplierId: 'sup-1',
        status: 'draft',
        lines: [{ id: 'l-1', itemId: 'item-1', grnLineId: 'grn-1', qty: 10, unitCost: 110 }],
      }),
    } as any;

    const mockThreeWay = {
      evaluateInvoice: async () => ({
        hasQtyExceeded: false,
        lines: [{ grnLineId: 'grn-1', invoiceQty: 10, grnQty: 10, qtyExceeded: false, priceVariancePct: 10 }],
      }),
    } as any;

    const service = new PriceVarianceExceptionService(
      mockRepo,
      mockInvoiceRepo,
      mockThreeWay,
      { record: async () => {} } as any
    );

    const [approveOutcome, rejectOutcome] = await Promise.allSettled([
      service.approveException('comp-1', 'exc-race-1', 'Approve wins', 'user-approver-1'),
      service.rejectException('comp-1', 'exc-race-1', 'Reject loses', 'user-approver-2'),
    ]);

    expect(approveOutcome.status).toBe('fulfilled');
    expect(rejectOutcome.status).toBe('rejected');
    expect((rejectOutcome as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);
    expect(excRow.status).toBe('approved');
  });

  it('serializes concurrent requests and supersedes prior pending/approved exceptions on new request', async () => {
    const queries: Array<{ sql: string; params: any[] }> = [];
    const mockTx = {
      query: vi.fn(async (sql: string, params: any[]) => {
        queries.push({ sql, params });
        return {
          rows: [
            {
              id: 'exc-new',
              companyId: 'comp-1',
              invoiceId: 'inv-1',
              supplierId: 'sup-1',
              status: 'pending',
              requestedBy: 'user-req',
              reason: 'Second request after approved',
              fingerprint: 'fp-1',
              maxVariancePc: 15,
            },
          ],
        };
      }),
    };

    const repo = new PriceVarianceExceptionRepository();
    const row = await repo.create(
      'comp-1',
      {
        invoiceId: 'inv-1',
        supplierId: 'sup-1',
        reason: 'Second request after approved',
        fingerprint: 'fp-1',
        snapshot: {},
        requestedBy: 'user-req',
        maxVariancePct: 15,
      },
      mockTx as any
    );

    expect(row.status).toBe('pending');
    expect(queries.length).toBe(2);
    expect(queries[0].sql).toContain("SET status = 'superseded'");
    expect(queries[0].sql).toContain("status IN ('pending', 'approved')");
    expect(queries[1].sql).toContain('INSERT INTO purch_price_variance_exceptions');

    // Also test concurrent service.requestException calls lock invoice FOR UPDATE first
    const events: string[] = [];
    let chain = Promise.resolve();
    const runSerialized = async <T>(fn: () => Promise<T>) => {
      const prev = chain;
      let unlock!: () => void;
      chain = new Promise<void>((res) => {
        unlock = res;
      });
      await prev;
      try {
        return await fn();
      } finally {
        unlock();
      }
    };
    vi.mocked(transactionManager.withTenantTransaction).mockImplementation(async (_c, cb) =>
      runSerialized(() => cb({} as any))
    );

    let reqCounter = 0;
    const mockRepoSvc = {
      computeFingerprint: () => 'fp-concurrent',
      create: async (_c: string, data: any) => {
        reqCounter += 1;
        events.push(`create-${reqCounter}`);
        return { id: `exc-${reqCounter}`, status: 'pending', reason: data.reason, requestedBy: data.requestedBy };
      },
    } as any;
    const mockInvRepoSvc = {
      findByIdForUpdate: async () => {
        events.push('lock-invoice');
        return {
          id: 'inv-1',
          supplierId: 'sup-1',
          supplierInvoiceNo: 'SINV-1',
          status: 'draft',
          lines: [{ id: 'l1', itemId: 'i1', grnLineId: 'g1', qty: 10, unitCost: 120 }],
        };
      },
    } as any;
    const mockMatchSvc = {
      evaluateInvoice: async () => ({
        overallStatus: 'variance_exceeded',
        hasQtyExceeded: false,
        lines: [{ grnLineId: 'g1', invoiceQty: 10, grnQty: 10, qtyExceeded: false, priceVariancePct: 20 }],
      }),
    } as any;

    const svc = new PriceVarianceExceptionService(
      mockRepoSvc,
      mockInvRepoSvc,
      mockMatchSvc,
      { record: async () => {} } as any
    );

    const [r1, r2] = await Promise.all([
      svc.requestException('comp-1', 'inv-1', 'Reason 1', 'user-1'),
      svc.requestException('comp-1', 'inv-1', 'Reason 2', 'user-2'),
    ]);
    expect(r1.id).toBe('exc-1');
    expect(r2.id).toBe('exc-2');
    expect(events).toEqual(['lock-invoice', 'create-1', 'lock-invoice', 'create-2']);
  });

  it('rolls back entire transaction when auditService.record fails on request, approve, reject, or supersede', async () => {
    const dbState = { committedWrites: 0 };
    vi.mocked(transactionManager.withTenantTransaction).mockImplementation(async (_c, cb) => {
      let stagedWrites = 0;
      const tx = { stagedWrite: () => { stagedWrites += 1; } } as any;
      const res = await cb(tx);
      dbState.committedWrites += stagedWrites;
      return res;
    });

    const failingAudit = {
      record: async () => {
        throw new Error('AUDIT_STORAGE_FAILURE');
      },
    } as any;

    const mockRepo = {
      computeFingerprint: () => 'fp-1',
      create: async (_c: string, _d: any, tx: any) => {
        tx.stagedWrite();
        return { id: 'exc-1', status: 'pending' };
      },
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
      updateStatus: async (_c: string, _id: string, status: string, _a: string, _r: string, tx: any) => {
        tx.stagedWrite();
        return { id: 'exc-1', status };
      },
    } as any;

    const mockInvRepo = {
      findByIdForUpdate: async () => ({
        id: 'inv-1',
        companyId: 'comp-1',
        supplierId: 'sup-1',
        supplierInvoiceNo: 'SINV-1',
        status: 'draft',
        lines: [{ id: 'l-1', itemId: 'it-1', grnLineId: 'g-1', qty: 10, unitCost: 120 }],
      }),
    } as any;

    const mockMatch = {
      evaluateInvoice: async () => ({
        overallStatus: 'variance_exceeded',
        hasQtyExceeded: false,
        lines: [{ grnLineId: 'g-1', invoiceQty: 10, grnQty: 10, qtyExceeded: false, priceVariancePct: 20 }],
      }),
    } as any;

    const service = new PriceVarianceExceptionService(mockRepo, mockInvRepo, mockMatch, failingAudit);

    await expect(service.requestException('comp-1', 'inv-1', 'Req reason', 'user-alice')).rejects.toThrow('AUDIT_STORAGE_FAILURE');
    await expect(service.approveException('comp-1', 'exc-1', 'App reason', 'user-bob')).rejects.toThrow('AUDIT_STORAGE_FAILURE');
    await expect(service.rejectException('comp-1', 'exc-1', 'Rej reason', 'user-bob')).rejects.toThrow('AUDIT_STORAGE_FAILURE');

    // Supersede branch when fingerprint mismatches & audit fails
    mockRepo.computeFingerprint = () => 'different-fp';
    await expect(service.approveException('comp-1', 'exc-1', 'App reason', 'user-bob')).rejects.toThrow('AUDIT_STORAGE_FAILURE');

    // Nothing should have been committed in any of the 4 cases
    expect(dbState.committedWrites).toBe(0);
  });

  it('marks expired fingerprint validity in listExceptions and blocks postInvoice when lines change after approval', async () => {
    const repo = new PriceVarianceExceptionRepository();
    const originalLines = [
      { invoiceLineId: 'l-1', itemId: 'item-1', grnLineId: 'grn-1', qty: 10, unitCost: 115, refUnitCost: 100 },
    ];
    const approvedFingerprint = repo.computeFingerprint('comp-1', 'inv-1', 'sup-1', originalLines);

    // 1. listExceptions after line cost edited to 130
    const service = new PriceVarianceExceptionService(
      {
        computeFingerprint: repo.computeFingerprint.bind(repo),
        listByInvoice: async () => [
          {
            id: 'exc-approved',
            companyId: 'comp-1',
            invoiceId: 'inv-1',
            supplierId: 'sup-1',
            status: 'approved',
            requestedBy: 'user-alice',
            approvedBy: 'user-bob',
            rejectedBy: null,
            reason: 'Approved for 115',
            decisionReason: 'Ok',
            fingerprint: approvedFingerprint,
            snapshot: {},
            maxVariancePc: 15,
            createdAt: '2026-11-20T10:00:00Z',
            updatedAt: '2026-11-20T10:05:00Z',
          },
          {
            id: 'exc-rejected',
            companyId: 'comp-1',
            invoiceId: 'inv-1',
            supplierId: 'sup-1',
            status: 'rejected',
            requestedBy: 'user-alice',
            approvedBy: null,
            rejectedBy: 'user-bob',
            reason: 'Earlier',
            decisionReason: 'Too high',
            fingerprint: 'old-fp',
            snapshot: {},
            maxVariancePc: 25,
            createdAt: '2026-11-19T10:00:00Z',
            updatedAt: '2026-11-19T10:05:00Z',
          },
        ],
      } as any,
      {
        findById: async () => ({
          id: 'inv-1',
          companyId: 'comp-1',
          supplierId: 'sup-1',
          status: 'draft',
          lines: [{ id: 'l-1', itemId: 'item-1', grnLineId: 'grn-1', qty: 10, unitCost: 130 }],
        }),
      } as any,
      {
        evaluateInvoice: async () => ({
          overallStatus: 'variance_exceeded',
          hasQtyExceeded: false,
          lines: [{ grnLineId: 'grn-1', grnUnitCost: 100, invoiceQty: 10, grnQty: 10, priceVariancePct: 30 }],
        }),
      } as any,
      { record: async () => {} } as any
    );

    const listed = await service.listExceptions('comp-1', 'inv-1');
    expect(listed).toHaveLength(2);
    expect(listed[0].isFingerprintValid).toBe(false);
    expect(listed[0].isExpired).toBe(true);
    // Terminal rejected state should NOT be marked as expired
    expect(listed[1].isExpired).toBe(false);

    // 2. Throws NotFoundError if invoice not in company
    const missingInvSvc = new PriceVarianceExceptionService(
      { computeFingerprint: repo.computeFingerprint.bind(repo), listByInvoice: async () => [] } as any,
      { findById: async () => null } as any,
      { evaluateInvoice: async () => ({ lines: [] }) } as any,
      { record: async () => {} } as any
    );
    await expect(missingInvSvc.listExceptions('comp-other', 'inv-1')).rejects.toThrow(NotFoundError);

    // 3. Fails loudly (never fail-open) if required fingerprint evaluation dependencies are missing
    const incompleteDepsSvc = new PriceVarianceExceptionService(
      { listByInvoice: async () => [{ id: 'exc-raw', status: 'approved' }] } as any,
      { findById: async () => ({ id: 'inv-1', companyId: 'comp-1', supplierId: 'sup-1', status: 'draft', lines: [{ id: 'l-1', itemId: 'item-1', grnLineId: 'grn-1', qty: 1, unitCost: 100 }] }) } as any,
      {} as any,
      { record: async () => {} } as any
    );
    await expect(incompleteDepsSvc.listExceptions('comp-1', 'inv-1')).rejects.toThrow();

    // 4. Invoice with empty lines explicitly marks pending/approved as invalid/expired (never undefined)
    const emptyLinesSvc = new PriceVarianceExceptionService(
      {
        computeFingerprint: repo.computeFingerprint.bind(repo),
        listByInvoice: async () => [
          {
            id: 'exc-empty-lines',
            companyId: 'comp-1',
            invoiceId: 'inv-1',
            supplierId: 'sup-1',
            status: 'approved',
            requestedBy: 'user-alice',
            approvedBy: 'user-bob',
            rejectedBy: null,
            reason: 'Old',
            decisionReason: 'Ok',
            fingerprint: approvedFingerprint,
            snapshot: {},
            maxVariancePc: 15,
            createdAt: '2026-11-20T10:00:00Z',
            updatedAt: '2026-11-20T10:05:00Z',
          },
        ],
      } as any,
      {
        findById: async () => ({ id: 'inv-1', companyId: 'comp-1', supplierId: 'sup-1', status: 'draft', lines: [] }),
      } as any,
      { evaluateInvoice: async () => ({ lines: [] }) } as any,
      { record: async () => {} } as any
    );
    const emptyLineRows = await emptyLinesSvc.listExceptions('comp-1', 'inv-1');
    expect(emptyLineRows[0].isFingerprintValid).toBe(false);
    expect(emptyLineRows[0].isExpired).toBe(true);

    // 3. InvoiceService.postInvoice rejects posting when lines changed after approval
    vi.spyOn(defaultPriceVarianceExceptionRepository, 'findActiveApprovedByInvoice').mockResolvedValueOnce({
      id: 'exc-approved',
      companyId: 'comp-1',
      invoiceId: 'inv-1',
      supplierId: 'sup-1',
      status: 'approved',
      requestedBy: 'user-alice',
      approvedBy: 'user-bob',
      rejectedBy: null,
      reason: 'Approved for 115',
      decisionReason: 'Ok',
      fingerprint: approvedFingerprint,
      snapshot: {},
      maxVariancePc: 15,
      createdAt: '2026-11-20T10:00:00Z',
      updatedAt: '2026-11-20T10:05:00Z',
    });
    vi.spyOn(defaultPriceVarianceExceptionRepository, 'findByIdForUpdate').mockResolvedValueOnce({
      id: 'exc-approved',
      companyId: 'comp-1',
      invoiceId: 'inv-1',
      supplierId: 'sup-1',
      status: 'approved',
      requestedBy: 'user-alice',
      approvedBy: 'user-bob',
      rejectedBy: null,
      reason: 'Approved for 115',
      decisionReason: 'Ok',
      fingerprint: approvedFingerprint,
      snapshot: {},
      maxVariancePc: 15,
      createdAt: '2026-11-20T10:00:00Z',
      updatedAt: '2026-11-20T10:05:00Z',
    });

    const editedInvoice = {
      id: 'inv-1',
      companyId: 'comp-1',
      supplierId: 'sup-1',
      supplierInvoiceNo: 'SINV-100',
      status: 'draft' as const,
      invoiceDate: '2026-11-20',
      lines: [
        {
          id: 'l-1',
          invoiceId: 'inv-1',
          companyId: 'comp-1',
          grnLineId: 'grn-1',
          itemId: 'item-1',
          qty: 10,
          unitCost: 130,
          lineNo: 1,
        },
      ],
    };

    const invService = new InvoiceService(
      {
        findByIdForUpdate: async () => editedInvoice,
        findById: async () => editedInvoice,
        lockGrnLinesAndGetPostedTotals: async () =>
          new Map([
            [
              'grn-1',
              {
                grnId: 'grn-hdr-1',
                grnStatus: 'posted',
                grnSupplierId: 'sup-1',
                warehouseId: 'wh-1',
                itemId: 'item-1',
                grnQty: 10,
                grnUnitCost: 100,
                postedQty: 0,
              },
            ],
          ]),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { record: async () => {} } as any,
      { resolveConfig: async () => { throw new NotFoundError('no config'); } } as any,
      {} as any,
      {
        evaluateInvoice: async () => ({
          invoiceId: 'inv-1',
          supplierInvoiceNo: 'SINV-100',
          overallStatus: 'variance_exceeded',
          hasQtyExceeded: false,
          hasPriceExceeded: true,
          policy: { qtyTolerancePct: 0, priceTolerancePct: 5, priceRoundingAbs: 0.01 },
          lines: [
            {
              grnLineId: 'grn-1',
              itemId: 'item-1',
              grnQty: 10,
              grnUnitCost: 100,
              invoiceQty: 10,
              invoiceUnitCost: 130,
              qtyVariance: 0,
              priceVariancePct: 30,
              status: 'variance_exceeded',
              messageAr: 'تجاوز السعر',
              qtyExceeded: false,
              priceExceeded: true,
            },
          ],
        }),
      } as any,
      {} as any
    );

    await expect(invService.postInvoice('comp-1', 'inv-1', 'user-bob')).rejects.toThrow(
      /تغيرت بنود أو أسعار فاتورة المورد بعد اعتماد الاستثناء/
    );
  });

  it('separates supersede_reason from decision_reason in repository create() and updateStatus()', async () => {
    const repo = new PriceVarianceExceptionRepository();
    const queries: Array<{ sql: string; params: any[] }> = [];
    const mockTx = {
      query: vi.fn(async (sql: string, params: any[]) => {
        queries.push({ sql, params });
        return {
          rows: [
            {
              id: 'exc-1',
              companyId: 'comp-1',
              invoiceId: 'inv-1',
              supplierId: 'sup-1',
              status: 'superseded',
              requestedBy: 'user-req',
              approvedBy: 'user-app',
              rejectedBy: null,
              supersededBy: 'user-req',
              reason: 'Original reason',
              decisionReason: 'Approved earlier',
              supersedeReason: 'تم استبدال الطلب بطلب استثناء جديد',
              fingerprint: 'fp-1',
              snapshot: {},
              maxVariancePc: 12,
              createdAt: '2026-11-20T00:00:00Z',
              updatedAt: '2026-11-20T00:00:00Z',
            },
          ],
        };
      }),
    };

    // 1. create() supersedes prior rows using supersede_reason ONLY (never decision_reason)
    await repo.create(
      'comp-1',
      {
        invoiceId: 'inv-1',
        supplierId: 'sup-1',
        reason: 'New variance request',
        fingerprint: 'fp-2',
        snapshot: {},
        requestedBy: 'user-req',
        maxVariancePct: 12,
      },
      mockTx as any
    );

    expect(queries[0].sql).toContain('supersede_reason =');
    expect(queries[0].sql).not.toContain('decision_reason =');
    expect(queries[1].sql).toContain('supersede_reason as "supersedeReason"');

    // 2. create() rejects missing requestedBy
    await expect(
      repo.create(
        'comp-1',
        {
          invoiceId: 'inv-1',
          supplierId: 'sup-1',
          reason: 'Missing actor',
          fingerprint: 'fp-2',
          snapshot: {},
          requestedBy: null,
        },
        mockTx as any
      )
    ).rejects.toThrow(ValidationError);

    // 3. updateStatus() routes decision_reason for approved/rejected and supersede_reason for superseded
    queries.length = 0;
    await repo.updateStatus('comp-1', 'exc-1', 'superseded', 'user-app', 'تغيرت بنود الفاتورة', mockTx as any);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("WHEN $3::text IN ('approved', 'rejected') THEN COALESCE($5::text, decision_reason)");
    expect(queries[0].sql).toContain("WHEN $3::text = 'superseded' THEN COALESCE($5::text, supersede_reason)");
    expect(queries[0].sql).toContain('supersede_reason as "supersedeReason"');
    expect(queries[0].params).toEqual(['comp-1', 'exc-1', 'superseded', 'user-app', 'تغيرت بنود الفاتورة']);

    // 4. updateStatus() rejects missing actorId or blank supersede reason
    await expect(repo.updateStatus('comp-1', 'exc-1', 'approved', '', 'Ok', mockTx as any)).rejects.toThrow(ValidationError);
    await expect(repo.updateStatus('comp-1', 'exc-1', 'superseded', 'user-app', '   ', mockTx as any)).rejects.toThrow(
      ValidationError
    );
  });

  it('blocks InvoiceService.deleteInvoice when price variance exceptions exist or DB raises 23503', async () => {
    const draftInvoice = {
      id: 'inv-del-1',
      companyId: 'comp-1',
      supplierId: 'sup-1',
      supplierInvoiceNo: 'SINV-DEL-1',
      status: 'draft' as const,
      invoiceDate: '2026-11-20',
      lines: [],
    };

    const deleteDraftSpy = vi.fn(async () => {});
    const invService = new InvoiceService(
      {
        findByIdForUpdate: async () => draftInvoice,
        deleteDraft: deleteDraftSpy,
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { record: async () => {} } as any
    );

    vi.spyOn(defaultPriceVarianceExceptionRepository, 'hasAnyForInvoice').mockResolvedValueOnce(true);
    await expect(invService.deleteInvoice('comp-1', 'inv-del-1', 'user-1')).rejects.toThrow(
      /لا يمكن حذف فاتورة المورد لوجود سجل طلبات استثناء تباين أسعار مرتبط بها/
    );
    expect(deleteDraftSpy).not.toHaveBeenCalled();

    // Concurrent race fallback: hasAnyForInvoice returned false, DB ON DELETE RESTRICT throws 23503
    vi.spyOn(defaultPriceVarianceExceptionRepository, 'hasAnyForInvoice').mockResolvedValueOnce(false);
    deleteDraftSpy.mockRejectedValueOnce(Object.assign(new Error('fk restrict'), { code: '23503' }));
    await expect(invService.deleteInvoice('comp-1', 'inv-del-1', 'user-1')).rejects.toThrow(ValidationError);
  });
});
