import { getDefaultExecutor } from '../db/index.js';
import { CompanyMembership } from './membershipStore.js';
import { RoleName } from '../rbac/roles.js';

export class MembershipRepository {
  // Test-time in-memory fallback when DATABASE_URL is not configured
  private memStore: Map<string, CompanyMembership> = new Map();

  private async getExecutor() {
    const executor = await getDefaultExecutor();
    return executor;
  }

  async addMember(
    userId: string,
    companyId: string,
    role: RoleName,
    isActive: boolean = true
  ): Promise<CompanyMembership> {
    const executor = await this.getExecutor();
    if (!executor) {
      const key = `${userId}:${companyId}`;
      const m: CompanyMembership = {
        id: key,
        userId,
        companyId,
        role,
        isActive,
        createdAt: new Date().toISOString(),
      };
      this.memStore.set(key, m);
      return m;
    }

    const sql = `
      INSERT INTO company_memberships (user_id, company_id, role, is_active)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, company_id)
      DO UPDATE SET role = EXCLUDED.role, is_active = EXCLUDED.is_active
      RETURNING id::text, user_id as "userId", company_id as "companyId", role, is_active as "isActive", created_at as "createdAt";
    `;

    const res = await executor.query<CompanyMembership>(sql, [userId, companyId, role, isActive]);
    return res.rows[0];
  }

  async getMembership(userId: string, companyId: string): Promise<CompanyMembership | null> {
    const executor = await this.getExecutor();
    if (!executor) {
      const key = `${userId}:${companyId}`;
      return this.memStore.get(key) || null;
    }

    const sql = `
      SELECT id::text, user_id as "userId", company_id as "companyId", role, is_active as "isActive", created_at as "createdAt"
      FROM company_memberships
      WHERE user_id = $1 AND company_id = $2;
    `;

    const res = await executor.query<CompanyMembership>(sql, [userId, companyId]);
    return res.rows[0] || null;
  }

  async listByUser(userId: string): Promise<CompanyMembership[]> {
    const executor = await this.getExecutor();
    if (!executor) {
      return Array.from(this.memStore.values()).filter((m) => m.userId === userId && m.isActive !== false);
    }

    const sql = `
      SELECT id::text, user_id as "userId", company_id as "companyId", role, is_active as "isActive", created_at as "createdAt"
      FROM company_memberships
      WHERE user_id = $1 AND is_active = true;
    `;

    const res = await executor.query<CompanyMembership>(sql, [userId]);
    return res.rows;
  }

  async listByCompany(companyId: string): Promise<CompanyMembership[]> {
    const executor = await this.getExecutor();
    if (!executor) {
      return Array.from(this.memStore.values()).filter((m) => m.companyId === companyId && m.isActive !== false);
    }

    const sql = `
      SELECT id::text, user_id as "userId", company_id as "companyId", role, is_active as "isActive", created_at as "createdAt"
      FROM company_memberships
      WHERE company_id = $1 AND is_active = true;
    `;

    const res = await executor.query<CompanyMembership>(sql, [companyId]);
    return res.rows;
  }

  async setMembershipStatus(userId: string, companyId: string, isActive: boolean): Promise<boolean> {
    const executor = await this.getExecutor();
    if (!executor) {
      const key = `${userId}:${companyId}`;
      const m = this.memStore.get(key);
      if (!m) return false;
      m.isActive = isActive;
      return true;
    }

    const sql = `
      UPDATE company_memberships
      SET is_active = $3
      WHERE user_id = $1 AND company_id = $2;
    `;
    const res = await executor.query(sql, [userId, companyId, isActive]);
    return (res.rowCount ?? 0) > 0;
  }
}

export const defaultMembershipRepository = new MembershipRepository();
