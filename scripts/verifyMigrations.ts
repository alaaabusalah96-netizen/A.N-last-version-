import fs from 'fs';
import path from 'path';
import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor } from '../src/server/db/index.js';

console.log('--- Running Migrations Verification (S9.3) ---');

const rootDir = process.cwd();

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
    // 1. Verify all expected tables exist
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

    // 2. Verify audit_logs append-only triggers exist
    const triggerRes = await executor.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger JOIN pg_class ON pg_class.oid = pg_trigger.tgrelid WHERE pg_class.relname = 'audit_logs';"
    );
    const triggerNames = new Set(triggerRes.rows.map((r) => r.tgname));

    await check("audit_logs has 'audit_logs_immutable' trigger", triggerNames.has('audit_logs_immutable'));
    await check("audit_logs has 'audit_logs_no_truncate' trigger", triggerNames.has('audit_logs_no_truncate'));

    // 3. Verify schema_migrations has checksum column and entries for all 8 migration files
    const migFilesDir = path.join(rootDir, 'database/migrations');
    const migFiles = fs.readdirSync(migFilesDir).filter((f) => f.endsWith('.sql'));

    const migDbRes = await executor.query<{ version: string; checksum: string | null }>(
      'SELECT version, checksum FROM schema_migrations;'
    );
    const appliedDbVersions = new Set(migDbRes.rows.map((r) => r.version));

    for (const f of migFiles) {
      await check(`Migration '${f}' is recorded in schema_migrations`, appliedDbVersions.has(f));
    }

    const allHaveChecksum = migDbRes.rows.every((r) => Boolean(r.checksum));
    await check('All schema_migrations records contain non-null checksums', allHaveChecksum);

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
