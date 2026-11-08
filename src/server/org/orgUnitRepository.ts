import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { OrgUnit, CreateOrgUnitInput, UpdateOrgUnitInput, UserOrgScope } from './orgUnitTypes.js';

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
   * List user org scopes for a company / user.
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
          s.created_at as "createdAt",
          u.code as "orgUnitCode",
          u.name_ar as "orgUnitNameAr"
        FROM user_org_scope s
        INNER JOIN org_units u ON s.org_unit_id = u.id
        WHERE s.company_id = $1 AND s.user_id = $2
        ORDER BY u.path ASC
      `;
      const res = await tx.query<UserOrgScope>(sql, [companyId, userId]);
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
    scopes: { orgUnitId: string; includeDescendants?: boolean; accessLevel?: 'read' | 'write' }[],
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
          `INSERT INTO user_org_scope (company_id, user_id, org_unit_id, include_descendants, access_level, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [
            companyId,
            userId,
            sc.orgUnitId,
            sc.includeDescendants !== undefined ? sc.includeDescendants : true,
            sc.accessLevel || 'read',
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
        WHERE company_id = $1 AND user_id = $2 AND status = 'active'
      `;
      const res = await tx.query(sql, [companyId, userId]);
      return res.rows.length > 0;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultOrgUnitRepository = new OrgUnitRepository();
