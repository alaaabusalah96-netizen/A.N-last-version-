import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;

function assertCheck(id: string, description: string, condition: boolean) {
  if (condition) {
    console.log(`[PASS] ${id}: ${description}`);
    passed++;
  } else {
    console.error(`[FAIL] ${id}: ${description}`);
    failed++;
  }
}

async function runVerification() {
  console.log('=== Running verifyP1cOrgUnits1 Verification ===\n');

  // S1: Migration 014 defines org_units and user_org_scope
  const mig014Path = path.resolve('database/migrations/014_org_units.sql');
  const mig014Exists = fs.existsSync(mig014Path);
  const mig014Content = mig014Exists ? fs.readFileSync(mig014Path, 'utf8') : '';
  const s1Mig =
    mig014Exists &&
    mig014Content.includes('CREATE TABLE IF NOT EXISTS org_units') &&
    mig014Content.includes('CREATE TABLE IF NOT EXISTS user_org_scope') &&
    mig014Content.includes('ALTER TABLE accounts') &&
    mig014Content.includes('ADD COLUMN IF NOT EXISTS org_unit_id');
  assertCheck('S1', 'Migration 014 exists and defines org_units and user_org_scope tables', s1Mig);

  // S2: table_ownership registers both org_units and user_org_scope
  const ownershipPath = path.resolve('database/table_ownership.json');
  const ownershipContent = fs.existsSync(ownershipPath) ? fs.readFileSync(ownershipPath, 'utf8') : '';
  const s2Ownership =
    ownershipContent.includes('"table": "org_units"') &&
    ownershipContent.includes('"table": "user_org_scope"') &&
    ownershipContent.includes('"scope": "tenant"');
  assertCheck('S2', 'table_ownership.json registers org_units and user_org_scope with tenant scope', s2Ownership);

  // S3: routes org-units exist and permission-checked
  const routesPath = path.resolve('src/server/routes/orgUnitRoutes.ts');
  const routesExists = fs.existsSync(routesPath);
  const routesContent = routesExists ? fs.readFileSync(routesPath, 'utf8') : '';
  const companyRoutesPath = path.resolve('src/server/routes/companyRoutes.ts');
  const companyRoutesContent = fs.existsSync(companyRoutesPath) ? fs.readFileSync(companyRoutesPath, 'utf8') : '';
  const s3Routes =
    routesExists &&
    routesContent.includes('/org-units') &&
    routesContent.includes('ORG_UNITS_READ') &&
    routesContent.includes('ORG_UNITS_WRITE') &&
    companyRoutesContent.includes('orgUnitRoutes');
  assertCheck('S3', 'orgUnitRoutes exists, is permission-gated, and mounted on companyRoutes', s3Routes);

  // S4: path / parent same-company validation in service (source check)
  const servicePath = path.resolve('src/server/org/orgUnitService.ts');
  const serviceExists = fs.existsSync(servicePath);
  const serviceContent = serviceExists ? fs.readFileSync(servicePath, 'utf8') : '';
  const s4ServiceValidation =
    serviceExists &&
    serviceContent.includes('parent.companyId !== companyId') &&
    serviceContent.includes('intercompany forbidden') &&
    serviceContent.includes('computedPath');
  assertCheck('S4', 'orgUnitService validates parent same-company and computes hierarchical path', s4ServiceValidation);

  // S5: Sidebar and App wire OrgUnitsPanel
  const sidebarPath = path.resolve('src/components/shell/AppSidebar.tsx');
  const sidebarContent = fs.existsSync(sidebarPath) ? fs.readFileSync(sidebarPath, 'utf8') : '';
  const appPath = path.resolve('src/App.tsx');
  const appContent = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : '';
  const panelExists = fs.existsSync(path.resolve('src/components/org/OrgUnitsPanel.tsx'));
  const s5UiWiring =
    panelExists &&
    sidebarContent.includes('الوحدات التنظيمية') &&
    sidebarContent.includes('org_units') &&
    appContent.includes('OrgUnitsPanel') &&
    appContent.includes('<OrgUnitsPanel');
  assertCheck('S5', 'Sidebar and App.tsx wire OrgUnitsPanel with Arabic label', s5UiWiring);

  // S6: permissions ORG_UNITS_* mapped
  const permsPath = path.resolve('src/server/rbac/permissions.ts');
  const permsContent = fs.existsSync(permsPath) ? fs.readFileSync(permsPath, 'utf8') : '';
  const rolesPath = path.resolve('src/server/rbac/roles.ts');
  const rolesContent = fs.existsSync(rolesPath) ? fs.readFileSync(rolesPath, 'utf8') : '';
  const s6Perms =
    permsContent.includes('ORG_UNITS_READ') &&
    permsContent.includes('ORG_UNITS_WRITE') &&
    rolesContent.includes('ORG_UNITS_READ') &&
    rolesContent.includes('ORG_UNITS_WRITE');
  assertCheck('S6', 'ORG_UNITS permissions defined and mapped in roles.ts', s6Perms);

  // S7: journal post still present (P1b regression marker)
  const journalServicePath = path.resolve('src/server/accounting/journalService.ts');
  const journalServiceContent = fs.existsSync(journalServicePath) ? fs.readFileSync(journalServicePath, 'utf8') : '';
  const s7JournalPost =
    journalServiceContent.includes('async postEntry(') &&
    journalServiceContent.includes('allocateSequenceNumber');
  assertCheck('S7', 'P1b journal posting engine and sequences remain intact', s7JournalPost);

  // S8: AI_PROJECT_STATE has AN-P1C-ORG-UNITS-1
  const statePath = path.resolve('docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  const s8State = stateContent.includes('AN-P1C-ORG-UNITS-1');
  assertCheck('S8', 'AI_PROJECT_STATE documents AN-P1C-ORG-UNITS-1', s8State);

  // S9: withTenantTransaction used for org unit repo access
  const repoPath = path.resolve('src/server/org/orgUnitRepository.ts');
  const repoContent = fs.existsSync(repoPath) ? fs.readFileSync(repoPath, 'utf8') : '';
  const s9TenantTx =
    repoContent.includes('withTenantTransaction') &&
    serviceContent.includes('withTenantTransaction');
  assertCheck('S9', 'withTenantTransaction used in orgUnitRepository and orgUnitService', s9TenantTx);

  console.log(`\n=== Verification Summary: Passed: ${passed} | Failed: ${failed} ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
