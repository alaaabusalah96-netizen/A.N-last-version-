import fs from 'fs';
import path from 'path';
import { check, blocked, summary } from './lib/testkit.js';

console.log('--- Running RLS & Table Ownership Coverage Verification (PHASE 4 / RLS BASELINE) ---');

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
      SELECT c.oid, c.relname as table_name, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r';
    `;
    const tablesRes = await executor.query<{ oid: number; table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(tablesSql);
    const dbTablesMap = new Map(tablesRes.rows.map((r) => [r.table_name, r]));

    // Rule 1: Every table in DB MUST be registered in table_ownership.json (fail on unknown tables)
    for (const tableName of dbTablesMap.keys()) {
      await check(`Table '${tableName}' is registered in table_ownership.json`, registryMap.has(tableName));
    }

    // Rule 2: Every table in table_ownership.json MUST exist in DB
    for (const regItem of registry) {
      await check(`Registered table '${regItem.table}' exists in database`, dbTablesMap.has(regItem.table));
      await check(`Registered table '${regItem.table}' has non-empty reason`, Boolean(regItem.reason && regItem.reason.trim()));

      const dbTable = dbTablesMap.get(regItem.table);
      if (!dbTable) continue;

      // Rule 3: EVERY table MUST have RLS enabled (relrowsecurity = true)
      await check(
        `Table '${regItem.table}' has RLS enabled (relrowsecurity=true)`,
        dbTable.relrowsecurity === true
      );

      // Fetch columns for this table
      const colsSql = `
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1;
      `;
      const colsRes = await executor.query<{ column_name: string; is_nullable: string }>(colsSql, [regItem.table]);
      const colNames = new Set(colsRes.rows.map((c) => c.column_name));
      const companyIdCol = colsRes.rows.find((c) => c.column_name === 'company_id');

      // Fetch policies for this table
      const polSql = `
        SELECT p.polname,
               p.polcmd,
               pg_get_expr(p.polqual, p.polrelid) as qual,
               pg_get_expr(p.polwithcheck, p.polrelid) as with_check,
               ARRAY(
                 SELECT r.rolname FROM pg_roles r WHERE r.oid = ANY(p.polroles)
               ) as roles
        FROM pg_policy p
        WHERE p.polrelid = $1;
      `;
      const polRes = await executor.query<{ polname: string; polcmd: string; qual: string | null; with_check: string | null; roles: string[] }>(
        polSql,
        [dbTable.oid]
      );

      if (regItem.scope === 'global' || regItem.scope === 'shared') {
        if (regItem.scope === 'global') {
          await check(`Global table '${regItem.table}' does NOT contain company_id column`, !colNames.has('company_id'));
        }

        // Must have an explicit policy targeting an_app
        const hasAppPolicy = polRes.rows.some((p) => p.roles.includes('an_app'));
        await check(
          `${regItem.scope.toUpperCase()} table '${regItem.table}' has explicit policy targeting 'an_app'`,
          hasAppPolicy
        );
      } else if (regItem.scope === 'tenant') {
        // Tenant scope requirements
        await check(`Tenant table '${regItem.table}' contains company_id column`, Boolean(companyIdCol));
        await check(`Tenant table '${regItem.table}' company_id column is NOT NULL`, companyIdCol?.is_nullable === 'NO');

        // Robust catalog Foreign Key Check
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

        // Tenant table FORCE ROW LEVEL SECURITY check
        await check(
          `Tenant table '${regItem.table}' forces RLS (relforcerowsecurity=true)`,
          dbTable.relforcerowsecurity === true
        );

        // Policy Check: policy must reference app.current_tenant_id in qual AND with_check
        const validPolicy = polRes.rows.some((p) => {
          const q = p.qual || '';
          const wc = p.with_check || '';
          return q.includes('app.current_tenant_id') && wc.includes('app.current_tenant_id') && p.roles.includes('an_app');
        });

        await check(
          `Tenant table '${regItem.table}' has RLS policy targeting 'an_app' referencing 'app.current_tenant_id' in qual AND with_check`,
          validPolicy
        );

        // Ensure tenant table never has a permissive global policy (e.g., USING true)
        const hasPermissivePolicy = polRes.rows.some((p) => {
          const q = (p.qual || '').trim().toLowerCase();
          const wc = (p.with_check || '').trim().toLowerCase();
          return q === 'true' || wc === 'true';
        });
        await check(
          `Tenant table '${regItem.table}' does NOT receive permissive global policy`,
          !hasPermissivePolicy
        );
      }
    }

    // Rule 4: Verify restricted an_app privileges on schema_migrations and audit_logs
    const appRoleExists = await executor.query<{ exists: boolean }>(
      "SELECT to_regrole('an_app') IS NOT NULL as exists;"
    );

    if (appRoleExists.rows[0]?.exists) {
      // schema_migrations must be SELECT-only
      const migPrivs = await executor.query<{ priv: string; has_priv: boolean }>(
        `SELECT p.priv, has_table_privilege('an_app', 'schema_migrations', p.priv) as has_priv
         FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(priv);`
      );
      const migMap = new Map(migPrivs.rows.map((r) => [r.priv, r.has_priv]));
      await check("an_app has SELECT on schema_migrations", migMap.get('SELECT') === true);
      await check("an_app does NOT have INSERT on schema_migrations", migMap.get('INSERT') === false);
      await check("an_app does NOT have UPDATE on schema_migrations", migMap.get('UPDATE') === false);
      await check("an_app does NOT have DELETE on schema_migrations", migMap.get('DELETE') === false);
      await check("an_app does NOT have TRUNCATE on schema_migrations", migMap.get('TRUNCATE') === false);

      // audit_logs must be SELECT + INSERT only (append-only)
      const auditPrivs = await executor.query<{ priv: string; has_priv: boolean }>(
        `SELECT p.priv, has_table_privilege('an_app', 'audit_logs', p.priv) as has_priv
         FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(priv);`
      );
      const auditMap = new Map(auditPrivs.rows.map((r) => [r.priv, r.has_priv]));
      await check("an_app has SELECT on audit_logs", auditMap.get('SELECT') === true);
      await check("an_app has INSERT on audit_logs", auditMap.get('INSERT') === true);
      await check("an_app does NOT have UPDATE on audit_logs", auditMap.get('UPDATE') === false);
      await check("an_app does NOT have DELETE on audit_logs", auditMap.get('DELETE') === false);
      await check("an_app does NOT have TRUNCATE on audit_logs", auditMap.get('TRUNCATE') === false);
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
