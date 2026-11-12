import { getDefaultExecutor } from '../db/index.js';
import { tenantContextStorage } from '../db/tenantContext.js';
import { DbExecutor } from '../db/types.js';
import { CompanyMembership } from './membershipStore.js';
import { RoleName } from '../rbac/roles.js';

export interface CompanyMemberRoleView {
  membershipId: string;
  userId: string;
  username: string;
  companyId: string;
  role: RoleName;
  roleId: string | null;
  roleCode: string | null;
  roleNameAr: string | null;
  isActive: boolean;
  createdAt: string;
}

export class MembershipRepository {
  private async getExecutor(customExecutor?: DbExecutor) {
    if (customExecutor) return customExecutor;
    const ctxExecutor = tenantContextStorage.getCurrentExecutor();
    if (ctxExecutor) return ctxExecutor;
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
    roleIdOrExecutor?: string | null | DbExecutor,
    customExecutor?: DbExecutor
  ): Promise<CompanyMembership> {
    let roleId: string | null = null;
    let resolvedExecutor: DbExecutor | undefined = customExecutor;
    if (typeof roleIdOrExecutor === 'string' || roleIdOrExecutor === null) {
      roleId = roleIdOrExecutor;
    } else if (roleIdOrExecutor && typeof roleIdOrExecutor === 'object') {
      resolvedExecutor = roleIdOrExecutor;
    }

    const executor = await this.getExecutor(resolvedExecutor);

    const sql = `
      INSERT INTO company_memberships (user_id, company_id, role, role_id, is_active)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, company_id)
      DO UPDATE SET role = EXCLUDED.role, role_id = EXCLUDED.role_id, is_active = EXCLUDED.is_active
      RETURNING id::text, user_id as "userId", company_id as "companyId", role, role_id as "roleId", is_active as "isActive", created_at as "createdAt";
    `;

    const res = await executor.query<CompanyMembership>(sql, [userId, companyId, role, roleId, isActive]);
    return res.rows[0];
  }

  async getMembership(userId: string, companyId: string, customExecutor?: DbExecutor): Promise<CompanyMembership | null> {
    const executor = await this.getExecutor(customExecutor);

    const sql = `
      SELECT id::text, user_id as "userId", company_id as "companyId", role, role_id as "roleId", is_active as "isActive", created_at as "createdAt"
      FROM company_memberships
      WHERE user_id = $1 AND company_id = $2;
    `;

    const res = await executor.query<CompanyMembership>(sql, [userId, companyId]);
    return res.rows[0] || null;
  }

  async listByUser(userId: string, customExecutor?: DbExecutor): Promise<CompanyMembership[]> {
    const executor = await this.getExecutor(customExecutor);

    const sql = `
      SELECT id::text, user_id as "userId", company_id as "companyId", role, role_id as "roleId", is_active as "isActive", created_at as "createdAt"
      FROM company_memberships
      WHERE user_id = $1 AND is_active = true;
    `;

    const res = await executor.query<CompanyMembership>(sql, [userId]);
    return res.rows;
  }

  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<CompanyMembership[]> {
    const executor = await this.getExecutor(customExecutor);

    const sql = `
      SELECT id::text, user_id as "userId", company_id as "companyId", role, role_id as "roleId", is_active as "isActive", created_at as "createdAt"
      FROM company_memberships
      WHERE company_id = $1 AND is_active = true;
    `;

    const res = await executor.query<CompanyMembership>(sql, [companyId]);
    return res.rows;
  }

  async listAllByCompany(companyId: string, customExecutor?: DbExecutor): Promise<CompanyMembership[]> {
    const executor = await this.getExecutor(customExecutor);

    const sql = `
      SELECT id::text, user_id as "userId", company_id as "companyId", role, role_id as "roleId", is_active as "isActive", created_at as "createdAt"
      FROM company_memberships
      WHERE company_id = $1;
    `;

    const res = await executor.query<CompanyMembership>(sql, [companyId]);
    return res.rows;
  }

  async updateMembership(
    userId: string,
    companyId: string,
    patch: { role?: RoleName; roleId?: string | null },
    customExecutor?: DbExecutor
  ): Promise<CompanyMembership | null> {
    const executor = await this.getExecutor(customExecutor);
    const sets: string[] = [];
    const params: unknown[] = [userId, companyId];

    if (patch.role !== undefined) {
      params.push(patch.role);
      sets.push(`role = $${params.length}`);
    }
    if (patch.roleId !== undefined) {
      params.push(patch.roleId);
      sets.push(`role_id = $${params.length}`);
    }

    if (sets.length === 0) {
      return await this.getMembership(userId, companyId, executor);
    }

    const sql = `
      UPDATE company_memberships
      SET ${sets.join(', ')}
      WHERE user_id = $1 AND company_id = $2
      RETURNING id::text, user_id as "userId", company_id as "companyId", role, role_id as "roleId", is_active as "isActive", created_at as "createdAt";
    `;
    const res = await executor.query<CompanyMembership>(sql, params);
    return res.rows[0] || null;
  }

  async setMembershipRoleById(
    membershipId: string,
    roleId: string | null,
    companyId: string,
    customExecutor?: DbExecutor
  ): Promise<CompanyMembership | null> {
    const executor = await this.getExecutor(customExecutor);
    const sql = `
      UPDATE company_memberships
      SET role_id = $2
      WHERE id = $1 AND company_id = $3
      RETURNING id::text, user_id as "userId", company_id as "companyId", role, role_id as "roleId", is_active as "isActive", created_at as "createdAt";
    `;
    const res = await executor.query<CompanyMembership>(sql, [membershipId, roleId, companyId]);
    return res.rows[0] || null;
  }

  async listCompanyMemberRoles(companyId: string, customExecutor?: DbExecutor): Promise<CompanyMemberRoleView[]> {
    const executor = await this.getExecutor(customExecutor);
    const sql = `
      SELECT
        cm.id::text AS "membershipId",
        cm.user_id AS "userId",
        u.username AS username,
        cm.company_id AS "companyId",
        cm.role AS role,
        cm.role_id AS "roleId",
        r.code AS "roleCode",
        r.name_ar AS "roleNameAr",
        cm.is_active AS "isActive",
        cm.created_at AS "createdAt"
      FROM company_memberships cm
      INNER JOIN platform_users u ON u.id = cm.user_id
      LEFT JOIN roles r ON r.id = cm.role_id AND r.company_id = cm.company_id
      WHERE cm.company_id = $1
      ORDER BY u.created_at DESC;
    `;
    const res = await executor.query<CompanyMemberRoleView>(sql, [companyId]);
    return res.rows;
  }

  async updateMembershipRole(userId: string, companyId: string, role: RoleName, customExecutor?: DbExecutor): Promise<boolean> {
    const updated = await this.updateMembership(userId, companyId, { role, roleId: null }, customExecutor);
    return Boolean(updated);
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
