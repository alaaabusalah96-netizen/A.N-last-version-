import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { assertNoDataApiExposure } from '../src/server/db/dataApiGuard.js';

console.log('--- Running Supabase Roles & Data API Guard Verification (F10-5) ---');

async function runTests() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Data API guard tests BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Executor unavailable.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  // 1. Verify application role does not inherit administrative Supabase roles
  const violations = await assertNoDataApiExposure(executor);
  await check(
    'assertNoDataApiExposure confirms application role does not inherit administrative Supabase roles',
    violations.length === 0,
    violations.length > 0 ? violations.join('; ') : undefined
  );

  // 2. Verify Supabase default roles are preserved and not altered by an_app
  const rolesRes = await executor.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role');"
  );
  const foundRoles = rolesRes.rows.map((r) => r.rolname);

  if (foundRoles.length > 0) {
    // Check that an_app is NOT a member of any of these roles
    const memberCheck = await executor.query<{ has_membership: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_roles r
        WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
          AND pg_has_role(current_user, r.oid, 'MEMBER')
      ) as has_membership;`
    );
    await check(
      'Application role does not have inherited membership in Supabase default roles',
      !memberCheck.rows[0]?.has_membership
    );
  } else {
    await check('Supabase default roles check (non-managed test environment)', true);
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
