import { defaultCompanyRepository, CompanyRepository } from './companyRepository.js';
import { Company, CreateCompanyInput } from './companyTypes.js';

/**
 * Company Store (Delegates to PostgreSQL CompanyRepository — No Map fallback)
 */
export class CompanyStore {
  constructor(private repo: CompanyRepository = defaultCompanyRepository) {}

  async create(input: CreateCompanyInput): Promise<Company> {
    return this.repo.create(input);
  }

  async getById(id: string): Promise<Company | null> {
    return this.repo.getById(id);
  }

  async findByCode(code: string): Promise<Company | null> {
    return this.repo.findByCode(code);
  }

  async list(): Promise<Company[]> {
    return this.repo.list();
  }

  clear(): void {
    // No-op for database-backed store
  }
}

export const defaultCompanyStore = new CompanyStore();
