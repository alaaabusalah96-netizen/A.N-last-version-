import { check, blocked, summary } from './lib/testkit.js';
import { spawnSync } from 'child_process';
import pg from 'pg';
import crypto from 'crypto';

console.log('--- Running Provisioning Verification (F10-2 / REPAIR-7) ---');

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

  async function takeBuiltInRolesSnapshot() {
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

  let testRoleCreated = false;

  try {
    const snapshotBefore = await takeBuiltInRolesSnapshot();

    // Run provisionAppRole via spawnSync to capture both stdout and stderr
    const childEnv = {
      ...process.env,
      NODE_ENV: 'test',
      MIGRATION_DATABASE_URL: migrationUrl,
      APP_DB_USER: testUser,
      APP_DB_PASSWORD: testPassword,
    };

    const provResult = spawnSync('npx', ['tsx', 'scripts/provisionAppRole.ts'], {
      env: childEnv,
      encoding: 'utf8',
    });

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

    // 2. Provisioning is idempotent
    const rerunResult = spawnSync('npx', ['tsx', 'scripts/provisionAppRole.ts'], {
      env: childEnv,
      encoding: 'utf8',
    });
    await check('2. Provisioning is idempotent', rerunResult.status === 0);

    // 3. Invalid uppercase username is rejected
    const invalidUserResult = spawnSync('npx', ['tsx', 'scripts/provisionAppRole.ts'], {
      env: { ...childEnv, APP_DB_USER: 'AN_APP_INVALID' },
      encoding: 'utf8',
    });
    await check('3. Invalid uppercase username is rejected', invalidUserResult.status === 1);

    // 4. Short password is rejected
    const shortPassResult = spawnSync('npx', ['tsx', 'scripts/provisionAppRole.ts'], {
      env: { ...childEnv, APP_DB_PASSWORD: 'short' },
      encoding: 'utf8',
    });
    await check('4. Short password is rejected', shortPassResult.status === 1);

    // 5. Password verifier is SCRAM-SHA-256 & qualified role query
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

    // 6. New application role can log in using URL API
    const userUrl = new URL(migrationUrl);
    userUrl.username = testUser;
    userUrl.password = testPassword;

    const userClient = new pg.Client({ connectionString: userUrl.toString() });
    let loginSuccess = false;
    try {
      await userClient.connect();
      loginSuccess = true;
    } catch {}

    await check('6. New application role can log in', loginSuccess);

    // 7. Application role cannot CREATE DATABASE
    let createDbFailed = false;
    try {
      await userClient.query('CREATE DATABASE test_forbidden_db;');
    } catch {
      createDbFailed = true;
    }
    await check('7. Application role cannot CREATE DATABASE', createDbFailed);

    // 8. Application role cannot CREATE ROLE
    let createRoleFailed = false;
    try {
      await userClient.query('CREATE ROLE test_forbidden_role;');
    } catch {
      createRoleFailed = true;
    }
    await check('8. Application role cannot CREATE ROLE', createRoleFailed);

    // 9. Application role cannot CREATE TABLE in public
    let createTableFailed = false;
    try {
      await userClient.query('CREATE TABLE public.test_forbidden_table (id int);');
    } catch {
      createTableFailed = true;
    }
    await check('9. Application role cannot CREATE TABLE in public', createTableFailed);

    // 10. Application role cannot TRUNCATE tables
    let truncateFailed = false;
    try {
      await userClient.query('TRUNCATE TABLE schema_migrations;');
    } catch {
      truncateFailed = true;
    }
    await check('10. Application role cannot TRUNCATE tables', truncateFailed);

    await userClient.end();

    // 11. Application role has no privileged memberships
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
    await check('11. Application role has no privileged memberships', !privMemRes.rows[0]?.has_priv);

    // Built-in role snapshots comparison
    const snapshotAfter = await takeBuiltInRolesSnapshot();

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

    // 15. Safe existing app role rerun succeeds
    const safeRerunResult = spawnSync('npx', ['tsx', 'scripts/provisionAppRole.ts'], {
      env: childEnv,
      encoding: 'utf8',
    });
    await check('15. Safe existing app role rerun succeeds', safeRerunResult.status === 0);

    // 16. Existing unsafe app role with CREATEROLE fails closed
    const unsafeUser = `an_unsafe_${crypto.randomBytes(4).toString('hex')}`;
    try {
      await client.query(`CREATE ROLE ${pg.escapeIdentifier(unsafeUser)} WITH LOGIN CREATEROLE PASSWORD 'Pass_1234567890123!';`);
      const unsafeProv = spawnSync('npx', ['tsx', 'scripts/provisionAppRole.ts'], {
        env: { ...childEnv, APP_DB_USER: unsafeUser, APP_DB_PASSWORD: 'Pass_1234567890123!' },
        encoding: 'utf8',
      });
      await check('16. Existing unsafe app role with CREATEROLE fails closed', unsafeProv.status === 1);
    } finally {
      await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(unsafeUser)};`).catch(() => {});
    }

    // 17. Unexpected direct membership is revoked or handled safely
    const memberUser = `an_mem_${crypto.randomBytes(4).toString('hex')}`;
    const dummyGroup = `an_grp_${crypto.randomBytes(4).toString('hex')}`;
    try {
      await client.query(`CREATE ROLE ${pg.escapeIdentifier(dummyGroup)} NOLOGIN;`);
      await client.query(`CREATE ROLE ${pg.escapeIdentifier(memberUser)} WITH LOGIN NOINHERIT PASSWORD 'Pass_1234567890123!';`);
      await client.query(`GRANT ${pg.escapeIdentifier(dummyGroup)} TO ${pg.escapeIdentifier(memberUser)};`);

      const memProv = spawnSync('npx', ['tsx', 'scripts/provisionAppRole.ts'], {
        env: { ...childEnv, APP_DB_USER: memberUser, APP_DB_PASSWORD: 'Pass_1234567890123!' },
        encoding: 'utf8',
      });
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
    // Cleanup test user and report if cleanup fails
    if (testRoleCreated) {
      try {
        await client.query(`DROP OWNED BY ${pg.escapeIdentifier(testUser)};`);
        await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(testUser)};`);
        await check('Cleanup of test user completed successfully', true);
      } catch (cleanupErr) {
        await check('Cleanup of test user completed successfully', false, String(cleanupErr));
      }
    }
    await client.end();
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
