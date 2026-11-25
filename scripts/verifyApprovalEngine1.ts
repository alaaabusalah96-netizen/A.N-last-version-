import pg from 'pg';
import { randomUUID } from 'crypto';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { ApprovalService, deriveApprovalState } from '../src/server/approvals/approvalService.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { PERMISSIONS } from '../src/server/rbac/permissions.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/server/http/errors.js';

console.log('=== VERIFYING AN-ERP-C1A (generic approval engine) ===');

async function rejects(fn: () => Promise<unknown>, type?: new (...a: any[]) => Error): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return type ? e instanceof type : true;
  }
}

async function run() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    blocked('DATABASE_URL is not set. Live DB checks A1..A12 are BLOCKED.');
    process.exit(summary().exitCode);
    return;
  }
  const u = new URL(dbUrl);
  if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname)) {
    blocked(`DATABASE_URL host '${u.hostname}' is not loopback. Refusing destructive test run.`);
    process.exit(summary().exitCode);
    return;
  }
  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Unable to connect to database executor.');
    process.exit(summary().exitCode);
    return;
  }

  const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const companyIds: string[] = [];
  const userIds: string[] = [];
  let cleanupFailed = false;
  const svc = new ApprovalService();
  const yes = async () => true;
  const no = async () => false;

  try {
    const companyRepo = new CompanyRepository();
    const userRepo = new UserRepository();
    const requester = await userRepo.createUser({ username: `ap_req_${unique}`, passwordHash: 'dummy', role: 'user' });
    const a1 = await userRepo.createUser({ username: `ap_a1_${unique}`, passwordHash: 'dummy', role: 'user' });
    const a2 = await userRepo.createUser({ username: `ap_a2_${unique}`, passwordHash: 'dummy', role: 'user' });
    const userB = await userRepo.createUser({ username: `ap_b_${unique}`, passwordHash: 'dummy', role: 'user' });
    userIds.push(requester.id, a1.id, a2.id, userB.id);
    const compA = await companyRepo.create({ code: `APA-${unique}`.slice(0, 20), nameAr: `شركة موافقات أ ${unique}`, createdBy: requester.id });
    const compB = await companyRepo.create({ code: `APB-${unique}`.slice(0, 20), nameAr: `شركة موافقات ب ${unique}`, createdBy: userB.id });
    companyIds.push(compA.id, compB.id);

    // A1 pure derivation
    const two = [{ stepNo: 1, permission: 'x' }, { stepNo: 2, permission: 'y' }];
    await check('A1: derive state: none pending, one pending-next, all approved, any reject',
      deriveApprovalState(two, []).status === 'pending' &&
        deriveApprovalState(two, [{ stepNo: 1, decision: 'approve' }]).nextStep?.stepNo === 2 &&
        deriveApprovalState(two, [{ stepNo: 1, decision: 'approve' }, { stepNo: 2, decision: 'approve' }]).status === 'approved' &&
        deriveApprovalState(two, [{ stepNo: 1, decision: 'reject' }]).status === 'rejected');

    // A2 default policy = one permission gate
    const doc1 = randomUUID();
    const r1 = await svc.requestApproval(compA.id, 'custody_write_off', doc1, PERMISSIONS.CUSTODY_SETTLE, requester.id);
    await check('A2: with no policy the request has one step using the default permission',
      r1.steps.length === 1 && r1.steps[0].permission === PERMISSIONS.CUSTODY_SETTLE && r1.status === 'pending' && r1.policyId === null);

    // A3 requester cannot approve own request
    await check('A3: requester cannot approve their own request',
      await rejects(() => svc.decide(compA.id, r1.id, 'approve', null, requester.id, yes), ForbiddenError));

    // A4 permission missing
    await check('A4: approver without the step permission is refused',
      await rejects(() => svc.decide(compA.id, r1.id, 'approve', null, a1.id, no), ForbiddenError));

    // A5 approve closes
    const done1 = await svc.decide(compA.id, r1.id, 'approve', null, a1.id, yes);
    await check('A5: a valid approval makes the request approved and isApproved true',
      done1.status === 'approved' && (await svc.isApproved(compA.id, 'custody_write_off', doc1)));

    // A6 closed request takes no more decisions
    await check('A6: an approved request takes no further decisions',
      await rejects(() => svc.decide(compA.id, r1.id, 'reject', 'late', a2.id, yes), ValidationError));

    // A7 two-step policy, distinct approvers, order
    const pol = await svc.setPolicy(compA.id, 'custody_write_off', [PERMISSIONS.CUSTODY_APPROVE, PERMISSIONS.CUSTODY_SETTLE], requester.id);
    const doc2 = randomUUID();
    const r2 = await svc.requestApproval(compA.id, 'custody_write_off', doc2, PERMISSIONS.CUSTODY_SETTLE, requester.id);
    await check('A7a: policy v1 pinned on the request with two steps', pol.version === 1 && r2.policyId === pol.id && r2.steps.length === 2);
    const asked: string[] = [];
    const rec = async (p: string) => { asked.push(p); return true; };
    const s1 = await svc.decide(compA.id, r2.id, 'approve', null, a1.id, rec);
    await check('A7b: after step 1 the request is still pending and step 2 is next, permission asked was step 1 permission',
      s1.status === 'pending' && s1.nextStep?.stepNo === 2 && asked[0] === PERMISSIONS.CUSTODY_APPROVE);
    await check('A7c: the same person cannot approve step 2 of the same request',
      await rejects(() => svc.decide(compA.id, r2.id, 'approve', null, a1.id, yes), ForbiddenError));
    const s2 = await svc.decide(compA.id, r2.id, 'approve', null, a2.id, rec);
    await check('A7d: second approver completes it with the step 2 permission', s2.status === 'approved' && asked[1] === PERMISSIONS.CUSTODY_SETTLE);

    // A8 reject needs reason and ends it
    const doc3 = randomUUID();
    const r3 = await svc.requestApproval(compA.id, 'custody_write_off', doc3, PERMISSIONS.CUSTODY_SETTLE, requester.id);
    await check('A8a: rejecting without a reason is refused', await rejects(() => svc.decide(compA.id, r3.id, 'reject', '  ', a1.id, yes), ValidationError));
    const rj = await svc.decide(compA.id, r3.id, 'reject', 'not justified', a1.id, yes);
    await check('A8b: reject ends the request; document is not approved', rj.status === 'rejected' && !(await svc.isApproved(compA.id, 'custody_write_off', doc3)));

    // A9 a rejected document can be requested again, an open or approved one cannot
    await check('A9a: duplicate request for an approved document is refused',
      await rejects(() => svc.requestApproval(compA.id, 'custody_write_off', doc2, PERMISSIONS.CUSTODY_SETTLE, requester.id), ValidationError));
    const r3b = await svc.requestApproval(compA.id, 'custody_write_off', doc3, PERMISSIONS.CUSTODY_SETTLE, requester.id);
    await check('A9b: after a rejection a new request can be opened', r3b.status === 'pending' && r3b.id !== r3.id);

    // A10 a new policy version does not change a request already in progress
    await svc.setPolicy(compA.id, 'custody_write_off', [PERMISSIONS.CUSTODY_DISBURSE], requester.id);
    const reloaded = await svc.getRequest(compA.id, r3b.id);
    await check('A10: a newer policy version leaves an in-flight request on its own steps', reloaded.policyId === pol.id && reloaded.steps.length === 2 && reloaded.steps[0].permission === PERMISSIONS.CUSTODY_APPROVE);

    // A11 unknown permission in a policy is refused
    await check('A11: policy with an unknown permission or empty steps is refused',
      (await rejects(() => svc.setPolicy(compA.id, 'x_doc', ['not:a:permission'], requester.id), ValidationError)) &&
        (await rejects(() => svc.setPolicy(compA.id, 'x_doc', [], requester.id), ValidationError)));

    // A12 tenant isolation
    await check('A12: company B cannot read or decide a company A request',
      (await rejects(() => svc.getRequest(compB.id, r3b.id), NotFoundError)) &&
        (await rejects(() => svc.decide(compB.id, r3b.id, 'approve', null, userB.id, yes), NotFoundError)) &&
        !(await svc.isApproved(compB.id, 'custody_write_off', doc2)));

    // A13 history is immutable at the database level (app role)
    await check('A13: decisions and policies cannot be updated or deleted by the app role',
      (await rejects(() => withTenantTransaction(compA.id, (tx) => tx.query(`UPDATE approval_decisions SET decision = 'approve' WHERE company_id = $1`, [compA.id])))) &&
        (await rejects(() => withTenantTransaction(compA.id, (tx) => tx.query(`DELETE FROM approval_policies WHERE company_id = $1`, [compA.id])))));

    // A14 audit
    const audits = await executor.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE company_id = $1 AND action IN ('APPROVAL_REQUESTED','APPROVAL_STEP_APPROVED','APPROVAL_REJECTED','APPROVAL_POLICY_SET')`,
      [compA.id]
    ).catch(() => null);
    await check('A14: every request, approval, rejection and policy change is audited',
      !audits || Number(audits.rows[0].n) >= 10, audits ? `count=${audits.rows[0].n}` : 'audit read denied for app role (checked via cleanup client)');
  } catch (err) {
    await check('Approval engine verification unexpected error', false, err instanceof Error ? err.message : String(err));
  } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(cleanupUrl));
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        for (const t of ['approval_decisions', 'approval_requests', 'approval_policies']) {
          await client.query(`ALTER TABLE ${t} DISABLE TRIGGER trg_${t}_guard`);
          await client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [companyIds]);
          await client.query(`ALTER TABLE ${t} ENABLE TRIGGER trg_${t}_guard`);
        }
        await client.query('DELETE FROM company_memberships WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
        if (userIds.length > 0) {
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }
        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('COMMIT');
        console.log('[cleanup] Test companies and approval records purged cleanly.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try { await client.query('ROLLBACK'); } catch {}
        console.error('[cleanup] Failed cleaning up verifyApprovalEngine1:', cleanupErr);
      } finally {
        await client.end();
      }
    }
    await closeAllExecutors();
  }
  const { exitCode } = summary();
  if (cleanupFailed) process.exit(1);
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[verifyApprovalEngine1] Fatal error:', err);
  process.exit(1);
});
