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

async function verifyIdentityUsers() {
  console.log('=== Running verifyIdentityUsers1 Verification ===\n');

  // S1: userAdminRoutes mounted at /users
  const routesIndexPath = path.resolve('src/server/routes/index.ts');
  const routesIndexContent = fs.existsSync(routesIndexPath) ? fs.readFileSync(routesIndexPath, 'utf8') : '';
  assertCheck('S1', 'userAdminRoutes mounted at /users in routes/index.ts', routesIndexContent.includes('/users') && routesIndexContent.includes('userAdminRoutes'));

  // S2: userAdminService exists with required methods
  const servicePath = path.resolve('src/server/identity/userAdminService.ts');
  const serviceExists = fs.existsSync(servicePath);
  const serviceContent = serviceExists ? fs.readFileSync(servicePath, 'utf8') : '';
  const serviceValid = serviceExists && serviceContent.includes('listUsers') && serviceContent.includes('createUser') && serviceContent.includes('resetPassword');
  assertCheck('S2', 'userAdminService exists with listUsers, createUser, resetPassword', serviceValid);

  // S3: USER_READ/USER_WRITE referenced on routes
  const routesPath = path.resolve('src/server/routes/userAdminRoutes.ts');
  const routesContent = fs.existsSync(routesPath) ? fs.readFileSync(routesPath, 'utf8') : '';
  assertCheck('S3', 'userAdminRoutes references USER_READ/USER_WRITE permissions', routesContent.includes('USER_READ') && routesContent.includes('USER_WRITE'));

  // S4: company_user restricted via service guards (static check)
  assertCheck('S4', 'userAdminService guards against privilege escalation', serviceContent.includes('platform_admin') && serviceContent.includes('ForbiddenError'));

  // S5: membership role enum limit in service
  assertCheck('S5', 'userAdminService restricts membership roles to company_admin|company_user', serviceContent.includes('company_admin') && serviceContent.includes('company_user'));

  // S6: AppSidebar contains المستخدمون
  const sidebarPath = path.resolve('src/components/shell/AppSidebar.tsx');
  const sidebarContent = fs.existsSync(sidebarPath) ? fs.readFileSync(sidebarPath, 'utf8') : '';
  assertCheck('S6', 'AppSidebar contains المستخدمون label', sidebarContent.includes('المستخدمون'));

  // S7: UsersAdminWorkspace exists and calls /api/users
  const wsPath = path.resolve('src/components/users/UsersAdminWorkspace.tsx');
  const wsContent = fs.existsSync(wsPath) ? fs.readFileSync(wsPath, 'utf8') : '';
  assertCheck('S7', 'UsersAdminWorkspace exists and calls /api/users', fs.existsSync(wsPath) && wsContent.includes('/api/users'));

  // S8: passwordHash never sent in route response mappers (static check)
  const hasSecureMapper = routesContent.includes('const { passwordHash, ...') || routesContent.includes('const { passwordHash, ...safeUser }');
  assertCheck('S8', 'userAdminRoutes maps user response to remove passwordHash', hasSecureMapper);

  // S9: auditService.record used on mutating paths
  assertCheck('S9', 'userAdminService uses auditService.record on mutations', serviceContent.includes('defaultAuditService.record'));

  // S10: AI_PROJECT_STATE marks AN-IDENTITY-USERS-1 IMPLEMENTED
  const statePath = path.resolve('docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  assertCheck('S10', 'AI_PROJECT_STATE.md documents AN-IDENTITY-USERS-1', stateContent.includes('AN-IDENTITY-USERS-1'));

  // S11: Accounting ACCOUNTING_ACCOUNTS_* still present (regression)
  assertCheck('S11', 'Accounting permissions still present in permissions.ts', permContent.includes('ACCOUNTING_ACCOUNTS_READ'));

  // S12: UI shell sidebar has الشركات and المحاسبة
  assertCheck('S12', 'Sidebar has الشركات and المحاسبة', sidebarContent.includes('الشركات') && sidebarContent.includes('المحاسبة'));

  console.log(`\n=== Verification Summary: Passed: ${passed} | Failed: ${failed} ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

const permPath = path.resolve('src/server/rbac/permissions.ts');
const permContent = fs.existsSync(permPath) ? fs.readFileSync(permPath, 'utf8') : '';

verifyIdentityUsers().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
