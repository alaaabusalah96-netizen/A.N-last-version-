import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import {
  OrgUnit,
  CreateOrgUnitInput,
  UpdateOrgUnitInput,
  UserOrgScope,
  OrgScopeAccessLevel,
  OrgUnitMember,
} from './orgUnitTypes.js';

export interface NormalizedScopeInsert {
  orgUnitId: string;
  includeDescendants: boolean;
  accessLevel: OrgScopeAccessLevel;
  roleId: string | null;
  validFrom: string | null;
  validUntil: string | null;
  reason: string | null;
}

export class OrgUnitRepository {
  /**
   * List all organizational units for a company, ordered by path/code.
   */
  async listUnits(companyId: string, customExecutor?: DbExecutor): Promise<OrgUnit[]> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        SELECT 
          id, 
          company_id as "companyId", 
          parent_id as "parentId", 
          code, 
          name_ar as "nameAr", 
          name_en as "nameEn", 
          unit_type as "unitType", 
          is_active as "isActive", 
          path, 
          created_at as "createdAt", 
          updated_at as "updatedAt"
        FROM org_units
        WHERE company_id = $1
        ORDER BY path ASC, code ASC
      `;
      const res = await tx.query<OrgUnit>(sql, [companyId]);
      return res.rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Find an organizational unit by ID.
   */
  async findById(companyId: string, id: string, customExecutor?: DbExecutor): Promise<OrgUnit | null> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        SELECT 
          id, 
          company_id as "companyId", 
          parent_id as "parentId", 
          code, 
          name_ar as "nameAr", 
          name_en as "nameEn", 
          unit_type as "unitType", 
          is_active as "isActive", 
          path, 
          created_at as "createdAt", 
          updated_at as "updatedAt"
        FROM org_units
        WHERE id = $1 AND company_id = $2
      `;
      const res = await tx.query<OrgUnit>(sql, [id, companyId]);
      return res.rows[0] || null;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Find an organizational unit by code within a company.
   */
  async findByCode(companyId: string, code: string, customExecutor?: DbExecutor): Promise<OrgUnit | null> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        SELECT 
          id, 
          company_id as "companyId", 
          parent_id as "parentId", 
          code, 
          name_ar as "nameAr", 
          name_en as "nameEn", 
          unit_type as "unitType", 
          is_active as "isActive", 
          path, 
          created_at as "createdAt", 
          updated_at as "updatedAt"
        FROM org_units
        WHERE company_id = $1 AND code = $2
      `;
      const res = await tx.query<OrgUnit>(sql, [companyId, code.trim()]);
      return res.rows[0] || null;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Insert a new organizational unit.
   */
  async createUnit(
    companyId: string,
    input: CreateOrgUnitInput,
    computedPath: string,
    customExecutor?: DbExecutor
  ): Promise<OrgUnit> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        INSERT INTO org_units (
          company_id, parent_id, code, name_ar, name_en, unit_type, is_active, path, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        RETURNING 
          id, 
          company_id as "companyId", 
          parent_id as "parentId", 
          code, 
          name_ar as "nameAr", 
          name_en as "nameEn", 
          unit_type as "unitType", 
          is_active as "isActive", 
          path, 
          created_at as "createdAt", 
          updated_at as "updatedAt"
      `;
      const res = await tx.query<OrgUnit>(sql, [
        companyId,
        input.parentId || null,
        input.code.trim(),
        input.nameAr.trim(),
        input.nameEn ? input.nameEn.trim() : null,
        input.unitType,
        input.isActive !== undefined ? input.isActive : true,
        computedPath,
      ]);
      return res.rows[0];
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Update unit details (name, active status).
   */
  async updateUnit(
    companyId: string,
    id: string,
    input: UpdateOrgUnitInput,
    customExecutor?: DbExecutor
  ): Promise<OrgUnit | null> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        UPDATE org_units
        SET 
          name_ar = COALESCE($3, name_ar),
          name_en = COALESCE($4, name_en),
          is_active = COALESCE($5, is_active),
          updated_at = NOW()
        WHERE id = $1 AND company_id = $2
        RETURNING 
          id, 
          company_id as "companyId", 
          parent_id as "parentId", 
          code, 
          name_ar as "nameAr", 
          name_en as "nameEn", 
          unit_type as "unitType", 
          is_active as "isActive", 
          path, 
          created_at as "createdAt", 
          updated_at as "updatedAt"
      `;
      const res = await tx.query<OrgUnit>(sql, [
        id,
        companyId,
        input.nameAr ? input.nameAr.trim() : null,
        input.nameEn !== undefined ? (input.nameEn ? input.nameEn.trim() : null) : null,
        input.isActive !== undefined ? input.isActive : null,
      ]);
      return res.rows[0] || null;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  /**
   * List all configured user org scopes for a company / user (including scheduled/expired rows for admin editing).
   */
  async listUserScopes(
    companyId: string,
    userId: string,
    customExecutor?: DbExecutor
  ): Promise<UserOrgScope[]> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        SELECT 
          s.company_id as "companyId",
          s.user_id as "userId",
          s.org_unit_id as "orgUnitId",
          s.include_descendants as "includeDescendants",
          s.access_level as "accessLevel",
          s.role_id as "roleId",
          r.code as "roleCode",
          s.valid_from::text as "validFrom",
          s.valid_until::text as "validUntil",
          s.delegated_by as "delegatedBy",
          s.reason,
          s.created_at as "createdAt",
          u.code as "orgUnitCode",
          u.name_ar as "orgUnitNameAr",
          u.code as "code",
          u.name_ar as "nameAr",
          u.unit_type as "unitType",
          u.path as "path"
        FROM user_org_scope s
        INNER JOIN org_units u ON s.org_unit_id = u.id
        LEFT JOIN roles r ON r.id = s.role_id AND r.company_id = s.company_id
        WHERE s.company_id = $1 AND s.user_id = $2
        ORDER BY u.unit_type ASC, u.path ASC
      `;
      const res = await tx.query<UserOrgScope>(sql, [companyId, userId]);
      return res.rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  /**
   * List currently effective user org scopes from v_user_effective_scopes (filters by valid_from/valid_until and active units).
   * Ordered by unit_type then org_unit_path.
   */
  async listEffectiveScopes(
    companyId: string,
    userId: string,
    customExecutor?: DbExecutor
  ): Promise<UserOrgScope[]> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        SELECT
          company_id as "companyId",
          user_id as "userId",
          org_unit_id as "orgUnitId",
          include_descendants as "includeDescendants",
          access_level as "accessLevel",
          role_id as "roleId",
          role_code as "roleCode",
          valid_from::text as "validFrom",
          valid_until::text as "validUntil",
          delegated_by as "delegatedBy",
          reason,
          created_at as "createdAt",
          org_unit_code as "orgUnitCode",
          org_unit_name_ar as "orgUnitNameAr",
          org_unit_code as "code",
          org_unit_name_ar as "nameAr",
          unit_type as "unitType",
          org_unit_path as "path"
        FROM v_user_effective_scopes
        WHERE company_id = $1 AND user_id = $2
        ORDER BY unit_type ASC, org_unit_path ASC
      `;
      const res = await tx.query<UserOrgScope>(sql, [companyId, userId]);
      return res.rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Count active company members whose effective scope covers an org unit.
   */
  async countActiveMembersInScope(
    companyId: string,
    orgUnitId: string,
    customExecutor?: DbExecutor
  ): Promise<number> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        SELECT count(DISTINCT s.user_id)::int AS cnt
        FROM org_units target
        JOIN v_user_effective_scopes s
          ON s.company_id = target.company_id
         AND (
           s.org_unit_id = target.id
           OR (s.include_descendants = true AND target.path LIKE s.org_unit_path || '%')
         )
        JOIN company_memberships cm
          ON cm.company_id = s.company_id AND cm.user_id = s.user_id AND cm.is_active = true
        WHERE target.company_id = $1 AND target.id = $2
      `;
      const res = await tx.query<{ cnt: number }>(sql, [companyId, orgUnitId]);
      return Number(res.rows[0]?.cnt || 0);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  /**
   * List active members holding effective scope over a specific organizational unit.
   */
  async listMembersByOrgUnit(
    companyId: string,
    orgUnitId: string,
    customExecutor?: DbExecutor
  ): Promise<OrgUnitMember[]> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        SELECT DISTINCT
          u.id as "userId",
          u.username,
          cm.role,
          s.org_unit_id as "orgUnitId",
          s.include_descendants as "includeDescendants",
          s.access_level as "accessLevel",
          s.role_id as "roleId",
          s.role_code as "roleCode",
          s.valid_from::text as "validFrom",
          s.valid_until::text as "validUntil",
          s.reason
        FROM org_units target
        JOIN v_user_effective_scopes s
          ON s.company_id = target.company_id
         AND (
           s.org_unit_id = target.id
           OR (s.include_descendants = true AND target.path LIKE s.org_unit_path || '%')
         )
        JOIN company_memberships cm
          ON cm.company_id = s.company_id AND cm.user_id = s.user_id AND cm.is_active = true
        JOIN platform_users u
          ON u.id = s.user_id AND u.is_active = true
        WHERE target.company_id = $1 AND target.id = $2
        ORDER BY u.username ASC
      `;
      const res = await tx.query<OrgUnitMember>(sql, [companyId, orgUnitId]);
      return res.rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Replace all user org scopes for a user within a company.
   */
  async setUserScopes(
    companyId: string,
    userId: string,
    scopes: NormalizedScopeInsert[],
    delegatedBy?: string | null,
    customExecutor?: DbExecutor
  ): Promise<void> {
    const run = async (tx: DbExecutor) => {
      // 1. Delete existing scopes for this user in this company
      await tx.query(
        `DELETE FROM user_org_scope WHERE company_id = $1 AND user_id = $2`,
        [companyId, userId]
      );

      // 2. Insert new scopes
      for (const sc of scopes) {
        await tx.query(
          `INSERT INTO user_org_scope (
             company_id, user_id, org_unit_id, include_descendants, access_level,
             role_id, valid_from, valid_until, delegated_by, reason, created_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
          [
            companyId,
            userId,
            sc.orgUnitId,
            sc.includeDescendants !== undefined ? sc.includeDescendants : true,
            sc.accessLevel || 'read',
            sc.roleId || null,
            sc.validFrom || null,
            sc.validUntil || null,
            delegatedBy || null,
            sc.reason || null,
          ]
        );
      }
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  /**
   * Check whether a user has an active membership in a company.
   */
  async checkUserCompanyMembership(
    companyId: string,
    userId: string,
    customExecutor?: DbExecutor
  ): Promise<boolean> {
    const run = async (tx: DbExecutor) => {
      const sql = `
        SELECT 1 
        FROM company_memberships 
        WHERE company_id = $1 AND user_id = $2 AND is_active = true
      `;
      const res = await tx.query(sql, [companyId, userId]);
      return res.rows.length > 0;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultOrgUnitRepository = new OrgUnitRepository();
