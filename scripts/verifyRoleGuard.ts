import { check, blocked, summary } from './lib/testkit.js';
import pg from 'pg';
import { assertSafeDbRole } from '../src/server/db/roleGuard.js';
import crypto from 'crypto';

console.log('--- Running Role Guard Verification (F10-3 / REPAIR-7) ---');

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
  const privRootRole = `an_privroot_${suffix}`;
  const interRole = `an_inter_${suffix}`;
  const leafRole = `an_leaf_${suffix}`;

  let createdRoles: string[] = [];

  try {
    // 1. Normal unprivileged role
    await adminClient.query(`CREATE ROLE ${pg.escapeIdentifier(normalRole)} LOGIN PASSWORD 'Pass123456789!';`);
    createdRoles.push(normalRole);

    // 2. Direct superuser role
    await adminClient.query(`CREATE ROLE ${pg.escapeIdentifier(superRole)} SUPERUSER LOGIN PASSWORD 'Pass123456789!';`);
    createdRoles.push(superRole);

    // 3. Three-level nested membership chain:
    // privileged_root (SUPERUSER, NOLOGIN) -> intermediate_role (NOLOGIN) -> application_leaf (LOGIN)
    await adminClient.query(`CREATE ROLE ${pg.escapeIdentifier(privRootRole)} SUPERUSER NOLOGIN;`);
    createdRoles.push(privRootRole);

    await adminClient.query(`CREATE ROLE ${pg.escapeIdentifier(interRole)} NOLOGIN;`);
    createdRoles.push(interRole);

    await adminClient.query(`CREATE ROLE ${pg.escapeIdentifier(leafRole)} LOGIN PASSWORD 'Pass123456789!';`);
    createdRoles.push(leafRole);

    await adminClient.query(`GRANT ${pg.escapeIdentifier(privRootRole)} TO ${pg.escapeIdentifier(interRole)};`);
    await adminClient.query(`GRANT ${pg.escapeIdentifier(interRole)} TO ${pg.escapeIdentifier(leafRole)};`);

    // Build URLs using URL API
    function buildUserUrl(user: string, pass: string): string {
      const u = new URL(migrationUrl!);
      u.username = user;
      u.password = pass;
      return u.toString();
    }

    const normalUrl = buildUserUrl(normalRole, 'Pass123456789!');
    const superUrl = buildUserUrl(superRole, 'Pass123456789!');
    const leafUrl = buildUserUrl(leafRole, 'Pass123456789!');

    // Test 1: Normal unprivileged role passes
    const normClient = new pg.Client({ connectionString: normalUrl });
    await normClient.connect();
    let normPassed = false;
    try {
      await assertSafeDbRole(normClient as any);
      normPassed = true;
    } catch {}
    await normClient.end();
    await check('1. Normal role passes', normPassed);

    // Test 2: Direct superuser role is rejected without leaking role name
    const supClient = new pg.Client({ connectionString: superUrl });
    await supClient.connect();
    let supThrew = false;
    let supLeaked = true;
    try {
      await assertSafeDbRole(supClient as any);
    } catch (err: any) {
      supThrew = err.message.includes('[dbRoleGuard]');
      supLeaked = err.message.includes(superRole) || err.message.includes('Pass123456789!');
    }
    await supClient.end();
    await check('2. Direct superuser role is rejected', supThrew);
    await check('No sensitive role names or credentials leak in errors', !supLeaked);

    // Test 3: Three-level nested privileged membership chain is rejected
    const leafClient = new pg.Client({ connectionString: leafUrl });
    await leafClient.connect();
    let leafThrew = false;
    try {
      await assertSafeDbRole(leafClient as any);
    } catch (err: any) {
      leafThrew = err.message.includes('[dbRoleGuard]');
    }
    await leafClient.end();
    await check('3. Nested privileged membership is rejected', leafThrew);

    // Test 4: Query failure is rejected fail-closed
    let queryFailRejected = false;
    try {
      await assertSafeDbRole({
        query: async () => {
          throw new Error('Connection abruptly terminated');
        },
      } as any);
    } catch (err: any) {
      queryFailRejected = err.message.includes('[dbRoleGuard] FATAL: Role verification query failed (fail-closed)');
    }
    await check('4. Query failure is rejected', queryFailRejected);

  } finally {
    // Clean up created roles in dependency-safe reverse order
    const rolesToDrop = [leafRole, interRole, privRootRole, superRole, normalRole];
    let cleanupFailed = false;
    let cleanupErrorMsg = '';

    for (const r of rolesToDrop) {
      try {
        await adminClient.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(r)};`);
      } catch (dropErr) {
        cleanupFailed = true;
        cleanupErrorMsg += `${r}: ${dropErr}; `;
      }
    }
    await adminClient.end();

    if (createdRoles.length > 0) {
      await check('Role cleanup executed cleanly', !cleanupFailed, cleanupFailed ? cleanupErrorMsg : undefined);
    }
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
