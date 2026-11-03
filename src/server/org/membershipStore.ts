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
 * Membership Store
 * Tracks user-to-company memberships and company-specific roles.
 */
export class MembershipStore {
  private memberships: Map<string, CompanyMembership> = new Map();

  async addMember(
    userId: string,
    companyId: string,
    role: RoleName,
    isActive: boolean = true
  ): Promise<CompanyMembership> {
    const key = `${userId}:${companyId}`;
    const membership: CompanyMembership = {
      id: key,
      userId,
      companyId,
      role,
      isActive,
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
    const m = this.memberships.get(key);
    return Boolean(m && m.isActive !== false);
  }

  async listByUser(userId: string): Promise<CompanyMembership[]> {
    return Array.from(this.memberships.values()).filter(
      (m) => m.userId === userId && m.isActive !== false
    );
  }

  async listByCompany(companyId: string): Promise<CompanyMembership[]> {
    return Array.from(this.memberships.values()).filter(
      (m) => m.companyId === companyId && m.isActive !== false
    );
  }

  async setMembershipStatus(userId: string, companyId: string, isActive: boolean): Promise<boolean> {
    const key = `${userId}:${companyId}`;
    const m = this.memberships.get(key);
    if (!m) return false;
    m.isActive = isActive;
    return true;
  }

  clear(): void {
    this.memberships.clear();
  }
}

export const defaultMembershipStore = new MembershipStore();
