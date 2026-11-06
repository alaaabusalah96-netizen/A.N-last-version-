import fs from 'fs';
import path from 'path';
import { check, summary } from './lib/testkit.js';

console.log('--- Running Migration 010 Static Security Verification ---');

const rootDir = process.cwd();
const migrationPath = path.join(rootDir, 'database/migrations/010_security_rls_baseline.sql');
const tableOwnershipPath = path.join(rootDir, 'database/table_ownership.json');

/**
 * Extracts the complete CREATE POLICY statement for a given policy and table,
 * up to the terminating semicolon.
 */
function policyStatement(content: string, policyName: string, tableName: string): string | null {
  const regex = new RegExp(`CREATE\\s+POLICY\\s+${policyName}\\s+ON\\s+${tableName}[\\s\\S]*?;`, 'i');
  const match = content.match(regex);
  return match ? match[0] : null;
}

async function runTests() {
  await check('1. migration 010 file exists', fs.existsSync(migrationPath));

  const content = fs.readFileSync(migrationPath, 'utf8');

  // 2. Role an_app idempotence
  const hasRoleInit = content.includes("IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'an_app')") &&
    content.includes("CREATE ROLE an_app WITH NOLOGIN NOINHERIT;");
  await check('2. idempotent creation of role an_app with NOLOGIN NOINHERIT', hasRoleInit);

  // 3. RLS enabled on all 8 tables
  const expectedTables = [
    'platform_users',
    'companies',
    'company_memberships',
    'user_sessions',
    'audit_logs',
    'login_rate_events',
    'schema_migrations',
    'tenant_demo_items',
  ];

  for (const table of expectedTables) {
    const rlsPattern = new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY;`, 'i');
    await check(`3. RLS enabled on table '${table}'`, rlsPattern.test(content));
  }

  // 4. FORCE ROW LEVEL SECURITY on tenant table
  const forceRlsPattern = /ALTER\s+TABLE\s+tenant_demo_items\s+FORCE\s+ROW\s+LEVEL\s+SECURITY;/i;
  await check('4. FORCE ROW LEVEL SECURITY on tenant_demo_items', forceRlsPattern.test(content));

  // 5. Five independent global and shared policies
  const independentPolicies = [
    { policy: 'platform_users_app_policy', table: 'platform_users' },
    { policy: 'companies_app_policy', table: 'companies' },
    { policy: 'company_memberships_app_policy', table: 'company_memberships' },
    { policy: 'user_sessions_app_policy', table: 'user_sessions' },
    { policy: 'login_rate_events_app_policy', table: 'login_rate_events' },
  ];

  for (const { policy, table } of independentPolicies) {
    const stmt = policyStatement(content, policy, table);
    const valid = Boolean(
      stmt &&
      /\bTO\s+an_app\b/i.test(stmt) &&
      /\bUSING\s*\(\s*true\s*\)/i.test(stmt) &&
      /\bWITH\s+CHECK\s*\(\s*true\s*\)/i.test(stmt)
    );
    await check(`5. exact policy statement for '${policy}' on '${table}'`, valid);
  }

  // 6. schema_migrations policy (SELECT-only)
  const schemaStmt = policyStatement(content, 'schema_migrations_app_policy', 'schema_migrations');
  const schemaValid = Boolean(
    schemaStmt &&
    /\bFOR\s+SELECT\b/i.test(schemaStmt) &&
    /\bTO\s+an_app\b/i.test(schemaStmt) &&
    /\bUSING\s*\(\s*true\s*\)/i.test(schemaStmt)
  );
  await check("6. exact policy statement for 'schema_migrations_app_policy' on 'schema_migrations'", schemaValid);

  // 7. audit_logs SELECT and INSERT policies
  const auditSelectStmt = policyStatement(content, 'audit_logs_app_select_policy', 'audit_logs');
  const auditSelectValid = Boolean(
    auditSelectStmt &&
    /\bFOR\s+SELECT\b/i.test(auditSelectStmt) &&
    /\bTO\s+an_app\b/i.test(auditSelectStmt) &&
    /\bUSING\s*\(\s*true\s*\)/i.test(auditSelectStmt)
  );
  await check("7. exact SELECT policy statement for 'audit_logs_app_select_policy' on 'audit_logs'", auditSelectValid);

  const auditInsertStmt = policyStatement(content, 'audit_logs_app_insert_policy', 'audit_logs');
  const auditInsertValid = Boolean(
    auditInsertStmt &&
    /\bFOR\s+INSERT\b/i.test(auditInsertStmt) &&
    /\bTO\s+an_app\b/i.test(auditInsertStmt) &&
    /\bWITH\s+CHECK\s*\(\s*true\s*\)/i.test(auditInsertStmt)
  );
  await check("7. exact INSERT policy statement for 'audit_logs_app_insert_policy' on 'audit_logs'", auditInsertValid);

  // 8. tenant_demo_items tenant isolation policy
  const tenantStmt = policyStatement(content, 'tenant_demo_isolation', 'tenant_demo_items');
  const tenantValid = Boolean(
    tenantStmt &&
    /\bTO\s+an_app\b/i.test(tenantStmt) &&
    tenantStmt.includes("USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)") &&
    tenantStmt.includes("WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)") &&
    !/\bUSING\s*\(\s*true\s*\)/i.test(tenantStmt) &&
    !/\bWITH\s+CHECK\s*\(\s*true\s*\)/i.test(tenantStmt)
  );
  await check("8. exact tenant isolation policy statement for 'tenant_demo_isolation' on 'tenant_demo_items'", tenantValid);

  // 9. Explicit privilege restrictions on audit_logs and schema_migrations
  const hasAuditRevoke = /REVOKE\s+UPDATE,\s*DELETE,\s*TRUNCATE\s+ON\s+TABLE\s+audit_logs\s+FROM\s+an_app;/i.test(content);
  await check('9. privileges: audit_logs mutations revoked from an_app', hasAuditRevoke);

  const hasSchemaRevoke = /REVOKE\s+ALL\s+ON\s+TABLE\s+schema_migrations\s+FROM\s+an_app;/i.test(content) &&
    /GRANT\s+SELECT\s+ON\s+TABLE\s+schema_migrations\s+TO\s+an_app;/i.test(content);
  await check('9. privileges: schema_migrations is SELECT-only for an_app', hasSchemaRevoke);

  // 10. Table ownership scopes from database/table_ownership.json
  const ownershipExists = fs.existsSync(tableOwnershipPath);
  const ownershipData: Array<{ table: string; scope: string }> = ownershipExists
    ? JSON.parse(fs.readFileSync(tableOwnershipPath, 'utf8'))
    : [];
  const ownershipMap = new Map(ownershipData.map((item) => [item.table, item.scope]));

  const expectedScopes: Record<string, string> = {
    platform_users: 'global',
    companies: 'global',
    user_sessions: 'global',
    login_rate_events: 'global',
    schema_migrations: 'global',
    company_memberships: 'shared',
    audit_logs: 'shared',
    tenant_demo_items: 'tenant',
  };

  const allScopesMatch = ownershipExists && Object.entries(expectedScopes).every(
    ([tbl, expectedScope]) => ownershipMap.get(tbl) === expectedScope
  );
  await check('10. table ownership scopes match catalog in database/table_ownership.json', allScopesMatch);

  // 11. Targeted routine revokes for audit_logs_block_mutation
  const auditPublicRevoke = /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.audit_logs_block_mutation\(\)\s+FROM\s+PUBLIC;/i.test(content);
  await check('11. targeted PUBLIC revoke on audit_logs_block_mutation()', auditPublicRevoke);

  const auditDataApiRevoke = /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.audit_logs_block_mutation\(\)\s+FROM\s+anon,\s*authenticated;/i.test(content);
  await check('12. targeted anon,authenticated revoke on audit_logs_block_mutation()', auditDataApiRevoke);

  // 12. Pin search_path on audit_logs_block_mutation
  const auditSearchPath = /ALTER\s+FUNCTION\s+public\.audit_logs_block_mutation\(\)\s+SET\s+search_path\s*=\s*pg_catalog;/i.test(content);
  await check('13. search_path pinned to pg_catalog on audit_logs_block_mutation()', auditSearchPath);

  // 13. Targeted routine revokes for rls_auto_enable
  const rlsPublicRevoke = /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.rls_auto_enable\(\)\s+FROM\s+PUBLIC;/i.test(content);
  await check('14. targeted PUBLIC revoke on rls_auto_enable()', rlsPublicRevoke);

  const rlsDataApiRevoke = /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.rls_auto_enable\(\)\s+FROM\s+anon,\s*authenticated;/i.test(content);
  await check('15. targeted anon,authenticated revoke on rls_auto_enable()', rlsDataApiRevoke);

  // 14. Preserve rls_auto_enable definition (no DROP)
  const preservesRlsAutoEnable = !/DROP\s+FUNCTION[^\n]*rls_auto_enable/i.test(content) &&
    !/DROP\s+EVENT\s+TRIGGER/i.test(content);
  await check('16. rls_auto_enable definition preserved without DROP or replacement', preservesRlsAutoEnable);

  // 15. Ensure NO broad REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC
  const hasBroadRevoke = /REVOKE\s+EXECUTE\s+ON\s+ALL\s+ROUTINES\s+IN\s+SCHEMA\s+public\s+FROM\s+PUBLIC;/i.test(content);
  await check('17. no broad REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC', !hasBroadRevoke);

  // 16. Untrusted Data API role revokes (anon & authenticated)
  const hasAnonRevokes = content.includes("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;") &&
    content.includes("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;") &&
    content.includes("REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon;") &&
    content.includes("REVOKE CREATE ON SCHEMA public FROM anon;");
  const hasAuthRevokes = content.includes("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;") &&
    content.includes("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;") &&
    content.includes("REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM authenticated;") &&
    content.includes("REVOKE CREATE ON SCHEMA public FROM authenticated;");
  await check('18. Data API roles (anon, authenticated) have tables, sequences, routines, and CREATE revoked', hasAnonRevokes && hasAuthRevokes);

  // 17. Default privileges configured fail-closed (no undefined_object exception swallowing or WHEN OTHERS)
  const hasDefaultPrivileges = content.includes('ALTER DEFAULT PRIVILEGES FOR ROLE') &&
    content.includes('REVOKE EXECUTE ON ROUTINES FROM PUBLIC');
  const noSwallowedExceptions = !content.includes('undefined_object') && !content.includes('WHEN OTHERS');
  await check('19. default privileges configured fail-closed without exception swallowing', hasDefaultPrivileges && noSwallowedExceptions);

  // 18. service_role preservation
  const touchesServiceRole = /service_role/i.test(content);
  await check('20. service_role untouched and preserved without modification', !touchesServiceRole);

  // 19. Security contract comments present
  const hasSecurityContract = content.includes('an_app is a shared trusted backend database identity') &&
    content.includes('Global/shared table policies using true') &&
    content.includes('Tenant-specific tables must retain tenant isolation');
  await check('21. security contract comments present in Migration 010', hasSecurityContract);

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
