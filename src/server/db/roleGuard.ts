import { DbExecutor } from './types.js';

export async function assertSafeDbRole(executor: DbExecutor): Promise<void> {
  if (!executor || typeof executor.query !== 'function') {
    throw new Error('[dbRoleGuard] FATAL: Invalid executor provided — role verification failed closed.');
  }

  try {
    const res = await executor.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      'SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user;'
    );

    if (!res || !res.rows || res.rows.length === 0) {
      throw new Error('[dbRoleGuard] FATAL: Role verification failed — current_user not found in pg_roles.');
    }

    const { rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole } = res.rows[0];

    // Check inherited memberships in privileged roles
    const inheritedRes = await executor.query<{ has_inherited: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_auth_members m
        JOIN pg_roles r ON m.roleid = r.oid
        JOIN pg_roles u ON m.member = u.oid
        WHERE u.rolname = current_user AND (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole)
      ) as has_inherited;`
    );

    const hasInherited = inheritedRes.rows[0]?.has_inherited ?? false;

    if (rolsuper || rolbypassrls || rolcreatedb || rolcreaterole || hasInherited) {
      throw new Error(
        `[dbRoleGuard] FATAL: Connected database user '${rolname}' has privileged attributes (super=${rolsuper}, bypassrls=${rolbypassrls}, createdb=${rolcreatedb}, createrole=${rolcreaterole}, inherited=${hasInherited}). Runtime application connection must be unprivileged (an_app role).`
      );
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('[dbRoleGuard]')) {
      throw err;
    }
    throw new Error(`[dbRoleGuard] FATAL: Role verification query failed (fail-closed): ${err instanceof Error ? err.message : String(err)}`);
  }
}
