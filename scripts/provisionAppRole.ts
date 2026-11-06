import pg from 'pg';
import { buildPgConfig } from '../src/server/db/connection.ts';
import { scramSha256Verifier } from '../src/server/security/scram.ts';
import { assertValidNodeEnv } from '../src/server/config/env.ts';

const { Client } = pg;
const USER_REGEX = /^[a-z_][a-z0-9_]{0,62}$/;

function redactSensitive(text: string): string {
  if (!text) return '';
  return text
    .replace(/SCRAM-SHA-256\$[^\s]+/g, '***REDACTED_VERIFIER***')
    .replace(/password\s*=\s*'[^']+'/gi, "password='***'")
    .replace(/password\s*=\s*"[^"]+"/gi, 'password="***"')
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@[^\s]+/gi, 'postgresql://[REDACTED_AUTH]@[HOST]');
}

async function provisionAppRole() {
  assertValidNodeEnv();
  console.log('--- Running Provision App Role Script ---');

  const migrationDbUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!migrationDbUrl) {
    console.error('[provision] ERROR: MIGRATION_DATABASE_URL (or DATABASE_URL) is required');
    process.exit(1);
  }

  const appDbPassword = process.env.APP_DB_PASSWORD;
  if (!appDbPassword || appDbPassword.length < 16) {
    console.error('[provision] ERROR: APP_DB_PASSWORD environment variable is required and must be at least 16 characters long');
    process.exit(1);
  }

  // Verify printable ASCII (32-126)
  for (let i = 0; i < appDbPassword.length; i++) {
    const code = appDbPassword.charCodeAt(i);
    if (code < 32 || code > 126) {
      console.error('[provision] ERROR: APP_DB_PASSWORD contains non-printable ASCII characters');
      process.exit(1);
    }
  }

  const appDbUser = process.env.APP_DB_USER || 'an_app';
  if (!USER_REGEX.test(appDbUser)) {
    console.error('[provision] ERROR: Invalid app database username format');
    process.exit(1);
  }

  const pgConfig = buildPgConfig(migrationDbUrl, process.env);
  const client = new Client(pgConfig);

  try {
    await client.connect();
    await client.query('BEGIN');

    // 1. Check current_user vs appDbUser
    const currentUserRes = await client.query('SELECT current_user as cur;');
    const currentUser = currentUserRes.rows[0].cur;
    if (currentUser === appDbUser) {
      throw new Error('Provisioner user cannot be identical to target app user (an_app)');
    }

    const verifier = scramSha256Verifier(appDbPassword);
    const dbNameRes = await client.query('SELECT current_database() as db;');
    const dbName = dbNameRes.rows[0].db;

    // 2. Check if role exists
    const checkRoleRes = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appDbUser]);
    const roleExists = checkRoleRes.rows.length > 0;
    const action = roleExists ? 'ALTER' : 'CREATE';

    if (roleExists) {
      const existingAttrs = await client.query<{ rolsuper: boolean; rolcreaterole: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = $1;',
        [appDbUser]
      );
      if (existingAttrs.rows[0]?.rolsuper || existingAttrs.rows[0]?.rolcreaterole || existingAttrs.rows[0]?.rolbypassrls) {
        throw new Error(`[provision] FATAL: Existing role '${appDbUser}' has dangerous elevated privileges and cannot be safely used as app role.`);
      }
    }

    const isSuperRes = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user;');
    const isSuper = isSuperRes.rows[0]?.rolsuper === true;

    // 3. Create or update role with NOINHERIT and least-privilege attributes
    const formatSql = action === 'ALTER' && !isSuper
      ? "SELECT format('%s ROLE %I WITH LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text, $2::text, $3::text) AS stmt;"
      : "SELECT format('%s ROLE %I WITH LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text, $2::text, $3::text) AS stmt;";

    const stmtRes = await client.query(formatSql, [action, appDbUser, verifier]);
    await client.query(stmtRes.rows[0].stmt);

    // 4. Revoke unexpected direct memberships
    const membershipsRes = await client.query(
      `SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE u.rolname=$1;`,
      [appDbUser]
    );
    for (const row of membershipsRes.rows) {
      const revokeStmt = await client.query(
        "SELECT format('REVOKE %I FROM %I;', $1::text, $2::text) AS stmt;",
        [row.rolname, appDbUser]
      );
      await client.query(revokeStmt.rows[0].stmt);
    }

    // 5. Clean up existing permissions of appDbUser prior to granting minimum permissions
    const revokeTablesStmt = await client.query(
      "SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I;', $1::text) AS stmt;",
      [appDbUser]
    );
    await client.query(revokeTablesStmt.rows[0].stmt);

    const revokeSeqStmt = await client.query(
      "SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I;', $1::text) AS stmt;",
      [appDbUser]
    );
    await client.query(revokeSeqStmt.rows[0].stmt);

    const revokeSchemaCreateStmt = await client.query(
      "SELECT format('REVOKE CREATE ON SCHEMA public FROM %I;', $1::text) AS stmt;",
      [appDbUser]
    );
    await client.query(revokeSchemaCreateStmt.rows[0].stmt);

    const revokeCreateDbStmt = await client.query(
      "SELECT format('REVOKE CREATE ON DATABASE %I FROM %I;', $1::text, $2::text) AS stmt;",
      [dbName, appDbUser]
    );
    await client.query(revokeCreateDbStmt.rows[0].stmt);

    const revokeDefaultTables = await client.query(
      "SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I;', $1::text, $2::text) AS stmt;",
      [currentUser, appDbUser]
    );
    await client.query(revokeDefaultTables.rows[0].stmt);

    const revokeDefaultSeq = await client.query(
      "SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I;', $1::text, $2::text) AS stmt;",
      [currentUser, appDbUser]
    );
    await client.query(revokeDefaultSeq.rows[0].stmt);

    // 6. Grant intended minimum permissions on database & schema
    const grantDbStmt = await client.query(
      "SELECT format('GRANT CONNECT ON DATABASE %I TO %I;', $1::text, $2::text) AS stmt;",
      [dbName, appDbUser]
    );
    await client.query(grantDbStmt.rows[0].stmt);

    const grantUsageStmt = await client.query(
      "SELECT format('GRANT USAGE ON SCHEMA public TO %I;', $1::text) AS stmt;",
      [appDbUser]
    );
    await client.query(grantUsageStmt.rows[0].stmt);

    // 7. Grant public tables & sequences privileges
    const grantTablesStmt = await client.query(
      "SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I;', $1::text) AS stmt;",
      [appDbUser]
    );
    await client.query(grantTablesStmt.rows[0].stmt);

    const grantSeqStmt = await client.query(
      "SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I;', $1::text) AS stmt;",
      [appDbUser]
    );
    await client.query(grantSeqStmt.rows[0].stmt);

    const defaultTablesStmt = await client.query(
      "SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I;', $1::text, $2::text) AS stmt;",
      [currentUser, appDbUser]
    );
    await client.query(defaultTablesStmt.rows[0].stmt);

    const defaultSeqStmt = await client.query(
      "SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I;', $1::text, $2::text) AS stmt;",
      [currentUser, appDbUser]
    );
    await client.query(defaultSeqStmt.rows[0].stmt);

    // 8. Audit logs restriction (append-only: SELECT, INSERT only)
    const auditCheck = await client.query("SELECT to_regclass('public.audit_logs') IS NOT NULL as exists;");
    if (auditCheck.rows[0].exists) {
      const auditRevokeStmt = await client.query(
        "SELECT format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM %I;', $1::text) AS stmt;",
        [appDbUser]
      );
      await client.query(auditRevokeStmt.rows[0].stmt);
    }

    // 9. Schema migrations restriction (SELECT-only)
    const migCheck = await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL as exists;");
    if (migCheck.rows[0].exists) {
      const migRevokeStmt = await client.query(
        "SELECT format('REVOKE ALL ON TABLE schema_migrations FROM %I;', $1::text) AS stmt;",
        [appDbUser]
      );
      await client.query(migRevokeStmt.rows[0].stmt);
      const migGrantStmt = await client.query(
        "SELECT format('GRANT SELECT ON TABLE schema_migrations TO %I;', $1::text) AS stmt;",
        [appDbUser]
      );
      await client.query(migGrantStmt.rows[0].stmt);
    }

    // 10. Post-provision Verification
    const verifyRoleRes = await client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolcanlogin: boolean;
    }>(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
       FROM pg_roles WHERE rolname = $1;`,
      [appDbUser]
    );

    const roleAttrs = verifyRoleRes.rows[0];
    if (!roleAttrs) {
      throw new Error(`[provision] Verification failed: Role '${appDbUser}' does not exist after provisioning.`);
    }

    if (roleAttrs.rolsuper) throw new Error(`[provision] Verification failed: '${appDbUser}' has rolsuper=true`);
    if (roleAttrs.rolbypassrls) throw new Error(`[provision] Verification failed: '${appDbUser}' has rolbypassrls=true`);
    if (roleAttrs.rolcreatedb) throw new Error(`[provision] Verification failed: '${appDbUser}' has rolcreatedb=true`);
    if (roleAttrs.rolcreaterole) throw new Error(`[provision] Verification failed: '${appDbUser}' has rolcreaterole=true`);
    if (roleAttrs.rolreplication) throw new Error(`[provision] Verification failed: '${appDbUser}' has rolreplication=true`);
    if (!roleAttrs.rolcanlogin) throw new Error(`[provision] Verification failed: '${appDbUser}' has rolcanlogin=false`);

    // Verify no direct or nested membership in protected roles
    const protectedRoles = ['postgres', 'supabase_admin', 'service_role', 'authenticator', 'anon', 'authenticated'];
    for (const protRole of protectedRoles) {
      const hasProt = await client.query<{ has_role: boolean }>(
        'SELECT pg_has_role($1, $2, $3) as has_role;',
        [appDbUser, protRole, 'USAGE']
      );
      if (hasProt.rows[0]?.has_role) {
        throw new Error(`[provision] Verification failed: '${appDbUser}' has unauthorized direct or inherited membership in '${protRole}'`);
      }
    }

    // Verify no ownership of public application tables
    const ownedTables = await client.query<{ tablename: string }>(
      `SELECT c.relname as tablename
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.oid = c.relowner
       WHERE n.nspname = 'public' AND r.rolname = $1 AND c.relkind = 'r';`,
      [appDbUser]
    );
    if (ownedTables.rows.length > 0) {
      const names = ownedTables.rows.map((r) => r.tablename).join(', ');
      throw new Error(`[provision] Verification failed: '${appDbUser}' owns application tables: ${names}`);
    }

    // Verify no schema CREATE privilege
    const schemaCreateCheck = await client.query<{ has_create: boolean }>(
      "SELECT has_schema_privilege($1, 'public', 'CREATE') as has_create;",
      [appDbUser]
    );
    if (schemaCreateCheck.rows[0]?.has_create) {
      throw new Error(`[provision] Verification failed: '${appDbUser}' has unauthorized CREATE privilege on schema public`);
    }

    // Verify exact intended privilege on schema_migrations
    if (migCheck.rows[0]?.exists) {
      const migCheckPriv = await client.query<{ has_priv: boolean }>(
        "SELECT has_table_privilege($1, 'schema_migrations', 'INSERT') as has_priv;",
        [appDbUser]
      );
      if (migCheckPriv.rows[0]?.has_priv) {
        throw new Error(`[provision] Verification failed: '${appDbUser}' has unauthorized INSERT privilege on schema_migrations`);
      }
    }

    await client.query('COMMIT');
    console.log(`--- App Role '${appDbUser}' Provisioned Successfully (Idempotent) ---`);
  } catch (err: any) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      console.error('[provision] Notice: rollback failed during error recovery');
    }
    const code = err.code || 'UNKNOWN';
    const message = redactSensitive(err.message || String(err));
    console.error(`[provision] FAILED code=${code} message=${message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

provisionAppRole();
