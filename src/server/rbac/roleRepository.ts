import { getDefaultExecutor } from '../db/index.js';
import { DbExecutor } from '../db/types.js';

export type RoleOrgLevel = 'company' | 'branch' | 'department';

export interface RoleRecord {
  id: string;
  companyId: string;
  code: string;
  nameAr: string;
  description: string | null;
  orgLevel: RoleOrgLevel;
  isSystem: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  permissions?: string[];
  permissionsCount?: number;
  usersCount?: number;
}

export class RoleRepository {
  private mapRow(row: any): RoleRecord {
    return {
      id: row.id,
      companyId: row.companyId ?? row.company_id,
      code: row.code,
      nameAr: row.nameAr ?? row.name_ar,
      description: row.description ?? null,
      orgLevel: (row.orgLevel ?? row.org_level ?? 'company') as RoleOrgLevel,
      isSystem: Boolean(row.isSystem ?? row.is_system ?? false),
      isActive: Boolean(row.isActive ?? row.is_active ?? true),
      createdAt: row.createdAt ?? row.created_at,
      updatedAt: row.updatedAt ?? row.updated_at,
      ...(row.permissions !== undefined ? { permissions: Array.isArray(row.permissions) ? row.permissions : [] } : {}),
      ...(row.permissionsCount !== undefined ? { permissionsCount: Number(row.permissionsCount) } : {}),
      ...(row.usersCount !== undefined ? { usersCount: Number(row.usersCount) } : {}),
    };
  }

  async listByCompany(companyId: string, executor?: DbExecutor): Promise<RoleRecord[]> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        SELECT
          r.id,
          r.company_id AS "companyId",
          r.code,
          r.name_ar AS "nameAr",
          r.description,
          r.org_level AS "orgLevel",
          r.is_system AS "isSystem",
          r.is_active AS "isActive",
          r.created_at AS "createdAt",
          r.updated_at AS "updatedAt",
          COALESCE(
            (SELECT array_agg(rp.permission_code ORDER BY rp.permission_code)
             FROM role_permissions rp WHERE rp.role_id = r.id),
            ARRAY[]::text[]
          ) AS permissions,
          (SELECT count(*)::int FROM role_permissions rp WHERE rp.role_id = r.id) AS "permissionsCount",
          (SELECT count(*)::int FROM company_memberships cm WHERE cm.company_id = r.company_id AND cm.role_id = r.id AND cm.is_active = true) AS "usersCount"
        FROM roles r
        WHERE r.company_id = $1
        ORDER BY r.is_system DESC, r.created_at ASC, r.code ASC;
      `;
      const res = await ex.query(sql, [companyId]);
      return res.rows.map((r) => this.mapRow(r));
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async findById(companyId: string, roleId: string, executor?: DbExecutor): Promise<RoleRecord | null> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        SELECT
          r.id,
          r.company_id AS "companyId",
          r.code,
          r.name_ar AS "nameAr",
          r.description,
          r.org_level AS "orgLevel",
          r.is_system AS "isSystem",
          r.is_active AS "isActive",
          r.created_at AS "createdAt",
          r.updated_at AS "updatedAt",
          COALESCE(
            (SELECT array_agg(rp.permission_code ORDER BY rp.permission_code)
             FROM role_permissions rp WHERE rp.role_id = r.id),
            ARRAY[]::text[]
          ) AS permissions
        FROM roles r
        WHERE r.company_id = $1 AND r.id = $2;
      `;
      const res = await ex.query(sql, [companyId, roleId]);
      return res.rows[0] ? this.mapRow(res.rows[0]) : null;
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async findByCode(companyId: string, code: string, executor?: DbExecutor): Promise<RoleRecord | null> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        SELECT
          r.id,
          r.company_id AS "companyId",
          r.code,
          r.name_ar AS "nameAr",
          r.description,
          r.org_level AS "orgLevel",
          r.is_system AS "isSystem",
          r.is_active AS "isActive",
          r.created_at AS "createdAt",
          r.updated_at AS "updatedAt"
        FROM roles r
        WHERE r.company_id = $1 AND r.code = $2;
      `;
      const res = await ex.query(sql, [companyId, code]);
      return res.rows[0] ? this.mapRow(res.rows[0]) : null;
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async insertRole(
    companyId: string,
    input: {
      code: string;
      nameAr: string;
      description?: string | null;
      orgLevel?: RoleOrgLevel;
      isSystem?: boolean;
    },
    executor?: DbExecutor
  ): Promise<RoleRecord> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        INSERT INTO roles (company_id, code, name_ar, description, org_level, is_system)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING
          id,
          company_id AS "companyId",
          code,
          name_ar AS "nameAr",
          description,
          org_level AS "orgLevel",
          is_system AS "isSystem",
          is_active AS "isActive",
          created_at AS "createdAt",
          updated_at AS "updatedAt";
      `;
      const res = await ex.query(sql, [
        companyId,
        input.code.trim(),
        input.nameAr.trim(),
        input.description ? input.description.trim() : null,
        input.orgLevel || 'company',
        Boolean(input.isSystem),
      ]);
      return this.mapRow(res.rows[0]);
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async updateRole(
    companyId: string,
    roleId: string,
    input: {
      nameAr?: string;
      description?: string | null;
      orgLevel?: RoleOrgLevel;
    },
    executor?: DbExecutor
  ): Promise<RoleRecord> {
    const run = async (ex: DbExecutor) => {
      const sets: string[] = ['updated_at = NOW()'];
      const params: unknown[] = [companyId, roleId];

      if (input.nameAr !== undefined) {
        params.push(input.nameAr.trim());
        sets.push(`name_ar = $${params.length}`);
      }
      if (input.description !== undefined) {
        params.push(input.description ? input.description.trim() : null);
        sets.push(`description = $${params.length}`);
      }
      if (input.orgLevel !== undefined) {
        params.push(input.orgLevel);
        sets.push(`org_level = $${params.length}`);
      }

      const sql = `
        UPDATE roles
        SET ${sets.join(', ')}
        WHERE company_id = $1 AND id = $2
        RETURNING
          id,
          company_id AS "companyId",
          code,
          name_ar AS "nameAr",
          description,
          org_level AS "orgLevel",
          is_system AS "isSystem",
          is_active AS "isActive",
          created_at AS "createdAt",
          updated_at AS "updatedAt";
      `;
      const res = await ex.query(sql, params);
      return this.mapRow(res.rows[0]);
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async setActive(
    companyId: string,
    roleId: string,
    isActive: boolean,
    executor?: DbExecutor
  ): Promise<RoleRecord> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        UPDATE roles
        SET is_active = $3, updated_at = NOW()
        WHERE company_id = $1 AND id = $2
        RETURNING
          id,
          company_id AS "companyId",
          code,
          name_ar AS "nameAr",
          description,
          org_level AS "orgLevel",
          is_system AS "isSystem",
          is_active AS "isActive",
          created_at AS "createdAt",
          updated_at AS "updatedAt";
      `;
      const res = await ex.query(sql, [companyId, roleId, isActive]);
      return this.mapRow(res.rows[0]);
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async countActiveMembers(companyId: string, roleId: string, executor?: DbExecutor): Promise<number> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        SELECT count(*)::int AS cnt
        FROM company_memberships
        WHERE company_id = $1 AND role_id = $2 AND is_active = true;
      `;
      const res = await ex.query<{ cnt: number }>(sql, [companyId, roleId]);
      return Number(res.rows[0]?.cnt || 0);
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async listPermissions(roleId: string, executor?: DbExecutor): Promise<string[]> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        SELECT permission_code AS code
        FROM role_permissions
        WHERE role_id = $1
        ORDER BY permission_code ASC;
      `;
      const res = await ex.query<{ code: string }>(sql, [roleId]);
      return res.rows.map((r) => r.code);
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async replacePermissions(roleId: string, codes: string[], executor?: DbExecutor): Promise<string[]> {
    const run = async (ex: DbExecutor) => {
      await ex.query(`DELETE FROM role_permissions WHERE role_id = $1;`, [roleId]);
      for (const code of codes) {
        await ex.query(
          `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING;`,
          [roleId, code]
        );
      }
      return [...codes];
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  async listRoleIdsWithPermissionsForUser(
    companyId: string,
    userId: string,
    executor?: DbExecutor
  ): Promise<Array<{ roleId: string; code: string; permissions: string[] }>> {
    const run = async (ex: DbExecutor) => {
      const sql = `
        SELECT
          r.id AS "roleId",
          r.code,
          COALESCE(
            array_agg(rp.permission_code ORDER BY rp.permission_code)
            FILTER (WHERE rp.permission_code IS NOT NULL),
            ARRAY[]::text[]
          ) AS permissions
        FROM company_memberships cm
        JOIN roles r ON r.id = cm.role_id AND r.company_id = cm.company_id AND r.is_active = true
        LEFT JOIN role_permissions rp ON rp.role_id = r.id
        WHERE cm.company_id = $1 AND cm.user_id = $2 AND cm.is_active = true
        GROUP BY r.id, r.code;
      `;
      const res = await ex.query<{ roleId: string; code: string; permissions: string[] }>(sql, [companyId, userId]);
      return res.rows;
    };
    return executor ? run(executor) : run(await this.defaultExecutor());
  }

  private async defaultExecutor(): Promise<DbExecutor> {
    const executor = await getDefaultExecutor();
    if (!executor) {
      throw new Error('DB_UNAVAILABLE: DATABASE_URL is required for role repository');
    }
    return executor;
  }
}

export const defaultRoleRepository = new RoleRepository();
