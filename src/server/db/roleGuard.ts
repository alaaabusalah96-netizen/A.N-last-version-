import { DbExecutor } from './types.js';

export async function assertSafeDbRole(executor: DbExecutor): Promise<void> {
  if (!executor || typeof executor.query !== 'function') {
    throw new Error('[dbRoleGuard] FATAL: Invalid executor provided — role verification failed closed.');
  }

  try {
    // 1. Check direct attributes of current_user
    const res = await executor.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
    }>(
      'SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = current_user;'
    );

    if (!res || !res.rows || res.rows.length === 0) {
      throw new Error('[dbRoleGuard] FATAL: Role verification failed — current_user not found in pg_roles.');
    }

    const { rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication } = res.rows[0];
    const violations: string[] = [];

    if (rolsuper) violations.push('super');
    if (rolbypassrls) violations.push('bypassrls');
    if (rolcreatedb) violations.push('createdb');
    if (rolcreaterole) violations.push('createrole');
    if (rolreplication) violations.push('replication');

    // 2. Multi-level membership check in privileged roles
    const membershipRes = await executor.query<{ has_priv: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_roles r
        WHERE r.rolname <> current_user
          AND (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
               OR r.rolname IN ('pg_read_all_data', 'pg_write_all_data', 'pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files'))
          AND pg_has_role(current_user, r.oid, 'MEMBER')
      ) as has_priv;`
    );

    if (membershipRes.rows[0]?.has_priv) {
      violations.push('member_of_privileged');
    }

    // 3. Check table ownership in public schema
    const ownerRes = await executor.query<{ count: string }>(
      "SELECT count(*)::text as count FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user;"
    );
    const ownedCount = parseInt(ownerRes.rows[0]?.count || '0', 10);
    if (ownedCount > 0) {
      violations.push('owns_tables');
    }

    if (violations.length > 0) {
      throw new Error(`[dbRoleGuard] FATAL: connected role violates least-privilege policy (reasons: ${violations.join(',')})`);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('[dbRoleGuard]')) {
      throw err;
    }
    throw new Error(`[dbRoleGuard] FATAL: Role verification query failed (fail-closed): ${err instanceof Error ? err.message : String(err)}`);
  }
}
