import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { AccountingPeriod, CreatePeriodInput } from './periodTypes.js';

export class PeriodRepository {
  /**
   * List all accounting periods for a company ordered by start_date descending.
   */
  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<AccountingPeriod[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
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
        ORDER BY start_date DESC, code DESC
      `;
      const res = await executor.query<AccountingPeriod>(sql, [companyId]);
      return res.rows;
    };

    if (customExecutor) {
      return await run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Find period by its ID.
   */
  async findById(companyId: string, periodId: string, customExecutor?: DbExecutor): Promise<AccountingPeriod | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
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
        WHERE id = $1 AND company_id = $2
      `;
      const res = await executor.query<AccountingPeriod>(sql, [periodId, companyId]);
      return res.rows[0] || null;
    };

    if (customExecutor) {
      return await run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Find period covering a specific entry date (start_date <= entryDate <= end_date).
   */
  async findCoveringDate(companyId: string, entryDate: string, customExecutor?: DbExecutor): Promise<AccountingPeriod | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
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
          AND start_date <= $2::date 
          AND end_date >= $2::date
        ORDER BY is_closed ASC, created_at DESC
        LIMIT 1
      `;
      const res = await executor.query<AccountingPeriod>(sql, [companyId, entryDate]);
      return res.rows[0] || null;
    };

    if (customExecutor) {
      return await run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Find period by its code within a company.
   */
  async findByCode(companyId: string, code: string, customExecutor?: DbExecutor): Promise<AccountingPeriod | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
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
        WHERE company_id = $1 AND code = $2
      `;
      const res = await executor.query<AccountingPeriod>(sql, [companyId, code.trim()]);
      return res.rows[0] || null;
    };

    if (customExecutor) {
      return await run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Create a new accounting period.
   */
  async create(companyId: string, input: CreatePeriodInput, customExecutor?: DbExecutor): Promise<AccountingPeriod> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        INSERT INTO accounting_periods (company_id, code, start_date, end_date, is_closed)
        VALUES ($1, $2, $3::date, $4::date, false)
        RETURNING 
          id, 
          company_id as "companyId", 
          code, 
          start_date::text as "startDate", 
          end_date::text as "endDate", 
          is_closed as "isClosed", 
          closed_at as "closedAt", 
          closed_by as "closedBy", 
          created_at as "createdAt"
      `;
      const res = await executor.query<AccountingPeriod>(sql, [
        companyId,
        input.code.trim(),
        input.startDate,
        input.endDate,
      ]);
      return res.rows[0];
    };

    if (customExecutor) {
      return await run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Close or reopen an accounting period.
   */
  async setClosed(
    companyId: string,
    periodId: string,
    isClosed: boolean,
    actorId?: string,
    customExecutor?: DbExecutor
  ): Promise<AccountingPeriod | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        UPDATE accounting_periods
        SET 
          is_closed = $3,
          closed_at = CASE WHEN $3 = true THEN NOW() ELSE NULL END,
          closed_by = CASE WHEN $3 = true THEN $4::uuid ELSE NULL END
        WHERE id = $1 AND company_id = $2
        RETURNING 
          id, 
          company_id as "companyId", 
          code, 
          start_date::text as "startDate", 
          end_date::text as "endDate", 
          is_closed as "isClosed", 
          closed_at as "closedAt", 
          closed_by as "closedBy", 
          created_at as "createdAt"
      `;
      const res = await executor.query<AccountingPeriod>(sql, [
        periodId,
        companyId,
        isClosed,
        actorId || null,
      ]);
      return res.rows[0] || null;
    };

    if (customExecutor) {
      return await run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultPeriodRepository = new PeriodRepository();
