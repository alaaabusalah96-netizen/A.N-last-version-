import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VoucherService } from '../voucherService.js';
import { CashRegisterService } from '../cashRegisterService.js';
import { NotFoundError, ValidationError } from '../../http/errors.js';
import { CashVoucher } from '../voucherTypes.js';

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn((_companyId: string, callback: (tx: unknown) => Promise<unknown>) => callback({})),
}));

const COMP_ID = '11111111-1111-4111-8111-111111111111';
const VOUCHER_ID = '22222222-2222-4222-8222-222222222222';
const REGISTER_ID = '33333333-3333-4333-8333-333333333333';
const CASH_GL_ID = '44444444-4444-4444-8444-444444444444';
const CONTRA_GL_ID = '55555555-5555-4555-8555-555555555555';
const ACTOR_ID = '66666666-6666-4666-8666-666666666666';
const JE_ID = '77777777-7777-4777-8777-777777777777';

function makeVoucher(overrides: Partial<CashVoucher> = {}): CashVoucher {
  return {
    id: VOUCHER_ID,
    companyId: COMP_ID,
    kind: 'receipt',
    voucherNo: null,
    registerId: REGISTER_ID,
    registerCode: 'CASH-1',
    registerNameAr: 'الصندوق الرئيسي',
    voucherDate: '2026-11-13',
    amount: 500,
    contraAccountId: CONTRA_GL_ID,
    contraAccountCode: '4100',
    contraAccountNameAr: 'إيرادات تشغيلية',
    status: 'draft',
    memo: 'تحصيل نقدي',
    reference: 'REF-100',
    journalEntryId: null,
    journalEntryNo: null,
    postedAt: null,
    postedBy: null,
    createdBy: ACTOR_ID,
    createdAt: '2026-11-13T10:00:00.000Z',
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

function createHarness() {
  const voucherRepo = {
    createDraft: vi.fn().mockImplementation(async (kind) => makeVoucher({ kind })),
    findById: vi.fn().mockImplementation(async (kind) => makeVoucher({ kind })),
    findByIdForUpdate: vi.fn(),
    listByCompany: vi.fn().mockResolvedValue([]),
    markPosted: vi.fn().mockResolvedValue(undefined),
    markCancelled: vi.fn().mockResolvedValue(undefined),
    listRegisterMovementRows: vi.fn().mockResolvedValue([]),
    listEmployeeCustodyMovements: vi.fn().mockResolvedValue([]),
  } as any;

  const registerRepo = {
    findById: vi.fn().mockResolvedValue({
      id: REGISTER_ID,
      companyId: COMP_ID,
      code: 'CASH-1',
      nameAr: 'الصندوق الرئيسي',
      glAccountId: CASH_GL_ID,
      openingBalance: 1000,
      isActive: true,
    }),
    lockForUpdate: vi.fn().mockResolvedValue({
      id: REGISTER_ID,
      companyId: COMP_ID,
      code: 'CASH-1',
      nameAr: 'الصندوق الرئيسي',
      glAccountId: CASH_GL_ID,
      openingBalance: 1000,
      isActive: true,
    }),
    sumMovements: vi.fn().mockResolvedValue({ totalIn: 500, totalOut: 200, netMovement: 300 }),
  } as any;

  const cashRegisterService = {
    getBalance: vi.fn().mockResolvedValue({
      registerId: REGISTER_ID,
      openingBalance: 1000,
      totalIn: 500,
      totalOut: 200,
      currentBalance: 1300,
    }),
  };

  const accountRepo = {
    findById: vi.fn().mockResolvedValue({
      id: CONTRA_GL_ID,
      companyId: COMP_ID,
      code: '4100',
      nameAr: 'إيرادات تشغيلية',
      accountType: 'revenue',
      isPostable: true,
      isActive: true,
    }),
  } as any;

  const journalRepo = {
    allocateSequenceNumber: vi.fn().mockImplementation(async (_cid, _type, prefix) => `${prefix}-00001`),
  } as any;

  const journalService = {
    createDraftEntry: vi.fn().mockResolvedValue({ id: JE_ID, entryNo: null, status: 'draft' }),
    postEntry: vi.fn().mockResolvedValue({ id: JE_ID, entryNo: 'JE-00010', status: 'posted' }),
  };

  const auditService = {
    record: vi.fn().mockResolvedValue(undefined),
  };

  const service = new VoucherService(
    voucherRepo,
    registerRepo,
    cashRegisterService,
    accountRepo,
    journalRepo,
    journalService,
    auditService
  );

  return {
    service,
    voucherRepo,
    registerRepo,
    cashRegisterService,
    accountRepo,
    journalRepo,
    journalService,
    auditService,
  };
}

describe('VoucherService & Unified Balance Unit Tests (No DB)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts a draft receipt voucher with Dr register GL, Cr contra account, CRV sequence, and audit record', async () => {
    const { service, voucherRepo, journalRepo, journalService, auditService } = createHarness();
    voucherRepo.findByIdForUpdate.mockResolvedValue(makeVoucher({ kind: 'receipt', status: 'draft', amount: 500 }));
    voucherRepo.findById.mockResolvedValue(
      makeVoucher({ kind: 'receipt', status: 'posted', voucherNo: 'CRV-00001', journalEntryId: JE_ID, journalEntryNo: 'JE-00010' })
    );

    const posted = await service.postReceiptVoucher(COMP_ID, VOUCHER_ID, ACTOR_ID, false);

    expect(posted.status).toBe('posted');
    expect(posted.voucherNo).toBe('CRV-00001');
    expect(journalRepo.allocateSequenceNumber).toHaveBeenCalledWith(COMP_ID, 'cash_receipt', 'CRV', {});
    const draftInput = journalService.createDraftEntry.mock.calls[0][1];
    expect(draftInput.lines).toEqual([
      expect.objectContaining({ accountId: CASH_GL_ID, debit: 500, credit: 0 }),
      expect.objectContaining({ accountId: CONTRA_GL_ID, debit: 0, credit: 500 }),
    ]);
    expect(journalService.postEntry).toHaveBeenCalledTimes(1);
    expect(voucherRepo.markPosted).toHaveBeenCalledWith('receipt', COMP_ID, VOUCHER_ID, 'CRV-00001', JE_ID, ACTOR_ID, {});
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CASH_RECEIPT_POST', entityId: VOUCHER_ID }),
      { executor: {} }
    );
  });

  it('posts a draft payment voucher with Dr contra account, Cr register GL, CPV sequence, after checking unified balance', async () => {
    const { service, voucherRepo, cashRegisterService, journalRepo, journalService } = createHarness();
    voucherRepo.findByIdForUpdate.mockResolvedValue(makeVoucher({ kind: 'payment', status: 'draft', amount: 400 }));
    voucherRepo.findById.mockResolvedValue(
      makeVoucher({ kind: 'payment', status: 'posted', voucherNo: 'CPV-00001', journalEntryId: JE_ID })
    );

    const posted = await service.postPaymentVoucher(COMP_ID, VOUCHER_ID, ACTOR_ID, false);

    expect(cashRegisterService.getBalance).toHaveBeenCalledWith(COMP_ID, REGISTER_ID, {});
    expect(journalRepo.allocateSequenceNumber).toHaveBeenCalledWith(COMP_ID, 'cash_payment', 'CPV', {});
    const draftInput = journalService.createDraftEntry.mock.calls[0][1];
    expect(draftInput.lines).toEqual([
      expect.objectContaining({ accountId: CONTRA_GL_ID, debit: 400, credit: 0 }),
      expect.objectContaining({ accountId: CASH_GL_ID, debit: 0, credit: 400 }),
    ]);
    expect(posted.status).toBe('posted');
  });

  it('rejects payment voucher posting when register balance is insufficient via unified getBalance', async () => {
    const { service, voucherRepo, cashRegisterService, journalService } = createHarness();
    voucherRepo.findByIdForUpdate.mockResolvedValue(makeVoucher({ kind: 'payment', status: 'draft', amount: 1500 }));
    cashRegisterService.getBalance.mockResolvedValue({
      registerId: REGISTER_ID,
      openingBalance: 1000,
      totalIn: 200,
      totalOut: 100,
      currentBalance: 1100,
    });

    await expect(service.postPaymentVoucher(COMP_ID, VOUCHER_ID, ACTOR_ID, false)).rejects.toThrow(ValidationError);
    expect(journalService.createDraftEntry).not.toHaveBeenCalled();
  });

  it('rejects duplicate posting of an already posted voucher', async () => {
    const { service, voucherRepo, journalService } = createHarness();
    voucherRepo.findByIdForUpdate.mockResolvedValue(makeVoucher({ kind: 'receipt', status: 'posted' }));

    await expect(service.postReceiptVoucher(COMP_ID, VOUCHER_ID, ACTOR_ID, false)).rejects.toThrow(ValidationError);
    expect(journalService.createDraftEntry).not.toHaveBeenCalled();
  });

  it('rejects voucher creation and posting when contra_account_id equals register glAccountId', async () => {
    const { service, voucherRepo, accountRepo } = createHarness();
    accountRepo.findById.mockResolvedValue({
      id: CASH_GL_ID,
      companyId: COMP_ID,
      code: '1100',
      nameAr: 'الصندوق الرئيسي',
      accountType: 'asset',
      isPostable: true,
      isActive: true,
    });

    await expect(
      service.createReceiptVoucher(
        COMP_ID,
        { registerId: REGISTER_ID, contraAccountId: CASH_GL_ID, amount: 100 },
        ACTOR_ID
      )
    ).rejects.toThrow(ValidationError);

    voucherRepo.findByIdForUpdate.mockResolvedValue(
      makeVoucher({ kind: 'receipt', status: 'draft', contraAccountId: CASH_GL_ID })
    );
    await expect(service.postReceiptVoucher(COMP_ID, VOUCHER_ID, ACTOR_ID, false)).rejects.toThrow(ValidationError);
  });

  it('rejects non-postable or inactive contra accounts with ValidationError', async () => {
    const { service, accountRepo } = createHarness();
    accountRepo.findById.mockResolvedValue({
      id: CONTRA_GL_ID,
      companyId: COMP_ID,
      code: '4000',
      nameAr: 'الإيرادات',
      accountType: 'revenue',
      isPostable: false,
      isActive: true,
    });

    await expect(
      service.createReceiptVoucher(
        COMP_ID,
        { registerId: REGISTER_ID, contraAccountId: CONTRA_GL_ID, amount: 100 },
        ACTOR_ID
      )
    ).rejects.toThrow(ValidationError);

    accountRepo.findById.mockResolvedValue({
      id: CONTRA_GL_ID,
      companyId: COMP_ID,
      code: '4100',
      nameAr: 'إيراد معطل',
      accountType: 'revenue',
      isPostable: true,
      isActive: false,
    });

    await expect(
      service.createPaymentVoucher(
        COMP_ID,
        { registerId: REGISTER_ID, contraAccountId: CONTRA_GL_ID, amount: 100 },
        ACTOR_ID
      )
    ).rejects.toThrow(ValidationError);
  });

  it('rejects cancelling a posted voucher and points to JournalService.reverseEntry', async () => {
    const { service, voucherRepo } = createHarness();
    voucherRepo.findByIdForUpdate.mockResolvedValue(makeVoucher({ kind: 'receipt', status: 'posted' }));

    await expect(
      service.cancelVoucher('receipt', COMP_ID, VOUCHER_ID, ACTOR_ID, 'إلغاء')
    ).rejects.toThrow(/reverseEntry/);
    expect(voucherRepo.markCancelled).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when voucher is absent (tenant isolation)', async () => {
    const { service, voucherRepo } = createHarness();
    voucherRepo.findById.mockResolvedValue(null);

    await expect(service.getVoucher('receipt', COMP_ID, VOUCHER_ID)).rejects.toThrow(NotFoundError);
  });

  it('CashRegisterService.getBalance reflects unified sumMovements from custody_movements and posted vouchers', async () => {
    const repo = {
      findById: vi.fn().mockResolvedValue({
        id: REGISTER_ID,
        companyId: COMP_ID,
        openingBalance: 1000,
      }),
      sumMovements: vi.fn().mockResolvedValue({
        totalIn: 750,
        totalOut: 300,
        netMovement: 450,
      }),
    } as any;
    const regSvc = new CashRegisterService(repo);
    const bal = await regSvc.getBalance(COMP_ID, REGISTER_ID, {} as any);
    expect(bal).toEqual({
      registerId: REGISTER_ID,
      openingBalance: 1000,
      totalIn: 750,
      totalOut: 300,
      currentBalance: 1450,
    });
  });
});
