import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BankAccountService } from '../bankAccountService.js';
import { BankReconcileService } from '../bankReconcileService.js';
import { YearCloseService } from '../../accounting/yearCloseService.js';
import { OperationalReportsService } from '../../accounting/operationalReportsService.js';
import { PeriodService } from '../../accounting/periodService.js';
import { ValidationError, ConflictError } from '../../http/errors.js';

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn((_companyId: string, callback: (tx: unknown) => Promise<unknown>) =>
    callback(mockTx)
  ),
}));

const COMP_ID = '11111111-1111-4111-8111-111111111111';
const BANK_ID = '22222222-2222-4222-8222-222222222222';
const GL_BANK_ID = '33333333-3333-4333-8333-333333333333';
const RE_ACC_ID = '44444444-4444-4444-8444-444444444444';
const REV_ACC_ID = '55555555-5555-4555-8555-555555555555';
const EXP_ACC_ID = '66666666-6666-4666-8666-666666666666';
const STMT_LINE_ID = '77777777-7777-4777-8777-777777777777';
const GL_LINE_ID = '88888888-8888-4888-8888-888888888888';
const PERIOD_ID = '99999999-9999-4999-8999-999999999999';
const JE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let mockTx: { query: ReturnType<typeof vi.fn> };

describe('AN-FINANCE-EXT-1 Unit Tests (Banking / Year Close / Operational Reports)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
  });

  describe('BankAccountService', () => {
    it('creates a bank account linked to an active postable asset GL account and rejects GL reuse', async () => {
      const repo = {
        findByCode: vi.fn().mockResolvedValue(null),
        findByGlAccount: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: BANK_ID, nameAr: 'بنك قائم' }),
        create: vi.fn().mockResolvedValue({
          id: BANK_ID,
          companyId: COMP_ID,
          code: 'BNK-01',
          nameAr: 'بنك الراجحي',
          bankName: 'مصرف الراجحي',
          glAccountId: GL_BANK_ID,
          openingBalance: '1000.00',
          isActive: true,
        }),
      } as any;
      const accountRepo = {
        findById: vi.fn().mockResolvedValue({
          id: GL_BANK_ID,
          accountType: 'asset',
          isPostable: true,
          isActive: true,
        }),
      } as any;
      const cashRegRepo = { findByGlAccount: vi.fn().mockResolvedValue(null) } as any;
      const auditService = { record: vi.fn().mockResolvedValue(undefined) } as any;

      const svc = new BankAccountService(repo, accountRepo, cashRegRepo, auditService);

      const created = await svc.createAccount(
        COMP_ID,
        {
          code: 'BNK-01',
          nameAr: 'بنك الراجحي',
          bankName: 'مصرف الراجحي',
          glAccountId: GL_BANK_ID,
          openingBalance: '1000.00',
        },
        ACTOR_ID
      );

      expect(created.id).toBe(BANK_ID);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'BANK_ACCOUNT_CREATE', entityId: BANK_ID }),
        expect.objectContaining({ executor: mockTx })
      );

      await expect(
        svc.createAccount(
          COMP_ID,
          { code: 'BNK-02', nameAr: 'حساب مكرر', bankName: 'الراجحي', glAccountId: GL_BANK_ID },
          ACTOR_ID
        )
      ).rejects.toThrow(ConflictError);
    });

    it('rejects linking a non-asset GL account to a bank account', async () => {
      const accountRepo = {
        findById: vi.fn().mockResolvedValue({
          id: EXP_ACC_ID,
          accountType: 'expense',
          isPostable: true,
          isActive: true,
        }),
      } as any;
      const svc = new BankAccountService({} as any, accountRepo, {} as any, { record: vi.fn() } as any);

      await expect(
        svc.createAccount(
          COMP_ID,
          { code: 'BNK-03', nameAr: 'بنك خطأ', bankName: 'بنك', glAccountId: EXP_ACC_ID },
          ACTOR_ID
        )
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('BankReconcileService', () => {
    it('matches statement deposit with GL debit and rejects mismatched amounts', async () => {
      const accountRepo = {
        findById: vi.fn().mockResolvedValue({
          id: BANK_ID,
          companyId: COMP_ID,
          glAccountId: GL_BANK_ID,
          openingBalance: '0.00',
          isActive: true,
        }),
      } as any;

      const reconRepo = {
        findStatementLineForUpdate: vi
          .fn()
          .mockResolvedValueOnce({
            id: STMT_LINE_ID,
            bankAccountId: BANK_ID,
            debitAmount: '0.00',
            creditAmount: '500.00',
            status: 'unmatched',
            reconciliationId: null,
          })
          .mockResolvedValueOnce({
            id: STMT_LINE_ID,
            bankAccountId: BANK_ID,
            debitAmount: '0.00',
            creditAmount: '500.00',
            status: 'unmatched',
            reconciliationId: null,
          }),
        findPostedGlLineForBank: vi
          .fn()
          .mockResolvedValueOnce({ id: GL_LINE_ID, debit: '500.00', credit: '0.00' })
          .mockResolvedValueOnce({ id: GL_LINE_ID, debit: '450.00', credit: '0.00' }),
        findMatchedByJournalLine: vi.fn().mockResolvedValue(null),
        setStatementLineMatch: vi.fn().mockResolvedValue({
          id: STMT_LINE_ID,
          status: 'matched',
          matchedJournalLineId: GL_LINE_ID,
        }),
      } as any;

      const auditService = { record: vi.fn().mockResolvedValue(undefined) } as any;
      const svc = new BankReconcileService(accountRepo, reconRepo, auditService);

      const matched = await svc.matchStatementLine(COMP_ID, BANK_ID, STMT_LINE_ID, GL_LINE_ID, ACTOR_ID);
      expect(matched.status).toBe('matched');
      expect(reconRepo.setStatementLineMatch).toHaveBeenCalledWith(
        COMP_ID,
        STMT_LINE_ID,
        GL_LINE_ID,
        ACTOR_ID,
        mockTx
      );

      await expect(
        svc.matchStatementLine(COMP_ID, BANK_ID, STMT_LINE_ID, GL_LINE_ID, ACTOR_ID)
      ).rejects.toThrow(ValidationError);
    });

    it('completes reconciliation when adjusted difference is zero and rejects non-zero difference', async () => {
      const accountRepo = {
        lockForUpdate: vi.fn().mockResolvedValue({
          id: BANK_ID,
          companyId: COMP_ID,
          glAccountId: GL_BANK_ID,
          openingBalance: '100.00',
          isActive: true,
        }),
      } as any;

      const reconRepo = {
        listStatementLines: vi.fn().mockResolvedValue([
          {
            id: STMT_LINE_ID,
            debitAmount: '0.00',
            creditAmount: '400.00',
            status: 'matched',
          },
        ]),
        listPostedGlMovements: vi.fn().mockResolvedValue([
          {
            journalLineId: GL_LINE_ID,
            debit: '400.00',
            credit: '0.00',
            isMatched: true,
          },
        ]),
        createCompletedReconciliation: vi.fn().mockResolvedValue({
          id: 'recon-1',
          statementEndDate: '2026-11-30',
          statementEndingBalance: '500.00',
          bookBalance: '500.00',
          differenceAmount: '0.00',
          status: 'completed',
        }),
        linkMatchedLinesToReconciliation: vi.fn().mockResolvedValue(1),
      } as any;

      const auditService = { record: vi.fn().mockResolvedValue(undefined) } as any;
      const svc = new BankReconcileService(accountRepo, reconRepo, auditService);

      await expect(
        svc.completeReconciliation(
          COMP_ID,
          BANK_ID,
          { statementEndDate: '2026-11-30', statementEndingBalance: '490.00' },
          ACTOR_ID
        )
      ).rejects.toThrow(ValidationError);

      const completed = await svc.completeReconciliation(
        COMP_ID,
        BANK_ID,
        { statementEndDate: '2026-11-30', statementEndingBalance: '500.00', memo: 'مطابق' },
        ACTOR_ID
      );
      expect(completed.status).toBe('completed');
      expect(completed.differenceAmount).toBe('0.00');
      expect(reconRepo.linkMatchedLinesToReconciliation).toHaveBeenCalledWith(
        COMP_ID,
        BANK_ID,
        '2026-11-30',
        'recon-1',
        mockTx
      );
    });
  });

  describe('YearCloseService & PeriodService preservation', () => {
    it('posts balanced P&L closing entry into Retained Earnings before closing periods', async () => {
      const periodRepo = {
        setClosed: vi.fn().mockResolvedValue({ id: PERIOD_ID, code: '2026-ALL', isClosed: true }),
      } as any;
      const accountRepo = {
        findById: vi.fn().mockResolvedValue({
          id: RE_ACC_ID,
          code: '3200',
          nameAr: 'الأرباح المبقاة',
          accountType: 'equity',
          isPostable: true,
          isActive: true,
        }),
      } as any;
      const callOrder: string[] = [];
      const journalService = {
        createDraftEntry: vi.fn().mockImplementation(async () => {
          callOrder.push('createDraft');
          return { id: JE_ID, status: 'draft' };
        }),
        postEntry: vi.fn().mockImplementation(async () => {
          callOrder.push('postEntry');
          return { id: JE_ID, entryNo: 'JE-CLOSE-01', status: 'posted' };
        }),
      } as any;
      periodRepo.setClosed.mockImplementation(async () => {
        callOrder.push('closePeriod');
        return { id: PERIOD_ID, code: '2026-ALL', isClosed: true };
      });
      const auditService = { record: vi.fn().mockResolvedValue(undefined) } as any;

      mockTx.query
        .mockResolvedValueOnce({ rows: [] }) // existing close check
        .mockResolvedValueOnce({ rows: [{ cnt: 0 }] }) // draft entries count
        .mockResolvedValueOnce({
          rows: [
            {
              id: PERIOD_ID,
              companyId: COMP_ID,
              code: '2026-ALL',
              startDate: '2026-01-01',
              endDate: '2026-12-31',
              isClosed: false,
            },
          ],
        }) // periods
        .mockResolvedValueOnce({
          rows: [
            { accountId: REV_ACC_ID, accountCode: '4100', accountNameAr: 'مبيعات', accountType: 'revenue', d: '0.00', c: '1500.00' },
            { accountId: EXP_ACC_ID, accountCode: '5100', accountNameAr: 'مصروفات', accountType: 'expense', d: '600.00', c: '0.00' },
          ],
        }) // pnl rows
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'yc-1',
              companyId: COMP_ID,
              fiscalYearCode: 'FY-2026',
              startDate: '2026-01-01',
              endDate: '2026-12-31',
              retainedEarningsAccountId: RE_ACC_ID,
              closingJournalEntryId: JE_ID,
              totalRevenue: '1500.00',
              totalExpenses: '600.00',
              netIncome: '900.00',
              closedPeriodsCount: 1,
              closedAt: new Date().toISOString(),
            },
          ],
        }); // insert year close

      const svc = new YearCloseService(periodRepo, accountRepo, journalService, auditService);
      const res = await svc.executeYearClose(
        COMP_ID,
        {
          fiscalYearCode: 'FY-2026',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
          retainedEarningsAccountId: RE_ACC_ID,
        },
        ACTOR_ID
      );

      expect(res.netIncome).toBe('900.00');
      expect(res.closedPeriodsCount).toBe(1);
      expect(callOrder).toEqual(['createDraft', 'postEntry', 'closePeriod']);

      const jeLines = journalService.createDraftEntry.mock.calls[0][1].lines;
      expect(jeLines).toEqual([
        expect.objectContaining({ accountId: REV_ACC_ID, debit: 1500, credit: 0 }),
        expect.objectContaining({ accountId: EXP_ACC_ID, debit: 0, credit: 600 }),
        expect.objectContaining({ accountId: RE_ACC_ID, debit: 0, credit: 900 }),
      ]);
    });

    it('preserves existing PeriodService.closePeriod intact', async () => {
      const periodRepo = {
        findByIdForUpdate: vi.fn().mockResolvedValue({ id: PERIOD_ID, code: '2026-01', isClosed: false }),
        setClosed: vi.fn().mockResolvedValue({ id: PERIOD_ID, code: '2026-01', isClosed: true }),
      } as any;
      const auditService = { record: vi.fn().mockResolvedValue(undefined) } as any;
      const periodSvc = new PeriodService(periodRepo, auditService);
      const closed = await periodSvc.closePeriod(COMP_ID, PERIOD_ID, ACTOR_ID);
      expect(closed.isClosed).toBe(true);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PERIOD_CLOSE', entityId: PERIOD_ID })
      );
    });
  });

  describe('OperationalReportsService', () => {
    it('aggregates Cash & Bank Summary and AR/AP Aging Summary accurately with bigint precision', async () => {
      const cashRepo = {
        listByCompany: vi.fn().mockResolvedValue([
          { id: 'reg-1', code: 'CASH-1', nameAr: 'الصندوق الرئيسي', isActive: true, openingBalance: 100 },
        ]),
        sumMovements: vi.fn().mockResolvedValue({ totalIn: 250, totalOut: 50, netMovement: 200 }),
      } as any;
      const bankRepo = {
        listByCompany: vi.fn().mockResolvedValue([
          {
            id: BANK_ID,
            code: 'BNK-01',
            nameAr: 'الراجحي',
            bankName: 'مصرف الراجحي',
            currencyCode: 'SAR',
            isActive: true,
            openingBalance: '1000.00',
            bookBalance: '2500.50',
            unmatchedStatementCount: 2,
            lastReconciledAt: null,
          },
        ]),
      } as any;
      const arService = {
        getAgingReport: vi.fn().mockResolvedValue({
          items: [{ invoiceId: 'ar-1' }],
          customerSummaries: [
            { customerId: 'c1', customerCode: 'C1', customerNameAr: 'عميل', invoiceCount: 1, totalOpenAmount: 700, bucket0To30: 700, bucket31To60: 0, bucket61Plus: 0 },
          ],
          grandTotalOpen: 700,
          grandTotal0To30: 700,
          grandTotal31To60: 0,
          grandTotal61Plus: 0,
        }),
      } as any;
      const apService = {
        listOpenItems: vi.fn().mockResolvedValue([
          {
            invoiceId: 'ap-1',
            supplierId: 's1',
            supplierCode: 'S1',
            supplierNameAr: 'مورد',
            remainingOpenAmount: 200,
            agingDays: 45,
          },
        ]),
      } as any;

      mockTx.query.mockResolvedValueOnce({ rows: [{ cnt: 1, total: '150.00' }] });

      const opsSvc = new OperationalReportsService(cashRepo, bankRepo, arService, apService);
      const cashBank = await opsSvc.getCashAndBankSummary(COMP_ID, mockTx as any);
      expect(cashBank.totalCashBalance).toBe('300.00');
      expect(cashBank.totalBankBalance).toBe('2500.50');
      expect(cashBank.totalLiquidityPosition).toBe('2800.50');
      expect(cashBank.totalOpenCustodyAmount).toBe('150.00');

      const aging = await opsSvc.getArApAgingSummary(COMP_ID, mockTx as any);
      expect(aging.ar.totalOpen).toBe('700.00');
      expect(aging.ap.totalOpen).toBe('200.00');
      expect(aging.ap.bucket31To60).toBe('200.00');
      expect(aging.netReceivablesMinusPayables).toBe('500.00');
    });
  });
});
