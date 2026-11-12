import { CompanyMemberRoleView, defaultMembershipRepository, MembershipRepository } from './membershipRepository.js';
import { RoleName } from '../rbac/roles.js';
import { DbExecutor } from '../db/types.js';

export interface CompanyMembership {
  id: string;
  userId: string;
  companyId: string;
  role: RoleName;
  roleId?: string | null;
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
    roleIdOrExecutor?: string | null | DbExecutor,
    customExecutor?: DbExecutor
  ): Promise<CompanyMembership> {
    return this.repo.addMember(userId, companyId, role, isActive, roleIdOrExecutor, customExecutor);
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

  async listAllByCompany(companyId: string, customExecutor?: DbExecutor): Promise<CompanyMembership[]> {
    return this.repo.listAllByCompany(companyId, customExecutor);
  }

  async listCompanyMemberRoles(companyId: string, customExecutor?: DbExecutor): Promise<CompanyMemberRoleView[]> {
    return this.repo.listCompanyMemberRoles(companyId, customExecutor);
  }

  async updateMembership(
    userId: string,
    companyId: string,
    patch: { role?: RoleName; roleId?: string | null },
    customExecutor?: DbExecutor
  ): Promise<CompanyMembership | null> {
    return this.repo.updateMembership(userId, companyId, patch, customExecutor);
  }

  async setRoleById(
    membershipId: string,
    roleId: string | null,
    companyId: string,
    customExecutor?: DbExecutor
  ): Promise<CompanyMembership | null> {
    return this.repo.setMembershipRoleById(membershipId, roleId, companyId, customExecutor);
  }

  async updateRole(userId: string, companyId: string, role: RoleName, customExecutor?: DbExecutor): Promise<boolean> {
    return this.repo.updateMembershipRole(userId, companyId, role, customExecutor);
  }

  async setStatusById(
    membershipId: string,
    companyId: string,
    isActive: boolean,
    userId?: string,
    customExecutor?: DbExecutor
  ): Promise<boolean> {
    return this.repo.setMembershipStatusById(membershipId, companyId, isActive, userId, customExecutor);
  }

  clear(): void {
    // No-op for database-backed store
  }
}

export const defaultMembershipStore = new MembershipStore();
