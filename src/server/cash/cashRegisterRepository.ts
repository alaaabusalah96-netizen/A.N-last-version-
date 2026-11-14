import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { CashRegister, CreateCashRegisterInput, UpdateCashRegisterInput, CustodyMovement } from './cashTypes.js';
import { toMoney } from '../lib/numeric.js';

function mapRegister(row: any): CashRegister {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    nameAr: row.nameAr,
    nameEn: row.nameEn ?? null,
    glAccountId: row.glAccountId,
    isActive: Boolean(row.isActive),
    openingBalance: toMoney(row.openingBalance ?? 0),
    memo: row.memo ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(row.createdAt).toISOString(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date(row.updatedAt).toISOString(),
  };
}

export class CashRegisterRepository {
  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<CashRegister[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          id,
          company_id as "companyId",
          code,
          name_ar as "nameAr",
          name_en as "nameEn",
          gl_account_id as "glAccountId",
          is_active as "isActive",
          opening_balance as "openingBalance",
          memo,
          created_by as "createdBy",
          created_at as "createdAt",
          updated_at as "updatedAt"
        FROM cash_registers
        WHERE company_id = $1
        ORDER BY created_at ASC;
      `;
      const res = await executor.query(sql, [companyId]);
      return res.rows.map(mapRegister);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, id: string, customExecutor?: DbExecutor): Promise<CashRegister | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          id,
          company_id as "companyId",
          code,
          name_ar as "nameAr",
          name_en as "nameEn",
          gl_account_id as "glAccountId",
          is_active as "isActive",
          opening_balance as "openingBalance",
          memo,
          created_by as "createdBy",
          created_at as "createdAt",
          updated_at as "updatedAt"
        FROM cash_registers
        WHERE company_id = $1 AND id = $2;
      `;
      const res = await executor.query(sql, [companyId, id]);
      if (res.rows.length === 0) return null;
      return mapRegister(res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByCode(companyId: string, code: string, customExecutor?: DbExecutor): Promise<CashRegister | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          id,
          company_id as "companyId",
          code,
          name_ar as "nameAr",
          name_en as "nameEn",
          gl_account_id as "glAccountId",
          is_active as "isActive",
          opening_balance as "openingBalance",
          memo,
          created_by as "createdBy",
          created_at as "createdAt",
          updated_at as "updatedAt"
        FROM cash_registers
        WHERE company_id = $1 AND code = $2;
      `;
      const res = await executor.query(sql, [companyId, code]);
      if (res.rows.length === 0) return null;
      return mapRegister(res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByGlAccount(companyId: string, glAccountId: string, customExecutor?: DbExecutor): Promise<CashRegister | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          id,
          company_id as "companyId",
          code,
          name_ar as "nameAr",
          name_en as "nameEn",
          gl_account_id as "glAccountId",
          is_active as "isActive",
          opening_balance as "openingBalance",
          memo,
          created_by as "createdBy",
          created_at as "createdAt",
          updated_at as "updatedAt"
        FROM cash_registers
        WHERE company_id = $1 AND gl_account_id = $2;
      `;
      const res = await executor.query(sql, [companyId, glAccountId]);
      if (res.rows.length === 0) return null;
      return mapRegister(res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async lockForUpdate(companyId: string, id: string, tx: DbExecutor): Promise<CashRegister | null> {
    const sql = `
      SELECT
        id,
        company_id as "companyId",
        code,
        name_ar as "nameAr",
        name_en as "nameEn",
        gl_account_id as "glAccountId",
        is_active as "isActive",
        opening_balance as "openingBalance",
        memo,
        created_by as "createdBy",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM cash_registers
      WHERE company_id = $1 AND id = $2
      FOR UPDATE;
    `;
    const res = await tx.query(sql, [companyId, id]);
    if (res.rows.length === 0) return null;
    return mapRegister(res.rows[0]);
  }

  async create(companyId: string, input: CreateCashRegisterInput, actorId: string | null, customExecutor?: DbExecutor): Promise<CashRegister> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        INSERT INTO cash_registers (
          company_id,
          code,
          name_ar,
          name_en,
          gl_account_id,
          is_active,
          opening_balance,
          memo,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)
        RETURNING
          id,
          company_id as "companyId",
          code,
          name_ar as "nameAr",
          name_en as "nameEn",
          gl_account_id as "glAccountId",
          is_active as "isActive",
          opening_balance as "openingBalance",
          memo,
          created_by as "createdBy",
          created_at as "createdAt",
          updated_at as "updatedAt";
      `;
      const opening = toMoney(input.openingBalance ?? 0);
      const res = await executor.query(sql, [
        companyId,
        input.code.trim(),
        input.nameAr.trim(),
        input.nameEn?.trim() || null,
        input.glAccountId,
        opening,
        input.memo?.trim() || null,
        actorId || null,
      ]);
      return mapRegister(res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async update(companyId: string, id: string, input: UpdateCashRegisterInput, customExecutor?: DbExecutor): Promise<CashRegister> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        UPDATE cash_registers
        SET
          code = COALESCE($3, code),
          name_ar = COALESCE($4, name_ar),
          name_en = CASE WHEN $5 THEN $6 ELSE name_en END,
          memo = CASE WHEN $7 THEN $8 ELSE memo END,
          updated_at = NOW()
        WHERE company_id = $1 AND id = $2
        RETURNING
          id,
          company_id as "companyId",
          code,
          name_ar as "nameAr",
          name_en as "nameEn",
          gl_account_id as "glAccountId",
          is_active as "isActive",
          opening_balance as "openingBalance",
          memo,
          created_by as "createdBy",
          created_at as "createdAt",
          updated_at as "updatedAt";
      `;
      const res = await executor.query(sql, [
        companyId,
        id,
        input.code !== undefined ? input.code.trim() : null,
        input.nameAr !== undefined ? input.nameAr.trim() : null,
        input.nameEn !== undefined,
        input.nameEn?.trim() || null,
        input.memo !== undefined,
        input.memo?.trim() || null,
      ]);
      return mapRegister(res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async deactivate(companyId: string, id: string, customExecutor?: DbExecutor): Promise<CashRegister> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        UPDATE cash_registers
        SET is_active = false, updated_at = NOW()
        WHERE company_id = $1 AND id = $2
        RETURNING
          id,
          company_id as "companyId",
          code,
          name_ar as "nameAr",
          name_en as "nameEn",
          gl_account_id as "glAccountId",
          is_active as "isActive",
          opening_balance as "openingBalance",
          memo,
          created_by as "createdBy",
          created_at as "createdAt",
          updated_at as "updatedAt";
      `;
      const res = await executor.query(sql, [companyId, id]);
      return mapRegister(res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async sumMovements(companyId: string, registerId: string, customExecutor?: DbExecutor): Promise<{ totalIn: number; totalOut: number; netMovement: number }> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          COALESCE(SUM(in_amt), 0)::numeric as "totalIn",
          COALESCE(SUM(out_amt), 0)::numeric as "totalOut",
          COALESCE(SUM(in_amt - out_amt), 0)::numeric as "netMovement"
        FROM (
          SELECT
            CASE WHEN direction = 'in' THEN amount ELSE 0 END as in_amt,
            CASE WHEN direction = 'out' THEN amount ELSE 0 END as out_amt
          FROM custody_movements
          WHERE company_id = $1 AND register_id = $2
          UNION ALL
          SELECT
            amount as in_amt,
            0::numeric as out_amt
          FROM cash_receipt_vouchers
          WHERE company_id = $1 AND register_id = $2 AND status = 'posted'
          UNION ALL
          SELECT
            0::numeric as in_amt,
            amount as out_amt
          FROM cash_payment_vouchers
          WHERE company_id = $1 AND register_id = $2 AND status = 'posted'
        ) unified_cash_flow;
      `;
      const res = await executor.query<{ totalIn: string | number; totalOut: string | number; netMovement: string | number }>(sql, [companyId, registerId]);
      const row = res.rows[0];
      return {
        totalIn: toMoney(row?.totalIn ?? 0),
        totalOut: toMoney(row?.totalOut ?? 0),
        netMovement: toMoney(row?.netMovement ?? 0),
      };
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async listMovements(companyId: string, registerId: string, customExecutor?: DbExecutor): Promise<CustodyMovement[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
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
          created_at as "createdAt"
        FROM custody_movements
        WHERE company_id = $1 AND register_id = $2
        ORDER BY created_at DESC;
      `;
      const res = await executor.query(sql, [companyId, registerId]);
      return res.rows.map((r: any) => ({
        id: r.id,
        companyId: r.companyId,
        custodyId: r.custodyId,
        registerId: r.registerId,
        movementType: r.movementType,
        direction: r.direction,
        amount: toMoney(r.amount),
        expenseAccountId: r.expenseAccountId || null,
        journalEntryId: r.journalEntryId || null,
        memo: r.memo || null,
        createdBy: r.createdBy || null,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(r.createdAt).toISOString(),
      }));
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultCashRegisterRepository = new CashRegisterRepository();
