import { getDefaultExecutor } from '../db/index.js';
import { DbExecutor } from '../db/types.js';
import { CompanyMembership } from './membershipStore.js';
import { RoleName } from '../rbac/roles.js';

export class MembershipRepository {
  private async getExecutor(customExecutor?: DbExecutor) {
    if (customExecutor) return customExecutor;
    const executor = await getDefaultExecutor();
    if (!executor) {
      throw new Error('DB_UNAVAILABLE: Database executor not available for MembershipRepository');
    }
    return executor;
  }

  async addMember(
    userId: string,
    companyId: string,
    role: RoleName,
    isActive: boolean = true,
    customExecutor?: DbExecutor
  ): Promise<CompanyMembership> {
    const executor = await this.getExecutor(customExecutor);

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

  async getMembership(userId: string, companyId: string, customExecutor?: DbExecutor): Promise<CompanyMembership | null> {
    const executor = await this.getExecutor(customExecutor);

    const sql = `
      SELECT id::text, user_id as "userId", company_id as "companyId", role, is_active as "isActive", created_at as "createdAt"
      FROM company_memberships
      WHERE user_id = $1 AND company_id = $2;
    `;

    const res = await executor.query<CompanyMembership>(sql, [userId, companyId]);
    return res.rows[0] || null;
  }

  async listByUser(userId: string, customExecutor?: DbExecutor): Promise<CompanyMembership[]> {
    const executor = await this.getExecutor(customExecutor);

    const sql = `
      SELECT id::text, user_id as "userId", company_id as "companyId", role, is_active as "isActive", created_at as "createdAt"
      FROM company_memberships
      WHERE user_id = $1 AND is_active = true;
    `;

    const res = await executor.query<CompanyMembership>(sql, [userId]);
    return res.rows;
  }

  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<CompanyMembership[]> {
    const executor = await this.getExecutor(customExecutor);

    const sql = `
      SELECT id::text, user_id as "userId", company_id as "companyId", role, is_active as "isActive", created_at as "createdAt"
      FROM company_memberships
      WHERE company_id = $1 AND is_active = true;
    `;

    const res = await executor.query<CompanyMembership>(sql, [companyId]);
    return res.rows;
  }

  async listAllByCompany(companyId: string, customExecutor?: DbExecutor): Promise<CompanyMembership[]> {
    const executor = await this.getExecutor(customExecutor);

    const sql = `
      SELECT id::text, user_id as "userId", company_id as "companyId", role, is_active as "isActive", created_at as "createdAt"
      FROM company_memberships
      WHERE company_id = $1;
    `;

    const res = await executor.query<CompanyMembership>(sql, [companyId]);
    return res.rows;
  }

  async updateMembershipRole(userId: string, companyId: string, role: RoleName, customExecutor?: DbExecutor): Promise<boolean> {
    const executor = await this.getExecutor(customExecutor);

    const sql = `
      UPDATE company_memberships
      SET role = $3
      WHERE user_id = $1 AND company_id = $2;
    `;
    const res = await executor.query(sql, [userId, companyId, role]);
    return (res.rowCount ?? 0) > 0;
  }

  async setMembershipStatusById(
    membershipId: string,
    companyId: string,
    isActive: boolean,
    userId?: string,
    customExecutor?: DbExecutor
  ): Promise<boolean> {
    const executor = await this.getExecutor(customExecutor);

    let sql = `
      UPDATE company_memberships
      SET is_active = $2
      WHERE id = $1 AND company_id = $3
    `;
    const params: (string | boolean)[] = [membershipId, isActive, companyId];

    if (userId) {
      sql += ` AND user_id = $4`;
      params.push(userId);
    }

    const res = await executor.query(sql, params);
    return (res.rowCount ?? 0) > 0;
  }

  async setMembershipStatus(
    userId: string,
    companyId: string,
    isActive: boolean,
    customExecutor?: DbExecutor
  ): Promise<boolean> {
    const executor = await this.getExecutor(customExecutor);
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
