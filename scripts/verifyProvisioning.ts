import { check, blocked, summary } from './lib/testkit.js';
import { execSync } from 'child_process';
import pg from 'pg';
import crypto from 'crypto';

console.log('--- Running Provisioning Verification (F10-2) ---');

async function runTests() {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!migrationUrl || migrationUrl.trim() === '') {
    blocked('MIGRATION_DATABASE_URL / DATABASE_URL is not set. Provisioning tests BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const testUser = `an_prov_${crypto.randomBytes(4).toString('hex')}`;
  const testPassword = `Pass_${crypto.randomBytes(12).toString('hex')}!1`;

  const client = new pg.Client({ connectionString: migrationUrl });
  await client.connect();

  const supabaseTestRole = `supabase_test_${crypto.randomBytes(4).toString('hex')}`;

  try {
    // 0. Setup a test Supabase-like role with a grant to test that provisionAppRole does NOT strip it
    await client.query(`CREATE ROLE ${pg.escapeIdentifier(supabaseTestRole)} NOLOGIN;`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${pg.escapeIdentifier(supabaseTestRole)};`);

    // 1. Run provisionAppRole via child_process
    const childEnv = {
      ...process.env,
      NODE_ENV: 'test',
      MIGRATION_DATABASE_URL: migrationUrl,
      APP_DB_USER: testUser,
      APP_DB_PASSWORD: testPassword,
    };

    let provSuccess = false;
    let stdoutOutput = '';
    try {
      const res = execSync('npx tsx scripts/provisionAppRole.ts', { env: childEnv, encoding: 'utf8' });
      stdoutOutput = res;
      provSuccess = true;
    } catch (err: any) {
      stdoutOutput = err.stdout || err.message || '';
    }

    await check('1. provisionAppRole successfully provisions test user', provSuccess);
    await check(
      '2. stdout/stderr does not leak raw password or verifier or connection strings',
      !stdoutOutput.includes(testPassword) &&
        !stdoutOutput.includes('SCRAM-SHA-256') &&
        !stdoutOutput.includes('postgres://') &&
        !stdoutOutput.includes('postgresql://')
    );

    // 3. Verify role attributes in pg_authid / pg_roles
    const roleRes = await client.query(
      'SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolpassword FROM pg_roles r JOIN pg_authid a ON r.oid = a.oid WHERE r.rolname = $1;',
      [testUser]
    );
    const rInfo = roleRes.rows[0];
    await check(
      '3. Provisioned role has NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION',
      rInfo &&
        !rInfo.rolsuper &&
        !rInfo.rolbypassrls &&
        !rInfo.rolcreatedb &&
        !rInfo.rolcreaterole &&
        !rInfo.rolreplication
    );
    await check(
      '4. Provisioned role password verifier starts with SCRAM-SHA-256',
      rInfo && rInfo.rolpassword && rInfo.rolpassword.startsWith('SCRAM-SHA-256')
    );

    // 5. Test login with new user and password
    const userDbUrl = migrationUrl
      .replace(/\/[^/]+$/, `/${new URL(migrationUrl).pathname.slice(1)}`)
      .replace(/^postgres:\/\/([^:@]+(:[^@]+)?@)?/, `postgres://${testUser}:${encodeURIComponent(testPassword)}@`);
    const userClient = new pg.Client({ connectionString: userDbUrl });
    let loginSuccess = false;
    try {
      await userClient.connect();
      loginSuccess = true;

      // 6. Test that provisioned user CANNOT execute administrative DDL
      let createDbFailed = false;
      try {
        await userClient.query('CREATE DATABASE test_forbidden_prov_db;');
      } catch {
        createDbFailed = true;
      }
      await check('5. Provisioned role cannot CREATE DATABASE', createDbFailed);

      let createRoleFailed = false;
      try {
        await userClient.query('CREATE ROLE test_forbidden_prov_role;');
      } catch {
        createRoleFailed = true;
      }
      await check('6. Provisioned role cannot CREATE ROLE', createRoleFailed);

      let createTableFailed = false;
      try {
        await userClient.query('CREATE TABLE public.test_forbidden_table (id serial);');
      } catch {
        createTableFailed = true;
      }
      await check('7. Provisioned role cannot execute DDL CREATE TABLE in public schema', createTableFailed);

      await userClient.end();
    } catch {}
    await check('8. Login with provisioned user and SCRAM password succeeds', loginSuccess);

    // 7. Verify that Supabase-like role privileges were NOT revoked or altered by provisionAppRole
    const privCheck = await client.query<{ has_usage: boolean }>(
      `SELECT has_schema_privilege($1, 'public', 'USAGE') as has_usage;`,
      [supabaseTestRole]
    );
    await check(
      '9. Default Supabase roles privileges are NOT modified or revoked by provisionAppRole',
      privCheck.rows[0]?.has_usage === true
    );

    // 8. Test idempotency: run provisioning again
    let idempotentSuccess = false;
    try {
      execSync('npx tsx scripts/provisionAppRole.ts', { env: childEnv, encoding: 'utf8' });
      idempotentSuccess = true;
    } catch {}
    await check('10. Re-running provisioning is idempotent', idempotentSuccess);

    // 9. Test invalid username format fails cleanly
    let invalidUserFail = false;
    try {
      execSync('npx tsx scripts/provisionAppRole.ts', {
        env: { ...childEnv, APP_DB_USER: 'AN_APP_INVALID' },
        encoding: 'utf8',
      });
    } catch {
      invalidUserFail = true;
    }
    await check('11. Invalid uppercase username causes safe provisioning failure', invalidUserFail);

    // 10. Test short password fails cleanly
    let shortPassFail = false;
    try {
      execSync('npx tsx scripts/provisionAppRole.ts', {
        env: { ...childEnv, APP_DB_PASSWORD: 'short' },
        encoding: 'utf8',
      });
    } catch {
      shortPassFail = true;
    }
    await check('12. Short password (< 16 chars) causes safe provisioning failure', shortPassFail);

    // 11. Test non-printable ASCII password fails cleanly
    let nonAsciiFail = false;
    try {
      execSync('npx tsx scripts/provisionAppRole.ts', {
        env: { ...childEnv, APP_DB_PASSWORD: 'ValidPassword123!\x00\x01' },
        encoding: 'utf8',
      });
    } catch {
      nonAsciiFail = true;
    }
    await check('13. Non-printable ASCII password causes safe provisioning failure', nonAsciiFail);
  } finally {
    // Cleanup test user and test Supabase role
    try {
      await client.query(`DROP OWNED BY ${pg.escapeIdentifier(testUser)};`);
      await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(testUser)};`);
    } catch {}
    try {
      await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(supabaseTestRole)};`);
    } catch {}
    await client.end();
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
