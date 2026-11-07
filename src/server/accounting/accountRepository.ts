import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { Account, CreateAccountInput } from './accountTypes.js';

function mapRowToAccount(row: any): Account {
  return {
    id: row.id,
    companyId: row.company_id,
    code: row.code,
    nameAr: row.name_ar,
    nameEn: row.name_en,
    accountType: row.account_type,
    parentId: row.parent_id,
    isPostable: row.is_postable,
    isActive: row.is_active,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class AccountRepository {
  async listAccountsByCompany(companyId: string, customExecutor?: DbExecutor): Promise<Account[]> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        SELECT id, company_id, code, name_ar, name_en, account_type, parent_id, is_postable, is_active, created_at, updated_at
        FROM accounts
        WHERE company_id = $1
        ORDER BY code ASC;
      `;
      const res = await tx.query(sql, [companyId]);
      return res.rows.map(mapRowToAccount);
    };

    if (customExecutor) {
      return run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  async findByCode(companyId: string, code: string, customExecutor?: DbExecutor): Promise<Account | null> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        SELECT id, company_id, code, name_ar, name_en, account_type, parent_id, is_postable, is_active, created_at, updated_at
        FROM accounts
        WHERE company_id = $1 AND code = $2;
      `;
      const res = await tx.query(sql, [companyId, code.trim()]);
      if (res.rows.length === 0) return null;
      return mapRowToAccount(res.rows[0]);
    };

    if (customExecutor) {
      return run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  async countAccountsByCompany(companyId: string, customExecutor?: DbExecutor): Promise<number> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        SELECT COUNT(*)::int as count
        FROM accounts
        WHERE company_id = $1;
      `;
      const res = await tx.query<{ count: number }>(sql, [companyId]);
      return res.rows[0]?.count || 0;
    };

    if (customExecutor) {
      return run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  async createAccount(input: CreateAccountInput, customExecutor?: DbExecutor): Promise<Account> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        INSERT INTO accounts (company_id, code, name_ar, name_en, account_type, parent_id, is_postable)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, company_id, code, name_ar, name_en, account_type, parent_id, is_postable, is_active, created_at, updated_at;
      `;
      const params = [
        input.companyId,
        input.code.trim(),
        input.nameAr.trim(),
        input.nameEn ? input.nameEn.trim() : null,
        input.accountType,
        input.parentId || null,
        input.isPostable !== undefined ? input.isPostable : true,
      ];
      const res = await tx.query(sql, params);
      return mapRowToAccount(res.rows[0]);
    };

    if (customExecutor) {
      return run(customExecutor);
    }
    return await withTenantTransaction(input.companyId, run);
  }
}

export const defaultAccountRepository = new AccountRepository();
