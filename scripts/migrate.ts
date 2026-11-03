import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';

const { Client } = pg;

async function runMigrations() {
  console.log('--- Running Database Migrations ---');

  const isProd = process.env.NODE_ENV === 'production';
  const isCi = process.env.CI === 'true';
  const requireDb = process.env.REQUIRE_DB === '1' || process.env.REQUIRE_DB === 'true';

  let migrationDbUrl = process.env.MIGRATION_DATABASE_URL;

  if (!migrationDbUrl) {
    if (isProd) {
      console.error('[migrate] ERROR: MIGRATION_DATABASE_URL is strictly required in production!');
      process.exit(1);
    }
    console.warn('[migrate] WARNING: MIGRATION_DATABASE_URL is missing. Falling back to DATABASE_URL.');
    migrationDbUrl = process.env.DATABASE_URL;
  }

  if (!migrationDbUrl || migrationDbUrl.trim() === '') {
    console.warn('[migrate] No database connection string provided.');
    if (requireDb || isCi || isProd) {
      console.error('[migrate] ERROR: Database connection required. Failing closed.');
      process.exit(1);
    }
    console.log('[migrate] Skipping migrations in non-DB mode.');
    return;
  }

  const client = new Client({ connectionString: migrationDbUrl });

  try {
    await client.connect();
  } catch (err) {
    console.error('[migrate] Failed to connect to database for migration:', err);
    if (requireDb || isCi || isProd) {
      process.exit(1);
    } else {
      console.log('[migrate] Connection failed in local dev mode. Skipping.');
      return;
    }
  }

  try {
    // Ensure schema_migrations table exists with checksum column
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Ensure checksum column exists if table was created in earlier migration
    await client.query(`
      ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT;
    `);

    const migrationsDir = path.resolve(process.cwd(), 'database/migrations');
    if (!fs.existsSync(migrationsDir)) {
      console.log('[migrate] No database/migrations directory found.');
      return;
    }

    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    // Fetch existing applied migrations
    const appliedRes = await client.query<{ version: string; checksum: string | null }>(
      'SELECT version, checksum FROM schema_migrations;'
    );
    const appliedMap = new Map<string, string | null>(appliedRes.rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sqlContent = fs.readFileSync(filePath, 'utf8');
      const currentChecksum = crypto.createHash('sha256').update(sqlContent).digest('hex');

      if (appliedMap.has(file)) {
        const storedChecksum = appliedMap.get(file);
        if (storedChecksum && storedChecksum !== currentChecksum) {
          console.error(`[migrate] FATAL: Migration checksum mismatch for applied file '${file}'! Stored: ${storedChecksum}, Current: ${currentChecksum}`);
          process.exit(1);
        }
        if (!storedChecksum) {
          console.log(`[migrate] Backfilling missing checksum for applied migration: ${file}`);
          await client.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [currentChecksum, file]);
        } else {
          console.log(`[migrate] Skipping already applied migration: ${file}`);
        }
        continue;
      }

      console.log(`[migrate] Applying migration: ${file}`);

      try {
        await client.query('BEGIN');
        // Transaction-level advisory lock
        await client.query('SELECT pg_advisory_xact_lock(727001)');

        // Re-verify in case another process ran it
        const recheckRes = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
        if (recheckRes.rows.length === 0) {
          await client.query(sqlContent);
          await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
            file,
            currentChecksum,
          ]);
        }
        await client.query('COMMIT');
        console.log(`[migrate] Successfully applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] ERROR: Failed to apply migration '${file}':`, err);
        process.exit(1);
      }
    }

    console.log('--- All Migrations Completed Successfully ---');
  } finally {
    await client.end();
  }
}

runMigrations().catch((err) => {
  console.error('[migrate] Migration script fatal error:', err);
  process.exit(1);
});
