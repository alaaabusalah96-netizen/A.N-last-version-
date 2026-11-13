import fs from 'node:fs';
import path from 'node:path';
import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor } from '../src/server/db/index.js';
import { tenantContextStorage } from '../src/server/db/tenantContext.js';
import { DbExecutor, QueryResult } from '../src/server/db/types.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { MembershipRepository } from '../src/server/org/membershipRepository.js';
import { RoleRepository } from '../src/server/rbac/roleRepository.js';
import { RoleService } from '../src/server/rbac/roleService.js';
import { PERMISSIONS } from '../src/server/rbac/permissions.js';
import { AuditUnavailableError } from '../src/server/http/errors.js';

class RollbackTestSentinel extends Error {
  constructor() {
    super('ROLLBACK_TEST_TRANSACTION');
  }
}

class AuditFailingExecutor implements DbExecutor {
  constructor(private inner: DbExecutor) {}

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    if (/INSERT\s+INTO\s+audit_logs/i.test(sql)) {
      throw new Error('SIMULATED_AUDIT_WRITE_FAILURE');
    }
    return await this.inner.query<T>(sql, params);
  }

  async withTransaction<T>(fn: (ex: DbExecutor) => Promise<T>): Promise<T> {
    return await fn(this);
  }

  async health() {
    return await this.inner.health();
  }

  async close() {
    return await this.inner.close();
  }
}

console.log('====================================================================');
console.log('=== VERIFYING AN-FIX-AUDIT-GOVERNANCE-13 (Audit Governance Policy) ===');
console.log('====================================================================');

async function run() {
  const root = process.cwd();

  // A1 (static): No mode: 'best_effort' in roleService.ts + battery/package registration
  const roleServiceSrc = fs.readFileSync(path.join(root, 'src/server/rbac/roleService.ts'), 'utf8');
  const batterySrc = fs.readFileSync(path.join(root, 'scripts/runFoundationBattery.ts'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  const bestEffortMatches = roleServiceSrc.match(/best_effort/g) || [];
  const requiredMatches = roleServiceSrc.match(/mode:\s*'required',\s*executor:\s*tx/g) || [];
  const registeredInBattery = batterySrc.includes('scripts/verifyAuditGovernance1.ts');
  const registeredInPkg =
    typeof pkgJson?.scripts?.['test:audit-governance-1'] === 'string' &&
    pkgJson.scripts['test:audit-governance-1'].includes('verifyAuditGovernance1.ts');

  await check(
    'A1 (static): roleService.ts has 0 best_effort audit calls (6 required inside tx) and script is registered',
    bestEffortMatches.length === 0 && requiredMatches.length >= 6 && registeredInBattery && registeredInPkg,
    `best_effort=${bestEffortMatches.length}, required=${requiredMatches.length}`
  );

  // ---- Loopback PostgreSQL Behavioral Proofs (A2 - A5) ----
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. A2-A5 loopback PostgreSQL audit governance proofs are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(dbUrl);
  } catch {
    blocked('DATABASE_URL is invalid URL format. A2-A5 audit governance proofs are BLOCKED.');
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
    blocked('Unable to connect to database executor. A2-A5 audit governance proofs are BLOCKED.');
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
      const runWithSavepoint = async <T>(
        cid: string,
        txToPass: DbExecutor,
        fn: (tx: DbExecutor) => Promise<T>
      ): Promise<T> => {
        const sp = `sp_audit_${++spCounter}`;
        await outerTx.query(`SAVEPOINT ${sp}`);
        try {
          await outerTx.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [cid]);
          const res = await tenantContextStorage.run({ companyId: cid, executor: txToPass }, () => fn(txToPass));
          await outerTx.query(`RELEASE SAVEPOINT ${sp}`);
          return res;
        } catch (err) {
          await outerTx.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await outerTx.query(`RELEASE SAVEPOINT ${sp}`);
          throw err;
        }
      };

      const txTenantRunner = <T>(cid: string, fn: (tx: DbExecutor) => Promise<T>) =>
        runWithSavepoint(cid, outerTx, fn);

      const failingTenantRunner = <T>(cid: string, fn: (tx: DbExecutor) => Promise<T>) =>
        runWithSavepoint(cid, new AuditFailingExecutor(outerTx), fn);

      const companyRepo = new CompanyRepository();
      const comp = await companyRepo.create(
        {
          code: `AUD_${suffix}`,
          nameAr: `شركة تدقيق ${suffix}`,
          createdBy: null,
        },
        outerTx
      );
      companyId = comp.id;

      const uRes = await outerTx.query<{ id: string }>(
        `INSERT INTO platform_users (username, password_hash, role, is_active)
         VALUES ($1, $2, 'platform_admin', true)
         RETURNING id`,
        [`audit_actor_${suffix}`, 'dummy_hash_audit_13']
      );
      actorId = uRes.rows[0].id;

      const roleRepo = new RoleRepository();
      const membershipRepo = new MembershipRepository();
      const roleService = new RoleService(roleRepo, () => undefined, txTenantRunner, membershipRepo);
      const failingRoleService = new RoleService(roleRepo, () => undefined, failingTenantRunner, membershipRepo);

      const safeCode = suffix.replace(/[^a-z0-9_]/gi, '_').toLowerCase();

      // A2 (live): Creating role inside tx succeeds and writes role.create audit row
      const roleCodeA2 = `gov_role_${safeCode}`;
      const createdA2 = await roleService.createRole(
        companyId,
        { code: roleCodeA2, nameAr: 'دور حوكمة التدقيق', orgLevel: 'company' },
        actorId
      );
      const a2AuditRes = await txTenantRunner(companyId, (tx) =>
        tx.query<{ action: string }>(
          `SELECT action FROM audit_logs
           WHERE company_id = $1 AND entity_id = $2 AND action = 'role.create'`,
          [companyId, createdA2.id]
        )
      );
      await check(
        'A2 (live): createRole succeeds inside transaction and records role.create in audit_logs',
        Boolean(createdA2.id) && a2AuditRes.rows.length === 1
      );

      // A3 (live): Deliberate audit failure via AuditFailingExecutor subclass -> operation rejected & rolled back (no role without audit)
      const roleCodeA3 = `gov_fail_${safeCode}`;
      let a3CreateErr: unknown = null;
      try {
        await failingRoleService.createRole(
          companyId,
          { code: roleCodeA3, nameAr: 'دور يجب تراجعه', orgLevel: 'company' },
          actorId
        );
      } catch (err) {
        a3CreateErr = err;
      }

      let a3DeactivateErr: unknown = null;
      try {
        await failingRoleService.setActive(companyId, createdA2.id, false, actorId);
      } catch (err) {
        a3DeactivateErr = err;
      }

      const a3RoleCheck = await txTenantRunner(companyId, (tx) =>
        tx.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM roles WHERE company_id = $1 AND code = $2`,
          [companyId, roleCodeA3]
        )
      );
      const a3AuditCheck = await txTenantRunner(companyId, (tx) =>
        tx.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM audit_logs WHERE company_id = $1 AND metadata->>'code' = $2`,
          [companyId, roleCodeA3]
        )
      );
      const a2StillActive = await txTenantRunner(companyId, (tx) => roleRepo.findById(companyId!, createdA2.id, tx));

      await check(
        'A3 (live): Audit failure via injected failing executor aborts and rolls back role.create and role.set_active (no un-audited mutations)',
        a3CreateErr instanceof AuditUnavailableError &&
          a3CreateErr.internalDetail?.includes('SIMULATED_AUDIT_WRITE_FAILURE') === true &&
          a3DeactivateErr instanceof AuditUnavailableError &&
          Number(a3RoleCheck.rows[0]?.cnt) === 0 &&
          Number(a3AuditCheck.rows[0]?.cnt) === 0 &&
          a2StillActive?.isActive === true
      );

      // A4 (live): Zero duplicate audit rows — 1 row per operation (create, update, permissions.set, set_active)
      await roleService.updateRole(companyId, createdA2.id, { nameAr: 'دور حوكمة محدّث' }, actorId);
      await roleService.setPermissions(companyId, createdA2.id, [PERMISSIONS.ACCOUNTING_ACCOUNTS_READ], actorId, 'platform_admin');
      await roleService.setActive(companyId, createdA2.id, false, actorId);

      const actionCountsRes = await txTenantRunner(companyId, (tx) =>
        tx.query<{ action: string; cnt: number }>(
          `SELECT action, count(*)::int AS cnt
           FROM audit_logs
           WHERE company_id = $1 AND entity_id = $2
           GROUP BY action`,
          [companyId, createdA2.id]
        )
      );
      const counts = new Map(actionCountsRes.rows.map((r) => [r.action, Number(r.cnt)]));
      await check(
        'A4 (live): Exactly 1 audit row per sensitive operation (role.create, role.update, role.permissions.set, role.set_active)',
        counts.get('role.create') === 1 &&
          counts.get('role.update') === 1 &&
          counts.get('role.permissions.set') === 1 &&
          counts.get('role.set_active') === 1 &&
          actionCountsRes.rows.length === 4
      );

      throw new RollbackTestSentinel();
    });
  } catch (err) {
    if (!(err instanceof RollbackTestSentinel)) {
      await check(
        'Unhandled exception during verifyAuditGovernance1 DB tests',
        false,
        err instanceof Error ? err.message : String(err)
      );
    }
  } finally {
    // A5: Full rollback leaves 0 leftover rows
    try {
      let remaining = 0;
      if (companyId) {
        const compCnt = await executor.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM companies WHERE id = $1`,
          [companyId]
        );
        remaining += Number(compCnt.rows[0]?.cnt || 0);
      }
      if (actorId) {
        const usrCnt = await executor.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM platform_users WHERE id = $1`,
          [actorId]
        );
        remaining += Number(usrCnt.rows[0]?.cnt || 0);
      }
      await check(
        'A5: Transaction rollback left 0 leftover rows across companies and platform_users',
        remaining === 0,
        `remaining=${remaining}`
      );
    } catch (cleanupErr) {
      await check(
        'A5 cleanup verification error',
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
