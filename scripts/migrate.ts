import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getDefaultExecutor } from '../src/server/db/index.js';

async function runMigrations() {
  console.log('--- Running Database Migrations ---');

  const executor = await getDefaultExecutor();
  if (!executor) {
    const requireDb = process.env.REQUIRE_DB === '1' || process.env.REQUIRE_DB === 'true';
    console.warn('[migrate] No DATABASE_URL configured.');
    if (requireDb) {
      console.error('[migrate] ERROR: REQUIRE_DB=1 is set but DATABASE_URL is missing. Failing closed.');
      process.exit(1);
    }
    console.log('[migrate] Skipping migrations in local non-DB mode.');
    return;
  }

  // Ensure schema_migrations table exists first
  await executor.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const migrationsDir = path.resolve(process.cwd(), 'database/migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.log('[migrate] No database/migrations directory found.');
    return;
  }

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  // Get applied versions
  const appliedResult = await executor.query<{ version: string }>('SELECT version FROM schema_migrations;');
  const appliedVersions = new Set(appliedResult.rows.map((r) => r.version));

  for (const file of files) {
    if (appliedVersions.has(file)) {
      console.log(`[migrate] Skipping already applied: ${file}`);
      continue;
    }

    console.log(`[migrate] Applying migration: ${file}`);
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');

    await executor.withTransaction(async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    });

    console.log(`[migrate] Successfully applied: ${file}`);
  }

  console.log('--- All Migrations Completed Successfully ---');
}

runMigrations().catch((err) => {
  console.error('[migrate] Migration failed:', err);
  process.exit(1);
});
