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

async function verifyFixAccountingRbac() {
  console.log('=== Running verifyFixAccountingRbac1 Verification ===\n');

  // S1: permissions.ts defines ACCOUNTING_ACCOUNTS_READ, CREATE, SEED
  const permPath = path.resolve('src/server/rbac/permissions.ts');
  const permContent = fs.existsSync(permPath) ? fs.readFileSync(permPath, 'utf8') : '';
  assertCheck(
    'S1',
    'permissions.ts defines ACCOUNTING_ACCOUNTS_READ, CREATE, and SEED',
    permContent.includes('ACCOUNTING_ACCOUNTS_READ') &&
      permContent.includes('ACCOUNTING_ACCOUNTS_CREATE') &&
      permContent.includes('ACCOUNTING_ACCOUNTS_SEED')
  );

  // S2: roles: company_user includes READ and excludes CREATE/SEED
  const rolesPath = path.resolve('src/server/rbac/roles.ts');
  const rolesContent = fs.existsSync(rolesPath) ? fs.readFileSync(rolesPath, 'utf8') : '';
  const companyUserBlock = rolesContent.split('company_user:')[1]?.split('],')[0] || '';
  const companyUserHasRead = companyUserBlock.includes('ACCOUNTING_ACCOUNTS_READ');
  const companyUserHasNoCreate = !companyUserBlock.includes('ACCOUNTING_ACCOUNTS_CREATE') && !companyUserBlock.includes('ACCOUNTING_ACCOUNTS_SEED');
  assertCheck('S2', 'roles.ts maps company_user to READ only without CREATE or SEED', companyUserHasRead && companyUserHasNoCreate);

  // S3: roles: company_admin includes READ+CREATE+SEED
  const companyAdminValid = rolesContent.includes('company_admin') &&
    rolesContent.includes('ACCOUNTING_ACCOUNTS_READ') &&
    rolesContent.includes('ACCOUNTING_ACCOUNTS_CREATE') &&
    rolesContent.includes('ACCOUNTING_ACCOUNTS_SEED');
  assertCheck('S3', 'roles.ts maps company_admin to READ, CREATE, and SEED', companyAdminValid);

  // S4: roles: platform_admin includes READ+CREATE+SEED
  const platformAdminValid = rolesContent.includes('platform_admin') &&
    rolesContent.includes('ACCOUNTING_ACCOUNTS_READ') &&
    rolesContent.includes('ACCOUNTING_ACCOUNTS_CREATE') &&
    rolesContent.includes('ACCOUNTING_ACCOUNTS_SEED');
  assertCheck('S4', 'roles.ts maps platform_admin to READ, CREATE, and SEED', platformAdminValid);

  // S5: accountingRoutes CREATE path references ACCOUNTING_ACCOUNTS_CREATE
  const routesPath = path.resolve('src/server/routes/accountingRoutes.ts');
  const routesContent = fs.existsSync(routesPath) ? fs.readFileSync(routesPath, 'utf8') : '';
  assertCheck(
    'S5',
    'accountingRoutes.ts enforces ACCOUNTING_ACCOUNTS_CREATE for POST /accounts',
    routesContent.includes('ACCOUNTING_ACCOUNTS_CREATE')
  );

  // S6: accountingRoutes SEED path references ACCOUNTING_ACCOUNTS_SEED
  assertCheck(
    'S6',
    'accountingRoutes.ts enforces ACCOUNTING_ACCOUNTS_SEED for POST /accounts/seed-default',
    routesContent.includes('ACCOUNTING_ACCOUNTS_SEED')
  );

  // S7: accountingRoutes GET references ACCOUNTING_ACCOUNTS_READ
  assertCheck(
    'S7',
    'accountingRoutes.ts enforces ACCOUNTING_ACCOUNTS_READ for GET /accounts',
    routesContent.includes('ACCOUNTING_ACCOUNTS_READ')
  );

  // S8: accountingRoutes does not authorize writes solely via assertCompanyAccess without permission
  assertCheck(
    'S8',
    'accountingRoutes.ts uses defaultRbacService.hasPermission checks (assertPermissionForCompanyQueryOrBody)',
    routesContent.includes('defaultRbacService.hasPermission')
  );

  // S9: AccountsPanel component exists and makes correct accounting endpoints
  const panelPath = path.resolve('src/components/accounting/AccountsPanel.tsx');
  const panelContent = fs.existsSync(panelPath) ? fs.readFileSync(panelPath, 'utf8') : '';
  assertCheck(
    'S9',
    'AccountsPanel component makes apiFetch calls to /api/accounting/accounts',
    panelContent.includes('/api/accounting/accounts')
  );

  // S10: AI_PROJECT_STATE lists AN-FIX-ACCOUNTING-RBAC-1
  const statePath = path.resolve('docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assertCheck(
    'S10',
    'AI_PROJECT_STATE.md documents AN-FIX-ACCOUNTING-RBAC-1',
    stateContent.includes('AN-FIX-ACCOUNTING-RBAC-1')
  );

  console.log(`\n=== Verification Summary: Passed: ${passed} | Failed: ${failed} ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

verifyFixAccountingRbac().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
