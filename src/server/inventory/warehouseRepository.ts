import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { Warehouse, CreateWarehouseInput, UpdateWarehouseInput } from './inventoryTypes.js';

export class WarehouseRepository {
  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<Warehouse[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          id, 
          company_id as "companyId", 
          code, 
          name_ar as "nameAr", 
          name_en as "nameEn", 
          is_active as "isActive", 
          created_at as "createdAt"
        FROM inv_warehouses
        WHERE company_id = $1
        ORDER BY code ASC
      `;
      const res = await executor.query<Warehouse>(sql, [companyId]);
      return res.rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, warehouseId: string, customExecutor?: DbExecutor): Promise<Warehouse | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          id, 
          company_id as "companyId", 
          code, 
          name_ar as "nameAr", 
          name_en as "nameEn", 
          is_active as "isActive", 
          created_at as "createdAt"
        FROM inv_warehouses
        WHERE id = $1 AND company_id = $2
      `;
      const res = await executor.query<Warehouse>(sql, [warehouseId, companyId]);
      return res.rows[0] || null;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByCode(companyId: string, code: string, customExecutor?: DbExecutor): Promise<Warehouse | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          id, 
          company_id as "companyId", 
          code, 
          name_ar as "nameAr", 
          name_en as "nameEn", 
          is_active as "isActive", 
          created_at as "createdAt"
        FROM inv_warehouses
        WHERE company_id = $1 AND code = $2
      `;
      const res = await executor.query<Warehouse>(sql, [companyId, code.trim()]);
      return res.rows[0] || null;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async create(companyId: string, input: CreateWarehouseInput, customExecutor?: DbExecutor): Promise<Warehouse> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        INSERT INTO inv_warehouses (company_id, code, name_ar, name_en, is_active)
        VALUES ($1, $2, $3, $4, true)
        RETURNING 
          id, 
          company_id as "companyId", 
          code, 
          name_ar as "nameAr", 
          name_en as "nameEn", 
          is_active as "isActive", 
          created_at as "createdAt"
      `;
      const res = await executor.query<Warehouse>(sql, [
        companyId,
        input.code.trim(),
        input.nameAr.trim(),
        input.nameEn ? input.nameEn.trim() : null,
      ]);
      return res.rows[0];
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async update(
    companyId: string,
    warehouseId: string,
    input: UpdateWarehouseInput,
    customExecutor?: DbExecutor
  ): Promise<Warehouse | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        UPDATE inv_warehouses SET
          name_ar = COALESCE($3, name_ar),
          name_en = CASE WHEN $4 THEN $5 ELSE name_en END,
          is_active = COALESCE($6, is_active)
        WHERE id = $1 AND company_id = $2
        RETURNING
          id,
          company_id as "companyId",
          code,
          name_ar as "nameAr",
          name_en as "nameEn",
          is_active as "isActive",
          created_at as "createdAt"
      `;
      const res = await executor.query<Warehouse>(sql, [
        warehouseId,
        companyId,
        input.nameAr !== undefined ? input.nameAr.trim() : null,
        input.nameEn !== undefined,
        input.nameEn ? input.nameEn.trim() : null,
        typeof input.isActive === 'boolean' ? input.isActive : null,
      ]);
      return res.rows[0] || null;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultWarehouseRepository = new WarehouseRepository();
