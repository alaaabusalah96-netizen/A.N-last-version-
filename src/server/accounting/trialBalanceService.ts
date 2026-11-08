import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { defaultOrgUnitService } from '../org/orgUnitService.js';
import { ForbiddenError } from '../http/errors.js';

export interface TrialBalanceRow {
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  accountNameEn?: string | null;
  accountType: string;
  totalDebit: number;
  totalCredit: number;
  netBalance: number;
}

export interface TrialBalanceSummary {
  asOfDate?: string | null;
  orgUnitId?: string | null;
  orgUnitNameAr?: string | null;
  rows: TrialBalanceRow[];
  grandTotalDebit: number;
  grandTotalCredit: number;
  isBalanced: boolean;
}

export class TrialBalanceService {
  /**
   * Generates a Trial Balance summary for a company from POSTED journal lines only.
   * Asserts actor has read scope access for opts.orgUnitId if specified.
   * Uses withTenantTransaction to enforce tenant database isolation.
   */
  async getTrialBalance(
    companyId: string,
    opts?: { asOfDate?: string; orgUnitId?: string },
    actorId?: string,
    isPlatformAdmin: boolean = false
  ): Promise<TrialBalanceSummary> {
    if (actorId && opts?.orgUnitId) {
      const allowed = await defaultOrgUnitService.assertUserOrgAccess(
        companyId,
        actorId,
        opts.orgUnitId,
        'read',
        isPlatformAdmin
      );
      if (!allowed) {
        throw new ForbiddenError('User is not authorized to view trial balance for this organizational unit scope');
      }
    }

    return await withTenantTransaction(companyId, async (executor: DbExecutor) => {
      let orgUnitNameAr: string | null = null;

      if (opts?.orgUnitId) {
        const orgRes = await executor.query<{ name_ar: string }>(
          `SELECT name_ar FROM org_units WHERE id = $1 AND company_id = $2`,
          [opts.orgUnitId, companyId]
        );
        if (orgRes.rows.length > 0) {
          orgUnitNameAr = orgRes.rows[0].name_ar;
        }
      }

      // Aggregate posted journal lines joined with accounts via subquery (posted entries only)
      const sql = `
        SELECT 
          a.id as "accountId",
          a.code as "accountCode",
          a.name_ar as "accountNameAr",
          a.name_en as "accountNameEn",
          a.account_type as "accountType",
          COALESCE(x.total_debit, 0)::float as "totalDebit",
          COALESCE(x.total_credit, 0)::float as "totalCredit",
          (COALESCE(x.total_debit, 0) - COALESCE(x.total_credit, 0))::float as "netBalance"
        FROM accounts a
        LEFT JOIN (
          SELECT 
            l.account_id,
            SUM(l.debit) as total_debit,
            SUM(l.credit) as total_credit
          FROM journal_lines l
          INNER JOIN journal_entries e 
            ON e.id = l.entry_id AND e.company_id = l.company_id
          WHERE e.status = 'posted'
            AND l.company_id = $1
            AND ($2::date IS NULL OR e.entry_date <= $2::date)
            AND ($3::uuid IS NULL OR e.org_unit_id = $3::uuid)
          GROUP BY l.account_id
        ) x ON x.account_id = a.id
        WHERE a.company_id = $1 AND a.is_postable = true
        ORDER BY a.code ASC
      `;

      const res = await executor.query<TrialBalanceRow>(sql, [
        companyId,
        opts?.asOfDate || null,
        opts?.orgUnitId || null,
      ]);

      const rows = res.rows;

      let grandTotalDebit = 0;
      let grandTotalCredit = 0;

      for (const row of rows) {
        grandTotalDebit += Math.round((row.totalDebit || 0) * 100);
        grandTotalCredit += Math.round((row.totalCredit || 0) * 100);
      }

      const finalDebit = grandTotalDebit / 100;
      const finalCredit = grandTotalCredit / 100;

      return {
        asOfDate: opts?.asOfDate || null,
        orgUnitId: opts?.orgUnitId || null,
        orgUnitNameAr,
        rows,
        grandTotalDebit: finalDebit,
        grandTotalCredit: finalCredit,
        isBalanced: Math.abs(grandTotalDebit - grandTotalCredit) === 0,
      };
    });
  }
}

export const defaultTrialBalanceService = new TrialBalanceService();
