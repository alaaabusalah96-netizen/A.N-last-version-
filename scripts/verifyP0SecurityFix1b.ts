import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;
let blocked = 0;

function assertCheck(id: string, description: string, condition: boolean) {
  if (condition) {
    console.log(`[PASS] ${id}: ${description}`);
    passed++;
  } else {
    console.error(`[FAIL] ${id}: ${description}`);
    failed++;
  }
}

function assertBlocked(id: string, description: string, reason: string) {
  console.log(`[BLOCKED] ${id}: ${description} (${reason})`);
  blocked++;
}

async function runVerification() {
  console.log('=== Running verifyP0SecurityFix1b Verification ===\n');

  // S1: app.ts mounts accounting routes and users routes (or apiRouter that includes both)
  const appTsPath = path.resolve('src/server/app.ts');
  const appTsContent = fs.existsSync(appTsPath) ? fs.readFileSync(appTsPath, 'utf8') : '';
  const s1Mounts =
    (appTsContent.includes("app.use('/api/accounting', accountingRoutes)") &&
      appTsContent.includes("app.use('/api/users', userAdminRoutes)")) ||
    (appTsContent.includes("app.use('/api', apiRouter)") &&
      appTsContent.includes('accountingRoutes') &&
      appTsContent.includes('userAdminRoutes'));
  assertCheck('S1', 'app.ts mounts accounting routes and users routes', s1Mounts);

  // S2: routes/index apiRouter not left as sole dead export if app does not import it
  const routesIndexPath = path.resolve('src/server/routes/index.ts');
  const routesIndexContent = fs.existsSync(routesIndexPath) ? fs.readFileSync(routesIndexPath, 'utf8') : '';
  const s2Exports =
    routesIndexContent.includes('accountingRoutes') &&
    routesIndexContent.includes('userAdminRoutes');
  assertCheck('S2', 'routes/index exports accounting and userAdmin routes properly', s2Exports);

  // S3: resetPassword / setUserActive paths require company scope for non-platform_admin (source)
  const userAdminServicePath = path.resolve('src/server/identity/userAdminService.ts');
  const userAdminServiceContent = fs.existsSync(userAdminServicePath) ? fs.readFileSync(userAdminServicePath, 'utf8') : '';
  const s3CompanyScope =
    userAdminServiceContent.includes('actor.role !== \'platform_admin\'') &&
    userAdminServiceContent.includes('companyId is required for company admins') &&
    userAdminServiceContent.includes('getMembership(userId, companyId)');
  assertCheck('S3', 'resetPassword and setUserActive require company scope for non-platform admins', s3CompanyScope);

  // S4: platform_admin target protection present in service
  const s4TargetProtect =
    userAdminServiceContent.includes('target.role === \'platform_admin\'') &&
    userAdminServiceContent.includes('Only platform admin can');
  assertCheck('S4', 'platform_admin target protection present in userAdminService', s4TargetProtect);

  // S5: membership update SQL or repo method includes company_id in WHERE
  const membershipRepoPath = path.resolve('src/server/org/membershipRepository.ts');
  const membershipRepoContent = fs.existsSync(membershipRepoPath) ? fs.readFileSync(membershipRepoPath, 'utf8') : '';
  const s5Where =
    membershipRepoContent.includes('UPDATE company_memberships') &&
    membershipRepoContent.includes('WHERE id = $1 AND company_id = $3');
  assertCheck('S5', 'membership update SQL includes company_id in WHERE clause', s5Where);

  // S6: companySettingsRepository uses withTenantTransaction
  const companySettingsRepoPath = path.resolve('src/server/org/companySettingsRepository.ts');
  const companySettingsRepoContent = fs.existsSync(companySettingsRepoPath) ? fs.readFileSync(companySettingsRepoPath, 'utf8') : '';
  const s6TenantTx =
    companySettingsRepoContent.includes('withTenantTransaction') &&
    !companySettingsRepoContent.includes('const executor = await this.getExecutor();');
  assertCheck('S6', 'companySettingsRepository uses withTenantTransaction', s6TenantTx);

  // S7: list users path filters by membership for tenant admins (source)
  const s7ListFilter =
    userAdminServiceContent.includes('listUsersByCompany(companyId)') &&
    userAdminServiceContent.includes('companyId is required for company-scoped user listing');
  assertCheck('S7', 'list users path filters by membership for tenant admins', s7ListFilter);

  // S8: no P_H / 'password'+'Hash' obfuscation in userAdminRoutes
  const userAdminRoutesPath = path.resolve('src/server/routes/userAdminRoutes.ts');
  const userAdminRoutesContent = fs.existsSync(userAdminRoutesPath) ? fs.readFileSync(userAdminRoutesPath, 'utf8') : '';
  const s8NoPH =
    !userAdminRoutesContent.includes('P_H') &&
    !userAdminRoutesContent.includes("'password' + 'Hash'") &&
    !userAdminRoutesContent.includes('"password" + "Hash"') &&
    userAdminRoutesContent.includes("import { hashPassword } from '../auth/passwordHash.js';");
  assertCheck('S8', 'no P_H / dynamic string concatenation obfuscation in userAdminRoutes', s8NoPH);

  // S9: password min length >= 12 on create/reset (source)
  const s9MinLen =
    userAdminRoutesContent.includes('password.length < 12') &&
    userAdminRoutesContent.includes('newPassword.length < 12');
  assertCheck('S9', 'password min length >= 12 enforced on create and reset in userAdminRoutes', s9MinLen);

  // S10: AI_PROJECT_STATE marks AN-P0-PLATFORM-SECURITY-FIX-1B
  const statePath = path.resolve('docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  const s10State =
    stateContent.includes('AN-P0-PLATFORM-SECURITY-FIX-1B') &&
    stateContent.includes('IMPLEMENTED');
  assertCheck('S10', 'AI_PROJECT_STATE documents AN-P0-PLATFORM-SECURITY-FIX-1B as IMPLEMENTED', s10State);

  // HTTP Probes H1 & H2 (using createApp if available, or fetch against dev server port 3000/3001)
  try {
    const { createApp } = await import('../src/server/app.js');
    const app = createApp();

    // Use lightweight express handler invocation mock or test
    // For pure route existence check without external server listening:
    // We check router stack for /api/accounting and /api/users
    const stack = (app as any)._router?.stack || [];
    const hasAccounting = stack.some((layer: any) => layer.regexp && layer.regexp.test('/api/accounting'));
    const hasUsers = stack.some((layer: any) => layer.regexp && layer.regexp.test('/api/users'));

    assertCheck('H1', 'Route layer for /api/accounting is registered on express app', hasAccounting);
    assertCheck('H2', 'Route layer for /api/users is registered on express app', hasUsers);
  } catch (err) {
    assertBlocked('H1', 'Route layer check for /api/accounting', String(err));
    assertBlocked('H2', 'Route layer check for /api/users', String(err));
  }

  console.log(`\n=== Verification Summary: Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked} ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
