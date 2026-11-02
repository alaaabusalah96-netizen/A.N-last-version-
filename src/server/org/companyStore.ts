import crypto from 'crypto';
import { Company, CreateCompanyInput } from './companyTypes.js';

/**
 * In-Memory Company Store (V1 Organization Foundation)
 * Encapsulates tenant/company persistence behind a clean interface.
 */
export class CompanyStore {
  private companies: Map<string, Company> = new Map();

  async create(input: CreateCompanyInput): Promise<Company> {
    const normalizedCode = input.code.trim().toUpperCase();
    const existing = await this.findByCode(normalizedCode);
    if (existing) {
      throw new Error(`Company with code '${normalizedCode}' already exists`);
    }

    const company: Company = {
      id: crypto.randomUUID(),
      code: normalizedCode,
      nameAr: input.nameAr.trim(),
      nameEn: input.nameEn?.trim(),
      isActive: true,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
    };

    this.companies.set(company.id, company);
    return company;
  }

  async getById(id: string): Promise<Company | null> {
    return this.companies.get(id) || null;
  }

  async findByCode(code: string): Promise<Company | null> {
    const normalized = code.trim().toUpperCase();
    for (const company of this.companies.values()) {
      if (company.code === normalized) {
        return company;
      }
    }
    return null;
  }

  async list(): Promise<Company[]> {
    return Array.from(this.companies.values());
  }

  clear(): void {
    this.companies.clear();
  }
}

export const defaultCompanyStore = new CompanyStore();
