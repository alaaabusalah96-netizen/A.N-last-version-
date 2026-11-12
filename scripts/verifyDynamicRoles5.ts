import fs from 'fs';
import path from 'path';
import { PERMISSION_CATALOG, PERMISSIONS } from '../src/server/rbac/permissions.js';
import { ROLE_PERMISSIONS } from '../src/server/rbac/roles.js';
import { RbacService } from '../src/server/rbac/rbacService.js';
import { RoleService } from '../src/server/rbac/roleService.js';
import { RoleRecord } from '../src/server/rbac/roleRepository.js';
import { ValidationError } from '../src/server/http/errors.js';
import { CompanyMembership } from '../src/server/org/membershipStore.js';
import { DbExecutor } from '../src/server/db/types.js';

class FakeRoleRepository {
  roles = new Map<string, RoleRecord>();
  perms = new Map<string, string[]>();
  activeMemberCounts = new Map<string, number>();

  async listByCompany(companyId: string): Promise<RoleRecord[]> {
    return Array.from(this.roles.values())
      .filter((r) => r.companyId === companyId)
      .map((r) => ({ ...r, permissions: this.perms.get(r.id) || [] }));
  }

  async findById(companyId: string, roleId: string): Promise<RoleRecord | null> {
    const r = this.roles.get(roleId);
    if (!r || r.companyId !== companyId) return null;
    return { ...r, permissions: this.perms.get(r.id) || [] };
  }

  async findByCode(companyId: string, code: string): Promise<RoleRecord | null> {
    for (const r of this.roles.values()) {
      if (r.companyId === companyId && r.code === code) return r;
    }
    return null;
  }

  async insertRole(companyId: string, input: any): Promise<RoleRecord> {
    const id = `role-${this.roles.size + 1}-${input.code}`;
    const row: RoleRecord = {
      id,
      companyId,
      code: input.code,
      nameAr: input.nameAr,
      description: input.description ?? null,
      orgLevel: input.orgLevel || 'company',
      isSystem: Boolean(input.isSystem),
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.roles.set(id, row);
    this.perms.set(id, []);
    return row;
  }

  async updateRole(companyId: string, roleId: string, input: any): Promise<RoleRecord> {
    const existing = this.roles.get(roleId)!;
    const updated: RoleRecord = {
      ...existing,
      ...(input.nameAr !== undefined ? { nameAr: input.nameAr } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.orgLevel !== undefined ? { orgLevel: input.orgLevel } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.roles.set(roleId, updated);
    return updated;
  }

  async setActive(companyId: string, roleId: string, isActive: boolean): Promise<RoleRecord> {
    const existing = this.roles.get(roleId)!;
    const updated = { ...existing, isActive, updatedAt: new Date().toISOString() };
    this.roles.set(roleId, updated);
    return updated;
  }

  async countActiveMembers(_companyId: string, roleId: string): Promise<number> {
    return this.activeMemberCounts.get(roleId) || 0;
  }

  async listPermissions(roleId: string): Promise<string[]> {
    return [...(this.perms.get(roleId) || [])];
  }

  async replacePermissions(roleId: string, codes: string[]): Promise<string[]> {
    this.perms.set(roleId, [...codes]);
    return [...codes];
  }
}

class FakeMembershipStore {
  memberships: CompanyMembership[] = [];

  async getMembership(userId: string, companyId: string): Promise<CompanyMembership | null> {
    return this.memberships.find((m) => m.userId === userId && m.companyId === companyId) || null;
  }

  async listByUser(userId: string): Promise<CompanyMembership[]> {
    return this.memberships.filter((m) => m.userId === userId && m.isActive);
  }
}

const fakeTx: DbExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
  withTransaction: async <T>(fn: (tx: DbExecutor) => Promise<T>) => fn(fakeTx),
} as any;

const fakeRunner = async <T>(_companyId: string, fn: (tx: DbExecutor) => Promise<T>): Promise<T> => {
  return await fn(fakeTx);
};

async function runTests() {
  console.log('=====================================================');
  console.log('=== VERIFYING AN-RBAC-ROLES-5 (Dynamic RBAC/Matrix) ===');
  console.log('=====================================================');

  let passed = 0;
  let failed = 0;

  const companyId = '11111111-1111-1111-1111-111111111111';
  const actorId = '22222222-2222-2222-2222-222222222222';

  const fakeRepo = new FakeRoleRepository();
  const fakeMembershipStore = new FakeMembershipStore();
  const rbacService = new RbacService(fakeMembershipStore as any, fakeRepo as any, fakeRunner);
  const roleService = new RoleService(
    fakeRepo as any,
    (cid) => rbacService.invalidate(cid),
    fakeRunner
  );

  // Bootstrap initial company roles via lazy listRoles
  const seeded = await roleService.listRoles(companyId);
  const companyAdminRole = seeded.find((r) => r.code === 'company_admin')!;

  // R1: createRole with 'Bad Code' -> ValidationError
  try {
    await roleService.createRole(companyId, { code: 'Bad Code', nameAr: 'دور خاطئ' }, actorId);
    console.error('R1 FAIL: Bad Code should throw ValidationError');
    failed++;
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('R1 PASS: Invalid role code rejected with ValidationError');
      passed++;
    } else {
      console.error('R1 FAIL:', err);
      failed++;
    }
  }

  // R2: duplicate code -> ValidationError
  try {
    await roleService.createRole(companyId, { code: 'company_admin', nameAr: 'مكرر' }, actorId);
    console.error('R2 FAIL: Duplicate role code should throw ValidationError');
    failed++;
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('R2 PASS: Duplicate code rejected with ValidationError');
      passed++;
    } else {
      console.error('R2 FAIL:', err);
      failed++;
    }
  }

  // R3: cloneFromCode='platform_admin' -> ValidationError
  try {
    await roleService.createRole(
      companyId,
      { code: 'super_clone', nameAr: 'نسخ غير مسموح', cloneFromCode: 'platform_admin' },
      actorId
    );
    console.error('R3 FAIL: Cloning platform_admin should throw ValidationError');
    failed++;
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('R3 PASS: Cloning platform_admin blocked with ValidationError');
      passed++;
    } else {
      console.error('R3 FAIL:', err);
      failed++;
    }
  }

  // Create custom role for R4/R6/R10/R11 tests
  const customRole = await roleService.createRole(
    companyId,
    { code: 'purchasing_clerk', nameAr: 'موظف مشتريات', orgLevel: 'branch', cloneFromCode: 'company_user' },
    actorId
  );

  // R4: setPermissions with invalid permission code 'x.y' -> ValidationError mentioning 'x.y'
  try {
    await roleService.setPermissions(companyId, customRole.id, ['x.y'], actorId, 'platform_admin');
    console.error('R4 FAIL: Invalid permission code should throw ValidationError');
    failed++;
  } catch (err) {
    if (err instanceof ValidationError && err.message.includes('x.y')) {
      console.log('R4 PASS: Unknown permission x.y rejected mentioning x.y');
      passed++;
    } else {
      console.error('R4 FAIL:', err);
      failed++;
    }
  }

  // R5: setPermissions on company_admin with [] -> ValidationError
  try {
    await roleService.setPermissions(companyId, companyAdminRole.id, [], actorId, 'platform_admin');
    console.error('R5 FAIL: Emptying company_admin permissions should throw ValidationError');
    failed++;
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('R5 PASS: Emptying company_admin permissions rejected with ValidationError');
      passed++;
    } else {
      console.error('R5 FAIL:', err);
      failed++;
    }
  }

  // R6: setActive(false) on role with active members -> ValidationError mentioning count
  try {
    fakeRepo.activeMemberCounts.set(customRole.id, 3);
    await roleService.setActive(companyId, customRole.id, false, actorId);
    console.error('R6 FAIL: Deactivating role with members should throw ValidationError');
    failed++;
  } catch (err) {
    if (err instanceof ValidationError && err.message.includes('3')) {
      console.log('R6 PASS: Deactivating role with active members blocked mentioning count (3)');
      passed++;
    } else {
      console.error('R6 FAIL:', err);
      failed++;
    }
  }

  // R7: deleteRole -> ValidationError
  try {
    await roleService.deleteRole(companyId, customRole.id);
    console.error('R7 FAIL: deleteRole should throw ValidationError');
    failed++;
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('R7 PASS: deleteRole rejected with ValidationError');
      passed++;
    } else {
      console.error('R7 FAIL:', err);
      failed++;
    }
  }

  // R8: rbacService for platform_admin even when role tables are empty -> grants all permissions
  try {
    const emptyRbac = new RbacService(new FakeMembershipStore() as any, new FakeRoleRepository() as any, fakeRunner);
    const platUser = { id: 'u-plat', username: 'admin', role: 'platform_admin' as const, isActive: true, createdAt: '' };
    const allowedAll = await emptyRbac.hasPermission(platUser, PERMISSIONS.ROLES_WRITE, companyId);
    if (allowedAll) {
      console.log('R8 PASS: platform_admin retains all permissions even with empty DB tables');
      passed++;
    } else {
      console.error('R8 FAIL: platform_admin denied');
      failed++;
    }
  } catch (err) {
    console.error('R8 FAIL:', err);
    failed++;
  }

  // R9: user with roleId=NULL and role='company_user' -> uses static company_user map
  try {
    const legacyUserId = 'u-legacy-1';
    fakeMembershipStore.memberships.push({
      id: 'm-1',
      userId: legacyUserId,
      companyId,
      role: 'company_user',
      roleId: null,
      isActive: true,
      createdAt: new Date().toISOString(),
    });
    const legacyUser = { id: legacyUserId, username: 'legacy', role: 'user' as const, isActive: true, createdAt: '' };
    const canReadCompany = await rbacService.hasPermission(legacyUser, PERMISSIONS.COMPANY_READ, companyId);
    const canWriteRoles = await rbacService.hasPermission(legacyUser, PERMISSIONS.ROLES_WRITE, companyId);
    if (canReadCompany && !canWriteRoles) {
      console.log('R9 PASS: NULL role_id falls back strictly to static ROLE_PERMISSIONS[company_user]');
      passed++;
    } else {
      console.error('R9 FAIL:', { canReadCompany, canWriteRoles });
      failed++;
    }
  } catch (err) {
    console.error('R9 FAIL:', err);
    failed++;
  }

  // R10: user with roleId pointing to a role having ONLY 2 permissions -> grants ONLY those 2
  const dynUserId = 'u-dyn-1';
  try {
    await roleService.setPermissions(
      companyId,
      customRole.id,
      [PERMISSIONS.PURCHASING_READ, PERMISSIONS.PURCHASING_WRITE],
      actorId,
      'company_admin'
    );
    fakeMembershipStore.memberships.push({
      id: 'm-2',
      userId: dynUserId,
      companyId,
      role: 'company_user',
      roleId: customRole.id,
      isActive: true,
      createdAt: new Date().toISOString(),
    });
    const dynUser = { id: dynUserId, username: 'dyn', role: 'user' as const, isActive: true, createdAt: '' };
    const pRead = await rbacService.hasPermission(dynUser, PERMISSIONS.PURCHASING_READ, companyId);
    const pWrite = await rbacService.hasPermission(dynUser, PERMISSIONS.PURCHASING_WRITE, companyId);
    const pPost = await rbacService.hasPermission(dynUser, PERMISSIONS.PURCHASING_POST, companyId);
    const pAcc = await rbacService.hasPermission(dynUser, PERMISSIONS.ACCOUNTING_ACCOUNTS_READ, companyId);
    if (pRead && pWrite && !pPost && !pAcc) {
      console.log('R10 PASS: Dynamic role_id strictly enforces exact 2 assigned permissions');
      passed++;
    } else {
      console.error('R10 FAIL:', { pRead, pWrite, pPost, pAcc });
      failed++;
    }
  } catch (err) {
    console.error('R10 FAIL:', err);
    failed++;
  }

  // R11: invalidate(companyId) after changing role permissions -> next read reflects change
  try {
    const dynUser = { id: dynUserId, username: 'dyn', role: 'user' as const, isActive: true, createdAt: '' };
    // Prime cache (currently has PURCHASING_READ, PURCHASING_WRITE — NOT PURCHASING_POST)
    const beforeMutate = await rbacService.hasPermission(dynUser, PERMISSIONS.PURCHASING_POST, companyId);
    // Mutate underlying storage without invalidating -> cached value still returns false
    await fakeRepo.replacePermissions(customRole.id, [
      PERMISSIONS.PURCHASING_READ,
      PERMISSIONS.PURCHASING_WRITE,
      PERMISSIONS.PURCHASING_POST,
    ]);
    const cachedResult = await rbacService.hasPermission(dynUser, PERMISSIONS.PURCHASING_POST, companyId);
    // Now invalidate cache -> next read must reflect updated DB permissions (true)
    rbacService.invalidate(companyId);
    const afterInvalidate = await rbacService.hasPermission(dynUser, PERMISSIONS.PURCHASING_POST, companyId);

    if (!beforeMutate && !cachedResult && afterInvalidate) {
      console.log('R11 PASS: Cache hit confirmed before invalidate; invalidate(companyId) immediately reflects updated permissions');
      passed++;
    } else {
      console.error('R11 FAIL:', { beforeMutate, cachedResult, afterInvalidate });
      failed++;
    }
  } catch (err) {
    console.error('R11 FAIL:', err);
    failed++;
  }

  // R12: PERMISSION_CATALOG count matches PERMISSIONS values count (and covers all values)
  try {
    const permValues = Object.values(PERMISSIONS);
    const catalogCodes = new Set(PERMISSION_CATALOG.map((c) => c.code));
    const allCovered = permValues.every((p) => catalogCodes.has(p));
    if (PERMISSION_CATALOG.length === permValues.length && allCovered && ROLE_PERMISSIONS.company_admin.includes(PERMISSIONS.ROLES_WRITE) && !ROLE_PERMISSIONS.company_user.includes(PERMISSIONS.ROLES_READ)) {
      console.log(`R12 PASS: PERMISSION_CATALOG parity verified (${PERMISSION_CATALOG.length} === ${permValues.length})`);
      passed++;
    } else {
      console.error('R12 FAIL:', { catalogLen: PERMISSION_CATALOG.length, permLen: permValues.length, allCovered });
      failed++;
    }
  } catch (err) {
    console.error('R12 FAIL:', err);
    failed++;
  }

  // R13: UI files existence & wiring check
  try {
    const rolesPanelPath = path.resolve(process.cwd(), 'src/components/rbac/RolesPanel.tsx');
    const matrixPath = path.resolve(process.cwd(), 'src/components/rbac/PermissionMatrix.tsx');
    const sidebarPath = path.resolve(process.cwd(), 'src/components/shell/AppSidebar.tsx');
    const appPath = path.resolve(process.cwd(), 'src/App.tsx');
    const usersPath = path.resolve(process.cwd(), 'src/components/users/UsersAdminWorkspace.tsx');

    const rolesExists = fs.existsSync(rolesPanelPath) && fs.existsSync(matrixPath);
    const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');
    const appContent = fs.readFileSync(appPath, 'utf8');
    const usersContent = fs.readFileSync(usersPath, 'utf8');

    const ok =
      rolesExists &&
      sidebarContent.includes("'roles'") &&
      appContent.includes("'roles'") &&
      appContent.includes('RolesPanel') &&
      usersContent.includes('company_admin') &&
      usersContent.includes('/roles');

    if (ok) {
      console.log('R13 PASS: UI screens, sidebar nav, App routing, and UsersAdminWorkspace company_admin wiring verified');
      passed++;
    } else {
      console.error('R13 FAIL: Missing expected UI files or wiring');
      failed++;
    }
  } catch (err) {
    console.error('R13 FAIL:', err);
    failed++;
  }

  console.log(`Summary -> Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Unexpected error in verifyDynamicRoles5:', err);
  process.exit(1);
});
