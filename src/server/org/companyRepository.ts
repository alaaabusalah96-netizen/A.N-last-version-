import { getDefaultExecutor } from '../db/index.js';
import { Company, CreateCompanyInput } from './companyTypes.js';
import { isUuid } from '../http/validators.js';

export class CompanyRepository {
  private async getExecutor() {
    const executor = await getDefaultExecutor();
    if (!executor) {
      throw new Error('DB_UNAVAILABLE: Database executor not available for CompanyRepository');
    }
    return executor;
  }

  async create(input: CreateCompanyInput): Promise<Company> {
    const executor = await this.getExecutor();
    const normalizedCode = input.code.trim().toUpperCase();

    const createdByUuid = input.createdBy && isUuid(input.createdBy) ? input.createdBy : null;

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

  async getById(id: string): Promise<Company | null> {
    const executor = await this.getExecutor();
    const sql = `
      SELECT id, code, name_ar as "nameAr", name_en as "nameEn", is_active as "isActive", created_at as "createdAt", created_by as "createdBy"
      FROM companies
      WHERE id = $1 AND is_active = true;
    `;

    const res = await executor.query<Company>(sql, [id]);
    return res.rows[0] || null;
  }

  async findByCode(code: string): Promise<Company | null> {
    const executor = await this.getExecutor();
    const normalized = code.trim().toUpperCase();
    const sql = `
      SELECT id, code, name_ar as "nameAr", name_en as "nameEn", is_active as "isActive", created_at as "createdAt", created_by as "createdBy"
      FROM companies
      WHERE code = $1 AND is_active = true;
    `;

    const res = await executor.query<Company>(sql, [normalized]);
    return res.rows[0] || null;
  }

  async list(): Promise<Company[]> {
    const executor = await this.getExecutor();
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
