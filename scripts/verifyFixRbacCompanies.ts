import { check, blocked, summary } from './lib/testkit.js';
import { defaultUserRepository } from '../src/server/auth/userRepository.js';
import { defaultCompanyRepository } from '../src/server/org/companyRepository.js';
import { defaultMembershipRepository } from '../src/server/org/membershipRepository.js';
import { defaultRbacService } from '../src/server/rbac/rbacService.js';
import { PERMISSIONS } from '../src/server/rbac/permissions.js';
import { requirePlatformAdmin } from '../src/server/rbac/requirePlatformAdmin.js';
import { hashPassword } from '../src/server/auth/passwordHash.js';

console.log('--- Running Behavioral RBAC Verification (R1.1) ---');

async function runTests() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Behavioral RBAC tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    const suffix = Date.now();
    const commonPassHash = await hashPassword('RbacTestPass123!');

    // 1. Create real companies
    const compA = await defaultCompanyRepository.create({ code: `RBAC_A_${suffix}`, nameAr: 'شركة أ' });
    const compB = await defaultCompanyRepository.create({ code: `RBAC_B_${suffix}`, nameAr: 'شركة ب' });

    // 2. Create real platform admin, orphan user, company user, company admin, and inactive user
    const platformAdmin = await defaultUserRepository.createUser({
      username: `plat_admin_${suffix}@erp.local`,
      passwordHash: commonPassHash,
      role: 'platform_admin',
    });

    const orphanUser = await defaultUserRepository.createUser({
      username: `orphan_${suffix}@erp.local`,
      passwordHash: commonPassHash,
      role: 'user',
    });

    const compAUser = await defaultUserRepository.createUser({
      username: `comp_a_user_${suffix}@erp.local`,
      passwordHash: commonPassHash,
      role: 'user',
    });

    const compAdminUser = await defaultUserRepository.createUser({
      username: `comp_admin_${suffix}@erp.local`,
      passwordHash: commonPassHash,
      role: 'user',
    });

    const inactiveUser = await defaultUserRepository.createUser({
      username: `inactive_user_${suffix}@erp.local`,
      passwordHash: commonPassHash,
      role: 'user',
    });

    // Add active & inactive memberships
    await defaultMembershipRepository.addMember(compAUser.id, compA.id, 'company_user', true);
    await defaultMembershipRepository.addMember(compAdminUser.id, compA.id, 'company_admin', true);
    await defaultMembershipRepository.addMember(inactiveUser.id, compA.id, 'company_user', false);

    // Test 1: platform_admin has company:read without companyId
    const t1 = await defaultRbacService.hasPermission(platformAdmin, PERMISSIONS.COMPANY_READ);
    await check('platform_admin has company:read without companyId', t1 === true);

    // Test 2: orphanUser without membership -> company:read without companyId -> false
    const t2 = await defaultRbacService.hasPermission(orphanUser, PERMISSIONS.COMPANY_READ);
    await check('orphanUser without membership has company:read -> false', t2 === false);

    // Test 3: company_user in A: read(A)=true, read(B)=false, write(A)=false
    const readA = await defaultRbacService.hasPermission(compAUser, PERMISSIONS.COMPANY_READ, compA.id);
    const readB = await defaultRbacService.hasPermission(compAUser, PERMISSIONS.COMPANY_READ, compB.id);
    const writeA = await defaultRbacService.hasPermission(compAUser, PERMISSIONS.COMPANY_WRITE, compA.id);
    await check('company_user in A: read(A)=true, read(B)=false, write(A)=false', readA === true && readB === false && writeA === false);

    // Test 4: company_admin in A: write(A)=true, write(B)=false
    const adminWriteA = await defaultRbacService.hasPermission(compAdminUser, PERMISSIONS.COMPANY_WRITE, compA.id);
    const adminWriteB = await defaultRbacService.hasPermission(compAdminUser, PERMISSIONS.COMPANY_WRITE, compB.id);
    await check('company_admin in A: write(A)=true, write(B)=false', adminWriteA === true && adminWriteB === false);

    // Test 5: Membership is_active = false => read(A)=false
    const inactiveReadA = await defaultRbacService.hasPermission(inactiveUser, PERMISSIONS.COMPANY_READ, compA.id);
    await check('Inactive membership (is_active=false) produces read(A)=false', inactiveReadA === false);

    // Test 6: requirePlatformAdmin rejects company_admin (403) and passes platform_admin
    let adminRejected = false;
    let adminStatus = 0;
    const mockResAdmin: any = {
      status: (code: number) => {
        adminStatus = code;
        return { json: () => { adminRejected = true; } };
      },
    };
    await requirePlatformAdmin({ user: compAdminUser } as any, mockResAdmin, (() => {}) as any);
    await check('requirePlatformAdmin rejects company_admin with 403', adminRejected && adminStatus === 403);

    let platformPassed: boolean = false;
    await requirePlatformAdmin({ user: platformAdmin } as any, mockResAdmin, (() => { platformPassed = true; }) as any);
    await check('requirePlatformAdmin passes platform_admin', Boolean(platformPassed));

  } catch (err) {
    await check('Behavioral RBAC test execution', false, err instanceof Error ? err.message : String(err));
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
