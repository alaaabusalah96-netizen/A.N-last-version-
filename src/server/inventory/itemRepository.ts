import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { Item, CreateItemInput } from './inventoryTypes.js';

export class ItemRepository {
  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<Item[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          id, 
          company_id as "companyId", 
          code, 
          name_ar as "nameAr", 
          name_en as "nameEn", 
          uom,
          is_active as "isActive", 
          created_at as "createdAt"
        FROM inv_items
        WHERE company_id = $1
        ORDER BY code ASC
      `;
      const res = await executor.query<Item>(sql, [companyId]);
      return res.rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, itemId: string, customExecutor?: DbExecutor): Promise<Item | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          id, 
          company_id as "companyId", 
          code, 
          name_ar as "nameAr", 
          name_en as "nameEn", 
          uom,
          is_active as "isActive", 
          created_at as "createdAt"
        FROM inv_items
        WHERE id = $1 AND company_id = $2
      `;
      const res = await executor.query<Item>(sql, [itemId, companyId]);
      return res.rows[0] || null;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByCode(companyId: string, code: string, customExecutor?: DbExecutor): Promise<Item | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          id, 
          company_id as "companyId", 
          code, 
          name_ar as "nameAr", 
          name_en as "nameEn", 
          uom,
          is_active as "isActive", 
          created_at as "createdAt"
        FROM inv_items
        WHERE company_id = $1 AND code = $2
      `;
      const res = await executor.query<Item>(sql, [companyId, code.trim()]);
      return res.rows[0] || null;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async create(companyId: string, input: CreateItemInput, customExecutor?: DbExecutor): Promise<Item> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        INSERT INTO inv_items (company_id, code, name_ar, name_en, uom, is_active)
        VALUES ($1, $2, $3, $4, $5, true)
        RETURNING 
          id, 
          company_id as "companyId", 
          code, 
          name_ar as "nameAr", 
          name_en as "nameEn", 
          uom,
          is_active as "isActive", 
          created_at as "createdAt"
      `;
      const res = await executor.query<Item>(sql, [
        companyId,
        input.code.trim(),
        input.nameAr.trim(),
        input.nameEn ? input.nameEn.trim() : null,
        input.uom ? input.uom.trim() : 'unit',
      ]);
      return res.rows[0];
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultItemRepository = new ItemRepository();
