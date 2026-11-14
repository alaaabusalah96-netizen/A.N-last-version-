import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import {
  CashVoucher,
  EmployeeCustodyMovementRow,
  RegisterMovementReportRow,
  VoucherKind,
  VoucherListFilters,
  VoucherStatus,
} from './voucherTypes.js';
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

function tableNameForKind(kind: VoucherKind): 'cash_receipt_vouchers' | 'cash_payment_vouchers' {
  return kind === 'receipt' ? 'cash_receipt_vouchers' : 'cash_payment_vouchers';
}

function mapVoucherRow(kind: VoucherKind, row: any): CashVoucher {
  return {
    id: row.id,
    companyId: row.companyId,
    kind,
    voucherNo: row.voucherNo ?? null,
    registerId: row.registerId,
    registerCode: row.registerCode ?? null,
    registerNameAr: row.registerNameAr ?? null,
    voucherDate: toIsoDate(row.voucherDate),
    amount: toMoney(row.amount),
    contraAccountId: row.contraAccountId,
    contraAccountCode: row.contraAccountCode ?? null,
    contraAccountNameAr: row.contraAccountNameAr ?? null,
    status: row.status as VoucherStatus,
    memo: row.memo ?? null,
    reference: row.reference ?? null,
    journalEntryId: row.journalEntryId ?? null,
    journalEntryNo: row.journalEntryNo ?? null,
    postedAt: toIsoTimestamp(row.postedAt),
    postedBy: row.postedBy ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: toIsoTimestamp(row.createdAt) || new Date().toISOString(),
    updatedAt: toIsoTimestamp(row.updatedAt) || new Date().toISOString(),
  };
}

const MOVEMENT_LABELS_AR: Record<string, string> = {
  disburse: 'صرف عهدة',
  settle_expense: 'تسوية مصروف عهدة',
  settle_return: 'مرتجع نقدي من عهدة',
  reverse: 'عكس حركة عهدة',
};

export class VoucherRepository {
  async createDraft(
    kind: VoucherKind,
    companyId: string,
    data: {
      registerId: string;
      voucherDate: string;
      amount: number;
      contraAccountId: string;
      memo: string | null;
      reference: string | null;
      createdBy: string | null;
    },
    tx: DbExecutor
  ): Promise<CashVoucher> {
    const tbl = tableNameForKind(kind);
    const sql = `
      INSERT INTO ${tbl} (
        company_id,
        register_id,
        voucher_date,
        amount,
        contra_account_id,
        status,
        memo,
        reference,
        created_by
      )
      VALUES ($1, $2, $3::date, $4, $5, 'draft', $6, $7, $8)
      RETURNING
        id,
        company_id as "companyId",
        voucher_no as "voucherNo",
        register_id as "registerId",
        voucher_date as "voucherDate",
        amount,
        contra_account_id as "contraAccountId",
        status,
        memo,
        reference,
        journal_entry_id as "journalEntryId",
        posted_at as "postedAt",
        posted_by as "postedBy",
        created_by as "createdBy",
        created_at as "createdAt",
        updated_at as "updatedAt";
    `;
    const res = await tx.query(sql, [
      companyId,
      data.registerId,
      data.voucherDate,
      toMoney(data.amount),
      data.contraAccountId,
      data.memo,
      data.reference,
      data.createdBy,
    ]);
    return mapVoucherRow(kind, res.rows[0]);
  }

  async findById(
    kind: VoucherKind,
    companyId: string,
    id: string,
    customExecutor?: DbExecutor
  ): Promise<CashVoucher | null> {
    const run = async (executor: DbExecutor) => {
      const tbl = tableNameForKind(kind);
      const sql = `
        SELECT
          v.id,
          v.company_id as "companyId",
          v.voucher_no as "voucherNo",
          v.register_id as "registerId",
          cr.code as "registerCode",
          cr.name_ar as "registerNameAr",
          v.voucher_date as "voucherDate",
          v.amount,
          v.contra_account_id as "contraAccountId",
          ca.code as "contraAccountCode",
          ca.name_ar as "contraAccountNameAr",
          v.status,
          v.memo,
          v.reference,
          v.journal_entry_id as "journalEntryId",
          je.entry_no as "journalEntryNo",
          v.posted_at as "postedAt",
          v.posted_by as "postedBy",
          v.created_by as "createdBy",
          v.created_at as "createdAt",
          v.updated_at as "updatedAt"
        FROM ${tbl} v
        INNER JOIN cash_registers cr ON cr.id = v.register_id AND cr.company_id = v.company_id
        INNER JOIN accounts ca ON ca.id = v.contra_account_id AND ca.company_id = v.company_id
        LEFT JOIN journal_entries je ON je.id = v.journal_entry_id AND je.company_id = v.company_id
        WHERE v.company_id = $1 AND v.id = $2;
      `;
      const res = await executor.query(sql, [companyId, id]);
      if (res.rows.length === 0) return null;
      return mapVoucherRow(kind, res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByIdForUpdate(
    kind: VoucherKind,
    companyId: string,
    id: string,
    tx: DbExecutor
  ): Promise<CashVoucher | null> {
    const tbl = tableNameForKind(kind);
    const sql = `
      SELECT
        id,
        company_id as "companyId",
        voucher_no as "voucherNo",
        register_id as "registerId",
        voucher_date as "voucherDate",
        amount,
        contra_account_id as "contraAccountId",
        status,
        memo,
        reference,
        journal_entry_id as "journalEntryId",
        posted_at as "postedAt",
        posted_by as "postedBy",
        created_by as "createdBy",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM ${tbl}
      WHERE company_id = $1 AND id = $2
      FOR UPDATE;
    `;
    const res = await tx.query(sql, [companyId, id]);
    if (res.rows.length === 0) return null;
    return mapVoucherRow(kind, res.rows[0]);
  }

  async listByCompany(
    kind: VoucherKind,
    companyId: string,
    filters: VoucherListFilters = {},
    customExecutor?: DbExecutor
  ): Promise<CashVoucher[]> {
    const run = async (executor: DbExecutor) => {
      const tbl = tableNameForKind(kind);
      const params: unknown[] = [companyId];
      const whereParts: string[] = ['v.company_id = $1'];

      if (filters.status) {
        params.push(filters.status);
        whereParts.push(`v.status = $${params.length}`);
      }
      if (filters.registerId) {
        params.push(filters.registerId);
        whereParts.push(`v.register_id = $${params.length}`);
      }
      if (filters.from) {
        params.push(filters.from);
        whereParts.push(`v.voucher_date >= $${params.length}::date`);
      }
      if (filters.to) {
        params.push(filters.to);
        whereParts.push(`v.voucher_date <= $${params.length}::date`);
      }

      const sql = `
        SELECT
          v.id,
          v.company_id as "companyId",
          v.voucher_no as "voucherNo",
          v.register_id as "registerId",
          cr.code as "registerCode",
          cr.name_ar as "registerNameAr",
          v.voucher_date as "voucherDate",
          v.amount,
          v.contra_account_id as "contraAccountId",
          ca.code as "contraAccountCode",
          ca.name_ar as "contraAccountNameAr",
          v.status,
          v.memo,
          v.reference,
          v.journal_entry_id as "journalEntryId",
          je.entry_no as "journalEntryNo",
          v.posted_at as "postedAt",
          v.posted_by as "postedBy",
          v.created_by as "createdBy",
          v.created_at as "createdAt",
          v.updated_at as "updatedAt"
        FROM ${tbl} v
        INNER JOIN cash_registers cr ON cr.id = v.register_id AND cr.company_id = v.company_id
        INNER JOIN accounts ca ON ca.id = v.contra_account_id AND ca.company_id = v.company_id
        LEFT JOIN journal_entries je ON je.id = v.journal_entry_id AND je.company_id = v.company_id
        WHERE ${whereParts.join(' AND ')}
        ORDER BY v.voucher_date DESC, v.created_at DESC
        LIMIT 200;
      `;
      const res = await executor.query(sql, params);
      return res.rows.map((r) => mapVoucherRow(kind, r));
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async markPosted(
    kind: VoucherKind,
    companyId: string,
    id: string,
    voucherNo: string,
    journalEntryId: string,
    postedBy: string,
    tx: DbExecutor
  ): Promise<void> {
    const tbl = tableNameForKind(kind);
    const sql = `
      UPDATE ${tbl}
      SET
        status = 'posted',
        voucher_no = COALESCE(voucher_no, $3),
        journal_entry_id = $4,
        posted_by = $5,
        posted_at = NOW(),
        updated_at = NOW()
      WHERE company_id = $1 AND id = $2;
    `;
    await tx.query(sql, [companyId, id, voucherNo, journalEntryId, postedBy]);
  }

  async markCancelled(
    kind: VoucherKind,
    companyId: string,
    id: string,
    reason: string | null,
    tx: DbExecutor
  ): Promise<void> {
    const tbl = tableNameForKind(kind);
    const sql = `
      UPDATE ${tbl}
      SET
        status = 'cancelled',
        memo = COALESCE($3, memo),
        updated_at = NOW()
      WHERE company_id = $1 AND id = $2;
    `;
    await tx.query(sql, [companyId, id, reason]);
  }

  async listRegisterMovementRows(
    companyId: string,
    filters: { registerId: string; from?: string; to?: string },
    customExecutor?: DbExecutor
  ): Promise<RegisterMovementReportRow[]> {
    const run = async (executor: DbExecutor) => {
      const params: unknown[] = [companyId, filters.registerId];
      const outerWhere: string[] = ['1=1'];
      if (filters.from) {
        params.push(filters.from);
        outerWhere.push(`m.movement_date >= $${params.length}::date`);
      }
      if (filters.to) {
        params.push(filters.to);
        outerWhere.push(`m.movement_date <= $${params.length}::date`);
      }

      const sql = `
        SELECT
          m.id,
          m.source_type as "sourceType",
          m.movement_label_ar as "movementLabelAr",
          m.movement_date as "movementDate",
          m.in_amount as "inAmount",
          m.out_amount as "outAmount",
          m.reference,
          m.actor_username as "actorUsername",
          m.journal_entry_id as "journalEntryId",
          m.journal_entry_no as "journalEntryNo",
          m.memo,
          m.register_id as "registerId",
          m.register_code as "registerCode",
          m.register_name_ar as "registerNameAr",
          m.created_at as "createdAt"
        FROM (
          SELECT
            cm.id,
            CASE cm.movement_type
              WHEN 'disburse' THEN 'custody_disburse'
              WHEN 'settle_return' THEN 'custody_return'
              ELSE 'custody_reverse'
            END as source_type,
            CASE cm.movement_type
              WHEN 'disburse' THEN 'صرف عهدة'
              WHEN 'settle_return' THEN 'مرتجع عهدة'
              ELSE 'عكس عهدة'
            END as movement_label_ar,
            (cm.created_at AT TIME ZONE 'UTC')::date as movement_date,
            CASE WHEN cm.direction = 'in' THEN cm.amount ELSE 0 END as in_amount,
            CASE WHEN cm.direction = 'out' THEN cm.amount ELSE 0 END as out_amount,
            COALESCE(c.custody_no, c.id::text) as reference,
            COALESCE(u.username, 'system') as actor_username,
            cm.journal_entry_id,
            COALESCE(je.entry_no, '—') as journal_entry_no,
            cm.memo,
            cm.register_id,
            cr.code as register_code,
            cr.name_ar as register_name_ar,
            cm.created_at
          FROM custody_movements cm
          INNER JOIN custody_records c ON c.id = cm.custody_id AND c.company_id = cm.company_id
          INNER JOIN cash_registers cr ON cr.id = cm.register_id AND cr.company_id = cm.company_id
          LEFT JOIN platform_users u ON u.id = cm.created_by
          LEFT JOIN journal_entries je ON je.id = cm.journal_entry_id AND je.company_id = cm.company_id
          WHERE cm.company_id = $1 AND cm.register_id = $2 AND cm.direction IN ('in', 'out')

          UNION ALL

          SELECT
            rv.id,
            'receipt_voucher' as source_type,
            'سند قبض' as movement_label_ar,
            rv.voucher_date as movement_date,
            rv.amount as in_amount,
            0::numeric as out_amount,
            COALESCE(rv.reference, rv.voucher_no, rv.id::text) as reference,
            COALESCE(u.username, 'system') as actor_username,
            rv.journal_entry_id,
            COALESCE(je.entry_no, '—') as journal_entry_no,
            rv.memo,
            rv.register_id,
            cr.code as register_code,
            cr.name_ar as register_name_ar,
            COALESCE(rv.posted_at, rv.created_at) as created_at
          FROM cash_receipt_vouchers rv
          INNER JOIN cash_registers cr ON cr.id = rv.register_id AND cr.company_id = rv.company_id
          LEFT JOIN platform_users u ON u.id = COALESCE(rv.posted_by, rv.created_by)
          LEFT JOIN journal_entries je ON je.id = rv.journal_entry_id AND je.company_id = rv.company_id
          WHERE rv.company_id = $1 AND rv.register_id = $2 AND rv.status = 'posted'

          UNION ALL

          SELECT
            pv.id,
            'payment_voucher' as source_type,
            'سند صرف' as movement_label_ar,
            pv.voucher_date as movement_date,
            0::numeric as in_amount,
            pv.amount as out_amount,
            COALESCE(pv.reference, pv.voucher_no, pv.id::text) as reference,
            COALESCE(u.username, 'system') as actor_username,
            pv.journal_entry_id,
            COALESCE(je.entry_no, '—') as journal_entry_no,
            pv.memo,
            pv.register_id,
            cr.code as register_code,
            cr.name_ar as register_name_ar,
            COALESCE(pv.posted_at, pv.created_at) as created_at
          FROM cash_payment_vouchers pv
          INNER JOIN cash_registers cr ON cr.id = pv.register_id AND cr.company_id = pv.company_id
          LEFT JOIN platform_users u ON u.id = COALESCE(pv.posted_by, pv.created_by)
          LEFT JOIN journal_entries je ON je.id = pv.journal_entry_id AND je.company_id = pv.company_id
          WHERE pv.company_id = $1 AND pv.register_id = $2 AND pv.status = 'posted'
        ) m
        WHERE ${outerWhere.join(' AND ')}
        ORDER BY m.movement_date DESC, m.created_at DESC
        -- Display page only — aggregates use listRegisterPeriodTotals
        LIMIT 500;
      `;
      const res = await executor.query(sql, params);
      return res.rows.map((r: any) => ({
        id: r.id,
        sourceType: r.sourceType,
        movementLabelAr: r.movementLabelAr,
        movementDate: toIsoDate(r.movementDate),
        inAmount: toMoney(r.inAmount),
        outAmount: toMoney(r.outAmount),
        reference: r.reference || '—',
        actorUsername: r.actorUsername || 'system',
        journalEntryId: r.journalEntryId ?? null,
        journalEntryNo: r.journalEntryNo || '—',
        memo: r.memo ?? null,
        registerId: r.registerId,
        registerCode: r.registerCode,
        registerNameAr: r.registerNameAr,
        createdAt: toIsoTimestamp(r.createdAt) || new Date().toISOString(),
      }));
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async listRegisterPeriodTotals(
    companyId: string,
    registerId: string,
    from?: string,
    to?: string,
    customExecutor?: DbExecutor
  ): Promise<{ openingNetBefore: number; totalIn: number; totalOut: number }> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          COALESCE(SUM(
            CASE
              WHEN $3::date IS NOT NULL AND m.movement_date < $3::date
              THEN m.in_amount - m.out_amount
              ELSE 0
            END
          ), 0)::text as "openingNetBefore",
          COALESCE(SUM(
            CASE
              WHEN ($3::date IS NULL OR m.movement_date >= $3::date)
               AND ($4::date IS NULL OR m.movement_date <= $4::date)
              THEN m.in_amount
              ELSE 0
            END
          ), 0)::text as "totalIn",
          COALESCE(SUM(
            CASE
              WHEN ($3::date IS NULL OR m.movement_date >= $3::date)
               AND ($4::date IS NULL OR m.movement_date <= $4::date)
              THEN m.out_amount
              ELSE 0
            END
          ), 0)::text as "totalOut"
        FROM (
          SELECT
            (cm.created_at AT TIME ZONE 'UTC')::date as movement_date,
            CASE WHEN cm.direction = 'in' THEN cm.amount ELSE 0 END as in_amount,
            CASE WHEN cm.direction = 'out' THEN cm.amount ELSE 0 END as out_amount
          FROM custody_movements cm
          WHERE cm.company_id = $1 AND cm.register_id = $2 AND cm.direction IN ('in', 'out')

          UNION ALL

          SELECT
            rv.voucher_date as movement_date,
            rv.amount as in_amount,
            0::numeric as out_amount
          FROM cash_receipt_vouchers rv
          WHERE rv.company_id = $1 AND rv.register_id = $2 AND rv.status = 'posted'

          UNION ALL

          SELECT
            pv.voucher_date as movement_date,
            0::numeric as in_amount,
            pv.amount as out_amount
          FROM cash_payment_vouchers pv
          WHERE pv.company_id = $1 AND pv.register_id = $2 AND pv.status = 'posted'
        ) m;
      `;
      const res = await executor.query<{ openingNetBefore: string; totalIn: string; totalOut: string }>(sql, [
        companyId,
        registerId,
        from || null,
        to || null,
      ]);
      const row = res.rows[0];
      return {
        openingNetBefore: toMoney(row?.openingNetBefore ?? 0),
        totalIn: toMoney(row?.totalIn ?? 0),
        totalOut: toMoney(row?.totalOut ?? 0),
      };
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async listEmployeeCustodyMovements(
    companyId: string,
    employeeUserId: string,
    customExecutor?: DbExecutor
  ): Promise<EmployeeCustodyMovementRow[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          cm.id,
          cm.custody_id as "custodyId",
          COALESCE(c.custody_no, c.id::text) as "custodyNo",
          c.status as "custodyStatus",
          cm.register_id as "registerId",
          cr.code as "registerCode",
          cr.name_ar as "registerNameAr",
          cm.movement_type as "movementType",
          cm.direction,
          cm.amount,
          cm.expense_account_id as "expenseAccountId",
          ea.code as "expenseAccountCode",
          ea.name_ar as "expenseAccountNameAr",
          cm.journal_entry_id as "journalEntryId",
          COALESCE(je.entry_no, '—') as "journalEntryNo",
          cm.memo,
          cm.created_at as "createdAt"
        FROM custody_movements cm
        INNER JOIN custody_records c ON c.id = cm.custody_id AND c.company_id = cm.company_id
        INNER JOIN cash_registers cr ON cr.id = cm.register_id AND cr.company_id = cm.company_id
        LEFT JOIN accounts ea ON ea.id = cm.expense_account_id AND ea.company_id = cm.company_id
        LEFT JOIN journal_entries je ON je.id = cm.journal_entry_id AND je.company_id = cm.company_id
        WHERE cm.company_id = $1 AND c.employee_user_id = $2
        ORDER BY cm.created_at DESC
        LIMIT 300;
      `;
      const res = await executor.query(sql, [companyId, employeeUserId]);
      return res.rows.map((r: any) => ({
        id: r.id,
        custodyId: r.custodyId,
        custodyNo: r.custodyNo,
        custodyStatus: r.custodyStatus,
        registerId: r.registerId,
        registerCode: r.registerCode,
        registerNameAr: r.registerNameAr,
        movementType: r.movementType,
        movementLabelAr: MOVEMENT_LABELS_AR[r.movementType] || r.movementType,
        direction: r.direction,
        amount: toMoney(r.amount),
        expenseAccountId: r.expenseAccountId ?? null,
        expenseAccountCode: r.expenseAccountCode ?? null,
        expenseAccountNameAr: r.expenseAccountNameAr ?? null,
        journalEntryId: r.journalEntryId ?? null,
        journalEntryNo: r.journalEntryNo || '—',
        memo: r.memo ?? null,
        createdAt: toIsoTimestamp(r.createdAt) || new Date().toISOString(),
      }));
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultVoucherRepository = new VoucherRepository();
