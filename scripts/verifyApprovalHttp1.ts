import { Server } from 'http';
import pg from 'pg';
import { check, blocked, summary, CookieJarFetch, loginAs, resetLoopbackRateLimits } from './lib/testkit.js';
import { createApp } from '../src/server/app.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { PERMISSIONS } from '../src/server/rbac/permissions.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { hashPassword } from '../src/server/auth/passwordHash.js';
import { defaultMembershipStore } from '../src/server/org/membershipStore.js';

console.log('=========================================================================');
console.log('=== VERIFYING C1-b APPROVAL HTTP API (H1..H16)                       ===');
console.log('=========================================================================');

function assertLoopbackUrl(raw: string, varName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${varName} is invalid URL format`);
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
  }
  return parsed;
}

async function isHttpAppReachable(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json');
  } catch {
    return false;
  }
}

async function run() {
  let baseUrl = (process.env.VERIFY_APP_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Approval HTTP checks are BLOCKED.');
    process.exit(summary().exitCode);
    return;
  }
  try {
    assertLoopbackUrl(dbUrl, 'DATABASE_URL');
    if (process.env.MIGRATION_DATABASE_URL && process.env.MIGRATION_DATABASE_URL.trim() !== '') {
      assertLoopbackUrl(process.env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL');
    }
  } catch (err) {
    blocked(err instanceof Error ? err.message : String(err));
    process.exit(summary().exitCode);
    return;
  }
  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Unable to connect to database executor. Approval HTTP checks are BLOCKED.');
    process.exit(summary().exitCode);
    return;
  }

  let localServer: Server | undefined;
  const prevCorsOrigins = process.env.CORS_ORIGINS;
  if (!(await isHttpAppReachable(baseUrl))) {
    const app = createApp();
    await new Promise<void>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        const addr = s.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        process.env.CORS_ORIGINS = [prevCorsOrigins, baseUrl].filter(Boolean).join(',');
        resolve();
      });
      localServer = s;
    });
  }

  const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const companyIds: string[] = [];
  const userIds: string[] = [];
  let cleanupFailed = false;

  try {
    const companyRepo = new CompanyRepository();
    const userRepo = new UserRepository();
    const pass = 'ApprHttpPass123!';
    const passwordHash = await hashPassword(pass);
    const mk = async (tag: string) => userRepo.createUser({ username: `appr_${tag}_${unique}`, passwordHash, role: 'user' });
    const admin = await mk('adm');
    const admin2 = await mk('adm2');
    const emp = await mk('emp');
    const outsider = await mk('out');
    userIds.push(admin.id, admin2.id, emp.id, outsider.id);
    const compA = await companyRepo.create({ code: `APA-${unique}`.slice(0, 20), nameAr: `شركة موافقات أ ${unique}`, createdBy: admin.id });
    const compB = await companyRepo.create({ code: `APB-${unique}`.slice(0, 20), nameAr: `شركة موافقات ب ${unique}`, createdBy: outsider.id });
    companyIds.push(compA.id, compB.id);
    await defaultMembershipStore.addMember(admin.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(admin2.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(emp.id, compA.id, 'company_user', true);
    await defaultMembershipStore.addMember(outsider.id, compB.id, 'company_admin', true);

    await resetLoopbackRateLimits(executor, [admin, admin2, emp, outsider].map((u) => `user:${u.username.toLowerCase()}`));
    const jarNone = new CookieJarFetch();
    const login = async (u: { username: string }) => {
      const jar = new CookieJarFetch();
      const { csrfToken } = await loginAs(jar, baseUrl, u.username, pass);
      return { jar, csrfToken };
    };
    const sAdmin = await login(admin);
    const sAdmin2 = await login(admin2);
    const sEmp = await login(emp);
    const sOut = await login(outsider);

    const base = (c: string) => `${baseUrl}/api/companies/${c}/approvals`;
    const call = async (s: { jar: CookieJarFetch; csrfToken: string }, method: string, url: string, body?: unknown, withCsrf = true) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: baseUrl };
      if (withCsrf) headers['x-csrf-token'] = s.csrfToken;
      const res = await s.jar.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const json: any = await res.json().catch(() => ({}));
      return { status: res.status, json };
    };

    const r1 = await jarNone.fetch(`${base(compA.id)}/requests`);
    await check(`H1: list without session returns 401 (got ${r1.status})`, r1.status === 401);

    const steps = [PERMISSIONS.CUSTODY_APPROVE];
    const h2 = await call(sEmp, 'PUT', `${base(compA.id)}/policies/test_doc`, { steps });
    await check(`H2: company_user cannot publish a policy (403, got ${h2.status})`, h2.status === 403);
    const h3 = await call(sAdmin, 'PUT', `${base(compA.id)}/policies/test_doc`, { steps });
    await check(`H3: company_admin publishes policy v1 (200, got ${h3.status})`, h3.status === 200 && h3.json.policy?.version === 1);
    const h3b = await call(sAdmin, 'PUT', `${base(compA.id)}/policies/test_doc`, { steps: ['no.such.permission'] });
    await check(`H3b: unknown permission in a policy is rejected (400, got ${h3b.status})`, h3b.status === 400);
    const h4 = await call(sEmp, 'GET', `${base(compA.id)}/policies`);
    await check(`H4: company_user can read policies (200, got ${h4.status}) and sees test_doc`, h4.status === 200 && h4.json.policies?.some((p: any) => p.documentType === 'test_doc'));

    const doc1 = '11111111-1111-4111-8111-111111111111';
    const doc2 = '22222222-2222-4222-8222-222222222222';
    const h5 = await call(sAdmin, 'POST', `${base(compA.id)}/requests`, { documentType: 'no_policy_type', documentId: doc1 });
    await check(`H5: submit without a published policy is rejected (400, got ${h5.status})`, h5.status === 400);
    const h6 = await call(sEmp, 'POST', `${base(compA.id)}/requests`, { documentType: 'test_doc', documentId: doc1 });
    await check(`H6: company_user cannot submit over HTTP (403, got ${h6.status})`, h6.status === 403);
    const h7 = await call(sAdmin, 'POST', `${base(compA.id)}/requests`, { documentType: 'test_doc', documentId: doc1 });
    const req1 = h7.json.request?.id;
    await check(`H7: admin submits (201, pending, step needs custody approve; got ${h7.status})`,
      h7.status === 201 && h7.json.request?.status === 'pending' && h7.json.request?.nextStep?.permission === PERMISSIONS.CUSTODY_APPROVE);

    const h8 = await call(sAdmin, 'POST', `${base(compA.id)}/requests/${req1}/decision`, { decision: 'approve' });
    await check(`H8: requester cannot approve own request (403, got ${h8.status})`, h8.status === 403);
    const h9 = await call(sEmp, 'POST', `${base(compA.id)}/requests/${req1}/decision`, { decision: 'approve' });
    await check(`H9: user without the step permission cannot approve (403, got ${h9.status})`, h9.status === 403);
    const h10 = await call(sAdmin2, 'POST', `${base(compA.id)}/requests/${req1}/decision`, { decision: 'approve' }, false);
    await check(`H10: decision without CSRF token is blocked (403, got ${h10.status})`, h10.status === 403);
    const h11 = await call(sAdmin2, 'POST', `${base(compA.id)}/requests/${req1}/decision`, { decision: 'approve' });
    await check(`H11: second admin approves (200, approved; got ${h11.status})`, h11.status === 200 && h11.json.request?.status === 'approved');
    const h12 = await call(sAdmin2, 'POST', `${base(compA.id)}/requests/${req1}/decision`, { decision: 'approve' });
    await check(`H12: closed request takes no more decisions (400, got ${h12.status})`, h12.status === 400);

    const h13a = await call(sAdmin, 'POST', `${base(compA.id)}/requests`, { documentType: 'test_doc', documentId: doc2 });
    const req2 = h13a.json.request?.id;
    const h13 = await call(sAdmin2, 'POST', `${base(compA.id)}/requests/${req2}/decision`, { decision: 'reject' });
    await check(`H13: reject without a reason is refused (400, got ${h13.status})`, h13.status === 400);
    const h14 = await call(sAdmin2, 'POST', `${base(compA.id)}/requests/${req2}/decision`, { decision: 'reject', reason: 'غير مكتمل' });
    await check(`H14: reject with reason (200, rejected; got ${h14.status})`, h14.status === 200 && h14.json.request?.status === 'rejected');

    const l1 = await call(sEmp, 'GET', `${base(compA.id)}/requests?status=approved`);
    await check(`H15: status filter returns only the approved request (got ${l1.json.requests?.length})`,
      l1.status === 200 && l1.json.requests?.length === 1 && l1.json.requests[0].id === req1);
    const l2 = await call(sEmp, 'GET', `${base(compA.id)}/requests?documentId=${doc2}`);
    await check(`H15b: documentId filter returns the rejected request`, l2.status === 200 && l2.json.requests?.length === 1 && l2.json.requests[0].status === 'rejected');
    const l3 = await call(sEmp, 'GET', `${base(compA.id)}/requests/${req1}`);
    await check(`H15c: get by id returns 2 history rows? decisions=${l3.json.request?.decisions?.length}`, l3.status === 200 && l3.json.request?.decisions?.length === 1);
    const l4 = await call(sEmp, 'GET', `${base(compA.id)}/requests/not-a-uuid`);
    await check(`H15d: bad id format returns 400 (got ${l4.status})`, l4.status === 400);
    const l5 = await call(sEmp, 'GET', `${base(compA.id)}/requests?status=bogus`);
    await check(`H15e: bad status filter returns 400 (got ${l5.status})`, l5.status === 400);

    const x1 = await call(sOut, 'GET', `${base(compA.id)}/requests`);
    await check(`H16: user of another company cannot read company A requests (403, got ${x1.status})`, x1.status === 403);
    const x2 = await call(sOut, 'GET', `${base(compA.id)}/requests/${req1}`);
    await check(`H16b: other company cannot read a request by id (403, got ${x2.status})`, x2.status === 403);
    const x3 = await call(sOut, 'GET', `${base(compB.id)}/requests`);
    await check(`H16c: other company sees none of A's requests in its own list`, x3.status === 200 && x3.json.requests?.length === 0);
    const x4 = await call(sAdmin2, 'GET', `${base(compB.id)}/requests`);
    await check(`H16d: company A admin cannot read company B (403, got ${x4.status})`, x4.status === 403);
  } catch (err) {
    await check('Approval HTTP verification unexpected error', false, err instanceof Error ? err.message : String(err));
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
          await client.query('DELETE FROM user_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }
        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('COMMIT');
        console.log('[cleanup] Approval HTTP test data purged cleanly.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try { await client.query('ROLLBACK'); } catch {}
        console.error('[cleanup] Failed cleaning up verifyApprovalHttp1:', cleanupErr);
      } finally {
        await client.end();
      }
    }
    if (localServer) localServer.close();
    if (prevCorsOrigins === undefined) delete process.env.CORS_ORIGINS; else process.env.CORS_ORIGINS = prevCorsOrigins;
    await closeAllExecutors();
  }

  const { exitCode } = summary();
  if (cleanupFailed) process.exit(1);
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[verifyApprovalHttp1] Fatal error:', err);
  process.exit(1);
});
