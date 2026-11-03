import fs from 'fs';
import path from 'path';
import { check, blocked, summary } from './lib/testkit.js';

console.log('--- Running RLS & Table Ownership Coverage Verification (R9.1) ---');

const rootDir = process.cwd();

interface TableOwnership {
  table: string;
  scope: 'global' | 'shared' | 'tenant';
  reason: string;
  allowOptionalCompanyId?: boolean;
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
        if (colNames.has('company_id')) {
          const isAllowedException = regItem.allowOptionalCompanyId === true && regItem.table === 'platform_users';
          await check(
            `Global table '${regItem.table}' company_id column is permitted via explicit schema registry exception`,
            isAllowedException
          );
          if (isAllowedException) {
            await check(
              `Global table '${regItem.table}' optional company_id column is nullable`,
              companyIdCol?.is_nullable === 'YES'
            );
          }
        } else {
          await check(`Global table '${regItem.table}' does NOT contain company_id column`, true);
        }
      } else if (regItem.scope === 'tenant') {
        // Rule 3: Tenant scope requirements
        await check(`Tenant table '${regItem.table}' contains company_id column`, Boolean(companyIdCol));
        await check(`Tenant table '${regItem.table}' company_id column is NOT NULL`, companyIdCol?.is_nullable === 'NO');

        // Robust catalog Foreign Key Check using pg_constraint, pg_class, pg_namespace, and pg_attribute
        const fkCatalogSql = `
          SELECT 
            con.conname AS constraint_name,
            c_src.relname AS source_table,
            a_src.attname AS source_column,
            c_ref.relname AS ref_table,
            a_ref.attname AS ref_column,
            con.convalidated AS is_validated
          FROM pg_constraint con
          JOIN pg_class c_src ON c_src.oid = con.conrelid
          JOIN pg_namespace n_src ON n_src.oid = c_src.relnamespace
          JOIN pg_class c_ref ON c_ref.oid = con.confrelid
          JOIN pg_namespace n_ref ON n_ref.oid = c_ref.relnamespace
          JOIN pg_attribute a_src ON a_src.attrelid = con.conrelid AND a_src.attnum = ANY(con.conkey)
          JOIN pg_attribute a_ref ON a_ref.attrelid = con.confrelid AND a_ref.attnum = ANY(con.confkey)
          WHERE con.contype = 'f'
            AND n_src.nspname = 'public'
            AND n_ref.nspname = 'public'
            AND c_src.relname = $1
            AND a_src.attname = 'company_id'
            AND c_ref.relname = 'companies'
            AND a_ref.attname = 'id'
            AND con.convalidated = true;
        `;
        const fkRes = await executor.query(fkCatalogSql, [regItem.table]);
        await check(
          `Tenant table '${regItem.table}' has valid active FK on company_id referencing companies(id)`,
          fkRes.rows.length > 0
        );

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
