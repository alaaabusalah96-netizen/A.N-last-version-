import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
import { buildPgConfig } from './connection.js';

export function computeFileChecksum(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

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
    // 1. Ensure schema_migrations table exists with version, checksum, applied_at
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Ensure checksum column exists if table was created in earlier migration
    await client.query(`
      ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT;
    `);

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

    const fileChecksumMap = new Map<string, string>();
    const fileSet = new Set(files);

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      fileChecksumMap.set(file, computeFileChecksum(filePath));
    }

    // 4. Fetch list of already applied migrations from DB
    const res = await client.query<{ version: string; checksum: string | null }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version;'
    );

    // 5. Backfill & Mismatch validation inside transaction
    await client.query('BEGIN;');
    try {
      for (const row of res.rows) {
        const { version, checksum: storedChecksum } = row;
        if (!fileSet.has(version)) {
          throw new Error(
            `[migrate] FATAL: Applied migration '${version}' exists in database but corresponding migration file is missing from disk!`
          );
        }

        const currentChecksum = fileChecksumMap.get(version)!;

        if (!storedChecksum || storedChecksum.trim() === '') {
          // Backfill missing checksum for legacy record
          console.log(`[migrate] Backfilling checksum for legacy applied migration: ${version}`);
          await client.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2;', [
            currentChecksum,
            version,
          ]);
        } else if (storedChecksum !== currentChecksum) {
          throw new Error(
            `[migrate] FATAL: Checksum mismatch for applied migration '${version}'! Stored: ${storedChecksum}, Current: ${currentChecksum}`
          );
        }
      }
      await client.query('COMMIT;');
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    }

    // Enforce NOT NULL on checksum column after successful backfill
    await client.query(`
      ALTER TABLE schema_migrations ALTER COLUMN checksum SET NOT NULL;
    `).catch(() => {});

    // 6. Fetch updated set of applied versions
    const updatedRes = await client.query<{ version: string }>('SELECT version FROM schema_migrations;');
    const appliedVersions = new Set(updatedRes.rows.map((r) => r.version));

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
      const checksum = fileChecksumMap.get(file)!;

      await client.query('BEGIN;');
      try {
        await client.query('SELECT pg_advisory_xact_lock(727001);');
        const recheck = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1;', [version]);
        if (recheck.rows.length === 0) {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2);', [
            version,
            checksum,
          ]);
        }
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
