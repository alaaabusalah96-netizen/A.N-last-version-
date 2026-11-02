import { RoleName } from '../rbac/roles.js';

export interface CompanyMembership {
  id: string;
  userId: string;
  companyId: string;
  role: RoleName;
  createdAt: string;
}

/**
 * Membership Store
 * Tracks user-to-company memberships and company-specific roles.
 */
export class MembershipStore {
  private memberships: Map<string, CompanyMembership> = new Map();

  async addMember(userId: string, companyId: string, role: RoleName): Promise<CompanyMembership> {
    const key = `${userId}:${companyId}`;
    const membership: CompanyMembership = {
      id: key,
      userId,
      companyId,
      role,
      createdAt: new Date().toISOString(),
    };
    this.memberships.set(key, membership);
    return membership;
  }

  async getMembership(userId: string, companyId: string): Promise<CompanyMembership | null> {
    const key = `${userId}:${companyId}`;
    return this.memberships.get(key) || null;
  }

  async hasMembership(userId: string, companyId: string): Promise<boolean> {
    const key = `${userId}:${companyId}`;
    return this.memberships.has(key);
  }

  async listByUser(userId: string): Promise<CompanyMembership[]> {
    return Array.from(this.memberships.values()).filter((m) => m.userId === userId);
  }

  async listByCompany(companyId: string): Promise<CompanyMembership[]> {
    return Array.from(this.memberships.values()).filter((m) => m.companyId === companyId);
  }

  clear(): void {
    this.memberships.clear();
  }
}

export const defaultMembershipStore = new MembershipStore();
