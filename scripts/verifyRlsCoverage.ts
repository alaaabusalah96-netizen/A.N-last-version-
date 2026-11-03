import fs from 'fs';
import path from 'path';
import { check, blocked, summary } from './lib/testkit.js';

console.log('--- Running RLS Coverage Verification ---');

const rootDir = process.cwd();

async function runTests() {
  const allowlistPath = path.join(rootDir, 'database/rls_allowlist.json');
  await check('rls_allowlist.json exists', fs.existsSync(allowlistPath));

  const allowlist: Array<{ table: string; reason: string }> = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  const allowlistTableNames = new Set(allowlist.map((a) => a.table));

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Skipping live DB RLS coverage queries.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    const { getDefaultExecutor } = await import('../src/server/db/index.js');
    const executor = await getDefaultExecutor();
    if (!executor) {
      blocked('Unable to connect to DB for RLS coverage verification.');
      const { exitCode } = summary();
      process.exit(exitCode);
      return;
    }

    // Query all tables in public schema containing company_id column
    const tablesSql = `
      SELECT DISTINCT c.relname as table_name, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND a.attname = 'company_id'
        AND NOT a.attisdropped;
    `;

    const tablesRes = await executor.query<{
      table_name: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(tablesSql);

    for (const row of tablesRes.rows) {
      const tableName = row.table_name;
      if (allowlistTableNames.has(tableName)) {
        continue;
      }

      await check(`Table '${tableName}' has RLS enabled (relrowsecurity=true)`, row.relrowsecurity === true);
      await check(`Table '${tableName}' forces RLS (relforcerowsecurity=true)`, row.relforcerowsecurity === true);

      // Check for policy referencing app.current_tenant_id
      const policiesSql = `
        SELECT polname, pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as with_check
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1;
      `;

      const polRes = await executor.query<{ polname: string; qual: string | null; with_check: string | null }>(
        policiesSql,
        [tableName]
      );

      const hasTenantPolicy = polRes.rows.some((p) => {
        const qualStr = p.qual || '';
        const checkStr = p.with_check || '';
        return qualStr.includes('app.current_tenant_id') || checkStr.includes('app.current_tenant_id');
      });

      await check(`Table '${tableName}' has policy referencing 'app.current_tenant_id'`, hasTenantPolicy);
    }
  } catch (err) {
    await check('RLS coverage query execution', false, err instanceof Error ? err.message : String(err));
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
