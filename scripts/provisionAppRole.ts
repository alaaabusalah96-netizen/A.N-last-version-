import pg from 'pg';
import { resolveSslConfig } from '../src/server/db/adapters/PostgresqlAdapter.js';

const { Client } = pg;

async function provisionAppRole() {
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

  const appDbUser = process.env.APP_DB_USER || 'an_app';

  const sslConfig = resolveSslConfig(process.env);
  const client = new Client({
    connectionString: migrationDbUrl,
    ssl: sslConfig,
  });
  try {
    await client.connect();

    // Check if role exists
    const checkRoleRes = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appDbUser]);
    const roleExists = checkRoleRes.rows.length > 0;

    if (!roleExists) {
      console.log(`[provision] Creating role '${appDbUser}'...`);
      const fmtRes = await client.query(
        "SELECT format('CREATE ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) as stmt",
        [appDbUser, appDbPassword]
      );
      await client.query(fmtRes.rows[0].stmt);
    } else {
      console.log(`[provision] Role '${appDbUser}' exists. Updating credentials and attributes...`);
      const fmtRes = await client.query(
        "SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) as stmt",
        [appDbUser, appDbPassword]
      );
      await client.query(fmtRes.rows[0].stmt);
    }

    // Schema & Table Permissions
    console.log(`[provision] Granting permissions to '${appDbUser}'...`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${appDbUser}";`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${appDbUser}";`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${appDbUser}";`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${appDbUser}";`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${appDbUser}";`);

    // Append-only audit log restriction
    console.log(`[provision] Revoking UPDATE/DELETE/TRUNCATE on audit_logs from '${appDbUser}'...`);
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_logs') THEN
          EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM %I', '${appDbUser}');
        END IF;
      END $$;
    `);

    // Schema migrations table restriction: REVOKE ALL except GRANT SELECT
    console.log(`[provision] Restricting schema_migrations to SELECT-only for '${appDbUser}'...`);
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations') THEN
          EXECUTE format('REVOKE ALL ON TABLE schema_migrations FROM %I', '${appDbUser}');
          EXECUTE format('GRANT SELECT ON TABLE schema_migrations TO %I', '${appDbUser}');
        END IF;
      END $$;
    `);

    console.log(`--- App Role '${appDbUser}' Provisioned Successfully ---`);
  } catch (err) {
    console.error('[provision] Error provisioning app role:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

provisionAppRole();
