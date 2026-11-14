import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CustodyService } from '../custodyService.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../http/errors.js';
import { CustodyRecord } from '../cashTypes.js';

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn((_companyId: string, callback: (tx: unknown) => Promise<unknown>) => callback({})),
}));

const COMP_ID = '11111111-1111-4111-8111-111111111111';
const CUSTODY_ID = '22222222-2222-4222-8222-222222222222';
const EMPLOYEE_ID = '33333333-3333-4333-8333-333333333333';
const REQUESTER_ID = '44444444-4444-4444-8444-444444444444';
const APPROVER_ID = '55555555-5555-4555-8555-555555555555';
const REGISTER_ID = '66666666-6666-4666-8666-666666666666';
const CASH_GL_ID = '77777777-7777-4777-8777-777777777777';
const CUSTODY_GL_ID = '88888888-8888-4888-8888-888888888888';
const EXPENSE_GL_ID = '99999999-9999-4999-8999-999999999999';
const JE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeCustody(overrides: Partial<CustodyRecord> = {}): CustodyRecord {
  return {
    id: CUSTODY_ID,
    companyId: COMP_ID,
    custodyNo: 'CUS-00001',
    employeeUserId: EMPLOYEE_ID,
    employeeUsername: 'emp_one',
    registerId: REGISTER_ID,
    registerCode: 'CASH-1',
    registerNameAr: 'الصندوق الرئيسي',
    amount: 1000,
    purpose: 'مشتريات تشغيلية طارئة',
    status: 'open',
    requestDate: '2026-11-13',
    requestedBy: REQUESTER_ID,
    approvedBy: APPROVER_ID,
    approvedAt: '2026-11-13T10:00:00.000Z',
    rejectedBy: null,
    rejectedAt: null,
    rejectReason: null,
    disbursedBy: APPROVER_ID,
    disbursedAt: '2026-11-13T10:05:00.000Z',
    settledBy: null,
    settledAt: null,
    disburseJournalEntryId: JE_ID,
    disburseJournalEntryNo: 'JE-00001',
    settleJournalEntryId: null,
    settleJournalEntryNo: null,
    settledExpenseTotal: null,
    settledCashReturn: null,
    memo: null,
    createdAt: '2026-11-13T09:50:00.000Z',
    updatedAt: '2026-11-13T10:05:00.000Z',
    ...overrides,
  };
}

function createHarness() {
  const custodyRepo = {
    create: vi.fn(),
    findById: vi.fn(),
    findByIdForUpdate: vi.fn(),
    listByCompany: vi.fn(),
    setStatus: vi.fn().mockResolvedValue(undefined),
    markDisbursed: vi.fn().mockResolvedValue(undefined),
    markSettled: vi.fn().mockResolvedValue(undefined),
    markRejected: vi.fn().mockResolvedValue(undefined),
    markCancelled: vi.fn().mockResolvedValue(undefined),
    listOpenByEmployee: vi.fn(),
    insertMovement: vi.fn().mockResolvedValue({ id: 'mov-1' }),
    listMovements: vi.fn(),
  } as any;

  const registerRepo = {
    findById: vi.fn().mockResolvedValue({
      id: REGISTER_ID,
      companyId: COMP_ID,
      code: 'CASH-1',
      nameAr: 'الصندوق الرئيسي',
      glAccountId: CASH_GL_ID,
      openingBalance: 2500,
      isActive: true,
    }),
    lockForUpdate: vi.fn().mockResolvedValue({
      id: REGISTER_ID,
      companyId: COMP_ID,
      code: 'CASH-1',
      nameAr: 'الصندوق الرئيسي',
      glAccountId: CASH_GL_ID,
      openingBalance: 2500,
      isActive: true,
    }),
    sumMovements: vi.fn().mockResolvedValue({ totalIn: 0, totalOut: 0, netMovement: 0 }),
  } as any;

  const accountRepo = {
    findById: vi.fn().mockResolvedValue({
      id: EXPENSE_GL_ID,
      companyId: COMP_ID,
      code: '5100',
      nameAr: 'مصروفات عمومية',
      accountType: 'expense',
      isPostable: true,
      isActive: true,
    }),
  } as any;

  const journalRepo = {
    allocateSequenceNumber: vi.fn().mockResolvedValue('CUS-00001'),
  } as any;

  const journalService = {
    createDraftEntry: vi.fn().mockResolvedValue({ id: JE_ID, entryNo: null, status: 'draft' }),
    postEntry: vi.fn().mockResolvedValue({ id: JE_ID, entryNo: 'JE-00002', status: 'posted' }),
  };

  const auditService = {
    record: vi.fn().mockResolvedValue(undefined),
  };

  const membershipStore = {
    getMembership: vi.fn().mockResolvedValue({
      id: 'mem-1',
      userId: EMPLOYEE_ID,
      companyId: COMP_ID,
      role: 'company_user',
      roleId: null,
      isActive: true,
      createdAt: '2026-11-13T00:00:00.000Z',
    }),
    listByCompany: vi.fn().mockResolvedValue([]),
  };

  const userRepo = {
    findById: vi.fn().mockResolvedValue({
      id: EMPLOYEE_ID,
      username: 'emp_one',
      role: 'company_user',
      isActive: true,
    }),
  };

  const glResolver = {
    resolveAndAssertUsable: vi.fn().mockResolvedValue({
      custodyReceivableAccountId: CUSTODY_GL_ID,
      source: 'company_settings' as const,
      versionNo: null,
    }),
  };

  const service = new CustodyService(
    custodyRepo,
    registerRepo,
    accountRepo,
    journalRepo,
    journalService,
    auditService,
    membershipStore,
    userRepo,
    glResolver
  );

  return {
    service,
    custodyRepo,
    registerRepo,
    accountRepo,
    journalRepo,
    journalService,
    auditService,
    membershipStore,
    userRepo,
    glResolver,
  };
}

describe('CustodyService Unit Tests (No DB)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('State Machine Transitions', () => {
    it('rejects pending -> open (disburseCustody on pending)', async () => {
      const { service, custodyRepo } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'pending' }));

      await expect(service.disburseCustody(COMP_ID, CUSTODY_ID, APPROVER_ID)).rejects.toThrow(ValidationError);
    });

    it('rejects pending -> settled (settleCustody on pending)', async () => {
      const { service, custodyRepo } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'pending' }));

      await expect(
        service.settleCustody(
          COMP_ID,
          CUSTODY_ID,
          { lines: [{ expenseAccountId: EXPENSE_GL_ID, amount: 1000 }], cashReturn: 0 },
          APPROVER_ID
        )
      ).rejects.toThrow(ValidationError);
    });

    it('rejects approved -> settled (settleCustody before disburse)', async () => {
      const { service, custodyRepo } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'approved' }));

      await expect(
        service.settleCustody(
          COMP_ID,
          CUSTODY_ID,
          { lines: [{ expenseAccountId: EXPENSE_GL_ID, amount: 1000 }], cashReturn: 0 },
          APPROVER_ID
        )
      ).rejects.toThrow(ValidationError);
    });

    it('rejects settled -> settled (duplicate settle)', async () => {
      const { service, custodyRepo } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'settled' }));

      await expect(
        service.settleCustody(
          COMP_ID,
          CUSTODY_ID,
          { lines: [{ expenseAccountId: EXPENSE_GL_ID, amount: 1000 }], cashReturn: 0 },
          APPROVER_ID
        )
      ).rejects.toThrow(ValidationError);
    });

    it('rejects open -> open (duplicate disburse)', async () => {
      const { service, custodyRepo } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'open' }));

      await expect(service.disburseCustody(COMP_ID, CUSTODY_ID, APPROVER_ID)).rejects.toThrow(ValidationError);
    });

    it('rejects open -> cancelled and points to settlement / reverseEntry', async () => {
      const { service, custodyRepo } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'open' }));

      await expect(
        service.cancelCustody(COMP_ID, CUSTODY_ID, APPROVER_ID, 'محاولة إلغاء', { canCancelApproved: true })
      ).rejects.toThrow(/reverseEntry/);
    });

    it('rejects rejected -> approved', async () => {
      const { service, custodyRepo } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'rejected' }));

      await expect(service.approveCustody(COMP_ID, CUSTODY_ID, APPROVER_ID, true)).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError when custody does not exist', async () => {
      const { service, custodyRepo } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(null);

      await expect(service.approveCustody(COMP_ID, CUSTODY_ID, APPROVER_ID, false)).rejects.toThrow(NotFoundError);
    });
  });

  describe('SoD & Approval / Cancel Governance', () => {
    it('enforces SoD: requester cannot approve own custody unless platform_admin', async () => {
      const { service, custodyRepo } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(
        makeCustody({ status: 'pending', requestedBy: REQUESTER_ID })
      );

      await expect(service.approveCustody(COMP_ID, CUSTODY_ID, REQUESTER_ID, false)).rejects.toThrow(ForbiddenError);
    });

    it('allows distinct approver without creating movement or journal entry', async () => {
      const { service, custodyRepo, journalService } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(
        makeCustody({ status: 'pending', requestedBy: REQUESTER_ID })
      );
      custodyRepo.findById.mockResolvedValue(makeCustody({ status: 'approved', approvedBy: APPROVER_ID }));

      const res = await service.approveCustody(COMP_ID, CUSTODY_ID, APPROVER_ID, false);
      expect(res.status).toBe('approved');
      expect(custodyRepo.insertMovement).not.toHaveBeenCalled();
      expect(journalService.createDraftEntry).not.toHaveBeenCalled();
    });

    it('requires CUSTODY_APPROVE permission (canCancelApproved) when cancelling an approved custody', async () => {
      const { service, custodyRepo } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'approved' }));

      await expect(
        service.cancelCustody(COMP_ID, CUSTODY_ID, REQUESTER_ID, 'لا حاجة لها', { canCancelApproved: false })
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe('Strict Settlement Amount Rules & Accounting Validation', () => {
    it('accepts exact split: expense 700 + cashReturn 300 = 1000 with balanced JE and direction=none for expense', async () => {
      const { service, custodyRepo, journalService, auditService } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'open', amount: 1000 }));
      custodyRepo.findById.mockResolvedValue(
        makeCustody({
          status: 'settled',
          settledExpenseTotal: 700,
          settledCashReturn: 300,
          settleJournalEntryId: JE_ID,
          settleJournalEntryNo: 'JE-00002',
        })
      );

      const res = await service.settleCustody(
        COMP_ID,
        CUSTODY_ID,
        {
          lines: [{ expenseAccountId: EXPENSE_GL_ID, amount: 700, memo: 'مستلزمات' }],
          cashReturn: 300,
        },
        APPROVER_ID
      );

      expect(res.status).toBe('settled');
      expect(journalService.createDraftEntry).toHaveBeenCalledTimes(1);
      const draftInput = journalService.createDraftEntry.mock.calls[0][1];
      expect(draftInput.lines).toEqual([
        expect.objectContaining({ accountId: EXPENSE_GL_ID, debit: 700, credit: 0 }),
        expect.objectContaining({ accountId: CASH_GL_ID, debit: 300, credit: 0 }),
        expect.objectContaining({ accountId: CUSTODY_GL_ID, debit: 0, credit: 1000 }),
      ]);
      expect(journalService.postEntry).toHaveBeenCalledTimes(1);
      expect(custodyRepo.insertMovement).toHaveBeenCalledTimes(2);
      expect(custodyRepo.insertMovement.mock.calls[0][1]).toMatchObject({
        movementType: 'settle_expense',
        direction: 'none',
        amount: 700,
        expenseAccountId: EXPENSE_GL_ID,
      });
      expect(custodyRepo.insertMovement.mock.calls[1][1]).toMatchObject({
        movementType: 'settle_return',
        direction: 'in',
        amount: 300,
        expenseAccountId: null,
      });
      expect(custodyRepo.markSettled).toHaveBeenCalledWith(COMP_ID, CUSTODY_ID, APPROVER_ID, JE_ID, 700, 300, null, {});
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CUSTODY_SETTLE', entityId: CUSTODY_ID }),
        { executor: {} }
      );
    });

    it('rejects 701 + 300 != 1000 (over by 1) before calling JournalService', async () => {
      const { service, custodyRepo, journalService } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'open', amount: 1000 }));

      await expect(
        service.settleCustody(
          COMP_ID,
          CUSTODY_ID,
          { lines: [{ expenseAccountId: EXPENSE_GL_ID, amount: 701 }], cashReturn: 300 },
          APPROVER_ID
        )
      ).rejects.toThrow(ValidationError);
      expect(journalService.createDraftEntry).not.toHaveBeenCalled();
    });

    it('rejects 700 + 299 != 1000 (short by 1)', async () => {
      const { service, custodyRepo, journalService } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'open', amount: 1000 }));

      await expect(
        service.settleCustody(
          COMP_ID,
          CUSTODY_ID,
          { lines: [{ expenseAccountId: EXPENSE_GL_ID, amount: 700 }], cashReturn: 299 },
          APPROVER_ID
        )
      ).rejects.toThrow(ValidationError);
      expect(journalService.createDraftEntry).not.toHaveBeenCalled();
    });

    it('rejects even a 0.01 difference (strict zero tolerance)', async () => {
      const { service, custodyRepo } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'open', amount: 1000 }));

      await expect(
        service.settleCustody(
          COMP_ID,
          CUSTODY_ID,
          { lines: [{ expenseAccountId: EXPENSE_GL_ID, amount: 700.01 }], cashReturn: 300 },
          APPROVER_ID
        )
      ).rejects.toThrow(ValidationError);
    });

    it('accepts cashReturn = 0 when expense equals full custody amount without creating settle_return movement', async () => {
      const { service, custodyRepo, journalService } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'open', amount: 1000 }));
      custodyRepo.findById.mockResolvedValue(
        makeCustody({ status: 'settled', settledExpenseTotal: 1000, settledCashReturn: 0 })
      );

      const res = await service.settleCustody(
        COMP_ID,
        CUSTODY_ID,
        { lines: [{ expenseAccountId: EXPENSE_GL_ID, amount: 1000 }], cashReturn: 0 },
        APPROVER_ID
      );

      expect(res.status).toBe('settled');
      expect(custodyRepo.insertMovement).toHaveBeenCalledTimes(1);
      expect(custodyRepo.insertMovement.mock.calls[0][1]).toMatchObject({
        movementType: 'settle_expense',
        direction: 'none',
        amount: 1000,
      });
      const draftInput = journalService.createDraftEntry.mock.calls[0][1];
      expect(draftInput.lines).toHaveLength(2);
    });

    it('rejects expense line pointing to a liability account', async () => {
      const { service, custodyRepo, accountRepo, journalService } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'open', amount: 1000 }));
      accountRepo.findById.mockResolvedValue({
        id: EXPENSE_GL_ID,
        companyId: COMP_ID,
        code: '2100',
        nameAr: 'الموردون',
        accountType: 'liability',
        isPostable: true,
        isActive: true,
      });

      await expect(
        service.settleCustody(
          COMP_ID,
          CUSTODY_ID,
          { lines: [{ expenseAccountId: EXPENSE_GL_ID, amount: 1000 }], cashReturn: 0 },
          APPROVER_ID
        )
      ).rejects.toThrow(ValidationError);
      expect(journalService.createDraftEntry).not.toHaveBeenCalled();
    });

    it('rejects expense line pointing to a header account with isPostable = false', async () => {
      const { service, custodyRepo, accountRepo, journalService } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'open', amount: 1000 }));
      accountRepo.findById.mockResolvedValue({
        id: EXPENSE_GL_ID,
        companyId: COMP_ID,
        code: '5000',
        nameAr: 'المصروفات',
        accountType: 'expense',
        isPostable: false,
        isActive: true,
      });

      await expect(
        service.settleCustody(
          COMP_ID,
          CUSTODY_ID,
          { lines: [{ expenseAccountId: EXPENSE_GL_ID, amount: 1000 }], cashReturn: 0 },
          APPROVER_ID
        )
      ).rejects.toThrow(ValidationError);
      expect(journalService.createDraftEntry).not.toHaveBeenCalled();
    });
  });

  describe('Disburse Custody Checks', () => {
    it('rejects disburseCustody when register balance is insufficient', async () => {
      const { service, custodyRepo, registerRepo, journalService } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'approved', amount: 1000 }));
      registerRepo.lockForUpdate.mockResolvedValue({
        id: REGISTER_ID,
        companyId: COMP_ID,
        code: 'CASH-1',
        nameAr: 'الصندوق الرئيسي',
        glAccountId: CASH_GL_ID,
        openingBalance: 400,
        isActive: true,
      });
      registerRepo.sumMovements.mockResolvedValue({ totalIn: 0, totalOut: 0, netMovement: 0 });

      await expect(service.disburseCustody(COMP_ID, CUSTODY_ID, APPROVER_ID)).rejects.toThrow(ValidationError);
      expect(journalService.createDraftEntry).not.toHaveBeenCalled();
    });

    it('disburses custody atomically with posted balanced JE and out movement', async () => {
      const { service, custodyRepo, journalService, auditService } = createHarness();
      custodyRepo.findByIdForUpdate.mockResolvedValue(makeCustody({ status: 'approved', amount: 1000 }));
      custodyRepo.findById.mockResolvedValue(makeCustody({ status: 'open', disburseJournalEntryId: JE_ID }));

      const res = await service.disburseCustody(COMP_ID, CUSTODY_ID, APPROVER_ID);
      expect(res.status).toBe('open');
      expect(journalService.createDraftEntry).toHaveBeenCalledTimes(1);
      const draftInput = journalService.createDraftEntry.mock.calls[0][1];
      expect(draftInput.lines).toEqual([
        expect.objectContaining({ accountId: CUSTODY_GL_ID, debit: 1000, credit: 0 }),
        expect.objectContaining({ accountId: CASH_GL_ID, debit: 0, credit: 1000 }),
      ]);
      expect(journalService.postEntry).toHaveBeenCalledTimes(1);
      expect(custodyRepo.insertMovement).toHaveBeenCalledWith(
        COMP_ID,
        expect.objectContaining({
          custodyId: CUSTODY_ID,
          movementType: 'disburse',
          direction: 'out',
          amount: 1000,
          journalEntryId: JE_ID,
        }),
        {}
      );
      expect(custodyRepo.markDisbursed).toHaveBeenCalledWith(COMP_ID, CUSTODY_ID, APPROVER_ID, JE_ID, {});
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CUSTODY_DISBURSE', entityId: CUSTODY_ID }),
        { executor: {} }
      );
    });
  });
});
