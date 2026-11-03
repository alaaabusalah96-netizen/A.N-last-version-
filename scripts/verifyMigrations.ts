import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor } from '../src/server/db/index.js';

console.log('--- Running Migrations Verification (S9.3) ---');

const rootDir = process.cwd();
const { Client } = pg;

async function runTests() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live migration verification tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Database executor unavailable for migration verification tests.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    // 1. Verify all expected tables exist in schema
    const expectedTables = [
      'schema_migrations',
      'platform_users',
      'companies',
      'company_memberships',
      'user_sessions',
      'tenant_demo_items',
      'audit_logs',
      'login_rate_events',
    ];

    const tablesRes = await executor.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public';"
    );
    const existingTables = new Set(tablesRes.rows.map((r) => r.tablename));

    for (const tbl of expectedTables) {
      await check(`Table '${tbl}' exists in database schema`, existingTables.has(tbl));
    }

    // 2. R5.2 App Role permissions on schema_migrations (Must be SELECT-only)
    // 2.1 App role CAN SELECT from schema_migrations
    let selectPassed = false;
    try {
      const res = await executor.query('SELECT version FROM schema_migrations LIMIT 1;');
      selectPassed = Array.isArray(res.rows);
    } catch {}
    await check('App role has SELECT permission on schema_migrations', selectPassed);

    // 2.2 App role CANNOT INSERT into schema_migrations
    let insertBlocked = false;
    try {
      await executor.query("INSERT INTO schema_migrations (version, checksum) VALUES ('unauthorized_v1', 'fake');");
    } catch {
      insertBlocked = true;
    }
    await check('App role INSERT into schema_migrations is blocked (Permission Denied)', insertBlocked);

    // 2.3 App role CANNOT UPDATE schema_migrations
    let updateBlocked = false;
    try {
      await executor.query("UPDATE schema_migrations SET checksum = 'fake_corrupted';");
    } catch {
      updateBlocked = true;
    }
    await check('App role UPDATE on schema_migrations is blocked (Permission Denied)', updateBlocked);

    // 2.4 App role CANNOT DELETE from schema_migrations
    let deleteBlocked = false;
    try {
      await executor.query('DELETE FROM schema_migrations;');
    } catch {
      deleteBlocked = true;
    }
    await check('App role DELETE on schema_migrations is blocked (Permission Denied)', deleteBlocked);

    // 3. Tests using Migration Owner role (MIGRATION_DATABASE_URL)
    const migrationDbUrl = process.env.MIGRATION_DATABASE_URL;
    if (migrationDbUrl && migrationDbUrl.trim() !== '') {
      const ownerClient = new Client({ connectionString: migrationDbUrl });
      await ownerClient.connect();

      try {
        // 3.1 Verify triggers on audit_logs via owner
        const triggerRes = await ownerClient.query<{ tgname: string }>(
          "SELECT tgname FROM pg_trigger JOIN pg_class ON pg_class.oid = pg_trigger.tgrelid WHERE pg_class.relname = 'audit_logs';"
        );
        const triggerNames = new Set(triggerRes.rows.map((r) => r.tgname));
        await check("audit_logs has 'audit_logs_immutable' trigger (owner verified)", triggerNames.has('audit_logs_immutable'));
        await check("audit_logs has 'audit_logs_no_truncate' trigger (owner verified)", triggerNames.has('audit_logs_no_truncate'));

        // 3.2 Verify all schema_migrations have non-empty checksums
        const migDbRes = await ownerClient.query<{ version: string; checksum: string | null }>(
          'SELECT version, checksum FROM schema_migrations ORDER BY version;'
        );
        const allHaveChecksum = migDbRes.rows.length > 0 && migDbRes.rows.every((r) => Boolean(r.checksum && r.checksum.trim()));
        await check('All schema_migrations records contain non-empty checksums', allHaveChecksum);

        // 3.3 Idempotency: Running migrate twice succeeds without changes
        const tsxBin = path.resolve(rootDir, 'node_modules/.bin/tsx');
        const migrateScript = path.resolve(rootDir, 'scripts/migrate.ts');

        const run1 = spawnSync(tsxBin, [migrateScript], { env: process.env, stdio: 'pipe' });
        const run2 = spawnSync(tsxBin, [migrateScript], { env: process.env, stdio: 'pipe' });
        await check('Running migrate twice executes idempotently with exit code 0', run1.status === 0 && run2.status === 0);

        // 3.4 Checksum mismatch test:
        // Tamper with checksum of first migration record, run migrate -> must fail with exit 1, restore in finally
        const firstVersion = migDbRes.rows[0]?.version;
        const originalChecksum = migDbRes.rows[0]?.checksum;

        if (firstVersion && originalChecksum) {
          try {
            await ownerClient.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [
              'corrupted_checksum_for_testing_purposes',
              firstVersion,
            ]);

            const mismatchRun = spawnSync(tsxBin, [migrateScript], { env: process.env, stdio: 'pipe' });
            await check('Migration script detects checksum mismatch and fails with exit code 1', mismatchRun.status === 1);
          } finally {
            // Restore original checksum
            await ownerClient.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [
              originalChecksum,
              firstVersion,
            ]);
          }
        }
      } finally {
        await ownerClient.end();
      }
    } else {
      console.log('[verifyMigrations] MIGRATION_DATABASE_URL not set. Skipping owner-specific checksum tampering tests.');
    }

  } catch (err) {
    await check('Migration verification query execution', false, err instanceof Error ? err.message : String(err));
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
