import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { buildPgConfig } from './connection.js';

export async function runMigrations(): Promise<void> {
  const connectionString = process.env.MIGRATION_DATABASE_URL;

  if (!connectionString) {
    throw new Error('MIGRATION_DATABASE_URL environment variable is required for running migrations.');
  }

  const pgConfig = buildPgConfig(connectionString, process.env);
  const client = new pg.Client(pgConfig);

  console.log('[migrate] Connecting to database using MIGRATION_DATABASE_URL...');
  await client.connect();

  try {
    // 1. Ensure schema_migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Fetch list of already applied migrations
    const res = await client.query<{ version: string }>('SELECT version FROM schema_migrations;');
    const appliedVersions = new Set(res.rows.map((r) => r.version));

    // 3. Read migration files from database/migrations
    const migrationsDir = path.resolve('database/migrations');
    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`Migrations directory not found at ${migrationsDir}`);
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    console.log(`[migrate] Found ${files.length} migration files in ${migrationsDir}`);

    let executedCount = 0;

    for (const file of files) {
      const version = file;
      if (appliedVersions.has(version)) {
        console.log(`[migrate] [SKIP] ${file} (already applied)`);
        continue;
      }

      console.log(`[migrate] [APPLYING] ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      await client.query('BEGIN;');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1);', [version]);
        await client.query('COMMIT;');
        console.log(`[migrate] [SUCCESS] ${file}`);
        executedCount++;
      } catch (err) {
        await client.query('ROLLBACK;');
        console.error(`[migrate] [FAIL] ${file}:`, err);
        throw err;
      }
    }

    console.log(`\n[migrate] Migration completed successfully. Executed: ${executedCount} new migration(s).`);
  } finally {
    await client.end();
  }
}
