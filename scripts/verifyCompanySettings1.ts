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

async function verifyCompanySettings() {
  console.log('=== Running verifyCompanySettings1 Verification ===\n');

  // S1: migration 012 defines company_settings
  const migrationPath = path.resolve('database/migrations/012_company_settings.sql');
  const migrationExists = fs.existsSync(migrationPath);
  const migrationContent = migrationExists ? fs.readFileSync(migrationPath, 'utf8') : '';
  assertCheck('S1', 'Migration 012 exists and defines company_settings table', migrationExists && migrationContent.includes('CREATE TABLE IF NOT EXISTS company_settings'));

  // S2: table_ownership registers company_settings tenant
  const ownershipPath = path.resolve('database/table_ownership.json');
  const ownershipContent = fs.existsSync(ownershipPath) ? fs.readFileSync(ownershipPath, 'utf8') : '';
  assertCheck('S2', 'table_ownership.json registers company_settings with tenant scope', ownershipContent.includes('"table": "company_settings"') && ownershipContent.includes('"scope": "tenant"'));

  // S3: routes GET/PUT settings exist and check permissions
  const routesPath = path.resolve('src/server/routes/companySettingsRoutes.ts');
  const routesExists = fs.existsSync(routesPath);
  const routesContent = routesExists ? fs.readFileSync(routesPath, 'utf8') : '';
  const routesValid = routesExists && 
    routesContent.includes('COMPANY_SETTINGS_READ') && 
    routesContent.includes('COMPANY_SETTINGS_WRITE') &&
    routesContent.includes("companySettingsRoutes.get('/settings'") &&
    routesContent.includes("companySettingsRoutes.put('/settings'");
  assertCheck('S3', 'companySettingsRoutes.ts exists with GET/PUT and permission checks', routesValid);

  // S4: service getSettings returns defaults when empty
  const servicePath = path.resolve('src/server/org/companySettingsService.ts');
  const serviceContent = fs.existsSync(servicePath) ? fs.readFileSync(servicePath, 'utf8') : '';
  assertCheck('S4', 'companySettingsService.ts provides defaults if settings missing', serviceContent.includes('defaultCurrencyCode: \'EGP\'') && serviceContent.includes('if (!settings)'));

  // S5: AppSidebar has إعدادات الشركة
  const sidebarPath = path.resolve('src/components/shell/AppSidebar.tsx');
  const sidebarContent = fs.existsSync(sidebarPath) ? fs.readFileSync(sidebarPath, 'utf8') : '';
  assertCheck('S5', 'AppSidebar contains إعدادات الشركة label', sidebarContent.includes('إعدادات الشركة'));

  // S6: CompanySettingsPanel posts/puts to settings API
  const panelPath = path.resolve('src/components/companies/CompanySettingsPanel.tsx');
  const panelContent = fs.existsSync(panelPath) ? fs.readFileSync(panelPath, 'utf8') : '';
  assertCheck('S6', 'CompanySettingsPanel makes calls to settings API', panelContent.includes('`/api/companies/${selectedCompanyId}/settings`'));

  // S7: company_user restricted via roles mapping
  const rolesPath = path.resolve('src/server/rbac/roles.ts');
  const rolesContent = fs.existsSync(rolesPath) ? fs.readFileSync(rolesPath, 'utf8') : '';
  const companyUserBlock = rolesContent.split('company_user:')[1]?.split('],')[0] || '';
  const companyUserHasRead = companyUserBlock.includes('COMPANY_SETTINGS_READ');
  const companyUserHasNoWrite = !companyUserBlock.includes('COMPANY_SETTINGS_WRITE');
  assertCheck('S7', 'roles.ts maps company_user to SETTINGS_READ only', companyUserHasRead && companyUserHasNoWrite);

  // S8: AI_PROJECT_STATE has AN-COMPANY-SETTINGS-1
  const statePath = path.resolve('docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assertCheck('S8', 'AI_PROJECT_STATE.md documents AN-COMPANY-SETTINGS-1', stateContent.includes('AN-COMPANY-SETTINGS-1'));

  // S9: Identity users + accounting permissions regression check
  const permPath = path.resolve('src/server/rbac/permissions.ts');
  const permContent = fs.existsSync(permPath) ? fs.readFileSync(permPath, 'utf8') : '';
  assertCheck('S9', 'Identity and Accounting permissions remain in permissions.ts', 
    permContent.includes('USER_READ') && permContent.includes('ACCOUNTING_ACCOUNTS_READ'));

  // S10: UI_VISIBILITY: settings nav + panel wired
  const appPath = path.resolve('src/App.tsx');
  const appContent = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : '';
  assertCheck('S10', 'App.tsx wires activeNav for company_settings to CompanySettingsPanel', 
    appContent.includes('company_settings') && appContent.includes('CompanySettingsPanel'));

  console.log(`\n=== Verification Summary: Passed: ${passed} | Failed: ${failed} ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

verifyCompanySettings().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
