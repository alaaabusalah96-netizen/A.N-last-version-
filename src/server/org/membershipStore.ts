import { defaultMembershipRepository, MembershipRepository } from './membershipRepository.js';
import { RoleName } from '../rbac/roles.js';
import { DbExecutor } from '../db/types.js';

export interface CompanyMembership {
  id: string;
  userId: string;
  companyId: string;
  role: RoleName;
  isActive: boolean;
  createdAt: string;
}

/**
 * Membership Store (Delegates to PostgreSQL MembershipRepository — No Map fallback)
 */
export class MembershipStore {
  constructor(private repo: MembershipRepository = defaultMembershipRepository) {}

  async addMember(
    userId: string,
    companyId: string,
    role: RoleName,
    isActive: boolean = true,
    customExecutor?: DbExecutor
  ): Promise<CompanyMembership> {
    return this.repo.addMember(userId, companyId, role, isActive, customExecutor);
  }

  async getMembership(userId: string, companyId: string, customExecutor?: DbExecutor): Promise<CompanyMembership | null> {
    return this.repo.getMembership(userId, companyId, customExecutor);
  }

  async hasMembership(userId: string, companyId: string, customExecutor?: DbExecutor): Promise<boolean> {
    const m = await this.repo.getMembership(userId, companyId, customExecutor);
    return Boolean(m && m.isActive !== false);
  }

  async listByUser(userId: string, customExecutor?: DbExecutor): Promise<CompanyMembership[]> {
    return this.repo.listByUser(userId, customExecutor);
  }

  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<CompanyMembership[]> {
    return this.repo.listByCompany(companyId, customExecutor);
  }

  async setMembershipStatus(userId: string, companyId: string, isActive: boolean, customExecutor?: DbExecutor): Promise<boolean> {
    return this.repo.setMembershipStatus(userId, companyId, isActive, customExecutor);
  }

  clear(): void {
    // No-op for database-backed store
  }
}

export const defaultMembershipStore = new MembershipStore();
