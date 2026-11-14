import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import {
  CustodyListFilters,
  CustodyMovement,
  CustodyRecord,
  CustodyStatus,
  OpenCustodyEmployeeSummary,
} from './cashTypes.js';
import { toMoney } from '../lib/numeric.js';

function toIsoDate(val: unknown): string {
  if (!val) return '';
  if (typeof val === 'string') return val.slice(0, 10);
  return new Date(val as Date).toISOString().slice(0, 10);
}

function toIsoTimestamp(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'string') return val;
  return new Date(val as Date).toISOString();
}

function mapCustodyRow(row: any): CustodyRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    custodyNo: row.custodyNo ?? null,
    employeeUserId: row.employeeUserId,
    employeeUsername: row.employeeUsername ?? null,
    registerId: row.registerId,
    registerCode: row.registerCode ?? null,
    registerNameAr: row.registerNameAr ?? null,
    amount: toMoney(row.amount),
    purpose: row.purpose,
    status: row.status as CustodyStatus,
    requestDate: toIsoDate(row.requestDate),
    requestedBy: row.requestedBy ?? null,
    approvedBy: row.approvedBy ?? null,
    approvedAt: toIsoTimestamp(row.approvedAt),
    rejectedBy: row.rejectedBy ?? null,
    rejectedAt: toIsoTimestamp(row.rejectedAt),
    rejectReason: row.rejectReason ?? null,
    disbursedBy: row.disbursedBy ?? null,
    disbursedAt: toIsoTimestamp(row.disbursedAt),
    settledBy: row.settledBy ?? null,
    settledAt: toIsoTimestamp(row.settledAt),
    disburseJournalEntryId: row.disburseJournalEntryId ?? null,
    disburseJournalEntryNo: row.disburseJournalEntryNo ?? null,
    settleJournalEntryId: row.settleJournalEntryId ?? null,
    settleJournalEntryNo: row.settleJournalEntryNo ?? null,
    settledExpenseTotal:
      row.settledExpenseTotal !== null && row.settledExpenseTotal !== undefined
        ? toMoney(row.settledExpenseTotal)
        : null,
    settledCashReturn:
      row.settledCashReturn !== null && row.settledCashReturn !== undefined
        ? toMoney(row.settledCashReturn)
        : null,
    memo: row.memo ?? null,
    createdAt: toIsoTimestamp(row.createdAt) || new Date().toISOString(),
    updatedAt: toIsoTimestamp(row.updatedAt) || new Date().toISOString(),
  };
}

function mapMovementRow(row: any): CustodyMovement {
  return {
    id: row.id,
    companyId: row.companyId,
    custodyId: row.custodyId,
    registerId: row.registerId,
    movementType: row.movementType,
    direction: row.direction,
    amount: toMoney(row.amount),
    expenseAccountId: row.expenseAccountId ?? null,
    expenseAccountCode: row.expenseAccountCode ?? null,
    expenseAccountNameAr: row.expenseAccountNameAr ?? null,
    journalEntryId: row.journalEntryId ?? null,
    journalEntryNo: row.journalEntryNo ?? null,
    memo: row.memo ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: toIsoTimestamp(row.createdAt) || new Date().toISOString(),
  };
}

export class CustodyRepository {
  async create(
    companyId: string,
    data: {
      custodyNo: string;
      employeeUserId: string;
      registerId: string;
      amount: number;
      purpose: string;
      requestDate: string;
      requestedBy: string | null;
      memo: string | null;
    },
    tx: DbExecutor
  ): Promise<CustodyRecord> {
    const sql = `
      INSERT INTO custody_records (
        company_id,
        custody_no,
        employee_user_id,
        register_id,
        amount,
        purpose,
        status,
        request_date,
        requested_by,
        memo
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::date, $8, $9)
      RETURNING
        id,
        company_id as "companyId",
        custody_no as "custodyNo",
        employee_user_id as "employeeUserId",
        register_id as "registerId",
        amount,
        purpose,
        status,
        request_date as "requestDate",
        requested_by as "requestedBy",
        approved_by as "approvedBy",
        approved_at as "approvedAt",
        rejected_by as "rejectedBy",
        rejected_at as "rejectedAt",
        reject_reason as "rejectReason",
        disbursed_by as "disbursedBy",
        disbursed_at as "disbursedAt",
        settled_by as "settledBy",
        settled_at as "settledAt",
        disburse_journal_entry_id as "disburseJournalEntryId",
        settle_journal_entry_id as "settleJournalEntryId",
        settled_expense_total as "settledExpenseTotal",
        settled_cash_return as "settledCashReturn",
        memo,
        created_at as "createdAt",
        updated_at as "updatedAt";
    `;
    const res = await tx.query(sql, [
      companyId,
      data.custodyNo,
      data.employeeUserId,
      data.registerId,
      toMoney(data.amount),
      data.purpose,
      data.requestDate,
      data.requestedBy,
      data.memo,
    ]);
    return mapCustodyRow(res.rows[0]);
  }

  async findById(companyId: string, id: string, customExecutor?: DbExecutor): Promise<CustodyRecord | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          c.id,
          c.company_id as "companyId",
          c.custody_no as "custodyNo",
          c.employee_user_id as "employeeUserId",
          emp.username as "employeeUsername",
          c.register_id as "registerId",
          cr.code as "registerCode",
          cr.name_ar as "registerNameAr",
          c.amount,
          c.purpose,
          c.status,
          c.request_date as "requestDate",
          c.requested_by as "requestedBy",
          c.approved_by as "approvedBy",
          c.approved_at as "approvedAt",
          c.rejected_by as "rejectedBy",
          c.rejected_at as "rejectedAt",
          c.reject_reason as "rejectReason",
          c.disbursed_by as "disbursedBy",
          c.disbursed_at as "disbursedAt",
          c.settled_by as "settledBy",
          c.settled_at as "settledAt",
          c.disburse_journal_entry_id as "disburseJournalEntryId",
          dje.entry_no as "disburseJournalEntryNo",
          c.settle_journal_entry_id as "settleJournalEntryId",
          sje.entry_no as "settleJournalEntryNo",
          c.settled_expense_total as "settledExpenseTotal",
          c.settled_cash_return as "settledCashReturn",
          c.memo,
          c.created_at as "createdAt",
          c.updated_at as "updatedAt"
        FROM custody_records c
        LEFT JOIN platform_users emp ON emp.id = c.employee_user_id
        INNER JOIN cash_registers cr ON cr.id = c.register_id AND cr.company_id = c.company_id
        LEFT JOIN journal_entries dje ON dje.id = c.disburse_journal_entry_id AND dje.company_id = c.company_id
        LEFT JOIN journal_entries sje ON sje.id = c.settle_journal_entry_id AND sje.company_id = c.company_id
        WHERE c.company_id = $1 AND c.id = $2;
      `;
      const res = await executor.query(sql, [companyId, id]);
      if (res.rows.length === 0) return null;
      return mapCustodyRow(res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByIdForUpdate(companyId: string, id: string, tx: DbExecutor): Promise<CustodyRecord | null> {
    const sql = `
      SELECT
        id,
        company_id as "companyId",
        custody_no as "custodyNo",
        employee_user_id as "employeeUserId",
        register_id as "registerId",
        amount,
        purpose,
        status,
        request_date as "requestDate",
        requested_by as "requestedBy",
        approved_by as "approvedBy",
        approved_at as "approvedAt",
        rejected_by as "rejectedBy",
        rejected_at as "rejectedAt",
        reject_reason as "rejectReason",
        disbursed_by as "disbursedBy",
        disbursed_at as "disbursedAt",
        settled_by as "settledBy",
        settled_at as "settledAt",
        disburse_journal_entry_id as "disburseJournalEntryId",
        settle_journal_entry_id as "settleJournalEntryId",
        settled_expense_total as "settledExpenseTotal",
        settled_cash_return as "settledCashReturn",
        memo,
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM custody_records
      WHERE company_id = $1 AND id = $2
      FOR UPDATE;
    `;
    const res = await tx.query(sql, [companyId, id]);
    if (res.rows.length === 0) return null;
    return mapCustodyRow(res.rows[0]);
  }

  async listByCompany(
    companyId: string,
    filters: CustodyListFilters = {},
    customExecutor?: DbExecutor
  ): Promise<CustodyRecord[]> {
    const run = async (executor: DbExecutor) => {
      const params: unknown[] = [companyId];
      const whereParts: string[] = ['c.company_id = $1'];

      if (filters.status) {
        params.push(filters.status);
        whereParts.push(`c.status = $${params.length}`);
      }
      if (filters.employeeUserId) {
        params.push(filters.employeeUserId);
        whereParts.push(`c.employee_user_id = $${params.length}`);
      }
      if (filters.registerId) {
        params.push(filters.registerId);
        whereParts.push(`c.register_id = $${params.length}`);
      }
      if (filters.from) {
        params.push(filters.from);
        whereParts.push(`c.request_date >= $${params.length}::date`);
      }
      if (filters.to) {
        params.push(filters.to);
        whereParts.push(`c.request_date <= $${params.length}::date`);
      }

      const sql = `
        SELECT
          c.id,
          c.company_id as "companyId",
          c.custody_no as "custodyNo",
          c.employee_user_id as "employeeUserId",
          emp.username as "employeeUsername",
          c.register_id as "registerId",
          cr.code as "registerCode",
          cr.name_ar as "registerNameAr",
          c.amount,
          c.purpose,
          c.status,
          c.request_date as "requestDate",
          c.requested_by as "requestedBy",
          c.approved_by as "approvedBy",
          c.approved_at as "approvedAt",
          c.rejected_by as "rejectedBy",
          c.rejected_at as "rejectedAt",
          c.reject_reason as "rejectReason",
          c.disbursed_by as "disbursedBy",
          c.disbursed_at as "disbursedAt",
          c.settled_by as "settledBy",
          c.settled_at as "settledAt",
          c.disburse_journal_entry_id as "disburseJournalEntryId",
          dje.entry_no as "disburseJournalEntryNo",
          c.settle_journal_entry_id as "settleJournalEntryId",
          sje.entry_no as "settleJournalEntryNo",
          c.settled_expense_total as "settledExpenseTotal",
          c.settled_cash_return as "settledCashReturn",
          c.memo,
          c.created_at as "createdAt",
          c.updated_at as "updatedAt"
        FROM custody_records c
        LEFT JOIN platform_users emp ON emp.id = c.employee_user_id
        INNER JOIN cash_registers cr ON cr.id = c.register_id AND cr.company_id = c.company_id
        LEFT JOIN journal_entries dje ON dje.id = c.disburse_journal_entry_id AND dje.company_id = c.company_id
        LEFT JOIN journal_entries sje ON sje.id = c.settle_journal_entry_id AND sje.company_id = c.company_id
        WHERE ${whereParts.join(' AND ')}
        ORDER BY c.created_at DESC
        LIMIT 100;
      `;
      const res = await executor.query(sql, params);
      return res.rows.map(mapCustodyRow);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async setStatus(
    companyId: string,
    id: string,
    patch: {
      status: CustodyStatus;
      approvedBy?: string | null;
      approvedAt?: boolean;
      memo?: string | null;
    },
    tx: DbExecutor
  ): Promise<void> {
    const sets: string[] = ['status = $3', 'updated_at = NOW()'];
    const params: unknown[] = [companyId, id, patch.status];

    if (patch.approvedBy !== undefined) {
      params.push(patch.approvedBy);
      sets.push(`approved_by = $${params.length}`);
    }
    if (patch.approvedAt) {
      sets.push('approved_at = NOW()');
    }
    if (patch.memo !== undefined) {
      params.push(patch.memo);
      sets.push(`memo = $${params.length}`);
    }

    const sql = `
      UPDATE custody_records
      SET ${sets.join(', ')}
      WHERE company_id = $1 AND id = $2;
    `;
    await tx.query(sql, params);
  }

  async markDisbursed(
    companyId: string,
    id: string,
    disbursedBy: string,
    disburseJournalEntryId: string,
    tx: DbExecutor
  ): Promise<void> {
    const sql = `
      UPDATE custody_records
      SET
        status = 'open',
        disbursed_by = $3,
        disbursed_at = NOW(),
        disburse_journal_entry_id = $4,
        updated_at = NOW()
      WHERE company_id = $1 AND id = $2;
    `;
    await tx.query(sql, [companyId, id, disbursedBy, disburseJournalEntryId]);
  }

  async markSettled(
    companyId: string,
    id: string,
    settledBy: string,
    settleJournalEntryId: string,
    settledExpenseTotal: number,
    settledCashReturn: number,
    memo: string | null,
    tx: DbExecutor
  ): Promise<void> {
    const sql = `
      UPDATE custody_records
      SET
        status = 'settled',
        settled_by = $3,
        settled_at = NOW(),
        settle_journal_entry_id = $4,
        settled_expense_total = $5,
        settled_cash_return = $6,
        memo = COALESCE($7, memo),
        updated_at = NOW()
      WHERE company_id = $1 AND id = $2;
    `;
    await tx.query(sql, [
      companyId,
      id,
      settledBy,
      settleJournalEntryId,
      toMoney(settledExpenseTotal),
      toMoney(settledCashReturn),
      memo,
    ]);
  }

  async markRejected(
    companyId: string,
    id: string,
    rejectedBy: string,
    rejectReason: string,
    tx: DbExecutor
  ): Promise<void> {
    const sql = `
      UPDATE custody_records
      SET
        status = 'rejected',
        rejected_by = $3,
        rejected_at = NOW(),
        reject_reason = $4,
        updated_at = NOW()
      WHERE company_id = $1 AND id = $2;
    `;
    await tx.query(sql, [companyId, id, rejectedBy, rejectReason]);
  }

  async markCancelled(
    companyId: string,
    id: string,
    reason: string | null,
    tx: DbExecutor
  ): Promise<void> {
    const sql = `
      UPDATE custody_records
      SET
        status = 'cancelled',
        memo = COALESCE($3, memo),
        updated_at = NOW()
      WHERE company_id = $1 AND id = $2;
    `;
    await tx.query(sql, [companyId, id, reason]);
  }

  async listOpenByEmployee(
    companyId: string,
    employeeUserId?: string,
    customExecutor?: DbExecutor
  ): Promise<OpenCustodyEmployeeSummary[]> {
    const run = async (executor: DbExecutor) => {
      const params: unknown[] = [companyId];
      let filterSql = '';
      if (employeeUserId) {
        params.push(employeeUserId);
        filterSql = ` AND c.employee_user_id = $${params.length}`;
      }
      const sql = `
        SELECT
          c.employee_user_id as "employeeUserId",
          COALESCE(u.username, '') as "employeeUsername",
          COUNT(*)::int as "openCount",
          COALESCE(SUM(c.amount), 0)::numeric as "totalAmount"
        FROM custody_records c
        LEFT JOIN platform_users u ON u.id = c.employee_user_id
        WHERE c.company_id = $1 AND c.status = 'open'${filterSql}
        GROUP BY c.employee_user_id, u.username
        ORDER BY "totalAmount" DESC;
      `;
      const res = await executor.query<{
        employeeUserId: string;
        employeeUsername: string;
        openCount: number;
        totalAmount: string | number;
      }>(sql, params);
      return res.rows.map((r) => ({
        employeeUserId: r.employeeUserId,
        employeeUsername: r.employeeUsername,
        openCount: Number(r.openCount),
        totalAmount: toMoney(r.totalAmount),
      }));
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async insertMovement(
    companyId: string,
    movement: {
      custodyId: string;
      registerId: string;
      movementType: 'disburse' | 'settle_expense' | 'settle_return' | 'reverse';
      direction: 'out' | 'in' | 'none';
      amount: number;
      expenseAccountId: string | null;
      journalEntryId: string | null;
      memo: string | null;
      createdBy: string | null;
    },
    tx: DbExecutor
  ): Promise<CustodyMovement> {
    const sql = `
      INSERT INTO custody_movements (
        company_id,
        custody_id,
        register_id,
        movement_type,
        direction,
        amount,
        expense_account_id,
        journal_entry_id,
        memo,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING
        id,
        company_id as "companyId",
        custody_id as "custodyId",
        register_id as "registerId",
        movement_type as "movementType",
        direction,
        amount,
        expense_account_id as "expenseAccountId",
        journal_entry_id as "journalEntryId",
        memo,
        created_by as "createdBy",
        created_at as "createdAt";
    `;
    const res = await tx.query(sql, [
      companyId,
      movement.custodyId,
      movement.registerId,
      movement.movementType,
      movement.direction,
      toMoney(movement.amount),
      movement.expenseAccountId,
      movement.journalEntryId,
      movement.memo,
      movement.createdBy,
    ]);
    return mapMovementRow(res.rows[0]);
  }

  async listMovements(
    companyId: string,
    filters: { custodyId?: string; registerId?: string },
    customExecutor?: DbExecutor
  ): Promise<CustodyMovement[]> {
    const run = async (executor: DbExecutor) => {
      const params: unknown[] = [companyId];
      const whereParts: string[] = ['m.company_id = $1'];
      if (filters.custodyId) {
        params.push(filters.custodyId);
        whereParts.push(`m.custody_id = $${params.length}`);
      }
      if (filters.registerId) {
        params.push(filters.registerId);
        whereParts.push(`m.register_id = $${params.length}`);
      }
      const sql = `
        SELECT
          m.id,
          m.company_id as "companyId",
          m.custody_id as "custodyId",
          m.register_id as "registerId",
          m.movement_type as "movementType",
          m.direction,
          m.amount,
          m.expense_account_id as "expenseAccountId",
          a.code as "expenseAccountCode",
          a.name_ar as "expenseAccountNameAr",
          m.journal_entry_id as "journalEntryId",
          je.entry_no as "journalEntryNo",
          m.memo,
          m.created_by as "createdBy",
          m.created_at as "createdAt"
        FROM custody_movements m
        LEFT JOIN accounts a ON a.id = m.expense_account_id AND a.company_id = m.company_id
        LEFT JOIN journal_entries je ON je.id = m.journal_entry_id AND je.company_id = m.company_id
        WHERE ${whereParts.join(' AND ')}
        ORDER BY m.created_at DESC;
      `;
      const res = await executor.query(sql, params);
      return res.rows.map(mapMovementRow);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultCustodyRepository = new CustodyRepository();
