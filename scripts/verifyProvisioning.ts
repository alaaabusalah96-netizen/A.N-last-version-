import { check, blocked, summary } from './lib/testkit.js';
import { spawnSync } from 'child_process';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { buildPgConfig } from '../src/server/db/connection.js';

console.log('--- Running Provisioning Verification (F10-2 / REPAIR-7) ---');

const CONNECT_TIMEOUT_MS = 10000;
const SPAWN_TIMEOUT_MS = 15000;

function logStage(stageName: string): { end: () => void } {
  const start = Date.now();
  console.log(`[verifyProvisioning] [START] ${stageName} (t=${new Date().toISOString()})`);
  return {
    end: () => {
      const duration = Date.now() - start;
      console.log(`[verifyProvisioning] [END] ${stageName} (${duration}ms)`);
    },
  };
}

const tsxBin = fs.existsSync(path.resolve(process.cwd(), 'node_modules/.bin/tsx'))
  ? path.resolve(process.cwd(), 'node_modules/.bin/tsx')
  : 'npx';

function runProvisionSpawn(callLabel: string, env: NodeJS.ProcessEnv) {
  const stage = logStage(`spawnSync [${callLabel}]`);
  const cmd = tsxBin === 'npx' ? 'npx' : tsxBin;
  const args = tsxBin === 'npx' ? ['tsx', 'scripts/provisionAppRole.ts'] : ['scripts/provisionAppRole.ts'];

  const res = spawnSync(cmd, args, {
    env,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: 'SIGTERM',
  });
  stage.end();

  if (res.error) {
    console.error(
      `[verifyProvisioning] [TIMEOUT/ERROR] spawnSync [${callLabel}]: ${res.error.message} (code: ${(res.error as any).code || 'NONE'})`
    );
  }
  return res;
}

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

  let client: pg.Client | null = null;
  let userClient: pg.Client | null = null;
  let testRoleCreated = false;

  try {
    // 1. Connect provisioner client
    const connectStage = logStage('connect (provisioner client)');
    const clientConfig = {
      ...buildPgConfig(migrationUrl, process.env),
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    };
    client = new pg.Client(clientConfig);
    await client.connect();
    await client.query("SET statement_timeout = '15000';");
    connectStage.end();

    async function takeBuiltInRolesSnapshot() {
      if (!client) throw new Error('Client not connected');
      const roles = ['anon', 'authenticated', 'service_role'];
      const snapshot: Record<string, any> = {};

      for (const r of roles) {
        const reg = await client.query('SELECT to_regrole($1) IS NOT NULL as exists;', [r]);
        if (!reg.rows[0]?.exists) {
          snapshot[r] = { exists: false };
          continue;
        }

        const attrs = await client.query(
          'SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit FROM pg_roles WHERE rolname = $1;',
          [r]
        );
        const members = await client.query(
          `SELECT m.rolname as member_of
           FROM pg_auth_members am
           JOIN pg_roles m ON m.oid = am.roleid
           JOIN pg_roles u ON u.oid = am.member
           WHERE u.rolname = $1
           ORDER BY m.rolname;`,
          [r]
        );
        const privs = await client.query(
          `SELECT c.relname as table_name, p.priv
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(priv)
           WHERE n.nspname = 'public'
             AND c.relkind IN ('r', 'v')
             AND has_table_privilege($1, c.oid, p.priv)
           ORDER BY c.relname, p.priv;`,
          [r]
        );

        snapshot[r] = {
          exists: true,
          attributes: attrs.rows[0],
          memberships: members.rows.map((row) => row.member_of),
          privileges: privs.rows,
        };
      }
      return snapshot;
    }

    // 2. Snapshot built-in roles before
    const snapBeforeStage = logStage('snapshot built-in roles (before)');
    const snapshotBefore = await takeBuiltInRolesSnapshot();
    snapBeforeStage.end();

    const childEnv = {
      ...process.env,
      NODE_ENV: 'test',
      MIGRATION_DATABASE_URL: migrationUrl,
      APP_DB_USER: testUser,
      APP_DB_PASSWORD: testPassword,
    };

    // 3. Call 1: initial provision
    const provResult = runProvisionSpawn('Call 1: initial provision', childEnv);
    const combinedOutput = `${provResult.stdout || ''}\n${provResult.stderr || ''}`;
    testRoleCreated = provResult.status === 0;

    // 1. Provisioning succeeds
    await check('1. Provisioning succeeds', provResult.status === 0);

    // Output leakage check on combined stdout and stderr
    await check(
      'Output leakage: stdout/stderr does not leak raw password, SCRAM verifier, or raw credentials',
      !combinedOutput.includes(testPassword) &&
      !combinedOutput.includes('SCRAM-SHA-256$') &&
      !combinedOutput.includes('postgres://') &&
      !combinedOutput.includes('postgresql://')
    );

    // 4. Call 2: idempotent rerun
    const rerunResult = runProvisionSpawn('Call 2: idempotent rerun', childEnv);
    // 2. Provisioning is idempotent
    await check('2. Provisioning is idempotent', rerunResult.status === 0);

    // 5. Call 3: invalid uppercase username
    const invalidUserResult = runProvisionSpawn('Call 3: uppercase username', {
      ...childEnv,
      APP_DB_USER: 'AN_APP_INVALID',
    });
    // 3. Invalid uppercase username is rejected
    await check('3. Invalid uppercase username is rejected', invalidUserResult.status === 1);

    // 6. Call 4: short password
    const shortPassResult = runProvisionSpawn('Call 4: short password', {
      ...childEnv,
      APP_DB_PASSWORD: 'short',
    });
    // 4. Short password is rejected
    await check('4. Short password is rejected', shortPassResult.status === 1);

    // 7. Role attributes and SCRAM verifier check
    const roleAttrsStage = logStage('check role attributes and SCRAM verifier');
    const roleRes = await client.query(
      `SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolinherit, a.rolpassword as auth_password
       FROM pg_roles r
       JOIN pg_authid a ON r.oid = a.oid
       WHERE r.rolname = $1;`,
      [testUser]
    );
    const rInfo = roleRes.rows[0];
    await check(
      '5. Password verifier is SCRAM-SHA-256',
      Boolean(rInfo && typeof rInfo.auth_password === 'string' && rInfo.auth_password.startsWith('SCRAM-SHA-256$'))
    );
    await check(
      'Role attributes: NOINHERIT, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION',
      Boolean(
        rInfo &&
        !rInfo.rolinherit &&
        !rInfo.rolsuper &&
        !rInfo.rolbypassrls &&
        !rInfo.rolcreatedb &&
        !rInfo.rolcreaterole &&
        !rInfo.rolreplication
      )
    );
    roleAttrsStage.end();

    // 8. Application role login test
    const userLoginStage = logStage('privilege checks / an_app login');
    const userUrl = new URL(migrationUrl);
    userUrl.username = testUser;
    userUrl.password = testPassword;

    let loginSuccess = false;
    try {
      const userCfg = {
        ...buildPgConfig(userUrl.toString(), process.env),
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      };
      userClient = new pg.Client(userCfg);
      await userClient.connect();
      await userClient.query("SET statement_timeout = '15000';");
      loginSuccess = true;
    } catch (err: any) {
      console.warn(`[verifyProvisioning] userClient connect note: ${err?.message || err}`);
    }
    userLoginStage.end();

    // 6. New application role can log in
    await check('6. New application role can log in', loginSuccess);

    // 9. Privilege enforcement tests on userClient
    const privTestsStage = logStage('privilege tests: CREATE DATABASE / ROLE / TABLE / TRUNCATE');
    let createDbFailed = false;
    if (userClient && loginSuccess) {
      try {
        await userClient.query('CREATE DATABASE test_forbidden_db;');
      } catch {
        createDbFailed = true;
      }
    } else {
      createDbFailed = true;
    }
    // 7. Application role cannot CREATE DATABASE
    await check('7. Application role cannot CREATE DATABASE', createDbFailed);

    let createRoleFailed = false;
    if (userClient && loginSuccess) {
      try {
        await userClient.query('CREATE ROLE test_forbidden_role;');
      } catch {
        createRoleFailed = true;
      }
    } else {
      createRoleFailed = true;
    }
    // 8. Application role cannot CREATE ROLE
    await check('8. Application role cannot CREATE ROLE', createRoleFailed);

    let createTableFailed = false;
    if (userClient && loginSuccess) {
      try {
        await userClient.query('CREATE TABLE public.test_forbidden_table (id int);');
      } catch {
        createTableFailed = true;
      }
    } else {
      createTableFailed = true;
    }
    // 9. Application role cannot CREATE TABLE in public
    await check('9. Application role cannot CREATE TABLE in public', createTableFailed);

    let truncateFailed = false;
    if (userClient && loginSuccess) {
      try {
        await userClient.query('TRUNCATE TABLE schema_migrations;');
      } catch {
        truncateFailed = true;
      }
    } else {
      truncateFailed = true;
    }
    // 10. Application role cannot TRUNCATE tables
    await check('10. Application role cannot TRUNCATE tables', truncateFailed);

    if (userClient) {
      await userClient.end().catch(() => {});
      userClient = null;
    }
    privTestsStage.end();

    // 10. Privileged memberships check
    const privMemStage = logStage('check privileged memberships');
    const privMemRes = await client.query(
      `SELECT EXISTS (
        SELECT 1 FROM pg_roles r
        WHERE r.rolname <> $1
          AND (
            r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
            OR r.rolname IN (
              'service_role', 'supabase_admin', 'postgres', 'authenticator', 'anon', 'authenticated'
            )
          )
          AND pg_has_role($1, r.oid, 'MEMBER')
      ) as has_priv;`,
      [testUser]
    );
    // 11. Application role has no privileged memberships
    await check('11. Application role has no privileged memberships', !privMemRes.rows[0]?.has_priv);
    privMemStage.end();

    // 11. Snapshot built-in roles after
    const snapAfterStage = logStage('snapshot built-in roles (after)');
    const snapshotAfter = await takeBuiltInRolesSnapshot();
    snapAfterStage.end();

    // 12. Provisioning does not modify built-in role attributes
    const attrsEqual = JSON.stringify(
      Object.fromEntries(Object.entries(snapshotBefore).map(([k, v]) => [k, v.attributes]))
    ) === JSON.stringify(
      Object.fromEntries(Object.entries(snapshotAfter).map(([k, v]) => [k, v.attributes]))
    );
    await check('12. Provisioning does not modify built-in role attributes', attrsEqual);

    // 13. Provisioning does not modify built-in role memberships
    const membersEqual = JSON.stringify(
      Object.fromEntries(Object.entries(snapshotBefore).map(([k, v]) => [k, v.memberships]))
    ) === JSON.stringify(
      Object.fromEntries(Object.entries(snapshotAfter).map(([k, v]) => [k, v.memberships]))
    );
    await check('13. Provisioning does not modify built-in role memberships', membersEqual);

    // 14. Provisioning does not modify built-in role object privileges
    const privsEqual = JSON.stringify(
      Object.fromEntries(Object.entries(snapshotBefore).map(([k, v]) => [k, v.privileges]))
    ) === JSON.stringify(
      Object.fromEntries(Object.entries(snapshotAfter).map(([k, v]) => [k, v.privileges]))
    );
    await check('14. Provisioning does not modify built-in role object privileges', privsEqual);

    // 12. Call 5: Safe existing app role rerun succeeds
    const safeRerunResult = runProvisionSpawn('Call 5: safe existing app role rerun', childEnv);
    // 15. Safe existing app role rerun succeeds
    await check('15. Safe existing app role rerun succeeds', safeRerunResult.status === 0);

    // 13. Call 6: Existing unsafe app role with CREATEROLE fails closed
    const unsafeUser = `an_unsafe_${crypto.randomBytes(4).toString('hex')}`;
    try {
      await client.query(`CREATE ROLE ${pg.escapeIdentifier(unsafeUser)} WITH LOGIN CREATEROLE PASSWORD 'Pass_1234567890123!';`);
      const unsafeProv = runProvisionSpawn('Call 6: unsafe app role with CREATEROLE', {
        ...childEnv,
        APP_DB_USER: unsafeUser,
        APP_DB_PASSWORD: 'Pass_1234567890123!',
      });
      // 16. Existing unsafe app role with CREATEROLE fails closed
      await check('16. Existing unsafe app role with CREATEROLE fails closed', unsafeProv.status === 1);
    } finally {
      await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(unsafeUser)};`).catch(() => {});
    }

    // 14. Call 7: Unexpected direct membership is revoked or handled safely
    const memberUser = `an_mem_${crypto.randomBytes(4).toString('hex')}`;
    const dummyGroup = `an_grp_${crypto.randomBytes(4).toString('hex')}`;
    try {
      await client.query(`CREATE ROLE ${pg.escapeIdentifier(dummyGroup)} NOLOGIN;`);
      await client.query(`CREATE ROLE ${pg.escapeIdentifier(memberUser)} WITH LOGIN NOINHERIT PASSWORD 'Pass_1234567890123!';`);
      await client.query(`GRANT ${pg.escapeIdentifier(dummyGroup)} TO ${pg.escapeIdentifier(memberUser)};`);

      const memProv = runProvisionSpawn('Call 7: unexpected membership', {
        ...childEnv,
        APP_DB_USER: memberUser,
        APP_DB_PASSWORD: 'Pass_1234567890123!',
      });
      // 17. Provisioning handles existing role with unexpected membership
      await check('17. Provisioning handles existing role with unexpected membership', memProv.status === 0);

      // Verify dummyGroup membership was revoked
      const memCheck = await client.query(
        `SELECT pg_has_role($1, $2, 'MEMBER') as has_mem;`,
        [memberUser, dummyGroup]
      );
      await check('Direct unexpected membership revoked by provisioning', memCheck.rows[0]?.has_mem === false);
    } finally {
      await client.query(`DROP OWNED BY ${pg.escapeIdentifier(memberUser)};`).catch(() => {});
      await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(memberUser)};`).catch(() => {});
      await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(dummyGroup)};`).catch(() => {});
    }

  } finally {
    // 15. Cleanup test user
    const cleanupStage = logStage('cleanup test user');
    if (testRoleCreated && client) {
      try {
        await client.query(`DROP OWNED BY ${pg.escapeIdentifier(testUser)};`);
        await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(testUser)};`);
        await check('Cleanup of test user completed successfully', true);
      } catch (cleanupErr) {
        await check('Cleanup of test user completed successfully', false, String(cleanupErr));
      }
    }
    cleanupStage.end();

    const endStage = logStage('end (closing all clients)');
    if (userClient) {
      await userClient.end().catch(() => {});
      userClient = null;
    }
    if (client) {
      await client.end().catch(() => {});
      client = null;
    }
    endStage.end();
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('[verifyProvisioning] Fatal test error:', err);
  process.exit(1);
});
