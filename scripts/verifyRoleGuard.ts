import { check, blocked, summary } from './lib/testkit.js';
import pg from 'pg';
import { assertSafeDbRole } from '../src/server/db/roleGuard.js';
import crypto from 'crypto';

console.log('--- Running Role Guard Verification (F10-3) ---');

async function runTests() {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!migrationUrl || migrationUrl.trim() === '') {
    blocked('MIGRATION_DATABASE_URL / DATABASE_URL is not set. Role guard tests BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const adminClient = new pg.Client({ connectionString: migrationUrl });
  await adminClient.connect();

  const suffix = crypto.randomBytes(4).toString('hex');
  const normalRole = `an_norm_${suffix}`;
  const superRole = `an_super_${suffix}`;
  const inheritRole = `an_inherit_${suffix}`;

  try {
    // 1. Create normal role
    await adminClient.query(`CREATE ROLE ${pg.escapeIdentifier(normalRole)} LOGIN PASSWORD 'Pass123456789!';`);
    // 2. Create super role
    await adminClient.query(`CREATE ROLE ${pg.escapeIdentifier(superRole)} SUPERUSER LOGIN PASSWORD 'Pass123456789!';`);
    // 3. Create inherit role chain
    await adminClient.query(`CREATE ROLE ${pg.escapeIdentifier(inheritRole)} LOGIN PASSWORD 'Pass123456789!';`);
    await adminClient.query(`GRANT ${pg.escapeIdentifier(superRole)} TO ${pg.escapeIdentifier(inheritRole)};`);

    const normalUrl = migrationUrl.replace(/\/[^/]+$/, `/${new URL(migrationUrl).pathname.slice(1)}`).replace(/^postgres:\/\/([^:@]+(:[^@]+)?@)?/, `postgres://${normalRole}:Pass123456789!@`);
    const superUrl = migrationUrl.replace(/\/[^/]+$/, `/${new URL(migrationUrl).pathname.slice(1)}`).replace(/^postgres:\/\/([^:@]+(:[^@]+)?@)?/, `postgres://${superRole}:Pass123456789!@`);
    const inheritUrl = migrationUrl.replace(/\/[^/]+$/, `/${new URL(migrationUrl).pathname.slice(1)}`).replace(/^postgres:\/\/([^:@]+(:[^@]+)?@)?/, `postgres://${inheritRole}:Pass123456789!@`);

    // Test normal role -> passes assertSafeDbRole
    const normClient = new pg.Client({ connectionString: normalUrl });
    await normClient.connect();
    let normPassed = false;
    try {
      await assertSafeDbRole(normClient as any);
      normPassed = true;
    } catch {}
    await normClient.end();
    await check('Normal unprivileged role passes assertSafeDbRole', normPassed);

    // Test super role -> throws
    const supClient = new pg.Client({ connectionString: superUrl });
    await supClient.connect();
    let supThrew = false;
    try {
      await assertSafeDbRole(supClient as any);
    } catch (err: any) {
      supThrew = err.message.includes('[dbRoleGuard]') && !err.message.includes(superRole);
    }
    await supClient.end();
    await check('Superuser role is rejected by assertSafeDbRole without leaking role name', supThrew);

    // Test inherited privileged role -> throws
    const inhClient = new pg.Client({ connectionString: inheritUrl });
    await inhClient.connect();
    let inhThrew = false;
    try {
      await assertSafeDbRole(inhClient as any);
    } catch (err: any) {
      inhThrew = err.message.includes('[dbRoleGuard]');
    }
    await inhClient.end();
    await check('Role with inherited privileged membership is rejected by assertSafeDbRole', inhThrew);

  } finally {
    try {
      await adminClient.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(inheritRole)};`);
      await adminClient.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(superRole)};`);
      await adminClient.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(normalRole)};`);
    } catch {}
    await adminClient.end();
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
