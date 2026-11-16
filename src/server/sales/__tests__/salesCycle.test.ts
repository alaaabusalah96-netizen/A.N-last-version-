import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CustomerService } from '../customerService.js';
import { SalesDeliveryService } from '../salesDeliveryService.js';
import { SalesInvoiceService } from '../salesInvoiceService.js';
import { SalesCollectionService } from '../salesCollectionService.js';
import { ArAgingService } from '../arAgingService.js';
import { ValidationError, NotFoundError, ConflictError } from '../../http/errors.js';

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn((_companyId: string, callback: (tx: unknown) => Promise<unknown>) =>
    callback(mockTx)
  ),
}));

const COMP_ID = '11111111-1111-4111-8111-111111111111';
const CUST_ID = '22222222-2222-4222-8222-222222222222';
const WH_ID = '33333333-3333-4333-8333-333333333333';
const ITEM_ID = '44444444-4444-4444-8444-444444444444';
const DEL_ID = '55555555-5555-4555-8555-555555555555';
const DEL_LINE_ID = '55555555-5555-4555-8555-555555555556';
const INV_ID = '66666666-6666-4666-8666-666666666666';
const REG_ID = '77777777-7777-4777-8777-777777777777';
const COL_ID = '88888888-8888-4888-8888-888888888888';
const AR_ACC_ID = '99999999-9999-4999-8999-999999999991';
const REV_ACC_ID = '99999999-9999-4999-8999-999999999992';
const CASH_GL_ID = '99999999-9999-4999-8999-999999999993';
const JE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let mockTx: { query: ReturnType<typeof vi.fn> };

describe('AN-SALES-CYCLE-1 Domain Services Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
  });

  describe('CustomerService', () => {
    it('creates a customer and rejects duplicate customer code', async () => {
      const customerRepo = {
        list: vi.fn().mockResolvedValue([]),
        findById: vi.fn(),
        findByCode: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: CUST_ID, code: 'CUST-01' }),
        create: vi.fn().mockResolvedValue({
          id: CUST_ID,
          companyId: COMP_ID,
          code: 'CUST-01',
          nameAr: 'عميل التجربة',
          creditLimit: 5000,
          isActive: true,
        }),
      } as any;
      const auditService = { record: vi.fn().mockResolvedValue(undefined) } as any;
      const service = new CustomerService(customerRepo, auditService);

      const created = await service.createCustomer(
        COMP_ID,
        { code: 'CUST-01', nameAr: 'عميل التجربة', creditLimit: 5000 },
        ACTOR_ID
      );
      expect(created.code).toBe('CUST-01');
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SALES_CUSTOMER_CREATE', companyId: COMP_ID })
      );

      await expect(
        service.createCustomer(COMP_ID, { code: 'CUST-01', nameAr: 'مكرر' }, ACTOR_ID)
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('SalesDeliveryService', () => {
    it('posts delivery note, decrements warehouse balance, and records negative stock movement', async () => {
      const deliveryRepo = {
        findByIdForUpdate: vi.fn().mockResolvedValue({ id: DEL_ID, status: 'draft', warehouseId: WH_ID }),
        findById: vi
          .fn()
          .mockResolvedValueOnce({
            id: DEL_ID,
            companyId: COMP_ID,
            customerId: CUST_ID,
            customerNameAr: 'عميل أ',
            warehouseId: WH_ID,
            status: 'draft',
            lines: [
              { id: DEL_LINE_ID, itemId: ITEM_ID, itemNameAr: 'صنف 1', qty: 5, unitPrice: 100, unitCost: 60 },
            ],
          })
          .mockResolvedValueOnce({
            id: DEL_ID,
            companyId: COMP_ID,
            deliveryNo: 'DLV-00001',
            status: 'posted',
          }),
        markPosted: vi.fn().mockResolvedValue(undefined),
      } as any;
      const customerRepo = { findById: vi.fn() } as any;
      const stockRepo = {
        getBalanceForUpdate: vi.fn().mockResolvedValue({ qty: 12 }),
        decrementBalance: vi.fn().mockResolvedValue({ qty: 7 }),
        createMovement: vi.fn().mockResolvedValue({ id: 'mov-1' }),
      } as any;
      const journalRepo = {
        allocateSequenceNumber: vi.fn().mockResolvedValue('DLV-00001'),
      } as any;
      const auditService = { record: vi.fn().mockResolvedValue(undefined) } as any;

      mockTx.query.mockResolvedValue({ rows: [{ id: WH_ID, is_active: true }] });

      const service = new SalesDeliveryService(
        deliveryRepo,
        customerRepo,
        stockRepo,
        journalRepo,
        auditService
      );

      const posted = await service.postDelivery(COMP_ID, DEL_ID, ACTOR_ID);

      expect(posted.status).toBe('posted');
      expect(posted.deliveryNo).toBe('DLV-00001');
      expect(stockRepo.getBalanceForUpdate).toHaveBeenCalledWith(COMP_ID, WH_ID, ITEM_ID, mockTx);
      expect(stockRepo.decrementBalance).toHaveBeenCalledWith(COMP_ID, WH_ID, ITEM_ID, 5, mockTx);
      expect(stockRepo.createMovement).toHaveBeenCalledWith(
        COMP_ID,
        WH_ID,
        ITEM_ID,
        'issue',
        -5,
        expect.stringContaining('DLV-00001'),
        ACTOR_ID,
        undefined,
        mockTx
      );
      expect(deliveryRepo.markPosted).toHaveBeenCalledWith(COMP_ID, DEL_ID, 'DLV-00001', ACTOR_ID, mockTx);
    });

    it('rejects delivery posting when warehouse stock balance is insufficient', async () => {
      const deliveryRepo = {
        findByIdForUpdate: vi.fn().mockResolvedValue({ id: DEL_ID, status: 'draft', warehouseId: WH_ID }),
        findById: vi.fn().mockResolvedValue({
          id: DEL_ID,
          companyId: COMP_ID,
          customerId: CUST_ID,
          warehouseId: WH_ID,
          status: 'draft',
          lines: [{ id: DEL_LINE_ID, itemId: ITEM_ID, itemNameAr: 'صنف 1', qty: 15, unitPrice: 100 }],
        }),
        markPosted: vi.fn(),
      } as any;
      const stockRepo = {
        getBalanceForUpdate: vi.fn().mockResolvedValue({ qty: 4 }),
        decrementBalance: vi.fn(),
        createMovement: vi.fn(),
      } as any;
      const journalRepo = { allocateSequenceNumber: vi.fn().mockResolvedValue('DLV-00002') } as any;
      const auditService = { record: vi.fn() } as any;

      mockTx.query.mockResolvedValue({ rows: [{ id: WH_ID, is_active: true }] });

      const service = new SalesDeliveryService(
        deliveryRepo,
        {} as any,
        stockRepo,
        journalRepo,
        auditService
      );

      await expect(service.postDelivery(COMP_ID, DEL_ID, ACTOR_ID)).rejects.toThrow(ValidationError);
      expect(stockRepo.decrementBalance).not.toHaveBeenCalled();
      expect(deliveryRepo.markPosted).not.toHaveBeenCalled();
    });
  });

  describe('SalesInvoiceService', () => {
    it('prevents over-invoicing beyond remaining delivered quantity when linked to deliveryLineId', async () => {
      const invoiceRepo = { createDraft: vi.fn() } as any;
      const customerRepo = {
        findById: vi.fn().mockResolvedValue({ id: CUST_ID, isActive: true }),
      } as any;

      mockTx.query
        .mockResolvedValueOnce({ rows: [{ id: DEL_ID, status: 'posted', customer_id: CUST_ID }] })
        .mockResolvedValueOnce({ rows: [{ id: DEL_LINE_ID, qty: '10', item_id: ITEM_ID }] })
        .mockResolvedValueOnce({ rows: [{ invoiced_qty: '7' }] });

      const service = new SalesInvoiceService(
        invoiceRepo,
        customerRepo,
        {} as any,
        {} as any,
        { record: vi.fn() } as any
      );

      await expect(
        service.createInvoice(
          COMP_ID,
          {
            customerId: CUST_ID,
            deliveryId: DEL_ID,
            lines: [{ itemId: ITEM_ID, deliveryLineId: DEL_LINE_ID, qty: 4, unitPrice: 100 }],
          },
          ACTOR_ID
        )
      ).rejects.toThrow(ValidationError);

      expect(invoiceRepo.createDraft).not.toHaveBeenCalled();
    });

    it('posts sales invoice with balanced Dr AR / Cr Revenue journal entry', async () => {
      const invoiceRepo = {
        findByIdForUpdate: vi.fn().mockResolvedValue({ id: INV_ID, status: 'draft', totalAmount: 1150 }),
        findById: vi
          .fn()
          .mockResolvedValueOnce({
            id: INV_ID,
            companyId: COMP_ID,
            customerId: CUST_ID,
            customerNameAr: 'عميل النور',
            invoiceDate: '2026-11-15',
            totalAmount: 1150,
            status: 'draft',
            lines: [{ id: 'sil-1', itemId: ITEM_ID, deliveryLineId: null, qty: 10, unitPrice: 115 }],
          })
          .mockResolvedValueOnce({
            id: INV_ID,
            companyId: COMP_ID,
            invoiceNo: 'SINV-00001',
            status: 'posted',
            journalEntryId: JE_ID,
          }),
        markPosted: vi.fn().mockResolvedValue(undefined),
      } as any;
      const journalRepo = {
        allocateSequenceNumber: vi.fn().mockResolvedValue('SINV-00001'),
      } as any;
      const journalService = {
        createDraftEntry: vi.fn().mockResolvedValue({ id: JE_ID, status: 'draft' }),
        postEntry: vi.fn().mockResolvedValue({ id: JE_ID, entryNo: 'JE-001', status: 'posted' }),
      } as any;
      const auditService = { record: vi.fn().mockResolvedValue(undefined) } as any;

      mockTx.query
        .mockResolvedValueOnce({ rows: [{ arAccountId: AR_ACC_ID }] })
        .mockResolvedValueOnce({ rows: [{ revAccountId: REV_ACC_ID }] });

      const service = new SalesInvoiceService(
        invoiceRepo,
        {} as any,
        journalRepo,
        journalService,
        auditService
      );

      const posted = await service.postInvoice(COMP_ID, INV_ID, ACTOR_ID);

      expect(posted.status).toBe('posted');
      expect(posted.invoiceNo).toBe('SINV-00001');
      const jeInput = journalService.createDraftEntry.mock.calls[0][1];
      expect(jeInput.lines).toEqual([
        expect.objectContaining({ accountId: AR_ACC_ID, debit: 1150, credit: 0 }),
        expect.objectContaining({ accountId: REV_ACC_ID, debit: 0, credit: 1150 }),
      ]);
      expect(journalService.postEntry).toHaveBeenCalledWith(COMP_ID, JE_ID, ACTOR_ID, false, mockTx);
      expect(invoiceRepo.markPosted).toHaveBeenCalledWith(COMP_ID, INV_ID, 'SINV-00001', JE_ID, ACTOR_ID, mockTx);
    });
  });

  describe('SalesCollectionService', () => {
    it('rejects over-collection exceeding remaining open invoice balance', async () => {
      const collectionRepo = { createDraft: vi.fn() } as any;
      const customerRepo = { findById: vi.fn().mockResolvedValue({ id: CUST_ID, isActive: true }) } as any;
      const registerRepo = { findById: vi.fn().mockResolvedValue({ id: REG_ID, isActive: true, glAccountId: CASH_GL_ID }) } as any;
      const invoiceRepo = {
        findById: vi.fn().mockResolvedValue({
          id: INV_ID,
          customerId: CUST_ID,
          status: 'posted',
          totalAmount: 1000,
        }),
      } as any;

      mockTx.query.mockResolvedValueOnce({ rows: [{ paid: '600' }] });

      const service = new SalesCollectionService(
        collectionRepo,
        customerRepo,
        invoiceRepo,
        registerRepo,
        {} as any,
        {} as any,
        { record: vi.fn() } as any
      );

      await expect(
        service.createCollection(
          COMP_ID,
          { customerId: CUST_ID, invoiceId: INV_ID, registerId: REG_ID, amount: 450 },
          ACTOR_ID
        )
      ).rejects.toThrow(ValidationError);
      expect(collectionRepo.createDraft).not.toHaveBeenCalled();
    });

    it('posts customer collection with balanced Dr Cash Register GL / Cr AR journal entry', async () => {
      const collectionRepo = {
        findByIdForUpdate: vi.fn().mockResolvedValue({ id: COL_ID, status: 'draft', amount: 400 }),
        findById: vi
          .fn()
          .mockResolvedValueOnce({
            id: COL_ID,
            companyId: COMP_ID,
            customerId: CUST_ID,
            customerNameAr: 'عميل النور',
            invoiceId: INV_ID,
            invoiceNo: 'SINV-00001',
            registerId: REG_ID,
            collectionDate: '2026-11-16',
            amount: 400,
            status: 'draft',
          })
          .mockResolvedValueOnce({
            id: COL_ID,
            companyId: COMP_ID,
            collectionNo: 'COL-00001',
            status: 'posted',
            journalEntryId: JE_ID,
          }),
        markPosted: vi.fn().mockResolvedValue(undefined),
      } as any;
      const registerRepo = {
        findById: vi.fn().mockResolvedValue({
          id: REG_ID,
          nameAr: 'الصندوق الرئيسي',
          isActive: true,
          glAccountId: CASH_GL_ID,
        }),
      } as any;
      const invoiceRepo = {
        findByIdForUpdate: vi.fn().mockResolvedValue({ id: INV_ID, status: 'posted', totalAmount: 1000 }),
      } as any;
      const journalRepo = {
        allocateSequenceNumber: vi.fn().mockResolvedValue('COL-00001'),
      } as any;
      const journalService = {
        createDraftEntry: vi.fn().mockResolvedValue({ id: JE_ID, status: 'draft' }),
        postEntry: vi.fn().mockResolvedValue({ id: JE_ID, entryNo: 'JE-002', status: 'posted' }),
      } as any;
      const auditService = { record: vi.fn().mockResolvedValue(undefined) } as any;

      mockTx.query
        .mockResolvedValueOnce({ rows: [{ paid: '600' }] })
        .mockResolvedValueOnce({ rows: [{ arAccountId: AR_ACC_ID }] });

      const service = new SalesCollectionService(
        collectionRepo,
        {} as any,
        invoiceRepo,
        registerRepo,
        journalRepo,
        journalService,
        auditService
      );

      const posted = await service.postCollection(COMP_ID, COL_ID, ACTOR_ID);

      expect(posted.status).toBe('posted');
      expect(posted.collectionNo).toBe('COL-00001');
      const jeInput = journalService.createDraftEntry.mock.calls[0][1];
      expect(jeInput.lines).toEqual([
        expect.objectContaining({ accountId: CASH_GL_ID, debit: 400, credit: 0 }),
        expect.objectContaining({ accountId: AR_ACC_ID, debit: 0, credit: 400 }),
      ]);
      expect(collectionRepo.markPosted).toHaveBeenCalledWith(COMP_ID, COL_ID, 'COL-00001', JE_ID, ACTOR_ID, mockTx);
    });
  });

  describe('ArAgingService', () => {
    it('classifies open invoices into 0-30, 31-60, and 61+ buckets and aggregates customer totals', async () => {
      const executor = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              invoiceId: 'inv-1',
              invoiceNo: 'SINV-00001',
              invoiceDate: '2026-11-10',
              dueDate: '2026-11-10',
              customerId: CUST_ID,
              customerCode: 'CUST-01',
              customerNameAr: 'عميل النور',
              invoiceTotal: '500',
              collectedAmount: '200',
              remainingOpenAmount: '300',
              agingDays: 6,
            },
            {
              invoiceId: 'inv-2',
              invoiceNo: 'SINV-00002',
              invoiceDate: '2026-10-01',
              dueDate: '2026-10-01',
              customerId: CUST_ID,
              customerCode: 'CUST-01',
              customerNameAr: 'عميل النور',
              invoiceTotal: '400',
              collectedAmount: '0',
              remainingOpenAmount: '400',
              agingDays: 45,
            },
            {
              invoiceId: 'inv-3',
              invoiceNo: 'SINV-00003',
              invoiceDate: '2026-08-01',
              dueDate: '2026-08-01',
              customerId: 'cust-2',
              customerCode: 'CUST-02',
              customerNameAr: 'عميل الشرق',
              invoiceTotal: '1000',
              collectedAmount: '250',
              remainingOpenAmount: '750',
              agingDays: 90,
            },
          ],
        }),
      } as any;

      const service = new ArAgingService();
      const report = await service.getAgingReport(COMP_ID, executor);

      expect(report.grandTotalOpen).toBe(1450);
      expect(report.grandTotal0To30).toBe(300);
      expect(report.grandTotal31To60).toBe(400);
      expect(report.grandTotal61Plus).toBe(750);
      expect(report.customerSummaries).toHaveLength(2);
      expect(report.customerSummaries[0]).toMatchObject({
        customerId: CUST_ID,
        invoiceCount: 2,
        bucket0To30: 300,
        bucket31To60: 400,
        bucket61Plus: 0,
        totalOpenAmount: 700,
      });
    });

    it('throws NotFoundError when customer does not exist', async () => {
      const repo = { findById: vi.fn().mockResolvedValue(null) } as any;
      const service = new CustomerService(repo, { record: vi.fn() } as any);
      await expect(service.getCustomer(COMP_ID, CUST_ID)).rejects.toThrow(NotFoundError);
    });
  });
});
