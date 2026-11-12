import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { defaultOrgUnitService } from '../org/orgUnitService.js';
import { ForbiddenError, ValidationError } from '../http/errors.js';
import { toMinorUnits, fromMinorUnits } from '../lib/numeric.js';

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
    if (actorId && !isPlatformAdmin) {
      const userScopes = await defaultOrgUnitService.listUserScopes(companyId, actorId);
      if (userScopes.length > 0) {
        if (!opts?.orgUnitId) {
          throw new ValidationError('Organizational unit filter (orgUnitId) is required for scoped users to generate Trial Balance');
        }
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
    } else if (actorId && opts?.orgUnitId) {
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
          COALESCE(x.total_debit, 0)::text as "totalDebit",
          COALESCE(x.total_credit, 0)::text as "totalCredit",
          (COALESCE(x.total_debit, 0) - COALESCE(x.total_credit, 0))::text as "netBalance"
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

      const mappedRows: TrialBalanceRow[] = res.rows.map((r: any) => ({
        ...r,
        totalDebit: Number(fromMinorUnits(toMinorUnits(r.totalDebit, 2), 2)),
        totalCredit: Number(fromMinorUnits(toMinorUnits(r.totalCredit, 2), 2)),
        netBalance: Number(fromMinorUnits(toMinorUnits(r.netBalance, 2), 2)),
      }));

      let debitUnits = BigInt(0);
      let creditUnits = BigInt(0);
      for (const row of res.rows) {
        debitUnits += toMinorUnits((row as any).totalDebit, 2);
        creditUnits += toMinorUnits((row as any).totalCredit, 2);
      }

      return {
        asOfDate: opts?.asOfDate || null,
        orgUnitId: opts?.orgUnitId || null,
        orgUnitNameAr,
        rows: mappedRows,
        grandTotalDebit: Number(fromMinorUnits(debitUnits, 2)),
        grandTotalCredit: Number(fromMinorUnits(creditUnits, 2)),
        isBalanced: debitUnits === creditUnits,
      };
    });
  }
}

export const defaultTrialBalanceService = new TrialBalanceService();
