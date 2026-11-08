import fs from 'fs';
import path from 'path';
import http from 'http';

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

async function runVerification() {
  console.log('=== Running verifyP0Verify1 Verification ===\n');

  // V1 (C1 Static): app.ts mounts accountingRoutes and userAdminRoutes
  const appTsPath = path.resolve('src/server/app.ts');
  const appTsContent = fs.existsSync(appTsPath) ? fs.readFileSync(appTsPath, 'utf8') : '';
  const v1Mounts =
    appTsContent.includes("app.use('/api/accounting', accountingRoutes)") &&
    appTsContent.includes("app.use('/api/users', userAdminRoutes)");
  assertCheck('V1', 'app.ts mounts accountingRoutes and userAdminRoutes under /api', v1Mounts);

  // V2 (C1 HTTP): Real in-process HTTP requests to mounted routes return != 404 (401/403)
  try {
    const { createApp } = await import('../src/server/app.js');
    const app = createApp();
    const server = app.listen(0, '127.0.0.1');

    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Test Accounting endpoint
      const resAccounting = await fetch(`${baseUrl}/api/accounting/accounts`);
      const v2aNot404 = resAccounting.status !== 404 && [401, 403].includes(resAccounting.status);
      assertCheck('V2a', 'GET /api/accounting/accounts returns 401/403 (not 404)', v2aNot404);

      // Test Users endpoint
      const resUsers = await fetch(`${baseUrl}/api/users`);
      const v2bNot404 = resUsers.status !== 404 && [401, 403].includes(resUsers.status);
      assertCheck('V2b', 'GET /api/users returns 401/403 (not 404)', v2bNot404);

      // Verify unmapped route actually 404s
      const res404 = await fetch(`${baseUrl}/api/unmapped-endpoint-for-test`);
      assertCheck('V2c', 'GET /api/unmapped-endpoint-for-test returns 404 Not Found', res404.status === 404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  } catch (err) {
    console.error('HTTP test error:', err);
    assertCheck('V2_HTTP', 'In-process HTTP server startup and route testing', false);
  }

  // V3 (C2 Static): userAdminService blocks non-platform_admin from mutating platform_admin targets
  const userAdminServicePath = path.resolve('src/server/identity/userAdminService.ts');
  const userAdminServiceContent = fs.existsSync(userAdminServicePath) ? fs.readFileSync(userAdminServicePath, 'utf8') : '';
  const v3TargetProtect =
    userAdminServiceContent.includes("target.role === 'platform_admin' && actor.role !== 'platform_admin'") &&
    userAdminServiceContent.includes('ForbiddenError');
  assertCheck('V3', 'userAdminService blocks non-platform_admin from mutating platform_admin targets', v3TargetProtect);

  // V4 (C2 Static): userAdminService enforces company scope for non-platform_admin
  const v4CompanyScope =
    userAdminServiceContent.includes("actor.role !== 'platform_admin'") &&
    userAdminServiceContent.includes('companyId is required for company admins') &&
    userAdminServiceContent.includes('defaultMembershipStore.getMembership(userId, companyId)');
  assertCheck('V4', 'userAdminService enforces companyId and membership check for non-platform_admin', v4CompanyScope);

  // V5 (C3 Static): membershipRepository setMembershipStatusById includes company_id in WHERE
  const membershipRepoPath = path.resolve('src/server/org/membershipRepository.ts');
  const membershipRepoContent = fs.existsSync(membershipRepoPath) ? fs.readFileSync(membershipRepoPath, 'utf8') : '';
  const v5WhereCompanyId =
    membershipRepoContent.includes('UPDATE company_memberships') &&
    membershipRepoContent.includes('WHERE id = $1 AND company_id = $3');
  assertCheck('V5', 'membershipRepository.setMembershipStatusById includes company_id in WHERE clause', v5WhereCompanyId);

  // V6 (C4 Static): companySettingsRepository uses withTenantTransaction
  const companySettingsRepoPath = path.resolve('src/server/org/companySettingsRepository.ts');
  const companySettingsRepoContent = fs.existsSync(companySettingsRepoPath) ? fs.readFileSync(companySettingsRepoPath, 'utf8') : '';
  const v6TenantTx =
    companySettingsRepoContent.includes("import { withTenantTransaction } from '../db/transactionManager.js';") &&
    companySettingsRepoContent.includes('withTenantTransaction(companyId, async (executor) =>');
  assertCheck('V6', 'companySettingsRepository operations wrapped in withTenantTransaction', v6TenantTx);

  // V7 (C5 Static): userAdminService listUsers calls listUsersByCompany for tenant admins
  const v7TenantList =
    userAdminServiceContent.includes('defaultUserRepository.listUsersByCompany(companyId)') &&
    userAdminServiceContent.includes('companyId is required for company-scoped user listing');
  assertCheck('V7', 'userAdminService.listUsers scopes user listing to company memberships', v7TenantList);

  // V8 (P0-7 Static): no string-split or dynamic obfuscation in userAdminRoutes
  const userAdminRoutesPath = path.resolve('src/server/routes/userAdminRoutes.ts');
  const userAdminRoutesContent = fs.existsSync(userAdminRoutesPath) ? fs.readFileSync(userAdminRoutesPath, 'utf8') : '';
  const v8NoObfuscation =
    !userAdminRoutesContent.includes('P_H') &&
    !userAdminRoutesContent.includes("'password' + 'Hash'") &&
    !userAdminRoutesContent.includes('"password" + "Hash"') &&
    userAdminRoutesContent.includes("import { hashPassword } from '../auth/passwordHash.js';");
  assertCheck('V8', 'no passwordHash dynamic import or string-split obfuscation in userAdminRoutes', v8NoObfuscation);

  // V9 (Password Policy Static): password min length >= 12 enforced
  const v9MinLen =
    userAdminRoutesContent.includes('password.length < 12') &&
    userAdminRoutesContent.includes('newPassword.length < 12');
  assertCheck('V9', 'minimum password length >= 12 enforced on creation and reset', v9MinLen);

  // V10 (App Factory): createApp is exported from src/server/app.ts without forced server.listen
  const v10AppExport =
    appTsContent.includes('export function createApp(): Express') &&
    !appTsContent.includes('.listen(');
  assertCheck('V10', 'createApp is cleanly exported from app.ts without side-effect listen', v10AppExport);

  // V11 (Docs State): AI_PROJECT_STATE documents AN-P0-VERIFY-1 as IMPLEMENTED
  const statePath = path.resolve('docs/foundation/AI_PROJECT_STATE.md');
  const stateContent = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  const v11State =
    stateContent.includes('AN-P0-VERIFY-1') &&
    stateContent.includes('IMPLEMENTED');
  assertCheck('V11', 'AI_PROJECT_STATE documents AN-P0-VERIFY-1 as IMPLEMENTED', v11State);

  console.log(`\n=== Verification Summary: Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked} ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
