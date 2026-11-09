import fs from 'fs';
import path from 'path';
import { check, blocked, summary } from './lib/testkit.js';
import { resolveSslConfig } from '../src/server/db/adapters/PostgresqlAdapter.js';
import { defaultUserRepository } from '../src/server/auth/userRepository.js';
import { defaultCompanyRepository } from '../src/server/org/companyRepository.js';
import { defaultMembershipRepository } from '../src/server/org/membershipRepository.js';
import { defaultRbacService } from '../src/server/rbac/rbacService.js';
import { hashPassword } from '../src/server/auth/passwordHash.js';

console.log('--- Running AN-FOUNDATION-REPAIR-2 Verification (R1.2) ---');

const rootDir = process.cwd();

async function runTests() {
  const hasDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '');

  // Test 1: vite.config.ts clean of dev mock tokens
  const viteConfigPath = path.join(rootDir, 'vite.config.ts');
  const viteContent = fs.readFileSync(viteConfigPath, 'utf8');
  const hasMockTokens = /devApiPlugin|AdminPass123|dev_token_/.test(viteContent);
  await check('vite.config.ts is clean of dev mock API, sessions, and hardcoded passwords', !hasMockTokens);

  // Test 2: vite.config.ts has proxy for /api
  await check('vite.config.ts properly configures /api reverse proxy to Express', viteContent.includes("proxy:") && viteContent.includes("'/api':"));

  // Test 3: getExecutorForCompany fails closed on empty / whitespace companyId
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

  // Test 4: Inactive membership rejection with real UUID records
  if (!hasDb) {
    blocked('DATABASE_URL is not set. Live inactive membership RBAC test is BLOCKED.');
  } else {
    try {
      const suffix = Date.now();
      const passwordHash = await hashPassword('TestPass123!');
      const comp = await defaultCompanyRepository.create({ code: `REP2_${suffix}`, nameAr: 'شركة صيانة 2' });
      const user = await defaultUserRepository.createUser({ username: `inactive_rep2_${suffix}@erp.local`, passwordHash, role: 'user' });

      await defaultMembershipRepository.addMember(user.id, comp.id, 'company_admin', false);
      const allowed = await defaultRbacService.hasPermission(user, 'company:read', comp.id);

      await check('Inactive membership (is_active=false) is rejected by RBAC', !allowed);
    } catch (err) {
      await check('Inactive membership test in DB', false, err instanceof Error ? err.message : String(err));
    }
  }

  // Test 5: Behavioral SSL Config Resolution (Strict R3 Production SSL Policy)
  await check('resolveSslConfig throws in production when DATABASE_SSL=disable', () => {
    try {
      resolveSslConfig({ NODE_ENV: 'production', DATABASE_SSL: 'disable' });
      return false;
    } catch (err) {
      return String(err).includes('Insecure database connection rejected');
    }
  });

  await check('resolveSslConfig ALLOW_INSECURE_DB_SSL=1 cannot bypass rejection in production', () => {
    try {
      resolveSslConfig({ NODE_ENV: 'production', DATABASE_SSL: 'disable', ALLOW_INSECURE_DB_SSL: '1' });
      return false;
    } catch (err) {
      return String(err).includes('Insecure database connection rejected');
    }
  });

  await check('resolveSslConfig throws in production when DATABASE_SSL_REJECT_UNAUTHORIZED=false', () => {
    try {
      resolveSslConfig({ NODE_ENV: 'production', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' });
      return false;
    } catch (err) {
      return String(err).includes('Insecure database connection rejected');
    }
  });

  await check('resolveSslConfig enables rejectUnauthorized by default in production', () => {
    const ssl = resolveSslConfig({ NODE_ENV: 'production' }) as any;
    return ssl && ssl.rejectUnauthorized === true;
  });

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
