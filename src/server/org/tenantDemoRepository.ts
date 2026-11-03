import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';

export interface TenantDemoItem {
  id: string;
  companyId: string;
  label: string;
  createdAt: string;
}

export class TenantDemoRepository {
  async createItem(companyId: string, label: string, customExecutor?: DbExecutor): Promise<TenantDemoItem> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        INSERT INTO tenant_demo_items (company_id, label)
        VALUES ($1, $2)
        RETURNING id, company_id as "companyId", label, created_at as "createdAt";
      `;
      const res = await tx.query<TenantDemoItem>(sql, [companyId, label.trim()]);
      return res.rows[0];
    };

    if (customExecutor) {
      return run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }

  async listItems(companyId: string, customExecutor?: DbExecutor): Promise<TenantDemoItem[]> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        SELECT id, company_id as "companyId", label, created_at as "createdAt"
        FROM tenant_demo_items
        WHERE company_id = $1
        ORDER BY created_at DESC;
      `;
      const res = await tx.query<TenantDemoItem>(sql, [companyId]);
      return res.rows;
    };

    if (customExecutor) {
      return run(customExecutor);
    }
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultTenantDemoRepository = new TenantDemoRepository();
