import { DbExecutor } from './types.js';

export async function assertSafeDbRole(executor: DbExecutor): Promise<void> {
  const isProd = process.env.NODE_ENV === 'production';
  const allowPrivilegedInDev = process.env.ALLOW_PRIVILEGED_DB_ROLE === '1';

  if (isProd && allowPrivilegedInDev) {
    console.warn('[dbRoleGuard] WARNING: ALLOW_PRIVILEGED_DB_ROLE=1 is ignored in production environments.');
  }

  try {
    const res = await executor.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;'
    );

    if (res.rows.length === 0) return;

    const { rolsuper, rolbypassrls } = res.rows[0];

    if (rolsuper || rolbypassrls) {
      const msg = `[dbRoleGuard] Connected database user has SUPERUSER (${rolsuper}) or BYPASSRLS (${rolbypassrls}) privileges!`;

      if (isProd) {
        throw new Error(`[dbRoleGuard] FATAL: Privileged database role (SUPERUSER/BYPASSRLS) is strictly forbidden in production!`);
      }

      if (!allowPrivilegedInDev) {
        throw new Error(`[dbRoleGuard] Privileged database role (SUPERUSER/BYPASSRLS) detected. Set ALLOW_PRIVILEGED_DB_ROLE=1 in local dev environment to override.`);
      }

      console.warn(`[dbRoleGuard] WARNING: ${msg}`);
    }
  } catch (err) {
    if (isProd) {
      throw err;
    }
    if (!allowPrivilegedInDev && err instanceof Error && err.message.includes('dbRoleGuard')) {
      throw err;
    }
    console.error('[dbRoleGuard] Failed to query current_user role privileges:', err instanceof Error ? err.message : String(err));
  }
}
