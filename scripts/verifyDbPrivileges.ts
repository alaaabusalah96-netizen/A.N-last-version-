import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor } from '../src/server/db/index.js';

console.log('--- Running Database Privileges Matrix Verification (R10 & R4 / REPAIR-7) ---');

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
    // 0. Verify connected DB user equals expected APP_DB_USER
    const expectedAppUser = process.env.APP_DB_USER || 'an_app';
    const currentUserRes = await executor.query<{ user_name: string }>(
      'SELECT current_user as user_name;'
    );
    const connectedUser = currentUserRes.rows[0]?.user_name;
    await check(
      `Connected DB user '${connectedUser}' matches expected application role '${expectedAppUser}'`,
      connectedUser === expectedAppUser
    );

    // 1. Direct role attributes check (SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE, REPLICATION)
    const roleRes = await executor.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
    }>(
      'SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = current_user;'
    );
    const roleInfo = roleRes.rows[0];

    await check('1. Connected DB user is NOT SUPERUSER', roleInfo && roleInfo.rolsuper === false);
    await check('2. Connected DB user does NOT have BYPASSRLS privilege', roleInfo && roleInfo.rolbypassrls === false);
    await check('3. Connected DB user does NOT have CREATEDB privilege', roleInfo && roleInfo.rolcreatedb === false);
    await check('4. Connected DB user does NOT have CREATEROLE privilege', roleInfo && roleInfo.rolcreaterole === false);
    await check('5. Connected DB user does NOT have REPLICATION privilege', roleInfo && roleInfo.rolreplication === false);

    // 2. Multi-level membership check using pg_has_role for protected and administrative roles
    const inheritedRes = await executor.query<{ has_priv: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_roles r
        WHERE r.rolname <> current_user
          AND (
            r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
            OR r.rolname IN (
              'service_role',
              'supabase_admin',
              'postgres',
              'authenticator',
              'anon',
              'authenticated',
              'pg_read_all_data',
              'pg_write_all_data',
              'pg_execute_server_program',
              'pg_read_server_files',
              'pg_write_server_files'
            )
          )
          AND pg_has_role(current_user, r.oid, 'MEMBER')
      ) as has_priv;`
    );
    await check('6. Connected DB user has no privileged or protected inherited membership', !inheritedRes.rows[0]?.has_priv);

    // 3. Test DDL prohibitions (CREATE DATABASE / CREATE ROLE should fail for an_app)
    let createDbFailed = false;
    try {
      await executor.query('CREATE DATABASE test_forbidden_db;');
      try {
        await executor.query('DROP DATABASE IF EXISTS test_forbidden_db;');
      } catch {}
    } catch {
      createDbFailed = true;
    }
    await check('7. an_app cannot CREATE DATABASE', createDbFailed);

    let createRoleFailed = false;
    try {
      await executor.query('CREATE ROLE test_forbidden_role;');
      try {
        await executor.query('DROP ROLE IF EXISTS test_forbidden_role;');
      } catch {}
    } catch {
      createRoleFailed = true;
    }
    await check('8. an_app cannot CREATE ROLE', createRoleFailed);

    // 4. Table Ownership: connected user must NOT be owner of any public tables
    const ownerRes = await executor.query<{ tablename: string; tableowner: string }>(
      "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user;"
    );
    await check(
      '9. App role is NOT owner of any tables in public schema',
      ownerRes.rows.length === 0,
      ownerRes.rows.length > 0 ? `Owned tables: ${ownerRes.rows.map((r) => r.tablename).join(', ')}` : undefined
    );

    // 5. Table Privilege Matrix
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
          "10. audit_logs table privileges (SELECT=true, INSERT=true, UPDATE=false, DELETE=false, TRUNCATE=false)",
          p.can_select && p.can_insert && !p.can_update && !p.can_delete && !p.can_truncate
        );
      } else if (tbl === 'schema_migrations') {
        await check(
          "11. schema_migrations table privileges (SELECT=true, INSERT=false, UPDATE=false, DELETE=false, TRUNCATE=false)",
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
