import { DbExecutor } from './types.js';

export async function assertSafeDbRole(executor: DbExecutor): Promise<void> {
  const isProd = process.env.NODE_ENV === 'production';
  const allowPrivileged = process.env.ALLOW_PRIVILEGED_DB_ROLE === '1';

  try {
    const res = await executor.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;'
    );

    if (res.rows.length === 0) return;

    const { rolsuper, rolbypassrls } = res.rows[0];

    if (rolsuper || rolbypassrls) {
      const msg = `[dbRoleGuard] WARNING: Connected database user has SUPERUSER (${rolsuper}) or BYPASSRLS (${rolbypassrls}) privileges!`;

      if (isProd && !allowPrivileged) {
        throw new Error(`[dbRoleGuard] FATAL: Privileged database role (SUPERUSER/BYPASSRLS) is strictly forbidden in production!`);
      }

      console.warn(msg);
    }
  } catch (err) {
    if (isProd && !allowPrivileged) {
      throw err;
    }
    console.error('[dbRoleGuard] Failed to query current_user role privileges:', err instanceof Error ? err.message : String(err));
  }
}
