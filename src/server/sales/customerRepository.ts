import { DbExecutor } from '../db/index.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { Customer, CreateCustomerInput, UpdateCustomerInput } from './salesTypes.js';

function mapRow(row: any): Customer {
  return {
    id: row.id,
    companyId: row.company_id,
    code: row.code,
    nameAr: row.name_ar,
    nameEn: row.name_en || null,
    phone: row.phone || null,
    email: row.email || null,
    taxNumber: row.tax_number || null,
    address: row.address || null,
    creditLimit: parseFloat(row.credit_limit || '0'),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export class CustomerRepository {
  async list(companyId: string, customExecutor?: DbExecutor): Promise<Customer[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT id, company_id, code, name_ar, name_en, phone, email, tax_number, address, credit_limit, is_active, created_at, updated_at
        FROM sales_customers
        WHERE company_id = $1
        ORDER BY name_ar ASC
      `;
      const res = await executor.query<any>(sql, [companyId]);
      return res.rows.map(mapRow);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, id: string, customExecutor?: DbExecutor): Promise<Customer | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT id, company_id, code, name_ar, name_en, phone, email, tax_number, address, credit_limit, is_active, created_at, updated_at
        FROM sales_customers
        WHERE company_id = $1 AND id = $2
      `;
      const res = await executor.query<any>(sql, [companyId, id]);
      if (res.rows.length === 0) return null;
      return mapRow(res.rows[0]);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByCode(companyId: string, code: string, customExecutor?: DbExecutor): Promise<Customer | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT id, company_id, code, name_ar, name_en, phone, email, tax_number, address, credit_limit, is_active, created_at, updated_at
        FROM sales_customers
        WHERE company_id = $1 AND code = $2
      `;
      const res = await executor.query<any>(sql, [companyId, code]);
      if (res.rows.length === 0) return null;
      return mapRow(res.rows[0]);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async create(companyId: string, input: CreateCustomerInput, customExecutor?: DbExecutor): Promise<Customer> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        INSERT INTO sales_customers (
          company_id, code, name_ar, name_en, phone, email, tax_number, address, credit_limit, is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, company_id, code, name_ar, name_en, phone, email, tax_number, address, credit_limit, is_active, created_at, updated_at
      `;
      const res = await executor.query<any>(sql, [
        companyId,
        input.code.trim(),
        input.nameAr.trim(),
        input.nameEn?.trim() || null,
        input.phone?.trim() || null,
        input.email?.trim() || null,
        input.taxNumber?.trim() || null,
        input.address?.trim() || null,
        input.creditLimit ?? 0,
        input.isActive ?? true,
      ]);
      return mapRow(res.rows[0]);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async update(companyId: string, id: string, input: UpdateCustomerInput, customExecutor?: DbExecutor): Promise<Customer | null> {
    const run = async (executor: DbExecutor) => {
      const existing = await this.findById(companyId, id, executor);
      if (!existing) return null;

      const sql = `
        UPDATE sales_customers
        SET
          name_ar = COALESCE($3, name_ar),
          name_en = COALESCE($4, name_en),
          phone = COALESCE($5, phone),
          email = COALESCE($6, email),
          tax_number = COALESCE($7, tax_number),
          address = COALESCE($8, address),
          credit_limit = COALESCE($9, credit_limit),
          is_active = COALESCE($10, is_active),
          updated_at = NOW()
        WHERE company_id = $1 AND id = $2
        RETURNING id, company_id, code, name_ar, name_en, phone, email, tax_number, address, credit_limit, is_active, created_at, updated_at
      `;
      const res = await executor.query<any>(sql, [
        companyId,
        id,
        input.nameAr !== undefined ? input.nameAr.trim() : null,
        input.nameEn !== undefined ? input.nameEn.trim() : null,
        input.phone !== undefined ? input.phone.trim() : null,
        input.email !== undefined ? input.email.trim() : null,
        input.taxNumber !== undefined ? input.taxNumber.trim() : null,
        input.address !== undefined ? input.address.trim() : null,
        input.creditLimit !== undefined ? input.creditLimit : null,
        input.isActive !== undefined ? input.isActive : null,
      ]);
      return mapRow(res.rows[0]);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async delete(companyId: string, id: string, customExecutor?: DbExecutor): Promise<boolean> {
    const run = async (executor: DbExecutor) => {
      const sql = `DELETE FROM sales_customers WHERE company_id = $1 AND id = $2 RETURNING id`;
      const res = await executor.query<any>(sql, [companyId, id]);
      return res.rows.length > 0;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultCustomerRepository = new CustomerRepository();
