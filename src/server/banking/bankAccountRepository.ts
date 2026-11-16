import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { BankAccount, CreateBankAccountInput, UpdateBankAccountInput } from './bankingTypes.js';
import { toMinorUnits, fromMinorUnits } from '../lib/numeric.js';

function mapBankAccount(row: any): BankAccount {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    nameAr: row.nameAr,
    nameEn: row.nameEn ?? null,
    bankName: row.bankName,
    accountNumber: row.accountNumber ?? null,
    iban: row.iban ?? null,
    currencyCode: row.currencyCode || 'SAR',
    glAccountId: row.glAccountId,
    glAccountCode: row.glAccountCode ?? undefined,
    glAccountNameAr: row.glAccountNameAr ?? undefined,
    openingBalance: fromMinorUnits(toMinorUnits(row.openingBalance ?? '0', 2), 2),
    bookBalance: row.bookBalance !== undefined ? fromMinorUnits(toMinorUnits(row.bookBalance, 2), 2) : undefined,
    unmatchedStatementCount:
      row.unmatchedStatementCount !== undefined ? Number(row.unmatchedStatementCount) : undefined,
    lastReconciledAt: row.lastReconciledAt
      ? typeof row.lastReconciledAt === 'string'
        ? row.lastReconciledAt
        : new Date(row.lastReconciledAt).toISOString()
      : null,
    isActive: Boolean(row.isActive),
    memo: row.memo ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(row.createdAt).toISOString(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date(row.updatedAt).toISOString(),
  };
}

export class BankAccountRepository {
  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<BankAccount[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          b.id,
          b.company_id as "companyId",
          b.code,
          b.name_ar as "nameAr",
          b.name_en as "nameEn",
          b.bank_name as "bankName",
          b.account_number as "accountNumber",
          b.iban,
          b.currency_code as "currencyCode",
          b.gl_account_id as "glAccountId",
          a.code as "glAccountCode",
          a.name_ar as "glAccountNameAr",
          b.opening_balance::text as "openingBalance",
          (
            b.opening_balance + COALESCE((
              SELECT SUM(l.debit - l.credit)
              FROM journal_lines l
              INNER JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
              WHERE l.company_id = b.company_id
                AND l.account_id = b.gl_account_id
                AND e.status = 'posted'
            ), 0)
          )::text as "bookBalance",
          COALESCE((
            SELECT COUNT(*)::int
            FROM fin_bank_statement_lines sl
            WHERE sl.company_id = b.company_id
              AND sl.bank_account_id = b.id
              AND sl.status = 'unmatched'
          ), 0) as "unmatchedStatementCount",
          (
            SELECT MAX(r.completed_at)
            FROM fin_bank_reconciliations r
            WHERE r.company_id = b.company_id
              AND r.bank_account_id = b.id
              AND r.status = 'completed'
          ) as "lastReconciledAt",
          b.is_active as "isActive",
          b.memo,
          b.created_by as "createdBy",
          b.created_at as "createdAt",
          b.updated_at as "updatedAt"
        FROM fin_bank_accounts b
        INNER JOIN accounts a ON a.id = b.gl_account_id AND a.company_id = b.company_id
        WHERE b.company_id = $1
        ORDER BY b.code ASC, b.created_at ASC;
      `;
      const res = await executor.query(sql, [companyId]);
      return res.rows.map(mapBankAccount);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, id: string, customExecutor?: DbExecutor): Promise<BankAccount | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          b.id,
          b.company_id as "companyId",
          b.code,
          b.name_ar as "nameAr",
          b.name_en as "nameEn",
          b.bank_name as "bankName",
          b.account_number as "accountNumber",
          b.iban,
          b.currency_code as "currencyCode",
          b.gl_account_id as "glAccountId",
          a.code as "glAccountCode",
          a.name_ar as "glAccountNameAr",
          b.opening_balance::text as "openingBalance",
          (
            b.opening_balance + COALESCE((
              SELECT SUM(l.debit - l.credit)
              FROM journal_lines l
              INNER JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
              WHERE l.company_id = b.company_id
                AND l.account_id = b.gl_account_id
                AND e.status = 'posted'
            ), 0)
          )::text as "bookBalance",
          b.is_active as "isActive",
          b.memo,
          b.created_by as "createdBy",
          b.created_at as "createdAt",
          b.updated_at as "updatedAt"
        FROM fin_bank_accounts b
        INNER JOIN accounts a ON a.id = b.gl_account_id AND a.company_id = b.company_id
        WHERE b.company_id = $1 AND b.id = $2;
      `;
      const res = await executor.query(sql, [companyId, id]);
      if (res.rows.length === 0) return null;
      return mapBankAccount(res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async lockForUpdate(companyId: string, id: string, tx: DbExecutor): Promise<BankAccount | null> {
    const sql = `
      SELECT
        id,
        company_id as "companyId",
        code,
        name_ar as "nameAr",
        name_en as "nameEn",
        bank_name as "bankName",
        account_number as "accountNumber",
        iban,
        currency_code as "currencyCode",
        gl_account_id as "glAccountId",
        opening_balance::text as "openingBalance",
        is_active as "isActive",
        memo,
        created_by as "createdBy",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM fin_bank_accounts
      WHERE company_id = $1 AND id = $2
      FOR UPDATE;
    `;
    const res = await tx.query(sql, [companyId, id]);
    if (res.rows.length === 0) return null;
    return mapBankAccount(res.rows[0]);
  }

  async findByCode(companyId: string, code: string, customExecutor?: DbExecutor): Promise<BankAccount | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          id,
          company_id as "companyId",
          code,
          name_ar as "nameAr",
          name_en as "nameEn",
          bank_name as "bankName",
          account_number as "accountNumber",
          iban,
          currency_code as "currencyCode",
          gl_account_id as "glAccountId",
          opening_balance::text as "openingBalance",
          is_active as "isActive",
          memo,
          created_by as "createdBy",
          created_at as "createdAt",
          updated_at as "updatedAt"
        FROM fin_bank_accounts
        WHERE company_id = $1 AND code = $2;
      `;
      const res = await executor.query(sql, [companyId, code.trim()]);
      if (res.rows.length === 0) return null;
      return mapBankAccount(res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByGlAccount(companyId: string, glAccountId: string, customExecutor?: DbExecutor): Promise<BankAccount | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          id,
          company_id as "companyId",
          code,
          name_ar as "nameAr",
          name_en as "nameEn",
          bank_name as "bankName",
          account_number as "accountNumber",
          iban,
          currency_code as "currencyCode",
          gl_account_id as "glAccountId",
          opening_balance::text as "openingBalance",
          is_active as "isActive",
          memo,
          created_by as "createdBy",
          created_at as "createdAt",
          updated_at as "updatedAt"
        FROM fin_bank_accounts
        WHERE company_id = $1 AND gl_account_id = $2;
      `;
      const res = await executor.query(sql, [companyId, glAccountId]);
      if (res.rows.length === 0) return null;
      return mapBankAccount(res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async create(
    companyId: string,
    input: CreateBankAccountInput,
    actorId: string | null,
    customExecutor?: DbExecutor
  ): Promise<BankAccount> {
    const run = async (executor: DbExecutor) => {
      const opening = fromMinorUnits(toMinorUnits(input.openingBalance ?? 0, 2), 2);
      const sql = `
        INSERT INTO fin_bank_accounts (
          company_id, code, name_ar, name_en, bank_name,
          account_number, iban, currency_code, gl_account_id,
          opening_balance, is_active, memo, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, true, $11, $12)
        RETURNING
          id,
          company_id as "companyId",
          code,
          name_ar as "nameAr",
          name_en as "nameEn",
          bank_name as "bankName",
          account_number as "accountNumber",
          iban,
          currency_code as "currencyCode",
          gl_account_id as "glAccountId",
          opening_balance::text as "openingBalance",
          is_active as "isActive",
          memo,
          created_by as "createdBy",
          created_at as "createdAt",
          updated_at as "updatedAt";
      `;
      const res = await executor.query(sql, [
        companyId,
        input.code.trim(),
        input.nameAr.trim(),
        input.nameEn?.trim() || null,
        input.bankName.trim(),
        input.accountNumber?.trim() || null,
        input.iban?.trim() || null,
        (input.currencyCode || 'SAR').trim().toUpperCase(),
        input.glAccountId,
        opening,
        input.memo?.trim() || null,
        actorId,
      ]);
      return mapBankAccount(res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async update(
    companyId: string,
    id: string,
    input: UpdateBankAccountInput,
    customExecutor?: DbExecutor
  ): Promise<BankAccount> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        UPDATE fin_bank_accounts
        SET
          code = COALESCE($3, code),
          name_ar = COALESCE($4, name_ar),
          name_en = CASE WHEN $5 THEN $6 ELSE name_en END,
          bank_name = COALESCE($7, bank_name),
          account_number = CASE WHEN $8 THEN $9 ELSE account_number END,
          iban = CASE WHEN $10 THEN $11 ELSE iban END,
          currency_code = COALESCE($12, currency_code),
          is_active = COALESCE($13, is_active),
          memo = CASE WHEN $14 THEN $15 ELSE memo END,
          updated_at = NOW()
        WHERE company_id = $1 AND id = $2
        RETURNING
          id,
          company_id as "companyId",
          code,
          name_ar as "nameAr",
          name_en as "nameEn",
          bank_name as "bankName",
          account_number as "accountNumber",
          iban,
          currency_code as "currencyCode",
          gl_account_id as "glAccountId",
          opening_balance::text as "openingBalance",
          is_active as "isActive",
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
        input.bankName !== undefined ? input.bankName.trim() : null,
        input.accountNumber !== undefined,
        input.accountNumber?.trim() || null,
        input.iban !== undefined,
        input.iban?.trim() || null,
        input.currencyCode !== undefined ? input.currencyCode.trim().toUpperCase() : null,
        input.isActive !== undefined ? input.isActive : null,
        input.memo !== undefined,
        input.memo?.trim() || null,
      ]);
      return mapBankAccount(res.rows[0]);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultBankAccountRepository = new BankAccountRepository();
