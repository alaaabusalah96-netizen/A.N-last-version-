import { User } from '../src/server/auth/userStore.js';
import { MembershipStore } from '../src/server/org/membershipStore.js';
import { RbacService } from '../src/server/rbac/rbacService.js';
import { PERMISSIONS } from '../src/server/rbac/permissions.js';
import { requirePlatformAdmin } from '../src/server/rbac/requirePlatformAdmin.js';

console.log('--- Running Behavioral RBAC Verification ---');

async function runTests() {
  let passed = 0;
  let failed = 0;

  const testStore = new MembershipStore();
  const rbac = new RbacService(testStore);

  // Users
  const platformAdmin: Omit<User, 'passwordHash'> = {
    id: 'user-platform-admin',
    username: 'superadmin',
    role: 'platform_admin',
    companyId: null,
    createdAt: new Date().toISOString(),
  };

  const companyAdminUser: Omit<User, 'passwordHash'> = {
    id: 'user-comp-admin',
    username: 'dan',
    role: 'user',
    companyId: 'comp-A',
    createdAt: new Date().toISOString(),
  };

  const companyUser: Omit<User, 'passwordHash'> = {
    id: 'user-member-1',
    username: 'alice',
    role: 'user',
    companyId: 'comp-A',
    createdAt: new Date().toISOString(),
  };

  const orphanUser: Omit<User, 'passwordHash'> = {
    id: 'user-orphan',
    username: 'bob',
    role: 'user',
    companyId: null,
    createdAt: new Date().toISOString(),
  };

  // Add memberships
  await testStore.addMember(companyUser.id, 'comp-A', 'company_user');
  await testStore.addMember(companyAdminUser.id, 'comp-A', 'company_admin');

  // Test 1: platform_admin has company:read without companyId
  const t1 = await rbac.hasPermission(platformAdmin, PERMISSIONS.COMPANY_READ);
  if (t1) {
    console.log('[PASS] platform_admin + company:read -> true');
    passed++;
  } else {
    console.error('[FAIL] platform_admin + company:read should be true');
    failed++;
  }

  // Test 2: companyUser has membership in comp-A -> company:read without companyId -> true
  const t2 = await rbac.hasPermission(companyUser, PERMISSIONS.COMPANY_READ);
  if (t2) {
    console.log('[PASS] member user + company:read without companyId -> true');
    passed++;
  } else {
    console.error('[FAIL] member user + company:read without companyId should be true');
    failed++;
  }

  // Test 3: orphanUser with NO membership -> company:read without companyId -> false
  const t3 = await rbac.hasPermission(orphanUser, PERMISSIONS.COMPANY_READ);
  if (!t3) {
    console.log('[PASS] orphan user without membership -> false');
    passed++;
  } else {
    console.error('[FAIL] orphan user should be false');
    failed++;
  }

  // Test 4: companyUser checks companyId='comp-B' (not a member) -> false
  const t4 = await rbac.hasPermission(companyUser, PERMISSIONS.COMPANY_READ, 'comp-B');
  if (!t4) {
    console.log('[PASS] companyUser for non-member comp-B -> false');
    passed++;
  } else {
    console.error('[FAIL] companyUser for non-member comp-B should be false');
    failed++;
  }

  // Test 5: companyUser (role=company_user) checks company:write on comp-A -> false
  const t5 = await rbac.hasPermission(companyUser, PERMISSIONS.COMPANY_WRITE, 'comp-A');
  if (!t5) {
    console.log('[PASS] company_user role cannot company:write on comp-A -> false');
    passed++;
  } else {
    console.error('[FAIL] company_user should not have company:write');
    failed++;
  }

  // Test 6: company_admin cannot perform platform-only company creation (requirePlatformAdmin middleware test)
  let rejected = false;
  let statusSet = 0;
  const mockReq: any = { user: companyAdminUser };
  const mockRes: any = {
    status: (code: number) => {
      statusSet = code;
      return {
        json: () => {
          rejected = true;
        },
      };
    },
  };
  const mockNext = () => {
    rejected = false;
  };

  requirePlatformAdmin(mockReq, mockRes, mockNext);
  if (rejected && statusSet === 403) {
    console.log('[PASS] company_admin is strictly rejected (403) by requirePlatformAdmin middleware');
    passed++;
  } else {
    console.error('[FAIL] company_admin was not rejected by requirePlatformAdmin');
    failed++;
  }

  // Test 7: platformAdmin passes requirePlatformAdmin middleware
  let platformPassed = false;
  const mockPlatformReq: any = { user: platformAdmin };
  requirePlatformAdmin(mockPlatformReq, mockRes, () => {
    platformPassed = true;
  });
  if (platformPassed) {
    console.log('[PASS] platform_admin passes requirePlatformAdmin middleware');
    passed++;
  } else {
    console.error('[FAIL] platform_admin failed requirePlatformAdmin');
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
