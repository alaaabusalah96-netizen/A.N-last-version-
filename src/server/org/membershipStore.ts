import { defaultMembershipRepository, MembershipRepository } from './membershipRepository.js';
import { RoleName } from '../rbac/roles.js';

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
    isActive: boolean = true
  ): Promise<CompanyMembership> {
    return this.repo.addMember(userId, companyId, role, isActive);
  }

  async getMembership(userId: string, companyId: string): Promise<CompanyMembership | null> {
    return this.repo.getMembership(userId, companyId);
  }

  async hasMembership(userId: string, companyId: string): Promise<boolean> {
    const m = await this.repo.getMembership(userId, companyId);
    return Boolean(m && m.isActive !== false);
  }

  async listByUser(userId: string): Promise<CompanyMembership[]> {
    return this.repo.listByUser(userId);
  }

  async listByCompany(companyId: string): Promise<CompanyMembership[]> {
    return this.repo.listByCompany(companyId);
  }

  async setMembershipStatus(userId: string, companyId: string, isActive: boolean): Promise<boolean> {
    return this.repo.setMembershipStatus(userId, companyId, isActive);
  }

  clear(): void {
    // No-op for database-backed store
  }
}

export const defaultMembershipStore = new MembershipStore();
