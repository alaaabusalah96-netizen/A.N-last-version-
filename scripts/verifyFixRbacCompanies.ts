import { User } from '../src/server/auth/userStore.js';
import { MembershipStore } from '../src/server/org/membershipStore.js';
import { RbacService } from '../src/server/rbac/rbacService.js';
import { PERMISSIONS } from '../src/server/rbac/permissions.js';
import { requirePlatformAdmin } from '../src/server/rbac/requirePlatformAdmin.js';

console.log('--- Running Behavioral RBAC Verification ---');

async function runTests() {
  let passed = 0;
  let failed = 0;
  let blocked = 0;

  const hasDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '');

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

  const testStore = new MembershipStore();
  const rbac = new RbacService(testStore);

  // Test 1: platform_admin has company:read without companyId (no DB query required)
  const t1 = await rbac.hasPermission(platformAdmin, PERMISSIONS.COMPANY_READ);
  if (t1) {
    console.log('[PASS] platform_admin + company:read -> true');
    passed++;
  } else {
    console.error('[FAIL] platform_admin + company:read should be true');
    failed++;
  }

  // Test 2: company_admin cannot perform platform-only company creation (requirePlatformAdmin middleware test)
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

  // Test 3: platformAdmin passes requirePlatformAdmin middleware
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

  // Live DB membership tests (Skipped / BLOCKED if no DATABASE_URL)
  if (!hasDb) {
    console.log('[BLOCKED] DATABASE_URL is not set. Live RBAC database membership tests are BLOCKED.');
    blocked++;
  } else {
    try {
      // orphanUser with NO membership -> company:read without companyId -> false
      const tOrphan = await rbac.hasPermission(orphanUser, PERMISSIONS.COMPANY_READ);

      await testStore.addMember(companyUser.id, 'comp-A', 'company_user');
      await testStore.addMember(companyAdminUser.id, 'comp-A', 'company_admin');

      // companyUser has membership in comp-A -> company:read without companyId -> true
      const dbT1 = await rbac.hasPermission(companyUser, PERMISSIONS.COMPANY_READ);
      // companyUser checks companyId='comp-B' (not a member) -> false
      const dbT2 = await rbac.hasPermission(companyUser, PERMISSIONS.COMPANY_READ, 'comp-B');
      // companyUser (role=company_user) checks company:write on comp-A -> false
      const dbT3 = await rbac.hasPermission(companyUser, PERMISSIONS.COMPANY_WRITE, 'comp-A');

      if (!tOrphan && dbT1 && !dbT2 && !dbT3) {
        console.log('[PASS] Live database membership RBAC permissions verified');
        passed++;
      } else {
        console.error('[FAIL] Live database membership RBAC permission checks failed');
        failed++;
      }
    } catch (err) {
      console.error('[FAIL] Live database membership operation error:', err);
      failed++;
    }
  }

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked}`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
