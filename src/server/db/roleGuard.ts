import { DbExecutor } from './types.js';

export async function assertSafeDbRole(executor: DbExecutor): Promise<void> {
  const isProd = process.env.NODE_ENV === 'production';
  const allowPrivilegedInDev = process.env.ALLOW_PRIVILEGED_DB_ROLE === '1';

  if (isProd && allowPrivilegedInDev) {
    console.warn('[dbRoleGuard] WARNING: ALLOW_PRIVILEGED_DB_ROLE=1 is ignored in production environments.');
  }

  const res = await executor.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;'
  );

  if (res.rows.length === 0) {
    throw new Error('[dbRoleGuard] FATAL: Role validation failed — current_user not found in pg_roles.');
  }

  const { rolsuper, rolbypassrls, rolname } = res.rows[0];

  // Also verify inherited or direct superuser / bypassrls via pg_auth_members / has_role if needed,
  // but current_user rolsuper and rolbypassrls cover effective attributes.
  if (rolsuper || rolbypassrls) {
    const msg = `[dbRoleGuard] Connected database user '${rolname}' has SUPERUSER (${rolsuper}) or BYPASSRLS (${rolbypassrls}) privileges!`;

    if (isProd) {
      throw new Error(`[dbRoleGuard] FATAL: Privileged database role (SUPERUSER/BYPASSRLS) is strictly forbidden in production!`);
    }

    if (!allowPrivilegedInDev) {
      throw new Error(`[dbRoleGuard] Privileged database role (SUPERUSER/BYPASSRLS) detected for '${rolname}'. Set ALLOW_PRIVILEGED_DB_ROLE=1 in local dev environment to override.`);
    }

    console.warn(`[dbRoleGuard] WARNING: ${msg}`);
  }
}

