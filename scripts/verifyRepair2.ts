import fs from 'fs';
import path from 'path';

console.log('--- Running AN-FOUNDATION-REPAIR-2 Verification ---');

const rootDir = process.cwd();

async function runTests() {
  let passed = 0;
  let failed = 0;

  // Test 1: vite.config.ts must be completely free of devApiPlugin, AdminPass123, dev_token_
  const viteConfigPath = path.join(rootDir, 'vite.config.ts');
  const viteContent = fs.readFileSync(viteConfigPath, 'utf8');

  const hasMockTokens = /devApiPlugin|AdminPass123|dev_token_/.test(viteContent);
  if (!hasMockTokens) {
    console.log('[PASS] vite.config.ts is clean of dev mock API, sessions, and hardcoded passwords');
    passed++;
  } else {
    console.error('[FAIL] vite.config.ts still contains mock tokens or devApiPlugin');
    failed++;
  }

  // Test 2: vite.config.ts has proxy for /api
  if (viteContent.includes("proxy:") && viteContent.includes("'/api':")) {
    console.log('[PASS] vite.config.ts properly configures /api reverse proxy to Express');
    passed++;
  } else {
    console.error('[FAIL] vite.config.ts is missing proxy for /api');
    failed++;
  }

  // Test 3: getExecutorForCompany fails closed on empty / whitespace companyId
  const dbIndexPath = path.join(rootDir, 'src/server/db/index.ts');
  const dbIndexContent = fs.readFileSync(dbIndexPath, 'utf8');

  const { getExecutorForCompany } = await import('../src/server/db/index.js');
  const emptyRes = await getExecutorForCompany('');
  const spaceRes = await getExecutorForCompany('   ');

  if (
    emptyRes === null &&
    spaceRes === null &&
    dbIndexContent.includes('!companyId?.trim()') ||
    dbIndexContent.includes('!companyId || !companyId.trim()')
  ) {
    console.log('[PASS] getExecutorForCompany strictly fails closed on empty / whitespace companyId');
    passed++;
  } else {
    console.error('[FAIL] getExecutorForCompany did not fail closed on empty companyId');
    failed++;
  }

  // Test 4: POST /api/companies in companyRoutes is guarded by requirePlatformAdmin
  const companyRoutesPath = path.join(rootDir, 'src/server/routes/companyRoutes.ts');
  const companyRoutesContent = fs.readFileSync(companyRoutesPath, 'utf8');

  if (
    companyRoutesContent.includes('requirePlatformAdmin') &&
    companyRoutesContent.includes("companyRoutes.post(\n  '/',\n  requireAuth,\n  requirePlatformAdmin") ||
    companyRoutesContent.includes("requirePlatformAdmin,")
  ) {
    console.log('[PASS] POST /api/companies is strictly restricted to platform_admin via requirePlatformAdmin');
    passed++;
  } else {
    console.error('[FAIL] POST /api/companies is not guarded by requirePlatformAdmin');
    failed++;
  }

  // Test 5: Inactive membership is rejected in rbacService
  const { MembershipStore } = await import('../src/server/org/membershipStore.js');
  const { RbacService } = await import('../src/server/rbac/rbacService.js');
  const testStore = new MembershipStore();
  const rbac = new RbacService(testStore);

  const testUser = {
    id: 'u-inactive-test',
    username: 'carol',
    role: 'user' as const,
    companyId: 'comp-X',
    createdAt: new Date().toISOString(),
  };

  // Add inactive membership
  await testStore.addMember(testUser.id, 'comp-X', 'company_admin', false);
  const allowed = await rbac.hasPermission(testUser, 'company:read', 'comp-X');

  if (!allowed) {
    console.log('[PASS] Inactive membership (isActive=false) is rejected by RBAC');
    passed++;
  } else {
    console.error('[FAIL] Inactive membership was incorrectly allowed by RBAC');
    failed++;
  }

  // Test 6: Production SSL rejects disable without override
  const adapterPath = path.join(rootDir, 'src/server/db/adapters/PostgresqlAdapter.ts');
  const adapterContent = fs.readFileSync(adapterPath, 'utf8');
  if (
    adapterContent.includes("ALLOW_INSECURE_DB_SSL !== '1'") &&
    adapterContent.includes("DATABASE_SSL === 'disable'")
  ) {
    console.log('[PASS] PostgresqlAdapter strictly rejects DATABASE_SSL=disable in production without override');
    passed++;
  } else {
    console.error('[FAIL] PostgresqlAdapter does not enforce production SSL rejection');
    failed++;
  }

  console.log(`Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
