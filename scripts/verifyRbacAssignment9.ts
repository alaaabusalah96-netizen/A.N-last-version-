import fs from 'node:fs';
import path from 'node:path';
import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { tenantContextStorage } from '../src/server/db/tenantContext.js';
import { DbExecutor } from '../src/server/db/types.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { MembershipRepository } from '../src/server/org/membershipRepository.js';
import { CompanyMembership, MembershipStore } from '../src/server/org/membershipStore.js';
import { PERMISSIONS } from '../src/server/rbac/permissions.js';
import { RbacService } from '../src/server/rbac/rbacService.js';
import { RoleRepository } from '../src/server/rbac/roleRepository.js';
import { RoleService } from '../src/server/rbac/roleService.js';
import { getTargetSystemRoleCodeForLegacyMembership, LEGACY_ROLE_TO_SYSTEM_CODE, ROLE_PERMISSIONS } from '../src/server/rbac/roles.js';
import { ValidationError } from '../src/server/http/errors.js';

class RollbackTestSentinel extends Error {
  constructor() {
    super('ROLLBACK_TEST_TRANSACTION');
  }
}

console.log('==================================================================');
console.log('=== VERIFYING AN-CI-RBAC-FIX-9 (Fail-Closed & Role Assignment) ===');
console.log('==================================================================');

async function run() {
  const root = process.cwd();

  // ---- Unit Isolation Check for R7 (always runnable, zero DB needed) ----
  const fakeCompanyId = '11111111-1111-4111-8111-111111111111';
  const fakeUserId = '22222222-2222-4222-8222-222222222222';
  const fakeRoleId = '33333333-3333-4333-8333-333333333333';

  const failingMembership: CompanyMembership = {
    id: '44444444-4444-4444-8444-444444444444',
    userId: fakeUserId,
    companyId: fakeCompanyId,
    role: 'company_admin', // High legacy privilege — fail-closed MUST NOT fall back to this when roleId is present!
    roleId: fakeRoleId,
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  const fakeMembershipStore = {
    async getMembership(uid: string, cid: string): Promise<CompanyMembership | null> {
      return uid === fakeUserId && cid === fakeCompanyId ? failingMembership : null;
    },
    async listByUser(uid: string): Promise<CompanyMembership[]> {
      return uid === fakeUserId ? [failingMembership] : [];
    },
  };

  const throwingRoleRepo = {
    async findById(): Promise<never> {
      throw new Error('SIMULATED_DB_OUTAGE_ROLE_LOOKUP');
    },
    async listPermissions(): Promise<never> {
      throw new Error('SIMULATED_DB_OUTAGE_PERM_LOOKUP');
    },
  };

  const unitTx: DbExecutor = {
    query: async () => ({ rows: [], rowCount: 0 }),
    withTransaction: async <T>(fn: (tx: DbExecutor) => Promise<T>) => fn(unitTx),
    health: async () => ({ ok: true }),
    close: async () => undefined,
  };

  const isolatedRbac = new RbacService(
    fakeMembershipStore as unknown as MembershipStore,
    throwingRoleRepo as unknown as RoleRepository,
    async <T>(_cid: string, fn: (ex: DbExecutor) => Promise<T>) => fn(unitTx)
  );

  const unitUser = {
    id: fakeUserId,
    username: 'fail_closed_probe',
    role: 'user' as const,
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  let r7NoThrow = true;
  let r7CompanyRead = true;
  let r7RolesWrite = true;
  let r7ResolvedPermsLen = -1;
  try {
    r7CompanyRead = await isolatedRbac.hasPermission(unitUser, PERMISSIONS.COMPANY_READ, fakeCompanyId);
    r7RolesWrite = await isolatedRbac.hasPermission(unitUser, PERMISSIONS.ROLES_WRITE, fakeCompanyId);
    const directPerms = await isolatedRbac.resolveMembershipPermissions(unitUser.id, failingMembership);
    r7ResolvedPermsLen = directPerms.length;
  } catch (err) {
    r7NoThrow = false;
    console.error('R7 unexpected exception:', err);
  }

  await check(
    'R7: Direct unit isolation — role_id present + failing role lookup returns [] / hasPermission=false (fail-closed, zero throw, no static fallback)',
    r7NoThrow && !r7CompanyRead && !r7RolesWrite && r7ResolvedPermsLen === 0
  );

  // ---- Static wiring checks for WP-4 (/me route), WP-5 (API + UI), WP-6 (conversion map) ----
  const authRoutesSrc = fs.readFileSync(path.join(root, 'src/server/routes/authRoutes.ts'), 'utf8');
  const roleRoutesSrc = fs.readFileSync(path.join(root, 'src/server/routes/roleRoutes.ts'), 'utf8');
  const usersWsSrc = fs.readFileSync(path.join(root, 'src/components/users/UsersAdminWorkspace.tsx'), 'utf8');

  await check(
    'W4-ME: authRoutes /me delegates active membership permissions to rbacService.resolveMembershipPermissions',
    authRoutesSrc.includes('resolveMembershipPermissions')
  );

  await check(
    'W5-API: roleRoutes mounts PUT /members/:userId/role and GET /members with USER_WRITE/USER_READ & userCanWrite',
    roleRoutesSrc.includes("'/members/:userId/role'") &&
      roleRoutesSrc.includes("'/members'") &&
      roleRoutesSrc.includes('PERMISSIONS.USER_WRITE') &&
      roleRoutesSrc.includes('userCanWrite')
  );

  await check(
    'W5-UI: UsersAdminWorkspace implements role assignment modal, compatibility option, empty/loading states, and userCanWrite gate',
    usersWsSrc.includes('/members/${assignRoleUser.id}/role') &&
      usersWsSrc.includes('تعيين الدور') &&
      usersWsSrc.includes('دور ثابت قديم (توافق)') &&
      usersWsSrc.includes('لا توجد أدوار ديناميكية — أنشئ دورًا من شاشة الأدوار') &&
      usersWsSrc.includes('userCanWrite')
  );

  await check(
    'W6-MAP: LEGACY_ROLE_TO_SYSTEM_CODE and getTargetSystemRoleCodeForLegacyMembership preserve exact parity map',
    LEGACY_ROLE_TO_SYSTEM_CODE.company_admin === 'company_admin' &&
      LEGACY_ROLE_TO_SYSTEM_CODE.company_user === 'company_user' &&
      getTargetSystemRoleCodeForLegacyMembership('platform_admin') === null
  );

  // ---- Loopback PostgreSQL Behavioral Proofs (R1 - R12) ----
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. R1-R6 & R8-R12 loopback PostgreSQL behavioral tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(dbUrl);
  } catch {
    blocked('DATABASE_URL is invalid URL format. R1-R6 & R8-R12 behavioral tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname)) {
    blocked(`DATABASE_URL host '${parsedUrl.hostname}' is not loopback. Refusing destructive test run.`);
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Unable to connect to database executor. R1-R6 & R8-R12 behavioral tests are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  let companyAId: string | null = null;
  let companyBId: string | null = null;
  const createdUserIds: string[] = [];

  try {
    await executor.withTransaction(async (outerTx: DbExecutor) => {
      let spCounter = 0;
      const runInTenant = async <T>(cid: string, fn: () => Promise<T>): Promise<T> => {
        const sp = `sp_rbac_${++spCounter}`;
        await outerTx.query(`SAVEPOINT ${sp}`);
        try {
          await outerTx.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [cid]);
          const res = await tenantContextStorage.run({ companyId: cid, executor: outerTx }, fn);
          await outerTx.query(`RELEASE SAVEPOINT ${sp}`);
          return res;
        } catch (err) {
          await outerTx.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await outerTx.query(`RELEASE SAVEPOINT ${sp}`);
          throw err;
        }
      };

      const txTenantRunner = async <T>(cid: string, fn: (tx: DbExecutor) => Promise<T>): Promise<T> => {
        return await runInTenant(cid, () => fn(outerTx));
      };

      const companyRepo = new CompanyRepository();
      const membershipRepo = new MembershipRepository();
      const membershipStore = new MembershipStore(membershipRepo);
      const roleRepo = new RoleRepository();
      const rbacService = new RbacService(membershipStore, roleRepo, txTenantRunner);
      const roleService = new RoleService(
        roleRepo,
        (cid, uid) => rbacService.invalidate(cid, uid),
        txTenantRunner,
        membershipRepo
      );

      const compA = await companyRepo.create(
        {
          code: `RBAC_A_${suffix}`,
          nameAr: `شركة أدوار أ ${suffix}`,
          createdBy: null,
        },
        outerTx
      );
      companyAId = compA.id;

      const compB = await companyRepo.create(
        {
          code: `RBAC_B_${suffix}`,
          nameAr: `شركة أدوار ب ${suffix}`,
          createdBy: null,
        },
        outerTx
      );
      companyBId = compB.id;

      const insertUser = async (uname: string, sysRole: 'user' | 'platform_admin' = 'user') => {
        const uRes = await outerTx.query<{
          id: string;
          username: string;
          role: 'user' | 'platform_admin';
          isActive: boolean;
          createdAt: string;
        }>(
          `INSERT INTO platform_users (username, password_hash, role, is_active)
           VALUES ($1, $2, $3, true)
           RETURNING id, username, role, is_active as "isActive", created_at as "createdAt"`,
          [uname, 'dummy_hash_rbac_assignment_9', sysRole]
        );
        const userRow = uRes.rows[0];
        createdUserIds.push(userRow.id);
        return userRow;
      };

      const adminActor = await insertUser(`rbac_admin_${suffix}`, 'platform_admin');
      const dynUser = await insertUser(`rbac_dyn_user_${suffix}`, 'user');
      const legacyUser = await insertUser(`rbac_legacy_user_${suffix}`, 'user');

      // R1: إنشاء دور ديناميكي بصلاحية واحدة عبر الخدمة -> ينجح
      const role1 = await roleService.createRole(
        companyAId,
        {
          code: `purch_reader_${suffix.replace(/[^a-z0-9_]/gi, '_')}`.toLowerCase(),
          nameAr: 'قارئ مشتريات',
          orgLevel: 'company',
        },
        adminActor.id
      );
      const role1Perms = await roleService.setPermissions(
        companyAId,
        role1.id,
        [PERMISSIONS.PURCHASING_READ],
        adminActor.id,
        'platform_admin'
      );
      await check(
        'R1: createRole + setPermissions with single permission succeeds',
        Boolean(role1.id) && role1Perms.length === 1 && role1Perms[0] === PERMISSIONS.PURCHASING_READ
      );

      // R2: addMember بـ roleId -> role_id محفوظ فعليًا (قراءة مرجعة)
      await membershipStore.addMember(dynUser.id, companyAId, 'company_user', true, role1.id, outerTx);
      const readBackMembership = await membershipStore.getMembership(dynUser.id, companyAId, outerTx);
      await check(
        'R2: addMember persists role_id and read-back confirms roleId matches role1.id',
        Boolean(readBackMembership && readBackMembership.roleId === role1.id)
      );

      // R3: المستخدم يملك صلاحية الدور بعد التعيين مباشرة -> hasPermission=true
      const r3HasRead = await rbacService.hasPermission(dynUser, PERMISSIONS.PURCHASING_READ, companyAId);
      const r3HasWrite = await rbacService.hasPermission(dynUser, PERMISSIONS.PURCHASING_WRITE, companyAId);
      await check(
        'R3: User holds exact permission of assigned role immediately (PURCHASING_READ=true, PURCHASING_WRITE=false)',
        r3HasRead === true && r3HasWrite === false
      );

      // R4: تغيير الدور لدور آخر -> الصلاحيات الجديدة فقط تنعكس فورًا (بلا انتظار TTL)
      const role2 = await roleService.createRole(
        companyAId,
        {
          code: `inv_reader_${suffix.replace(/[^a-z0-9_]/gi, '_')}`.toLowerCase(),
          nameAr: 'قارئ مخزون',
          orgLevel: 'branch',
        },
        adminActor.id
      );
      await roleService.setPermissions(
        companyAId,
        role2.id,
        [PERMISSIONS.INVENTORY_READ],
        adminActor.id,
        'platform_admin'
      );
      await roleService.assignRole(companyAId, dynUser.id, role2.id, adminActor.id);
      const r4HasOldPerm = await rbacService.hasPermission(dynUser, PERMISSIONS.PURCHASING_READ, companyAId);
      const r4HasNewPerm = await rbacService.hasPermission(dynUser, PERMISSIONS.INVENTORY_READ, companyAId);
      await check(
        'R4: Reassigning role via assignRole reflects new permissions immediately without waiting for TTL',
        r4HasOldPerm === false && r4HasNewPerm === true
      );

      // R5: assignRole بـ roleId من شركة أخرى -> ValidationError صريح «شركة أخرى»
      const roleCompB = await roleService.createRole(
        companyBId,
        {
          code: `other_role_${suffix.replace(/[^a-z0-9_]/gi, '_')}`.toLowerCase(),
          nameAr: 'دور شركة أخرى',
          orgLevel: 'company',
        },
        adminActor.id
      );
      let r5ThrewValidation = false;
      let r5MentionsOtherCompany = false;
      try {
        await roleService.assignRole(companyAId, dynUser.id, roleCompB.id, adminActor.id);
      } catch (err: any) {
        r5ThrewValidation = err instanceof ValidationError;
        r5MentionsOtherCompany = typeof err?.message === 'string' && err.message.includes('شركة أخرى');
      }
      await check(
        'R5: assignRole with roleId belonging to another company throws explicit ValidationError mentioning شركة أخرى',
        r5ThrewValidation && r5MentionsOtherCompany
      );

      // R6: تعيين دور غير نشط -> ValidationError
      const inactiveRole = await roleService.createRole(
        companyAId,
        {
          code: `inactive_role_${suffix.replace(/[^a-z0-9_]/gi, '_')}`.toLowerCase(),
          nameAr: 'دور معطل',
          orgLevel: 'company',
        },
        adminActor.id
      );
      await roleService.setActive(companyAId, inactiveRole.id, false, adminActor.id);
      let r6ThrewValidation = false;
      try {
        await roleService.assignRole(companyAId, dynUser.id, inactiveRole.id, adminActor.id);
      } catch (err) {
        r6ThrewValidation = err instanceof ValidationError;
      }
      await check(
        'R6: assignRole with inactive role rejects with ValidationError',
        r6ThrewValidation
      );

      // R8: عضوية بلا role_id (توافق) -> تعمل وفق ROLE_PERMISSIONS كما قبل
      await membershipStore.addMember(legacyUser.id, companyAId, 'company_user', true, outerTx);
      const legacyBefore = await membershipStore.getMembership(legacyUser.id, companyAId, outerTx);
      const r8CanAccRead = await rbacService.hasPermission(legacyUser, PERMISSIONS.ACCOUNTING_ACCOUNTS_READ, companyAId);
      const r8CanInvWrite = await rbacService.hasPermission(legacyUser, PERMISSIONS.INVENTORY_WRITE, companyAId);
      await check(
        'R8: Legacy membership (role_id IS NULL) resolves strictly via ROLE_PERMISSIONS[company_user]',
        legacyBefore?.roleId === null && r8CanAccRead === true && r8CanInvWrite === false
      );

      // R9: audit_log مكتوب لتغيير الدور -> صف واحد بالتغيير (من -> إلى)
      const auditRes = await runInTenant(companyAId, () =>
        outerTx.query<{ action: string; metadata: any }>(
          `SELECT action, metadata FROM audit_logs
           WHERE company_id = $1 AND entity_id = $2 AND action = 'membership.role.assign'`,
          [companyAId, readBackMembership!.id]
        )
      );
      const auditRow = auditRes.rows[0];
      await check(
        'R9: audit_logs recorded single membership.role.assign row capturing fromRoleId -> toRoleId',
        auditRes.rows.length === 1 &&
          auditRow?.metadata?.fromRoleId === role1.id &&
          auditRow?.metadata?.toRoleId === role2.id
      );

      // R10: تحويل صريح لعضوية قديمة وفق خريطة WP-6 -> صلاحيات = الدور النظامي المقابل، لا زيادة ولا نقصان
      const beforeConvertPerms = new Set(await rbacService.resolveMembershipPermissions(legacyUser.id, legacyBefore!));
      const { membership: convertedMembership, role: mappedSysRole } = await roleService.convertLegacyMembership(
        companyAId,
        legacyUser.id,
        adminActor.id
      );
      const afterConvertPerms = new Set(
        await rbacService.resolveMembershipPermissions(legacyUser.id, convertedMembership)
      );
      const staticExpected = new Set(ROLE_PERMISSIONS.company_user);
      const exactParity =
        beforeConvertPerms.size === staticExpected.size &&
        afterConvertPerms.size === staticExpected.size &&
        [...afterConvertPerms].every((p) => beforeConvertPerms.has(p)) &&
        convertedMembership.roleId === mappedSysRole.id &&
        mappedSysRole.code === 'company_user';
      await check(
        'R10: Explicit convertLegacyMembership binds company_user system role with zero permission gain/loss',
        exactParity
      );

      // R12: فحص الأدوار عبر استعلام من شركة أخرى كمستخدم تطبيقي -> صفر صفوف (RLS)
      const rlsCount = await runInTenant(companyBId, async () => {
        const roleInfo = await outerTx.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        );
        if (roleInfo.rows[0] && (roleInfo.rows[0].rolsuper || roleInfo.rows[0].rolbypassrls)) {
          await outerTx.query(`SET LOCAL ROLE an_app`);
        }
        const res = await outerTx.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM roles WHERE id = $1`,
          [role1.id]
        );
        return Number(res.rows[0]?.cnt ?? -1);
      });
      await check(
        'R12: Querying roles under Company B tenant context hides Company A roles (0 rows via RLS)',
        rlsCount === 0
      );

      // Roll back the entire transaction cleanly
      throw new RollbackTestSentinel();
    });
  } catch (err) {
    if (!(err instanceof RollbackTestSentinel)) {
      await check(
        'Unhandled exception during verifyRbacAssignment9 DB tests',
        false,
        err instanceof Error ? err.message : String(err)
      );
    }
  } finally {
    // R11: تنظيف كامل في finally -> كل الصفوف المنشأة محذوفة (عدّ = 0)
    try {
      const companyIds = ([companyAId, companyBId] as Array<string | null>).filter((id): id is string => Boolean(id));
      let remaining = 0;
      if (companyIds.length > 0) {
        const compCount = await executor.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM companies WHERE id = ANY($1::uuid[])`,
          [companyIds]
        );
        remaining += Number(compCount.rows[0]?.cnt || 0);

        const auditCount = await executor.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM audit_logs WHERE company_id = ANY($1::uuid[])`,
          [companyIds]
        );
        remaining += Number(auditCount.rows[0]?.cnt || 0);
      }
      if (createdUserIds.length > 0) {
        const userCount = await executor.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM platform_users WHERE id = ANY($1::uuid[])`,
          [createdUserIds]
        );
        remaining += Number(userCount.rows[0]?.cnt || 0);
      }
      await check(
        'R11: Full cleanup in finally confirmed 0 leftover rows across companies, platform_users, and audit_logs',
        remaining === 0,
        `remaining=${remaining}`
      );
    } catch (cleanupErr) {
      await check(
        'R11 cleanup verification error',
        false,
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      );
    }
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
