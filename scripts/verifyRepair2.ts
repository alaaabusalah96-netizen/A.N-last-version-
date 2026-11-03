import fs from 'fs';
import path from 'path';
import { check, blocked, summary } from './lib/testkit.js';

console.log('--- Running AN-FOUNDATION-REPAIR-2 Verification ---');

const rootDir = process.cwd();

async function runTests() {
  const hasDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '');

  // Test 1: vite.config.ts must be completely free of devApiPlugin, AdminPass123, dev_token_
  const viteConfigPath = path.join(rootDir, 'vite.config.ts');
  const viteContent = fs.readFileSync(viteConfigPath, 'utf8');
  const hasMockTokens = /devApiPlugin|AdminPass123|dev_token_/.test(viteContent);

  await check('vite.config.ts is clean of dev mock API, sessions, and hardcoded passwords', !hasMockTokens);

  // Test 2: vite.config.ts has proxy for /api
  await check('vite.config.ts properly configures /api reverse proxy to Express', viteContent.includes("proxy:") && viteContent.includes("'/api':"));

  // Test 3: getExecutorForCompany fails closed on empty / whitespace companyId by throwing TENANT_CONTEXT_REQUIRED
  await check('getExecutorForCompany strictly fails closed on empty / whitespace companyId', async () => {
    const { getExecutorForCompany } = await import('../src/server/db/index.js');
    let emptyThrew = false;
    let spaceThrew = false;
    try {
      await getExecutorForCompany('');
    } catch (err) {
      emptyThrew = String(err).includes('TENANT_CONTEXT_REQUIRED');
    }
    try {
      await getExecutorForCompany('   ');
    } catch (err) {
      spaceThrew = String(err).includes('TENANT_CONTEXT_REQUIRED');
    }
    return emptyThrew && spaceThrew;
  });

  // Test 4: POST /api/companies in companyRoutes is guarded by requirePlatformAdmin
  const companyRoutesPath = path.join(rootDir, 'src/server/routes/companyRoutes.ts');
  const companyRoutesContent = fs.readFileSync(companyRoutesPath, 'utf8');

  await check(
    'POST /api/companies is strictly restricted to platform_admin via requirePlatformAdmin',
    companyRoutesContent.includes('requirePlatformAdmin') && companyRoutesContent.includes("companyRoutes.post(\n  '/',\n  requireAuth,\n  requirePlatformAdmin")
  );

  // Test 5: Inactive membership rejection
  if (!hasDb) {
    blocked('DATABASE_URL is not set. Live inactive membership RBAC test is BLOCKED.');
  } else {
    try {
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

      await testStore.addMember(testUser.id, 'comp-X', 'company_admin', false);
      const allowed = await rbac.hasPermission(testUser, 'company:read', 'comp-X');

      await check('Inactive membership (isActive=false) is rejected by RBAC', !allowed);
    } catch (err) {
      await check('Inactive membership test in DB', false, err instanceof Error ? err.message : String(err));
    }
  }

  // Test 6: Production SSL rejects disable without override
  const adapterPath = path.join(rootDir, 'src/server/db/adapters/PostgresqlAdapter.ts');
  const adapterContent = fs.readFileSync(adapterPath, 'utf8');
  await check(
    'PostgresqlAdapter strictly rejects DATABASE_SSL=disable in production without override',
    adapterContent.includes("ALLOW_INSECURE_DB_SSL !== '1'") && adapterContent.includes("DATABASE_SSL === 'disable'")
  );

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
