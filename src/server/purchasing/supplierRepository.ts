import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { Supplier, CreateSupplierInput } from './purchasingTypes.js';

export class SupplierRepository {
  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<Supplier[]> {
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
        FROM purch_suppliers
        WHERE company_id = $1
        ORDER BY code ASC
      `;
      const res = await executor.query<Supplier>(sql, [companyId]);
      return res.rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, supplierId: string, customExecutor?: DbExecutor): Promise<Supplier | null> {
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
        FROM purch_suppliers
        WHERE id = $1 AND company_id = $2
      `;
      const res = await executor.query<Supplier>(sql, [supplierId, companyId]);
      return res.rows[0] || null;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByCode(companyId: string, code: string, customExecutor?: DbExecutor): Promise<Supplier | null> {
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
        FROM purch_suppliers
        WHERE company_id = $1 AND code = $2
      `;
      const res = await executor.query<Supplier>(sql, [companyId, code.trim()]);
      return res.rows[0] || null;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async create(companyId: string, input: CreateSupplierInput, customExecutor?: DbExecutor): Promise<Supplier> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        INSERT INTO purch_suppliers (company_id, code, name_ar, name_en, is_active)
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
      const res = await executor.query<Supplier>(sql, [
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
}

export const defaultSupplierRepository = new SupplierRepository();
