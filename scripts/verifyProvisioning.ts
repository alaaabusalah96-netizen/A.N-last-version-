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

  try {
    // Run provisionAppRole via child_process
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

    await check('provisionAppRole successfully provisions test user', provSuccess);
    await check('stdout/stderr does not leak raw password or verifier', !stdoutOutput.includes(testPassword) && !stdoutOutput.includes('SCRAM-SHA-256'));

    // Verify role attributes in pg_authid / pg_roles
    const roleRes = await client.query(
      'SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolpassword FROM pg_roles r JOIN pg_authid a ON r.oid = a.oid WHERE r.rolname = $1;',
      [testUser]
    );
    const rInfo = roleRes.rows[0];
    await check('Provisioned role has NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION', rInfo && !rInfo.rolsuper && !rInfo.rolbypassrls && !rInfo.rolcreatedb && !rInfo.rolcreaterole && !rInfo.rolreplication);
    await check('Provisioned role password verifier starts with SCRAM-SHA-256', rInfo && rInfo.rolpassword && rInfo.rolpassword.startsWith('SCRAM-SHA-256'));

    // Test login with new user and password
    const userDbUrl = migrationUrl.replace(/\/[^/]+$/, `/${new URL(migrationUrl).pathname.slice(1)}`).replace(/^postgres:\/\/([^:@]+(:[^@]+)?@)?/, `postgres://${testUser}:${encodeURIComponent(testPassword)}@`);
    const userClient = new pg.Client({ connectionString: userDbUrl });
    let loginSuccess = false;
    try {
      await userClient.connect();
      loginSuccess = true;
      await userClient.end();
    } catch {}
    await check('Login with provisioned user and SCRAM password succeeds', loginSuccess);

    // Test idempotency: run again
    let idempotentSuccess = false;
    try {
      execSync('npx tsx scripts/provisionAppRole.ts', { env: childEnv, encoding: 'utf8' });
      idempotentSuccess = true;
    } catch {}
    await check('Re-running provisioning is idempotent', idempotentSuccess);

    // Test invalid username format
    let invalidUserFail = false;
    try {
      execSync('npx tsx scripts/provisionAppRole.ts', { env: { ...childEnv, APP_DB_USER: 'AN_APP_INVALID' }, encoding: 'utf8' });
    } catch {
      invalidUserFail = true;
    }
    await check('Invalid uppercase username causes provisioning failure', invalidUserFail);

    // Test short password
    let shortPassFail = false;
    try {
      execSync('npx tsx scripts/provisionAppRole.ts', { env: { ...childEnv, APP_DB_PASSWORD: 'short' }, encoding: 'utf8' });
    } catch {
      shortPassFail = true;
    }
    await check('Short password causes provisioning failure', shortPassFail);

  } finally {
    // Cleanup test user
    try {
      await client.query(`DROP OWNED BY ${pg.escapeIdentifier(testUser)};`);
      await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(testUser)};`);
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
