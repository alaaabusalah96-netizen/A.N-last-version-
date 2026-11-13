import fs from 'node:fs';
import path from 'node:path';
import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { tenantContextStorage } from '../src/server/db/tenantContext.js';
import { DbExecutor } from '../src/server/db/types.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { MembershipRepository } from '../src/server/org/membershipRepository.js';
import { MembershipStore } from '../src/server/org/membershipStore.js';
import { AuditRepository } from '../src/server/audit/auditRepository.js';
import { AuditService } from '../src/server/audit/auditService.js';
import { RbacService } from '../src/server/rbac/rbacService.js';
import { RoleRepository } from '../src/server/rbac/roleRepository.js';
import { RoleService } from '../src/server/rbac/roleService.js';
import { UserAdminService } from '../src/server/identity/userAdminService.js';
import { ValidationError } from '../src/server/http/errors.js';

class RollbackTestSentinel extends Error {
  constructor() {
    super('ROLLBACK_TEST_TRANSACTION');
  }
}

console.log('=========================================================================');
console.log('=== VERIFYING AN-FIX-USER-CREATION-ATOMIC-12 (User Creation Atomicity) ===');
console.log('=========================================================================');

async function run() {
  const root = process.cwd();

  // U5: Battery & package.json registration check
  const batterySrc = fs.readFileSync(path.join(root, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const hasPkgScript = Object.entries(pkgJson.scripts || {}).some(
    ([k, v]) => k.startsWith('test:') && typeof v === 'string' && v.includes('verifyUserCreationAtomicity1.ts')
  );
  await check(
    'U5: verifyUserCreationAtomicity1.ts is registered in runFoundationBattery.ts and package.json',
    batterySrc.includes('scripts/verifyUserCreationAtomicity1.ts') && hasPkgScript
  );

  // ---- Loopback PostgreSQL Behavioral Proofs (U1 - U4) ----
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. U1-U4 loopback PostgreSQL atomicity proofs are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(dbUrl);
  } catch {
    blocked('DATABASE_URL is invalid URL format. U1-U4 atomicity proofs are BLOCKED.');
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
    blocked('Unable to connect to database executor. U1-U4 atomicity proofs are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  let companyId: string | null = null;
  let actorId: string | null = null;

  try {
    await executor.withTransaction(async (outerTx: DbExecutor) => {
      let spCounter = 0;
      const txTenantRunner = async <T>(cid: string, fn: (tx: DbExecutor) => Promise<T>): Promise<T> => {
        const sp = `sp_atom_${++spCounter}`;
        await outerTx.query(`SAVEPOINT ${sp}`);
        try {
          await outerTx.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [cid]);
          const res = await tenantContextStorage.run({ companyId: cid, executor: outerTx }, () => fn(outerTx));
          await outerTx.query(`RELEASE SAVEPOINT ${sp}`);
          return res;
        } catch (err) {
          await outerTx.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await outerTx.query(`RELEASE SAVEPOINT ${sp}`);
          throw err;
        }
      };

      const txGlobalRunner = async <T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> => {
        const sp = `sp_global_${++spCounter}`;
        await outerTx.query(`SAVEPOINT ${sp}`);
        try {
          const res = await fn(outerTx);
          await outerTx.query(`RELEASE SAVEPOINT ${sp}`);
          return res;
        } catch (err) {
          await outerTx.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await outerTx.query(`RELEASE SAVEPOINT ${sp}`);
          throw err;
        }
      };

      const companyRepo = new CompanyRepository();
      const comp = await companyRepo.create(
        {
          code: `ATOM_${suffix}`,
          nameAr: `شركة ذرية ${suffix}`,
          createdBy: null,
        },
        outerTx
      );
      companyId = comp.id;

      const userRepo = new UserRepository();
      const actorRow = await userRepo.createUser(
        {
          username: `atom_actor_${suffix}`,
          passwordHash: 'dummy_hash_actor_12',
          role: 'platform_admin',
        },
        outerTx
      );
      actorId = actorRow.id;
      const actor = {
        id: actorRow.id,
        username: actorRow.username,
        role: actorRow.role,
        isActive: actorRow.isActive,
        createdAt: actorRow.createdAt,
      };

      const membershipRepo = new MembershipRepository();
      const membershipStore = new MembershipStore(membershipRepo);
      const auditService = new AuditService(new AuditRepository());
      const roleRepo = new RoleRepository();
      const rbacService = new RbacService(membershipStore, roleRepo, txTenantRunner);
      const roleService = new RoleService(roleRepo, (cid, uid) => rbacService.invalidate(cid, uid), txTenantRunner, membershipRepo);

      const userAdminService = new UserAdminService(
        userRepo,
        membershipStore,
        auditService,
        rbacService,
        roleService,
        txTenantRunner,
        txGlobalRunner
      );

      // U1: Create user with membership and audit succeeds (3 rows; global platform_users write works with tenant set_config)
      const u1Username = `atom_u1_${suffix}`;
      const u1User = await userAdminService.createUser(actor, {
        username: u1Username,
        passwordHash: 'dummy_hash_u1_12',
        companyId,
        role: 'company_user',
      });
      const u1Users = await outerTx.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM platform_users WHERE id = $1`,
        [u1User.id]
      );
      const u1Mems = await outerTx.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM company_memberships WHERE user_id = $1 AND company_id = $2`,
        [u1User.id, companyId]
      );
      const u1Audits = await txTenantRunner(companyId, () =>
        outerTx.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM audit_logs WHERE company_id = $1 AND entity_id = $2 AND action = 'USER_CREATE'`,
          [companyId, u1User.id]
        )
      );
      await check(
        'U1: createUser creates user + membership + audit atomically (3 rows; tenant set_config allows global platform_users write)',
        Number(u1Users.rows[0]?.cnt) === 1 &&
          Number(u1Mems.rows[0]?.cnt) === 1 &&
          Number(u1Audits.rows[0]?.cnt) === 1
      );

      // U2: Simulated membership failure -> 0 user + 0 membership + 0 audit
      const u2Username = `atom_u2_${suffix}`;
      const failingMembershipStore = new MembershipStore(membershipRepo);
      failingMembershipStore.addMember = async () => {
        throw new Error('SIMULATED_MEMBERSHIP_FAILURE');
      };
      const u2Service = new UserAdminService(
        userRepo,
        failingMembershipStore,
        auditService,
        rbacService,
        roleService,
        txTenantRunner,
        txGlobalRunner
      );
      let u2Threw = false;
      try {
        await u2Service.createUser(actor, {
          username: u2Username,
          passwordHash: 'dummy_hash_u2_12',
          companyId,
          role: 'company_user',
        });
      } catch (err: any) {
        u2Threw = err?.message === 'SIMULATED_MEMBERSHIP_FAILURE';
      }
      const u2Users = await outerTx.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM platform_users WHERE username = $1`,
        [u2Username]
      );
      const u2Mems = await outerTx.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM company_memberships WHERE company_id = $1 AND user_id <> $2`,
        [companyId, u1User.id]
      );
      const u2Audits = await txTenantRunner(companyId, () =>
        outerTx.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM audit_logs WHERE company_id = $1 AND action = 'USER_CREATE' AND metadata->>'username' = $2`,
          [companyId, u2Username]
        )
      );
      await check(
        'U2: Simulated membership failure rolls back cleanly -> 0 users + 0 memberships + 0 audits',
        u2Threw &&
          Number(u2Users.rows[0]?.cnt) === 0 &&
          Number(u2Mems.rows[0]?.cnt) === 0 &&
          Number(u2Audits.rows[0]?.cnt) === 0
      );

      // U3: Simulated required audit failure -> rollback covers both user and membership
      const u3Username = `atom_u3_${suffix}`;
      const failingAuditRepo = {
        async log(): Promise<never> {
          throw new Error('SIMULATED_AUDIT_OUTAGE');
        },
      } as unknown as AuditRepository;
      const u3AuditService = new AuditService(failingAuditRepo);
      const u3Service = new UserAdminService(
        userRepo,
        membershipStore,
        u3AuditService,
        rbacService,
        roleService,
        txTenantRunner,
        txGlobalRunner
      );
      let u3Threw = false;
      try {
        await u3Service.createUser(actor, {
          username: u3Username,
          passwordHash: 'dummy_hash_u3_12',
          companyId,
          role: 'company_user',
        });
      } catch (err: any) {
        u3Threw = err?.message === 'SIMULATED_AUDIT_OUTAGE';
      }
      const u3Users = await outerTx.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM platform_users WHERE username = $1`,
        [u3Username]
      );
      const u3Mems = await outerTx.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM company_memberships WHERE company_id = $1 AND user_id <> $2`,
        [companyId, u1User.id]
      );
      const u3Audits = await txTenantRunner(companyId, () =>
        outerTx.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM audit_logs WHERE company_id = $1 AND action = 'USER_CREATE' AND metadata->>'username' = $2`,
          [companyId, u3Username]
        )
      );
      await check(
        'U3: Simulated required audit failure rolls back both user and membership -> 0 rows',
        u3Threw &&
          Number(u3Users.rows[0]?.cnt) === 0 &&
          Number(u3Mems.rows[0]?.cnt) === 0 &&
          Number(u3Audits.rows[0]?.cnt) === 0
      );

      // U4: Duplicate username -> 23505 -> ValidationError, no partial rows
      let u4ValidationErr = false;
      let u4MsgOk = false;
      try {
        await userAdminService.createUser(actor, {
          username: u1Username,
          passwordHash: 'dummy_hash_u4_12',
          companyId,
          role: 'company_user',
        });
      } catch (err: any) {
        u4ValidationErr = err instanceof ValidationError;
        u4MsgOk = typeof err?.message === 'string' && err.message.includes('المستخدم موجود مسبقًا');
      }
      const u4Users = await outerTx.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM platform_users WHERE username = $1`,
        [u1Username]
      );
      const u4Mems = await outerTx.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM company_memberships WHERE company_id = $1`,
        [companyId]
      );
      const u4Audits = await txTenantRunner(companyId, () =>
        outerTx.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM audit_logs WHERE company_id = $1 AND action = 'USER_CREATE'`,
          [companyId]
        )
      );
      await check(
        'U4: Duplicate username raises 23505 -> ValidationError with zero partial rows',
        u4ValidationErr &&
          u4MsgOk &&
          Number(u4Users.rows[0]?.cnt) === 1 &&
          Number(u4Mems.rows[0]?.cnt) === 1 &&
          Number(u4Audits.rows[0]?.cnt) === 1
      );

      throw new RollbackTestSentinel();
    });
  } catch (err) {
    if (!(err instanceof RollbackTestSentinel)) {
      await check(
        'Unhandled exception during verifyUserCreationAtomicity1 DB tests',
        false,
        err instanceof Error ? err.message : String(err)
      );
    }
  } finally {
    try {
      let remaining = 0;
      if (companyId) {
        const compCnt = await executor.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM companies WHERE id = $1`,
          [companyId]
        );
        remaining += Number(compCnt.rows[0]?.cnt || 0);

        const memCnt = await executor.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM company_memberships WHERE company_id = $1`,
          [companyId]
        );
        remaining += Number(memCnt.rows[0]?.cnt || 0);
      }
      if (actorId) {
        const usrCnt = await executor.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM platform_users WHERE id = $1`,
          [actorId]
        );
        remaining += Number(usrCnt.rows[0]?.cnt || 0);
      }
      if (remaining > 0) {
        await check('Rollback cleanup left leftover rows', false, `remaining=${remaining}`);
      }
    } catch (cleanupErr) {
      await check(
        'Cleanup verification error in finally block',
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
