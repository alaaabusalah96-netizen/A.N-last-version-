import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { toMinorUnits, fromMinorUnits } from '../lib/numeric.js';
import { ValidationError } from '../http/errors.js';

/**
 * تقارير مالية مبنية على القيود المرحّلة فقط (status='posted').
 * كل تجميع مالي يتم بوحدات صغرى bigint ثم يُعاد كنص عشري.
 * ممنوع جمع number مباشرة على مسار مالي.
 */

export interface GlLineRow {
  entryId: string;
  entryDate: string;
  createdAt: string;
  lineMemo: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
}

export interface GeneralLedgerResult {
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  accountType: string;
  fromDate: string | null;
  toDate: string | null;
  openingBalance: string;
  closingBalance: string;
  totalDebit: string;
  totalCredit: string;
  rows: GlLineRow[];
}

export interface StatementSectionRow {
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  accountType: string;
  amount: string;
}

export interface IncomeStatementResult {
  fromDate: string | null;
  toDate: string | null;
  revenue: StatementSectionRow[];
  expenses: StatementSectionRow[];
  totalRevenue: string;
  totalExpenses: string;
  netIncome: string;
}

export interface BalanceSheetResult {
  asOfDate: string | null;
  assets: StatementSectionRow[];
  liabilities: StatementSectionRow[];
  equity: StatementSectionRow[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  totalLiabilitiesAndEquity: string;
  isBalanced: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string | undefined, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!DATE_RE.test(value)) {
    throw new ValidationError(`${field}: صيغة التاريخ غير صحيحة (المتوقع YYYY-MM-DD)`);
  }
  return value;
}

/** الطبيعي للمدين حسب نوع الحساب: أصول/مصروفات مدين، غيرهم دائن. */
function signedAmount(accountType: string, debitUnits: bigint, creditUnits: bigint): bigint {
  return accountType === 'asset' || accountType === 'expense'
    ? debitUnits - creditUnits
    : creditUnits - debitUnits;
}

export class ReportsService {
  async getGeneralLedger(
    companyId: string,
    accountId: string,
    opts?: { fromDate?: string; toDate?: string }
  ): Promise<GeneralLedgerResult> {
    if (!companyId || typeof companyId !== 'string') throw new ValidationError('companyId is required');
    if (!accountId || typeof accountId !== 'string') throw new ValidationError('accountId is required');

    const fromDate = assertDate(opts?.fromDate, 'fromDate');
    const toDate = assertDate(opts?.toDate, 'toDate');

    return await withTenantTransaction(companyId, async (ex: DbExecutor) => {
      const accRes = await ex.query<any>(
        `SELECT id, code, name_ar as "nameAr", account_type as "accountType"
         FROM accounts WHERE id = $1 AND company_id = $2`,
        [accountId, companyId]
      );
      if (accRes.rows.length === 0) throw new ValidationError('الحساب المحاسبي غير موجود في هذه الشركة');
      const acc = accRes.rows[0];

      const openRes = await ex.query<any>(
        `SELECT COALESCE(SUM(l.debit),0)::text as d, COALESCE(SUM(l.credit),0)::text as c
         FROM journal_lines l
         INNER JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
         WHERE l.company_id = $1 AND l.account_id = $2 AND e.status = 'posted'
           AND ($3::date IS NULL OR e.entry_date < $3::date)`,
        [companyId, accountId, fromDate]
      );
      const openingUnits = signedAmount(
        acc.accountType,
        toMinorUnits(openRes.rows[0]?.d, 2),
        toMinorUnits(openRes.rows[0]?.c, 2)
      );

      const linesRes = await ex.query<any>(
        `SELECT l.id,
                l.entry_id as "entryId",
                e.entry_date::text as "entryDate",
                e.created_at::text as "createdAt",
                l.line_memo as "lineMemo",
                l.debit::text as "debit",
                l.credit::text as "credit"
         FROM journal_lines l
         INNER JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
         WHERE l.company_id = $1 AND l.account_id = $2 AND e.status = 'posted'
           AND ($3::date IS NULL OR e.entry_date >= $3::date)
           AND ($4::date IS NULL OR e.entry_date <= $4::date)
         ORDER BY e.entry_date ASC, e.created_at ASC, l.id ASC`,
        [companyId, accountId, fromDate, toDate]
      );

      let running = openingUnits;
      let totalDebit = BigInt(0);
      let totalCredit = BigInt(0);
      const rows: GlLineRow[] = linesRes.rows.map((r: any) => {
        const d = toMinorUnits(r.debit, 2);
        const c = toMinorUnits(r.credit, 2);
        totalDebit += d;
        totalCredit += c;
        running += (acc.accountType === 'asset' || acc.accountType === 'expense') ? (d - c) : (c - d);
        return {
          entryId: r.entryId,
          entryDate: r.entryDate,
          createdAt: r.createdAt,
          lineMemo: r.lineMemo ?? null,
          debit: fromMinorUnits(d, 2),
          credit: fromMinorUnits(c, 2),
          runningBalance: fromMinorUnits(running, 2),
        };
      });

      return {
        accountId,
        accountCode: acc.code,
        accountNameAr: acc.nameAr,
        accountType: acc.accountType,
        fromDate,
        toDate,
        openingBalance: fromMinorUnits(openingUnits, 2),
        closingBalance: fromMinorUnits(running, 2),
        totalDebit: fromMinorUnits(totalDebit, 2),
        totalCredit: fromMinorUnits(totalCredit, 2),
        rows,
      };
    });
  }

  async getIncomeStatement(
    companyId: string,
    opts?: { fromDate?: string; toDate?: string }
  ): Promise<IncomeStatementResult> {
    if (!companyId || typeof companyId !== 'string') throw new ValidationError('companyId is required');
    const fromDate = assertDate(opts?.fromDate, 'fromDate');
    const toDate = assertDate(opts?.toDate, 'toDate');

    return await withTenantTransaction(companyId, async (ex: DbExecutor) => {
      const res = await ex.query<any>(
        `SELECT a.id as "accountId", a.code as "accountCode", a.name_ar as "accountNameAr",
                a.account_type as "accountType",
                COALESCE(SUM(l.debit),0)::text as "d",
                COALESCE(SUM(l.credit),0)::text as "c"
         FROM accounts a
         INNER JOIN journal_lines l ON l.account_id = a.id AND l.company_id = a.company_id
         INNER JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
         WHERE a.company_id = $1 AND a.is_postable = true AND e.status = 'posted'
           AND a.account_type IN ('revenue','expense')
           AND ($2::date IS NULL OR e.entry_date >= $2::date)
           AND ($3::date IS NULL OR e.entry_date <= $3::date)
         GROUP BY a.id, a.code, a.name_ar, a.account_type
         ORDER BY a.code ASC`,
        [companyId, fromDate, toDate]
      );

      const revenue: StatementSectionRow[] = [];
      const expenses: StatementSectionRow[] = [];
      let revUnits = BigInt(0);
      let expUnits = BigInt(0);

      for (const r of res.rows) {
        const d = toMinorUnits(r.d, 2);
        const c = toMinorUnits(r.c, 2);
        const units = signedAmount(r.accountType, d, c);
        const row: StatementSectionRow = {
          accountId: r.accountId,
          accountCode: r.accountCode,
          accountNameAr: r.accountNameAr,
          accountType: r.accountType,
          amount: fromMinorUnits(units, 2),
        };
        if (r.accountType === 'revenue') { revenue.push(row); revUnits += units; }
        else { expenses.push(row); expUnits += units; }
      }

      return {
        fromDate,
        toDate,
        revenue,
        expenses,
        totalRevenue: fromMinorUnits(revUnits, 2),
        totalExpenses: fromMinorUnits(expUnits, 2),
        netIncome: fromMinorUnits(revUnits - expUnits, 2),
      };
    });
  }

  async getBalanceSheet(
    companyId: string,
    opts?: { asOfDate?: string }
  ): Promise<BalanceSheetResult> {
    if (!companyId || typeof companyId !== 'string') throw new ValidationError('companyId is required');
    const asOfDate = assertDate(opts?.asOfDate, 'asOfDate');

    return await withTenantTransaction(companyId, async (ex: DbExecutor) => {
      const res = await ex.query<any>(
        `SELECT a.id as "accountId", a.code as "accountCode", a.name_ar as "accountNameAr",
                a.account_type as "accountType",
                COALESCE(SUM(l.debit),0)::text as "d",
                COALESCE(SUM(l.credit),0)::text as "c"
         FROM accounts a
         INNER JOIN journal_lines l ON l.account_id = a.id AND l.company_id = a.company_id
         INNER JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
         WHERE a.company_id = $1 AND a.is_postable = true AND e.status = 'posted'
           AND a.account_type IN ('asset','liability','equity')
           AND ($2::date IS NULL OR e.entry_date <= $2::date)
         GROUP BY a.id, a.code, a.name_ar, a.account_type
         ORDER BY a.code ASC`,
        [companyId, asOfDate]
      );

      const assets: StatementSectionRow[] = [];
      const liabilities: StatementSectionRow[] = [];
      const equity: StatementSectionRow[] = [];
      let assetUnits = BigInt(0);
      let liabUnits = BigInt(0);
      let eqUnits = BigInt(0);

      for (const r of res.rows) {
        const units = signedAmount(r.accountType, toMinorUnits(r.d, 2), toMinorUnits(r.c, 2));
        const row: StatementSectionRow = {
          accountId: r.accountId,
          accountCode: r.accountCode,
          accountNameAr: r.accountNameAr,
          accountType: r.accountType,
          amount: fromMinorUnits(units, 2),
        };
        if (r.accountType === 'asset') { assets.push(row); assetUnits += units; }
        else if (r.accountType === 'liability') { liabilities.push(row); liabUnits += units; }
        else { equity.push(row); eqUnits += units; }
      }

      const liabPlusEquity = liabUnits + eqUnits;
      return {
        asOfDate,
        assets,
        liabilities,
        equity,
        totalAssets: fromMinorUnits(assetUnits, 2),
        totalLiabilities: fromMinorUnits(liabUnits, 2),
        totalEquity: fromMinorUnits(eqUnits, 2),
        totalLiabilitiesAndEquity: fromMinorUnits(liabPlusEquity, 2),
        isBalanced: assetUnits === liabPlusEquity,
      };
    });
  }
}

export const defaultReportsService = new ReportsService();
