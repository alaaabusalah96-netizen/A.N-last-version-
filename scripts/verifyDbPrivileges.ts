import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor } from '../src/server/db/index.js';

console.log('--- Running Database Privileges Matrix Verification (R10 & R4) ---');

async function runTests() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Database privilege tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Database executor unavailable for privilege verification.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    // 1. Role privileges: rolsuper = false, rolbypassrls = false, rolcreatedb = false, rolcreaterole = false
    const roleRes = await executor.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      user_name: string;
    }>(
      'SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, current_user as user_name FROM pg_roles WHERE rolname = current_user;'
    );
    const roleInfo = roleRes.rows[0];

    await check('1. Connected DB user is NOT SUPERUSER', roleInfo && roleInfo.rolsuper === false);
    await check('2. Connected DB user does NOT have BYPASSRLS privilege', roleInfo && roleInfo.rolbypassrls === false);
    await check('3. Connected DB user does NOT have CREATEDB privilege', roleInfo && roleInfo.rolcreatedb === false);
    await check('4. Connected DB user does NOT have CREATEROLE privilege', roleInfo && roleInfo.rolcreaterole === false);

    // 5. Privileged inherited membership check
    const inheritedRes = await executor.query<{ has_inherited: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_auth_members m
        JOIN pg_roles r ON m.roleid = r.oid
        JOIN pg_roles u ON m.member = u.oid
        WHERE u.rolname = current_user AND (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole)
      ) as has_inherited;`
    );
    await check('5. Connected DB user has no privileged inherited membership', !inheritedRes.rows[0]?.has_inherited);

    // 6. Test DDL prohibitions (CREATE DATABASE / CREATE ROLE should fail for an_app)
    let createDbFailed = false;
    try {
      await executor.query('CREATE DATABASE test_forbidden_db;');
    } catch {
      createDbFailed = true;
    }
    await check('6. an_app cannot CREATE DATABASE', createDbFailed);

    let createRoleFailed = false;
    try {
      await executor.query('CREATE ROLE test_forbidden_role;');
    } catch {
      createRoleFailed = true;
    }
    await check('7. an_app cannot CREATE ROLE', createRoleFailed);

    // 7. Table Ownership: connected user must NOT be owner of any public tables
    const ownerRes = await executor.query<{ tablename: string; tableowner: string }>(
      "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user;"
    );
    await check(
      '8. App role is NOT owner of any tables in public schema',
      ownerRes.rows.length === 0,
      ownerRes.rows.length > 0 ? `Owned tables: ${ownerRes.rows.map((r) => r.tablename).join(', ')}` : undefined
    );

    // 8. Table Privilege Matrix
    const tablesRes = await executor.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public';"
    );

    for (const row of tablesRes.rows) {
      const tbl = row.tablename;

      const privRes = await executor.query<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        can_truncate: boolean;
      }>(
        `SELECT
          has_table_privilege(current_user, $1, 'SELECT') as can_select,
          has_table_privilege(current_user, $1, 'INSERT') as can_insert,
          has_table_privilege(current_user, $1, 'UPDATE') as can_update,
          has_table_privilege(current_user, $1, 'DELETE') as can_delete,
          has_table_privilege(current_user, $1, 'TRUNCATE') as can_truncate;`,
        [tbl]
      );

      const p = privRes.rows[0];

      if (tbl === 'audit_logs') {
        await check(
          "9. audit_logs table privileges (SELECT=true, INSERT=true, UPDATE=false, DELETE=false, TRUNCATE=false)",
          p.can_select && p.can_insert && !p.can_update && !p.can_delete && !p.can_truncate
        );
      } else if (tbl === 'schema_migrations') {
        await check(
          "10. schema_migrations table privileges (SELECT=true, INSERT=false, UPDATE=false, DELETE=false, TRUNCATE=false)",
          p.can_select && !p.can_insert && !p.can_update && !p.can_delete && !p.can_truncate
        );
      } else {
        await check(
          `Table '${tbl}' privileges (SELECT=true, INSERT=true, UPDATE=true, DELETE=true, TRUNCATE=false)`,
          p.can_select && p.can_insert && p.can_update && p.can_delete && !p.can_truncate
        );
      }
    }
  } catch (err) {
    await check('Database privilege matrix execution', false, err instanceof Error ? err.message : String(err));
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
