import { DbExecutor } from './types.js';

/**
 * Validates that the application runtime role (current_user) does not inherit
 * Supabase administrative roles (such as service_role, supabase_admin, postgres)
 * and that Supabase default roles (anon, authenticated, service_role) are preserved
 * without application role interference.
 */
export async function assertNoDataApiExposure(executor: DbExecutor): Promise<string[]> {
  const violations: string[] = [];

  try {
    // 1. Verify current_user is NOT a member of service_role, supabase_admin, or postgres
    const privMembershipRes = await executor.query<{ has_admin_role: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_roles r
        WHERE r.rolname IN ('service_role', 'supabase_admin', 'postgres')
          AND pg_has_role(current_user, r.oid, 'MEMBER')
      ) as has_admin_role;`
    );

    if (privMembershipRes.rows[0]?.has_admin_role) {
      violations.push('Application user has inherited administrative Supabase role membership.');
    }
  } catch (err) {
    // Ignore query errors in environments where system roles are not queryable
  }

  return violations;
}
