import fs from 'fs';
import path from 'path';
import { check, blocked, summary } from './lib/testkit.js';

console.log('--- Running RLS & Table Ownership Coverage Verification (R9.1) ---');

const rootDir = process.cwd();

interface TableOwnership {
  table: string;
  scope: 'global' | 'shared' | 'tenant';
  reason: string;
}

async function runTests() {
  const registryPath = path.join(rootDir, 'database/table_ownership.json');
  await check('database/table_ownership.json exists', fs.existsSync(registryPath));

  const registry: TableOwnership[] = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const registryMap = new Map<string, TableOwnership>(registry.map((r) => [r.table, r]));

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Skipping live DB table ownership & RLS queries.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    const { getDefaultExecutor } = await import('../src/server/db/index.js');
    const executor = await getDefaultExecutor();
    if (!executor) {
      blocked('Unable to connect to DB for table ownership verification.');
      const { exitCode } = summary();
      process.exit(exitCode);
      return;
    }

    // 1. Fetch all tables in public schema
    const tablesSql = `
      SELECT c.relname as table_name, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r';
    `;
    const tablesRes = await executor.query<{ table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(tablesSql);
    const dbTablesMap = new Map(tablesRes.rows.map((r) => [r.table_name, r]));

    // Rule 1: Every table in DB MUST be present in table_ownership.json
    for (const tableName of dbTablesMap.keys()) {
      await check(`Table '${tableName}' is registered in table_ownership.json`, registryMap.has(tableName));
    }

    // Rule 2: Every table in table_ownership.json MUST exist in DB
    for (const regItem of registry) {
      await check(`Registered table '${regItem.table}' exists in database`, dbTablesMap.has(regItem.table));
      await check(`Registered table '${regItem.table}' has non-empty reason`, Boolean(regItem.reason && regItem.reason.trim()));

      const dbTable = dbTablesMap.get(regItem.table);
      if (!dbTable) continue;

      // Fetch columns for this table
      const colsSql = `
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1;
      `;
      const colsRes = await executor.query<{ column_name: string; is_nullable: string }>(colsSql, [regItem.table]);
      const colNames = new Set(colsRes.rows.map((c) => c.column_name));
      const companyIdCol = colsRes.rows.find((c) => c.column_name === 'company_id');

      if (regItem.scope === 'global') {
        // Rule 4: Global scope MUST NOT have company_id column
        await check(`Global table '${regItem.table}' does NOT contain company_id column`, !colNames.has('company_id'));
      } else if (regItem.scope === 'tenant') {
        // Rule 3: Tenant scope requirements
        await check(`Tenant table '${regItem.table}' contains company_id column`, Boolean(companyIdCol));
        await check(`Tenant table '${regItem.table}' company_id column is NOT NULL`, companyIdCol?.is_nullable === 'NO');

        // Foreign Key Check
        const fkSql = `
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'
            AND tc.table_name = $1
            AND kcu.column_name = 'company_id'
            AND ccu.table_name = 'companies';
        `;
        const fkRes = await executor.query(fkSql, [regItem.table]);
        await check(`Tenant table '${regItem.table}' has FK on company_id referencing companies(id)`, fkRes.rows.length > 0);

        // RLS Enabled & Forced
        await check(`Tenant table '${regItem.table}' has RLS enabled (relrowsecurity=true)`, dbTable.relrowsecurity === true);
        await check(`Tenant table '${regItem.table}' forces RLS (relforcerowsecurity=true)`, dbTable.relforcerowsecurity === true);

        // Policy Check
        const polSql = `
          SELECT polname, pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as with_check
          FROM pg_policy p
          JOIN pg_class c ON c.oid = p.polrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1;
        `;
        const polRes = await executor.query<{ polname: string; qual: string | null; with_check: string | null }>(polSql, [regItem.table]);

        const validPolicy = polRes.rows.some((p) => {
          const q = p.qual || '';
          const wc = p.with_check || '';
          return q.includes('app.current_tenant_id') && wc.includes('app.current_tenant_id');
        });

        await check(`Tenant table '${regItem.table}' has RLS policy referencing 'app.current_tenant_id' in qual AND with_check`, validPolicy);
      }
    }
  } catch (err) {
    await check('RLS and table ownership query execution', false, err instanceof Error ? err.message : String(err));
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
