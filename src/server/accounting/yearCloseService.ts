import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { PeriodRepository, defaultPeriodRepository } from './periodRepository.js';
import { AccountRepository, defaultAccountRepository } from './accountRepository.js';
import { JournalService, defaultJournalService } from './journalService.js';
import { CreateJournalLineInput } from './journalTypes.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { AccountingPeriod } from './periodTypes.js';
import { ValidationError, NotFoundError, ConflictError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { toMinorUnits, fromMinorUnits } from '../lib/numeric.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, field: string): string {
  if (!value || typeof value !== 'string' || !DATE_RE.test(value.trim())) {
    throw new ValidationError(`${field}: صيغة التاريخ غير صحيحة (المتوقع YYYY-MM-DD)`);
  }
  return value.trim();
}

export interface YearCloseAccountBalance {
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  accountType: 'revenue' | 'expense';
  balance: string;
}

export interface FiscalYearClosePreview {
  fiscalYearCode: string;
  startDate: string;
  endDate: string;
  alreadyClosed: boolean;
  existingCloseId: string | null;
  draftEntriesCount: number;
  coveredPeriods: AccountingPeriod[];
  openPeriodsToCloseCount: number;
  endDatePeriod: AccountingPeriod | null;
  canExecute: boolean;
  blockingReasons: string[];
  revenueAccounts: YearCloseAccountBalance[];
  expenseAccounts: YearCloseAccountBalance[];
  totalRevenue: string;
  totalExpenses: string;
  netIncome: string;
}

export interface FiscalYearCloseRecord {
  id: string;
  companyId: string;
  fiscalYearCode: string;
  startDate: string;
  endDate: string;
  retainedEarningsAccountId: string;
  retainedEarningsAccountCode?: string;
  retainedEarningsAccountNameAr?: string;
  closingJournalEntryId: string | null;
  closingEntryNo?: string | null;
  totalRevenue: string;
  totalExpenses: string;
  netIncome: string;
  closedPeriodsCount: number;
  notes: string | null;
  closedBy: string | null;
  closedAt: string;
}

export interface ExecuteYearCloseInput {
  fiscalYearCode: string;
  startDate: string;
  endDate: string;
  retainedEarningsAccountId: string;
  notes?: string | null;
}

export class YearCloseService {
  constructor(
    private periodRepo: PeriodRepository = defaultPeriodRepository,
    private accountRepo: AccountRepository = defaultAccountRepository,
    private journalService: JournalService = defaultJournalService,
    private auditService: AuditService = defaultAuditService
  ) {}

  async listYearCloses(companyId: string): Promise<FiscalYearCloseRecord[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const sql = `
        SELECT
          yc.id,
          yc.company_id as "companyId",
          yc.fiscal_year_code as "fiscalYearCode",
          yc.start_date::text as "startDate",
          yc.end_date::text as "endDate",
          yc.retained_earnings_account_id as "retainedEarningsAccountId",
          a.code as "retainedEarningsAccountCode",
          a.name_ar as "retainedEarningsAccountNameAr",
          yc.closing_journal_entry_id as "closingJournalEntryId",
          je.entry_no as "closingEntryNo",
          yc.total_revenue::text as "totalRevenue",
          yc.total_expenses::text as "totalExpenses",
          yc.net_income::text as "netIncome",
          yc.closed_periods_count as "closedPeriodsCount",
          yc.notes,
          yc.closed_by as "closedBy",
          yc.closed_at as "closedAt"
        FROM fin_fiscal_year_closes yc
        INNER JOIN accounts a ON a.id = yc.retained_earnings_account_id AND a.company_id = yc.company_id
        LEFT JOIN journal_entries je ON je.id = yc.closing_journal_entry_id AND je.company_id = yc.company_id
        WHERE yc.company_id = $1
        ORDER BY yc.end_date DESC, yc.closed_at DESC;
      `;
      const res = await tx.query<any>(sql, [companyId]);
      return res.rows.map((r) => ({
        ...r,
        totalRevenue: fromMinorUnits(toMinorUnits(r.totalRevenue ?? '0', 2), 2),
        totalExpenses: fromMinorUnits(toMinorUnits(r.totalExpenses ?? '0', 2), 2),
        netIncome: fromMinorUnits(toMinorUnits(r.netIncome ?? '0', 2), 2),
        closedAt: typeof r.closedAt === 'string' ? r.closedAt : new Date(r.closedAt).toISOString(),
      }));
    });
  }

  private async gatherPnlAndPeriods(
    companyId: string,
    fiscalYearCode: string,
    startDate: string,
    endDate: string,
    lockPeriods: boolean,
    tx: DbExecutor
  ) {
    const existingCloseRes = await tx.query<{ id: string }>(
      `SELECT id FROM fin_fiscal_year_closes WHERE company_id = $1 AND fiscal_year_code = $2 LIMIT 1`,
      [companyId, fiscalYearCode]
    );
    const existingCloseId = existingCloseRes.rows[0]?.id ?? null;

    const draftRes = await tx.query<{ cnt: string | number }>(
      `SELECT COUNT(*)::int as cnt
       FROM journal_entries
       WHERE company_id = $1
         AND status = 'draft'
         AND entry_date >= $2::date
         AND entry_date <= $3::date`,
      [companyId, startDate, endDate]
    );
    const draftEntriesCount = Number(draftRes.rows[0]?.cnt ?? 0);

    const periodsRes = await tx.query<AccountingPeriod>(
      `SELECT
         id,
         company_id as "companyId",
         code,
         start_date::text as "startDate",
         end_date::text as "endDate",
         is_closed as "isClosed",
         closed_at as "closedAt",
         closed_by as "closedBy",
         created_at as "createdAt"
       FROM accounting_periods
       WHERE company_id = $1
         AND start_date <= $3::date
         AND end_date >= $2::date
       ORDER BY start_date ASC
       ${lockPeriods ? 'FOR UPDATE' : ''}`,
      [companyId, startDate, endDate]
    );
    const coveredPeriods = periodsRes.rows;

    const endDatePeriod =
      coveredPeriods.find((p) => p.startDate <= endDate && p.endDate >= endDate) ?? null;

    // Aggregate posted revenue & expense accounts for [startDate, endDate]
    const pnlRes = await tx.query<any>(
      `SELECT
         a.id as "accountId",
         a.code as "accountCode",
         a.name_ar as "accountNameAr",
         a.account_type as "accountType",
         COALESCE(SUM(l.debit), 0)::text as "d",
         COALESCE(SUM(l.credit), 0)::text as "c"
       FROM accounts a
       INNER JOIN journal_lines l ON l.account_id = a.id AND l.company_id = a.company_id
       INNER JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
       WHERE a.company_id = $1
         AND a.is_postable = true
         AND a.account_type IN ('revenue', 'expense')
         AND e.status = 'posted'
         AND e.entry_date >= $2::date
         AND e.entry_date <= $3::date
       GROUP BY a.id, a.code, a.name_ar, a.account_type
       ORDER BY a.code ASC`,
      [companyId, startDate, endDate]
    );

    const revenueAccounts: YearCloseAccountBalance[] = [];
    const expenseAccounts: YearCloseAccountBalance[] = [];
    let revUnits = BigInt(0);
    let expUnits = BigInt(0);

    for (const r of pnlRes.rows) {
      const d = toMinorUnits(r.d, 2);
      const c = toMinorUnits(r.c, 2);
      if (r.accountType === 'revenue') {
        const net = c - d;
        if (net !== BigInt(0)) {
          revUnits += net;
          revenueAccounts.push({
            accountId: r.accountId,
            accountCode: r.accountCode,
            accountNameAr: r.accountNameAr,
            accountType: 'revenue',
            balance: fromMinorUnits(net, 2),
          });
        }
      } else {
        const net = d - c;
        if (net !== BigInt(0)) {
          expUnits += net;
          expenseAccounts.push({
            accountId: r.accountId,
            accountCode: r.accountCode,
            accountNameAr: r.accountNameAr,
            accountType: 'expense',
            balance: fromMinorUnits(net, 2),
          });
        }
      }
    }

    const netIncomeUnits = revUnits - expUnits;

    return {
      existingCloseId,
      draftEntriesCount,
      coveredPeriods,
      endDatePeriod,
      revenueAccounts,
      expenseAccounts,
      revUnits,
      expUnits,
      netIncomeUnits,
    };
  }

  async previewYearClose(
    companyId: string,
    input: { fiscalYearCode: string; startDate: string; endDate: string }
  ): Promise<FiscalYearClosePreview> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!input.fiscalYearCode || typeof input.fiscalYearCode !== 'string' || !input.fiscalYearCode.trim()) {
      throw new ValidationError('رمز السنة المالية مطلوب');
    }
    const code = input.fiscalYearCode.trim();
    const startDate = assertDate(input.startDate, 'تاريخ بداية السنة المالية');
    const endDate = assertDate(input.endDate, 'تاريخ نهاية السنة المالية');
    if (startDate > endDate) {
      throw new ValidationError('تاريخ بداية السنة المالية يجب أن يكون قبل أو يساوي تاريخ نهايتها');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const data = await this.gatherPnlAndPeriods(companyId, code, startDate, endDate, false, tx);
      const blockingReasons: string[] = [];

      if (data.existingCloseId) {
        blockingReasons.push(`السنة المالية (${code}) مغلقة مسبقاً`);
      }
      if (data.draftEntriesCount > 0) {
        blockingReasons.push(`يوجد ${data.draftEntriesCount} قيد مسودة غير مرحل ضمن نطاق السنة المالية`);
      }
      const hasClosingLines = data.revenueAccounts.length > 0 || data.expenseAccounts.length > 0;
      if (hasClosingLines) {
        if (!data.endDatePeriod) {
          blockingReasons.push(`لا توجد فترة محاسبية مفتوحة تغطي تاريخ نهاية السنة (${endDate}) لترحيل قيد الإقفال`);
        } else if (data.endDatePeriod.isClosed) {
          blockingReasons.push(
            `الفترة المحاسبية (${data.endDatePeriod.code}) المغطية لتاريخ نهاية السنة (${endDate}) مغلقة مسبقاً؛ يرجى فتحها أولاً لترحيل قيد الإقفال`
          );
        }
      }

      const openPeriodsToClose = data.coveredPeriods.filter(
        (p) => !p.isClosed && p.startDate >= startDate && p.endDate <= endDate
      );

      return {
        fiscalYearCode: code,
        startDate,
        endDate,
        alreadyClosed: Boolean(data.existingCloseId),
        existingCloseId: data.existingCloseId,
        draftEntriesCount: data.draftEntriesCount,
        coveredPeriods: data.coveredPeriods,
        openPeriodsToCloseCount: openPeriodsToClose.length,
        endDatePeriod: data.endDatePeriod,
        canExecute: blockingReasons.length === 0,
        blockingReasons,
        revenueAccounts: data.revenueAccounts,
        expenseAccounts: data.expenseAccounts,
        totalRevenue: fromMinorUnits(data.revUnits, 2),
        totalExpenses: fromMinorUnits(data.expUnits, 2),
        netIncome: fromMinorUnits(data.netIncomeUnits, 2),
      };
    });
  }

  /**
   * Executes fiscal year close atomically on top of existing accounting_periods + JournalService:
   * 1) Validates retained earnings equity account & checks no drafts/duplicate close.
   * 2) Builds and posts balanced P&L closing journal entry BEFORE locking/closing periods.
   * 3) Marks all open periods strictly inside [startDate, endDate] as closed and records PERIOD_CLOSE audits.
   * 4) Records fin_fiscal_year_closes & FISCAL_YEAR_CLOSE audit.
   */
  async executeYearClose(
    companyId: string,
    input: ExecuteYearCloseInput,
    actorId: string,
    isPlatformAdmin: boolean = false
  ): Promise<FiscalYearCloseRecord> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!input.fiscalYearCode || typeof input.fiscalYearCode !== 'string' || !input.fiscalYearCode.trim()) {
      throw new ValidationError('رمز السنة المالية مطلوب');
    }
    const fiscalYearCode = input.fiscalYearCode.trim();
    const startDate = assertDate(input.startDate, 'تاريخ بداية السنة المالية');
    const endDate = assertDate(input.endDate, 'تاريخ نهاية السنة المالية');
    if (startDate > endDate) {
      throw new ValidationError('تاريخ بداية السنة المالية يجب أن يكون قبل أو يساوي تاريخ نهايتها');
    }
    if (!input.retainedEarningsAccountId || !isUuid(input.retainedEarningsAccountId)) {
      throw new ValidationError('حساب الأرباح المبقاة (حقوق الملكية) مطلوب');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const reAccount = await this.accountRepo.findById(companyId, input.retainedEarningsAccountId, tx);
      if (!reAccount) {
        throw new NotFoundError('حساب الأرباح المبقاة المحدد غير موجود في دليل حسابات الشركة');
      }
      if (!reAccount.isActive) {
        throw new ValidationError('حساب الأرباح المبقاة غير نشط');
      }
      if (!reAccount.isPostable) {
        throw new ValidationError('حساب الأرباح المبقاة يجب أن يكون حساباً فرعياً قابلاً للترحيل');
      }
      if (reAccount.accountType !== 'equity') {
        throw new ValidationError(
          `حساب ترحيل النتيجة يجب أن يكون من نوع حقوق الملكية (equity) وليس ${reAccount.accountType}`
        );
      }

      const data = await this.gatherPnlAndPeriods(companyId, fiscalYearCode, startDate, endDate, true, tx);

      if (data.existingCloseId) {
        throw new ConflictError(`تم إقفال السنة المالية (${fiscalYearCode}) مسبقاً`);
      }

      if (data.draftEntriesCount > 0) {
        throw new ValidationError(
          `لا يمكن إقفال السنة المالية لوجود (${data.draftEntriesCount}) قيود مسودة غير مرحلة ضمن الفترة`
        );
      }

      const lines: CreateJournalLineInput[] = [];
      for (const rev of data.revenueAccounts) {
        const units = toMinorUnits(rev.balance, 2);
        if (units > BigInt(0)) {
          lines.push({
            accountId: rev.accountId,
            debit: Number(fromMinorUnits(units, 2)),
            credit: 0,
            lineMemo: `إقفال حساب إيرادات ${rev.accountCode} - ${fiscalYearCode}`,
          });
        } else if (units < BigInt(0)) {
          lines.push({
            accountId: rev.accountId,
            debit: 0,
            credit: Number(fromMinorUnits(-units, 2)),
            lineMemo: `إقفال حساب إيرادات ${rev.accountCode} - ${fiscalYearCode}`,
          });
        }
      }

      for (const exp of data.expenseAccounts) {
        const units = toMinorUnits(exp.balance, 2);
        if (units > BigInt(0)) {
          lines.push({
            accountId: exp.accountId,
            debit: 0,
            credit: Number(fromMinorUnits(units, 2)),
            lineMemo: `إقفال حساب مصروفات ${exp.accountCode} - ${fiscalYearCode}`,
          });
        } else if (units < BigInt(0)) {
          lines.push({
            accountId: exp.accountId,
            debit: Number(fromMinorUnits(-units, 2)),
            credit: 0,
            lineMemo: `إقفال حساب مصروفات ${exp.accountCode} - ${fiscalYearCode}`,
          });
        }
      }

      if (data.netIncomeUnits > BigInt(0)) {
        lines.push({
          accountId: reAccount.id,
          debit: 0,
          credit: Number(fromMinorUnits(data.netIncomeUnits, 2)),
          lineMemo: `ترحيل صافي ربح السنة المالية ${fiscalYearCode} إلى الأرباح المبقاة`,
        });
      } else if (data.netIncomeUnits < BigInt(0)) {
        lines.push({
          accountId: reAccount.id,
          debit: Number(fromMinorUnits(-data.netIncomeUnits, 2)),
          credit: 0,
          lineMemo: `ترحيل صافي خسارة السنة المالية ${fiscalYearCode} إلى الأرباح المبقاة`,
        });
      }

      let closingJournalEntryId: string | null = null;
      let closingEntryNo: string | null = null;

      if (lines.length >= 2) {
        if (!data.endDatePeriod) {
          throw new ValidationError(
            `لا توجد فترة محاسبية تغطي تاريخ نهاية السنة المالية (${endDate}) لترحيل قيد الإقفال`
          );
        }
        if (data.endDatePeriod.isClosed) {
          throw new ValidationError(
            `الفترة المحاسبية (${data.endDatePeriod.code}) مغلقة بالفعل ولا يمكن ترحيل قيد إقفال السنة عليها`
          );
        }

        const draft = await this.journalService.createDraftEntry(
          companyId,
          {
            entryDate: endDate,
            memo: `قيد إقفال السنة المالية (${fiscalYearCode}) وترحيل صافي النتيجة إلى ${reAccount.code} - ${reAccount.nameAr}`,
            lines,
          },
          actorId,
          isPlatformAdmin,
          tx
        );

        const posted = await this.journalService.postEntry(
          companyId,
          draft.id,
          actorId,
          isPlatformAdmin,
          tx
        );

        closingJournalEntryId = posted.id;
        closingEntryNo = posted.entryNo || null;
      }

      // Now close all open periods inside [startDate, endDate] on top of existing period mechanism
      const periodsToClose = data.coveredPeriods.filter(
        (p) => !p.isClosed && p.startDate >= startDate && p.endDate <= endDate
      );
      let closedPeriodsCount = 0;
      for (const period of periodsToClose) {
        const updated = await this.periodRepo.setClosed(companyId, period.id, true, actorId, tx);
        if (updated) {
          closedPeriodsCount++;
          await this.auditService.record(
            {
              actorUserId: actorId || null,
              companyId,
              action: 'PERIOD_CLOSE',
              entityType: 'accounting_period',
              entityId: updated.id,
              metadata: {
                code: updated.code,
                closedViaFiscalYear: fiscalYearCode,
              },
            },
            { executor: tx }
          );
        }
      }

      const totalRevenueStr = fromMinorUnits(data.revUnits, 2);
      const totalExpensesStr = fromMinorUnits(data.expUnits, 2);
      const netIncomeStr = fromMinorUnits(data.netIncomeUnits, 2);

      const insertSql = `
        INSERT INTO fin_fiscal_year_closes (
          company_id, fiscal_year_code, start_date, end_date,
          retained_earnings_account_id, closing_journal_entry_id,
          total_revenue, total_expenses, net_income,
          closed_periods_count, notes, closed_by
        )
        VALUES (
          $1, $2, $3::date, $4::date,
          $5, $6,
          $7::numeric, $8::numeric, $9::numeric,
          $10, $11, $12
        )
        RETURNING
          id,
          company_id as "companyId",
          fiscal_year_code as "fiscalYearCode",
          start_date::text as "startDate",
          end_date::text as "endDate",
          retained_earnings_account_id as "retainedEarningsAccountId",
          closing_journal_entry_id as "closingJournalEntryId",
          total_revenue::text as "totalRevenue",
          total_expenses::text as "totalExpenses",
          net_income::text as "netIncome",
          closed_periods_count as "closedPeriodsCount",
          notes,
          closed_by as "closedBy",
          closed_at as "closedAt";
      `;
      const insertRes = await tx.query<any>(insertSql, [
        companyId,
        fiscalYearCode,
        startDate,
        endDate,
        reAccount.id,
        closingJournalEntryId,
        totalRevenueStr,
        totalExpensesStr,
        netIncomeStr,
        closedPeriodsCount,
        input.notes?.trim() || null,
        actorId,
      ]);
      const record = insertRes.rows[0];

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'FISCAL_YEAR_CLOSE',
          entityType: 'fin_fiscal_year_closes',
          entityId: record.id,
          metadata: {
            fiscalYearCode,
            startDate,
            endDate,
            retainedEarningsAccountId: reAccount.id,
            closingJournalEntryId,
            closingEntryNo,
            totalRevenue: totalRevenueStr,
            totalExpenses: totalExpensesStr,
            netIncome: netIncomeStr,
            closedPeriodsCount,
          },
        },
        { executor: tx }
      );

      return {
        ...record,
        retainedEarningsAccountCode: reAccount.code,
        retainedEarningsAccountNameAr: reAccount.nameAr,
        closingEntryNo,
        totalRevenue: totalRevenueStr,
        totalExpenses: totalExpensesStr,
        netIncome: netIncomeStr,
        closedAt:
          typeof record.closedAt === 'string'
            ? record.closedAt
            : new Date(record.closedAt).toISOString(),
      };
    });
  }
}

export const defaultYearCloseService = new YearCloseService();
