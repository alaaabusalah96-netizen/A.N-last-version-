import { getDefaultExecutor } from '../db/index.js';
import { DbExecutor } from '../db/types.js';
import { Company, CreateCompanyInput } from './companyTypes.js';
import { isUuid } from '../http/validators.js';
import { ValidationError } from '../http/errors.js';

export class CompanyRepository {
  private async getExecutor(customExecutor?: DbExecutor) {
    if (customExecutor) return customExecutor;
    const executor = await getDefaultExecutor();
    if (!executor) {
      throw new Error('DB_UNAVAILABLE: Database executor not available for CompanyRepository');
    }
    return executor;
  }

  async create(input: CreateCompanyInput, customExecutor?: DbExecutor): Promise<Company> {
    const executor = await this.getExecutor(customExecutor);
    const normalizedCode = input.code.trim().toUpperCase();

    if (input.createdBy !== undefined && input.createdBy !== null && !isUuid(input.createdBy)) {
      throw new ValidationError('createdBy must be a valid UUID');
    }
    const createdByUuid = input.createdBy || null;

    const sql = `
      INSERT INTO companies (code, name_ar, name_en, created_by, is_active)
      VALUES ($1, $2, $3, $4, true)
      RETURNING id, code, name_ar as "nameAr", name_en as "nameEn", is_active as "isActive", created_at as "createdAt", created_by as "createdBy";
    `;

    const res = await executor.query<Company>(sql, [
      normalizedCode,
      input.nameAr.trim(),
      input.nameEn?.trim() || null,
      createdByUuid,
    ]);

    return res.rows[0];
  }

  async getById(id: string, customExecutor?: DbExecutor): Promise<Company | null> {
    const executor = await this.getExecutor(customExecutor);
    const sql = `
      SELECT id, code, name_ar as "nameAr", name_en as "nameEn", is_active as "isActive", created_at as "createdAt", created_by as "createdBy"
      FROM companies
      WHERE id = $1 AND is_active = true;
    `;

    const res = await executor.query<Company>(sql, [id]);
    return res.rows[0] || null;
  }

  async findByCode(code: string, customExecutor?: DbExecutor): Promise<Company | null> {
    const executor = await this.getExecutor(customExecutor);
    const normalized = code.trim().toUpperCase();
    const sql = `
      SELECT id, code, name_ar as "nameAr", name_en as "nameEn", is_active as "isActive", created_at as "createdAt", created_by as "createdBy"
      FROM companies
      WHERE code = $1 AND is_active = true;
    `;

    const res = await executor.query<Company>(sql, [normalized]);
    return res.rows[0] || null;
  }

  async list(customExecutor?: DbExecutor): Promise<Company[]> {
    const executor = await this.getExecutor(customExecutor);
    const sql = `
      SELECT id, code, name_ar as "nameAr", name_en as "nameEn", is_active as "isActive", created_at as "createdAt", created_by as "createdBy"
      FROM companies
      WHERE is_active = true
      ORDER BY created_at DESC;
    `;

    const res = await executor.query<Company>(sql);
    return res.rows;
  }
}

export const defaultCompanyRepository = new CompanyRepository();
