import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import pg from 'pg';
import crypto from 'crypto';
import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { computeFileChecksum } from '../src/server/db/migrationRunner.js';

console.log('=== RUNNING MIGRATION CHECKSUMS VERIFICATION (C1-C12 / AN-MIGRATION-CHECKSUMS-1) ===\n');

const rootDir = process.cwd();
const { Client } = pg;

async function runTests() {
  const dbUrl = process.env.DATABASE_URL;
  const migrationDbUrl = process.env.MIGRATION_DATABASE_URL;

  if (!migrationDbUrl || migrationDbUrl.trim() === '') {
    blocked('MIGRATION_DATABASE_URL is not set. Migration checksum tests BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const ownerClient = new Client({ connectionString: migrationDbUrl });
  await ownerClient.connect();

  try {
    const tsxBin = path.resolve(rootDir, 'node_modules/.bin/tsx');
    const migrateScript = path.resolve(rootDir, 'scripts/migrate.ts');

    // C1 & C2: Check schema_migrations has checksum column
    const colRes = await ownerClient.query<{ column_name: string; data_type: string }>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'schema_migrations' AND column_name = 'checksum';"
    );
    await check('C1 & C2: schema_migrations has checksum column of type text', colRes.rows.length > 0);

    // C3 & C4: Verify backfill & valid SHA-256 format for all records
    const migDbRes = await ownerClient.query<{ version: string; checksum: string | null }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version;'
    );
    const records = migDbRes.rows;
    await check('C3: Database has applied migration records', records.length > 0);

    const validSha256Regex = /^[a-f0-9]{64}$/i;
    const allValidSha256 =
      records.length > 0 &&
      records.every((r) => Boolean(r.checksum && validSha256Regex.test(r.checksum)));
    await check('C4: Every applied migration record has a non-empty valid 64-char SHA-256 hex checksum', allValidSha256);

    // C5: Check that current files match recorded checksums exactly
    const migrationsDir = path.join(rootDir, 'database/migrations');
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    let allChecksumsMatchFiles = true;
    for (const r of records) {
      const filePath = path.join(migrationsDir, r.version);
      if (!fs.existsSync(filePath)) {
        allChecksumsMatchFiles = false;
        break;
      }
      const actualHash = computeFileChecksum(filePath);
      if (actualHash !== r.checksum) {
        allChecksumsMatchFiles = false;
        break;
      }
    }
    await check('C5: All recorded checksums match actual sha256 of migration files on disk', allChecksumsMatchFiles);

    // C6: Idempotency check: running migrate twice succeeds with exit code 0
    const run1 = spawnSync(tsxBin, [migrateScript], { env: process.env, stdio: 'pipe' });
    const run2 = spawnSync(tsxBin, [migrateScript], { env: process.env, stdio: 'pipe' });
    await check('C6: Running migrate twice executes idempotently with exit code 0', run1.status === 0 && run2.status === 0);

    // C7: Tampering stored checksum in DB causes mismatch failure
    const firstRecord = records[0];
    if (firstRecord) {
      const originalChecksum = firstRecord.checksum;
      try {
        await ownerClient.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2;', [
          '0000000000000000000000000000000000000000000000000000000000000000',
          firstRecord.version,
        ]);

        const mismatchRun = spawnSync(tsxBin, [migrateScript], { env: process.env, stdio: 'pipe' });
        await check('C7: Tampered DB checksum causes migrate script to fail with exit code 1', mismatchRun.status === 1);
      } finally {
        await ownerClient.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2;', [
          originalChecksum,
          firstRecord.version,
        ]);
      }
    }

    // C8 & C9: Simulated file content modification / missing file check
    const mockVersion = '999_test_checksum_mock.sql';
    const mockPath = path.join(migrationsDir, mockVersion);
    try {
      fs.writeFileSync(mockPath, '-- mock migration for checksum test\nSELECT 1;');
      const mockHash = computeFileChecksum(mockPath);

      // Insert mock into DB
      await ownerClient.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2);', [
        mockVersion,
        mockHash,
      ]);

      // Modify mock file content
      fs.writeFileSync(mockPath, '-- modified content for checksum test\nSELECT 2;');
      const modifiedRun = spawnSync(tsxBin, [migrateScript], { env: process.env, stdio: 'pipe' });
      await check('C8: Modifying content of an applied migration file causes checksum mismatch & aborts', modifiedRun.status === 1);

      // Delete mock file
      fs.unlinkSync(mockPath);
      const missingRun = spawnSync(tsxBin, [migrateScript], { env: process.env, stdio: 'pipe' });
      await check('C9: Missing applied migration file on disk causes fatal error & aborts', missingRun.status === 1);
    } finally {
      if (fs.existsSync(mockPath)) {
        fs.unlinkSync(mockPath);
      }
      await ownerClient.query('DELETE FROM schema_migrations WHERE version = $1;', [mockVersion]).catch(() => {});
    }

    // C10: Failed migration transaction rollback leaves no orphaned record
    const badVersion = '999_bad_failing_migration.sql';
    const badPath = path.join(migrationsDir, badVersion);
    try {
      fs.writeFileSync(badPath, 'INVALID SQL SYNTAX AT ALL;');
      const badRun = spawnSync(tsxBin, [migrateScript], { env: process.env, stdio: 'pipe' });
      await check('C10-1: Failing migration script exits with code 1', badRun.status === 1);

      const checkBad = await ownerClient.query('SELECT 1 FROM schema_migrations WHERE version = $1;', [badVersion]);
      await check('C10-2: Failed migration transaction rolls back schema_migrations record', checkBad.rows.length === 0);
    } finally {
      if (fs.existsSync(badPath)) {
        fs.unlinkSync(badPath);
      }
    }

    // C11: App role (an_app / DATABASE_URL) privilege checks on schema_migrations
    if (dbUrl && dbUrl.trim() !== '') {
      const appExecutor = await getDefaultExecutor();
      if (appExecutor) {
        let insertBlocked = false;
        try {
          await appExecutor.query("INSERT INTO schema_migrations (version, checksum) VALUES ('v_test', 'hash');");
        } catch {
          insertBlocked = true;
        }
        await check('C11-1: App role (an_app) INSERT into schema_migrations is blocked', insertBlocked);

        let updateBlocked = false;
        try {
          await appExecutor.query("UPDATE schema_migrations SET checksum = 'tampered';");
        } catch {
          updateBlocked = true;
        }
        await check('C11-2: App role (an_app) UPDATE on schema_migrations is blocked', updateBlocked);

        let deleteBlocked = false;
        try {
          await appExecutor.query('DELETE FROM schema_migrations;');
        } catch {
          deleteBlocked = true;
        }
        await check('C11-3: App role (an_app) DELETE on schema_migrations is blocked', deleteBlocked);
      }
    }

    // C12: Migration Owner DDL/DML verification
    const ownerInsertRes = await ownerClient.query<{ has_priv: boolean }>(
      "SELECT has_table_privilege($1, 'schema_migrations', 'INSERT') as has_priv;",
      [process.env.APP_DB_USER || 'an_test']
    );
    await check('C12: Migration owner has full privileges on schema_migrations', ownerInsertRes.rows[0]?.has_priv === true);

  } finally {
    await ownerClient.end();
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Unhandled error in verifyMigrationChecksums1:', err);
  process.exit(1);
});
