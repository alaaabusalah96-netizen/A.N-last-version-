import pg from 'pg';
import { buildPgConfig } from '../src/server/db/connection.js';
import { assertValidNodeEnv } from '../src/server/config/env.js';

const { Client } = pg;

async function simulateManagedPg() {
  assertValidNodeEnv();
  console.log('--- Running CI Simulate Managed PG Script (F7) ---');

  const migrationDbUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!migrationDbUrl) {
    console.error('[ci-simulate] ERROR: DATABASE_URL or MIGRATION_DATABASE_URL is required');
    process.exit(1);
  }

  const pgConfig = buildPgConfig(migrationDbUrl, process.env);
  const client = new Client(pgConfig);

  try {
    await client.connect();

    const roles = ['anon', 'authenticated', 'service_role'];
    for (const role of roles) {
      const check = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (check.rows.length === 0) {
        console.log(`[ci-simulate] Creating role '${role}' (NOLOGIN)...`);
        await client.query(`CREATE ROLE ${pg.escapeIdentifier(role)} NOLOGIN;`);
      }
    }

    console.log('--- CI Simulate Managed PG Completed Successfully ---');
  } catch (err) {
    console.error('[ci-simulate] Error simulating managed PG (credentials redacted)');
    process.exit(1);
  } finally {
    await client.end();
  }
}

simulateManagedPg();
