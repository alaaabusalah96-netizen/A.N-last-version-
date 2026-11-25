import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultMembershipStore } from '../src/server/org/membershipStore.js';
import { AccountService } from '../src/server/accounting/accountService.js';
import { PeriodService } from '../src/server/accounting/periodService.js';
import { defaultJournalRepository } from '../src/server/accounting/journalRepository.js';
import { defaultCashRegisterService } from '../src/server/cash/cashRegisterService.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { defaultCustodyService } from '../src/server/cash/custodyService.js';
import { defaultApprovalService } from '../src/server/approvals/approvalService.js';
import { PERMISSIONS } from '../src/server/rbac/permissions.js';
import { CustodyVoucherService, defaultCustodyVoucherService } from '../src/server/cash/custodyVoucherService.js';
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-ERP-C1-c (custody voucher approval engine)      ===');
console.log('========================================================================');

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

async function run() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live DB checks P1..P11 are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    assertLoopbackUrl(dbUrl, 'DATABASE_URL');
    if (process.env.MIGRATION_DATABASE_URL && process.env.MIGRATION_DATABASE_URL.trim() !== '') {
      assertLoopbackUrl(process.env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL');
    }
  } catch (err) {
    blocked(err instanceof Error ? err.message : String(err));
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Unable to connect to database executor. Live DB checks P1..P11 are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const companyIds: string[] = [];
  const userIds: string[] = [];
  let cleanupFailed = false;

  try {
    const companyRepo = new CompanyRepository();
    const userRepo = new UserRepository();
    const accountService = new AccountService();
    const periodService = new PeriodService();

    const requester = await userRepo.createUser({ username: `cv_req_${unique}`, passwordHash: 'dummy_cv_hash', role: 'user' });
    const approver = await userRepo.createUser({ username: `cv_app_${unique}`, passwordHash: 'dummy_cv_hash', role: 'user' });
    const approver2 = await userRepo.createUser({ username: `cv_app2_${unique}`, passwordHash: 'dummy_cv_hash', role: 'user' });
    const userB = await userRepo.createUser({ username: `cv_b_${unique}`, passwordHash: 'dummy_cv_hash', role: 'user' });
    userIds.push(requester.id, approver.id, approver2.id, userB.id);

    const compA = await companyRepo.create({ code: `CVA-${unique}`.slice(0, 20), nameAr: `شركة حوافظ أ ${unique}`, createdBy: requester.id });
    const compB = await companyRepo.create({ code: `CVB-${unique}`.slice(0, 20), nameAr: `شركة حوافظ ب ${unique}`, createdBy: userB.id });
    companyIds.push(compA.id, compB.id);
    await defaultMembershipStore.addMember(requester.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(approver.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(approver2.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(userB.id, compB.id, 'company_admin', true);

    const { accounts } = await accountService.seedDefaultCoa(compA.id);
    await accountService.seedDefaultCoa(compB.id);
    const headerAsset = accounts.find((a) => a.code === '1000')!;
    const cashAccount = accounts.find((a) => a.code === '1100')!;
    const expenseAccount = accounts.find((a) => a.code === '5100')!;
    const custodyReceivable = await accountService.createAccount(compA.id, {
      code: '1250', nameAr: 'ذمة عهد الموظفين', accountType: 'asset', parentId: headerAsset.id, isPostable: true,
    });

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(year, now.getUTCMonth() + 1, 0)).getUTCDate();
    const openPeriod = await periodService.createPeriod(
      compA.id,
      { code: `${year}-${month}`, startDate: `${year}-${month}-01`, endDate: `${year}-${month}-${String(lastDay).padStart(2, '0')}` },
      requester.id
    );
    const register = await defaultCashRegisterService.createRegister(
      compA.id,
      { code: `REG-CV-${unique}`.slice(0, 30), nameAr: 'خزينة الحوافظ', glAccountId: cashAccount.id, openingBalance: 100000 },
      requester.id
    );
    await defaultCompanySettingsService.upsertSettings(requester.id, compA.id, { custodyReceivableAccountId: custodyReceivable.id });

    const newOpenCustody = async (amount: number) => {
      const c = await defaultCustodyService.requestCustody(
        compA.id, { employeeUserId: requester.id, registerId: register.id, amount, purpose: 'اختبار حوافظ العهدة' }, requester.id
      );
      await defaultCustodyService.approveCustody(compA.id, c.id, approver.id, false);
      return await defaultCustodyService.disburseCustody(compA.id, c.id, approver.id, false);
    };
    const remainingOf = async (custodyId: string) => {
      const c = await defaultCustodyService.getCustody(compA.id, custodyId);
      const mv = await defaultCustodyService.listCustodyMovements(compA.id, custodyId);
      const done = mv.filter((m) => m.movementType === 'settle_expense' || m.movementType === 'settle_return')
        .reduce((s, m) => s + m.amount, 0);
      return Math.round((c.amount - done) * 100) / 100;
    };
    const lineOf = (amount: number) => ({ expenseAccountId: expenseAccount.id, amount, memo: 'مصروف' });
    const rejects = async (fn: () => Promise<unknown>, cls: any) => {
      try { await fn(); return false; } catch (e) { return e instanceof cls; }
    };

    const svc = defaultCustodyVoucherService;
    const T = 'custody_voucher';
    const allow = async () => true;
    const denyOnly = (p: string) => async (x: string) => x !== p;
    const reqsOf = (docId: string) => defaultApprovalService.requestsForDocument(compA.id, T, docId);
    const journalOf = (vId: string) => svc.listVouchers(compA.id, custody.id).then((l) => l.find((x) => x.id === vId)!);

    const custody = await newOpenCustody(2000);

    // P1: no policy -> today's behaviour, no engine records
    const p1 = await svc.submitVoucher(compA.id, custody.id, { lines: [lineOf(100)] }, requester.id);
    const p1a = await svc.approveVoucher(compA.id, p1.id, approver.id, false);
    await check('P1: without a policy approve works as before and creates no engine records',
      p1a.status === 'approved' && (await reqsOf(p1.id)).length === 0);

    // publish a two-step policy
    await defaultApprovalService.setPolicy(compA.id, T, [PERMISSIONS.CUSTODY_APPROVE, PERMISSIONS.CUSTODY_SETTLE], requester.id);

    // P2: submit creates a pending request owned by the submitter
    const p2 = await svc.submitVoucher(compA.id, custody.id, { lines: [lineOf(200)] }, requester.id);
    const r2 = await reqsOf(p2.id);
    await check('P2: with a policy, submit creates one pending 2-step request (requester = submitter)',
      r2.length === 1 && r2[0].status === 'pending' && r2[0].steps.length === 2 && r2[0].requestedBy === requester.id);

    // P3: step 1 leaves the voucher submitted
    const p3 = await svc.approveVoucher(compA.id, p2.id, approver.id, false, allow);
    const r3 = await reqsOf(p2.id);
    await check('P3: first step approves the request step only: voucher still submitted, no journal entry',
      p3.status === 'submitted' && p3.journalEntryId === null && r3[0].decisions.length === 1 && r3[0].nextStep?.stepNo === 2);

    // P4: same person cannot do step 2
    await check('P4: the same person cannot decide a second step',
      await rejects(() => svc.approveVoucher(compA.id, p2.id, approver.id, false, allow), ForbiddenError));

    // P5: step permission is enforced
    await check('P5: a user lacking the step-2 permission cannot approve',
      await rejects(() => svc.approveVoucher(compA.id, p2.id, approver2.id, false, denyOnly(PERMISSIONS.CUSTODY_SETTLE)), ForbiddenError));

    // P7: fail closed without a checker
    await check('P7: under a policy, approving without a permission checker fails closed',
      await rejects(() => svc.approveVoucher(compA.id, p2.id, approver2.id, false), ForbiddenError));

    // P8: requester cannot approve own voucher
    await check('P8: submitter cannot approve own voucher under a policy',
      await rejects(() => svc.approveVoucher(compA.id, p2.id, requester.id, false, allow), ForbiddenError));

    // P6: final step posts
    const rem0 = await remainingOf(custody.id);
    const p6 = await svc.approveVoucher(compA.id, p2.id, approver2.id, false, allow);
    const r6 = await reqsOf(p2.id);
    await check('P6: last step approves: voucher posted (journal entry), remaining reduced by 200, request approved',
      p6.status === 'approved' && Boolean(p6.journalEntryId) && r6[0].status === 'approved' && (await remainingOf(custody.id)) === rem0 - 200);

    // P9: reject under a policy
    const p9 = await svc.submitVoucher(compA.id, custody.id, { lines: [lineOf(50)] }, requester.id);
    const p9r = await svc.rejectVoucher(compA.id, p9.id, 'غير مستوفى', approver.id, allow);
    const r9 = await reqsOf(p9.id);
    await check('P9: reject under a policy rejects voucher and request, with the reason on the decision',
      p9r.status === 'rejected' && r9[0].status === 'rejected' && r9[0].decisions[0].reason === 'غير مستوفى');
    await check('P9b: reject under a policy without a checker fails closed',
      await rejects(async () => {
        const x = await svc.submitVoucher(compA.id, custody.id, { lines: [lineOf(10)] }, requester.id);
        await svc.rejectVoucher(compA.id, x.id, 'سبب', approver.id);
      }, ForbiddenError));

    // P10: a voucher submitted before the policy existed gets its request on the first decision
    const c2 = await newOpenCustody(500);
    const noPolicySvc = new CustodyVoucherService(undefined, undefined, undefined, undefined, undefined, undefined, {
      hasPolicy: async () => false,
      requestApproval: (...a: Parameters<typeof defaultApprovalService.requestApproval>) => defaultApprovalService.requestApproval(...a),
      requestsForDocument: (...a: Parameters<typeof defaultApprovalService.requestsForDocument>) => defaultApprovalService.requestsForDocument(...a),
      decide: (...a: Parameters<typeof defaultApprovalService.decide>) => defaultApprovalService.decide(...a),
    });
    const legacy = await noPolicySvc.submitVoucher(compA.id, c2.id, { lines: [lineOf(80)] }, requester.id);
    const preLegacy = await reqsOf(legacy.id);
    await svc.approveVoucher(compA.id, legacy.id, approver.id, false, allow);
    const postLegacy = await reqsOf(legacy.id);
    await check('P10: a voucher submitted before the policy has no request; the first decision creates it for the submitter and records step 1',
      preLegacy.length === 0 && postLegacy.length === 1 && postLegacy[0].requestedBy === requester.id && postLegacy[0].decisions.length === 1);

    // P11: closed period at the last step rolls the decision back
    const c3 = await newOpenCustody(400);
    const pv = await svc.submitVoucher(compA.id, c3.id, { lines: [lineOf(150)] }, requester.id);
    await svc.approveVoucher(compA.id, pv.id, approver.id, false, allow);
    await periodService.closePeriod(compA.id, openPeriod.id, approver.id);
    const failed = await rejects(() => svc.approveVoucher(compA.id, pv.id, approver2.id, false, allow), ValidationError);
    const rpv = await reqsOf(pv.id);
    const vAfter = (await svc.listVouchers(compA.id, c3.id))[0];
    await check('P11: posting failure at the last step rolls the step decision back (request stays at step 2, voucher submitted)',
      failed && rpv[0].status === 'pending' && rpv[0].decisions.length === 1 && vAfter.status === 'submitted');
  } catch (err) {
    await check('Custody vouchers verification unexpected error', false, err instanceof Error ? err.message : String(err));
  } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(cleanupUrl));
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries DISABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines DISABLE TRIGGER trg_journal_lines_immutability');

        for (const t of ['approval_decisions', 'approval_requests', 'approval_policies']) {
          await client.query(`ALTER TABLE ${t} DISABLE TRIGGER trg_${t}_guard`);
          await client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [companyIds]);
          await client.query(`ALTER TABLE ${t} ENABLE TRIGGER trg_${t}_guard`);
        }
        await client.query('ALTER TABLE custody_vouchers DISABLE TRIGGER trg_custody_vouchers_guard');
        await client.query('ALTER TABLE custody_voucher_lines DISABLE TRIGGER trg_custody_voucher_lines_guard');
        await client.query('DELETE FROM custody_voucher_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM custody_vouchers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM custody_movements WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM custody_records WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM cash_registers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM journal_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query(
          'UPDATE journal_entries SET reversed_by_entry_id = NULL WHERE company_id = ANY($1::uuid[])',
          [companyIds]
        );
        await client.query('DELETE FROM journal_entries WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM company_settings WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounting_periods WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounting_sequences WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounts WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM company_memberships WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
        if (userIds.length > 0) {
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }

        await client.query('ALTER TABLE custody_vouchers ENABLE TRIGGER trg_custody_vouchers_guard');
        await client.query('ALTER TABLE custody_voucher_lines ENABLE TRIGGER trg_custody_voucher_lines_guard');
        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines ENABLE TRIGGER trg_journal_lines_immutability');
        await client.query('COMMIT');
        console.log('[cleanup] Test companies, journal entries, and custody lifecycle records purged cleanly.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch {}
        console.error('[cleanup] Failed cleaning up verifyCustodyApproval1:', cleanupErr);
      } finally {
        await client.end();
      }
    }
    await closeAllExecutors();
  }

  const { exitCode } = summary();
  if (cleanupFailed) {
    console.error('[cleanup] Cleanup failed. Failing test to prevent silent leakage.');
    process.exit(1);
  }
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[verifyCustodyApproval1] Fatal error:', err);
  process.exit(1);
});
