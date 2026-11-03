import { defaultCompanyRepository, CompanyRepository } from './companyRepository.js';
import { Company, CreateCompanyInput } from './companyTypes.js';
import { DbExecutor } from '../db/types.js';

/**
 * Company Store (Delegates to PostgreSQL CompanyRepository — No Map fallback)
 */
export class CompanyStore {
  constructor(private repo: CompanyRepository = defaultCompanyRepository) {}

  async create(input: CreateCompanyInput, customExecutor?: DbExecutor): Promise<Company> {
    return this.repo.create(input, customExecutor);
  }

  async getById(id: string, customExecutor?: DbExecutor): Promise<Company | null> {
    return this.repo.getById(id, customExecutor);
  }

  async findByCode(code: string, customExecutor?: DbExecutor): Promise<Company | null> {
    return this.repo.findByCode(code, customExecutor);
  }

  async list(customExecutor?: DbExecutor): Promise<Company[]> {
    return this.repo.list(customExecutor);
  }

  clear(): void {
    // No-op for database-backed store
  }
}

export const defaultCompanyStore = new CompanyStore();
