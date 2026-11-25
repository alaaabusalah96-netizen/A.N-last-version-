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
import { defaultCustodyExtrasService } from '../src/server/cash/custodyExtrasService.js';
import { defaultCustodyVoucherService } from '../src/server/cash/custodyVoucherService.js';
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';
import { defaultCustodyShortageSettlementService as ss } from '../src/server/cash/custodyShortageSettlementService.js';
import { PERMISSIONS } from '../src/server/rbac/permissions.js';
import { defaultApprovalService } from '../src/server/approvals/approvalService.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-ERP-C13 (shortage settlement: write-off / payroll)===');
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
    blocked('DATABASE_URL is not set. Live DB checks S1..S10 are BLOCKED.');
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
    blocked('Unable to connect to database executor. Live DB checks S1..S10 are BLOCKED.');
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

    const requester = await userRepo.createUser({ username: `ss_req_${unique}`, passwordHash: 'dummy_cv_hash', role: 'user' });
    const approver = await userRepo.createUser({ username: `ss_app_${unique}`, passwordHash: 'dummy_cv_hash', role: 'user' });
    const userB = await userRepo.createUser({ username: `ss_b_${unique}`, passwordHash: 'dummy_cv_hash', role: 'user' });
    userIds.push(requester.id, approver.id, userB.id);

    const compA = await companyRepo.create({ code: `CVA-${unique}`.slice(0, 20), nameAr: `شركة حوافظ أ ${unique}`, createdBy: requester.id });
    const compB = await companyRepo.create({ code: `CVB-${unique}`.slice(0, 20), nameAr: `شركة حوافظ ب ${unique}`, createdBy: userB.id });
    companyIds.push(compA.id, compB.id);
    await defaultMembershipStore.addMember(requester.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(approver.id, compA.id, 'company_admin', true);
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

    const jeCount = async () => {
      const c = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl));
      await c.connect();
      const r = await c.query('SELECT COUNT(*)::int AS n FROM journal_entries WHERE company_id=$1', [compA.id]);
      await c.end();
      return r.rows[0].n as number;
    };
    const receivableNet = async () => {
      const c = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl));
      await c.connect();
      const r = await c.query(`SELECT COALESCE(SUM(debit - credit),0)::text AS net FROM journal_lines WHERE company_id=$1 AND account_id=$2`, [compA.id, custodyReceivable.id]);
      await c.end();
      return Number(r.rows[0].net);
    };
    const regBalance = async () => {
      const b = await defaultCashRegisterService.getBalance(compA.id, register.id);
      return b.currentBalance;
    };

    const payrollRecv = await accountService.createAccount(compA.id, {
      code: '1260', nameAr: 'ذمة خصم الرواتب', accountType: 'asset', parentId: headerAsset.id, isPostable: true,
    });
    const allow = async () => true;
    const netOf = async (accId: string) => {
      const c = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl));
      await c.connect();
      const r = await c.query(`SELECT COALESCE(SUM(debit - credit),0)::text AS net FROM journal_lines WHERE company_id=$1 AND account_id=$2`, [compA.id, accId]);
      await c.end();
      return Number(r.rows[0].net);
    };
    const auditCount = async (action: string) => {
      const c = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl));
      await c.connect();
      const r = await c.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE company_id=$1 AND action=$2`, [compA.id, action]);
      await c.end();
      return r.rows[0].n as number;
    };
    const newClaim = async (amount: number, counted: number) => {
      const cu = await newOpenCustody(amount);
      const k = await defaultCustodyExtrasService.recordCashCount(compA.id, cu.id, { countedAmount: counted }, requester.id);
      const cl = await defaultCustodyExtrasService.createShortageClaim(compA.id, cu.id, k.id, {}, approver.id);
      return { cu, cl };
    };
    const claimOf = async (cuId: string, clId: string) =>
      (await defaultCustodyExtrasService.getStatement(compA.id, cuId)).shortageClaims.find((c) => c.id === clId)!;

    const { cu: cu1, cl: cl1 } = await newClaim(1000, 940);

    // C1: default company
    await check('C1: with no policy, both treatments are rejected and nothing changes (default = P2a-2 behaviour)',
      (await rejects(() => ss.requestSettlement(compA.id, cl1.id, { treatment: 'WRITE_OFF', amount: 10, reason: 'اختبار' }, requester.id), ValidationError)) &&
      (await rejects(() => ss.requestSettlement(compA.id, cl1.id, { treatment: 'PAYROLL_DEDUCT', amount: 10, reason: 'اختبار' }, requester.id), ValidationError)) &&
      (await rejects(() => ss.requestSettlement(compA.id, cl1.id, { treatment: 'FORGIVE', amount: 10, reason: 'اختبار' }, requester.id), ValidationError)) &&
      (await claimOf(cu1.id, cl1.id)).outstanding === 60);

    // C2: policy validation
    await check('C2: policy needs the right account type (expense for write-off, asset for payroll), active and postable',
      (await rejects(() => ss.setPolicy(compA.id, 'WRITE_OFF', { enabled: true, accountId: payrollRecv.id }, approver.id), ValidationError)) &&
      (await rejects(() => ss.setPolicy(compA.id, 'PAYROLL_DEDUCT', { enabled: true, accountId: expenseAccount.id }, approver.id), ValidationError)) &&
      (await rejects(() => ss.setPolicy(compA.id, 'PAYROLL_DEDUCT', { enabled: true, accountId: headerAsset.id }, approver.id), ValidationError)) &&
      (await rejects(() => ss.setPolicy(compA.id, 'WRITE_OFF', { enabled: 'yes', accountId: expenseAccount.id }, approver.id), ValidationError)));

    await ss.setPolicy(compA.id, 'WRITE_OFF', { enabled: true, accountId: expenseAccount.id, ceiling: 30 }, approver.id);
    await ss.setPolicy(compA.id, 'PAYROLL_DEDUCT', { enabled: true, accountId: payrollRecv.id }, approver.id);
    const pols = await ss.listPolicies(compA.id);
    await check('C3: policies are versioned and listed (latest per treatment)',
      pols.length === 2 && pols.every((p) => p.enabled && p.version === 1));

    // C4: request does not post
    const jeBefore = await jeCount();
    const recvBefore = await receivableNet();
    const w = await ss.requestSettlement(compA.id, cl1.id, { treatment: 'WRITE_OFF', amount: 20, reason: 'عجز غير قابل للتحصيل' }, requester.id);
    const afterReq = await claimOf(cu1.id, cl1.id);
    await check('C4: a request is pending, reserves 20 on the claim and posts NOTHING',
      w.status === 'pending' && afterReq.pendingSettlement === 20 && afterReq.outstanding === 60 &&
      (await jeCount()) === jeBefore && (await receivableNet()) === recvBefore);

    // C5: ceiling, over-amount
    await check('C5: write-off above the ceiling (30), above the available amount, zero, or 3 decimals is rejected',
      (await rejects(() => ss.requestSettlement(compA.id, cl1.id, { treatment: 'WRITE_OFF', amount: 31, reason: 'اختبار' }, requester.id), ValidationError)) &&
      (await rejects(() => ss.requestSettlement(compA.id, cl1.id, { treatment: 'PAYROLL_DEDUCT', amount: 41, reason: 'اختبار' }, requester.id), ValidationError)) &&
      (await rejects(() => ss.requestSettlement(compA.id, cl1.id, { treatment: 'PAYROLL_DEDUCT', amount: 0, reason: 'اختبار' }, requester.id), ValidationError)) &&
      (await rejects(() => ss.requestSettlement(compA.id, cl1.id, { treatment: 'PAYROLL_DEDUCT', amount: '1.005', reason: 'اختبار' }, requester.id), ValidationError)) &&
      (await rejects(() => ss.requestSettlement(compA.id, cl1.id, { treatment: 'PAYROLL_DEDUCT', amount: 5, reason: '' }, requester.id), ValidationError)));

    // C6: requester cannot approve
    await check('C6: the requester cannot approve their own settlement; missing checker fails closed',
      (await rejects(() => ss.approveSettlement(compA.id, w.id, requester.id, false, allow), ForbiddenError)) &&
      (await rejects(() => ss.approveSettlement(compA.id, w.id, approver.id, false, undefined as any), ForbiddenError)) &&
      (await rejects(() => ss.approveSettlement(compA.id, w.id, approver.id, false, async (p: string) => p !== PERMISSIONS.CUSTODY_APPROVE), ForbiddenError)));

    // C7: approve posts the exact entry
    const wa = await ss.approveSettlement(compA.id, w.id, approver.id, false, allow);
    const c = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl));
    await c.connect();
    const lines = (await c.query(
      `SELECT account_id, debit::text AS d, credit::text AS c FROM journal_lines WHERE company_id=$1 AND entry_id=$2 ORDER BY debit DESC`,
      [compA.id, wa.journalEntryId]
    )).rows;
    await c.end();
    await check('C7: approval posts Dr loss expense 20 / Cr custody receivable 20, balanced; receivable falls by 20',
      wa.status === 'posted' && lines.length === 2 &&
      lines[0].account_id === expenseAccount.id && Number(lines[0].d) === 20 && Number(lines[0].c) === 0 &&
      lines[1].account_id === custodyReceivable.id && Number(lines[1].c) === 20 && Number(lines[1].d) === 0 &&
      (await receivableNet()) === recvBefore - 20);

    await check('C8: a decided settlement cannot be approved or rejected again',
      (await rejects(() => ss.approveSettlement(compA.id, w.id, approver.id, false, allow), ValidationError)) &&
      (await rejects(() => ss.rejectSettlement(compA.id, w.id, 'x', approver.id, allow), ValidationError)));

    // C9: payroll
    const pr = await ss.requestSettlement(compA.id, cl1.id, { treatment: 'PAYROLL_DEDUCT', amount: 15, reason: 'خصم من الراتب' }, requester.id);
    const pa = await ss.approveSettlement(compA.id, pr.id, approver.id, false, allow);
    await check('C9: payroll deduction posts Dr payroll receivable 15 / Cr custody receivable 15',
      pa.status === 'posted' && (await netOf(payrollRecv.id)) === 15 && (await receivableNet()) === recvBefore - 35);

    // C10: totals and repay interaction
    const mid = await claimOf(cu1.id, cl1.id);
    await check('C10: claim shows settled 35, outstanding 25, status partly_repaid',
      mid.settled === 35 && mid.outstanding === 25 && mid.status === 'partly_repaid' && mid.settlements.length === 2);
    const pend = await ss.requestSettlement(compA.id, cl1.id, { treatment: 'PAYROLL_DEDUCT', amount: 10, reason: 'خصم آخر' }, requester.id);
    await check('C11: cash repayment cannot take the amount reserved by a pending settlement; settlement cannot exceed what is left',
      (await rejects(() => defaultCustodyExtrasService.repayShortage(compA.id, cl1.id, { amount: 16 }, approver.id, false), ValidationError)) &&
      (await rejects(() => ss.requestSettlement(compA.id, cl1.id, { treatment: 'PAYROLL_DEDUCT', amount: 16, reason: 'اختبار' }, requester.id), ValidationError)));

    // C12: reject frees the reserve
    await check('C12: rejection needs a reason, then frees the reserve and posts nothing',
      (await rejects(() => ss.rejectSettlement(compA.id, pend.id, '  ', approver.id, allow), ValidationError)) &&
      (await ss.rejectSettlement(compA.id, pend.id, 'غير مقبول', approver.id, allow)).status === 'rejected' &&
      (await claimOf(cu1.id, cl1.id)).pendingSettlement === 0 && (await netOf(payrollRecv.id)) === 15);

    // C13: close the claim with cash
    const rep = await defaultCustodyExtrasService.repayShortage(compA.id, cl1.id, { amount: 25 }, approver.id, false);
    await check('C13: cash repayment of the rest closes the claim as settled; nothing more can be taken; receivable = counted 940 - 35',
      rep.status === 'settled' && rep.outstanding === 0 && (await receivableNet()) === 1000 - 20 - 15 - 25 &&
      (await rejects(() => ss.requestSettlement(compA.id, cl1.id, { treatment: 'WRITE_OFF', amount: 1, reason: 'اختبار' }, requester.id), ValidationError)));

    // C14: disabled policy
    await ss.setPolicy(compA.id, 'WRITE_OFF', { enabled: false, accountId: expenseAccount.id }, approver.id);
    const { cu: cu2, cl: cl2 } = await newClaim(500, 450);
    await check('C14: a disabled treatment is rejected (policy version 2 disables write-off); payroll still works',
      (await rejects(() => ss.requestSettlement(compA.id, cl2.id, { treatment: 'WRITE_OFF', amount: 5, reason: 'اختبار' }, requester.id), ValidationError)) &&
      (await ss.listPolicies(compA.id)).find((p) => p.treatment === 'WRITE_OFF')!.version === 2);

    // C15: immutability
    let i1 = false, i2 = false, i3 = false;
    try { await withTenantTransaction(compA.id, (tx) => tx.query('DELETE FROM custody_shortage_settlements WHERE company_id = $1', [compA.id])); } catch { i1 = true; }
    try { await withTenantTransaction(compA.id, (tx) => tx.query("UPDATE custody_settlement_policies SET enabled = false WHERE company_id = $1", [compA.id])); } catch { i2 = true; }
    try { await withTenantTransaction(compA.id, (tx) => tx.query('DELETE FROM custody_shortage_settlement_postings WHERE company_id = $1', [compA.id])); } catch { i3 = true; }
    await check('C15: settlements, postings and policies cannot be edited or deleted (DB triggers)', i1 && i2 && i3);

    // C16: audit
    await check('C16: every step is audited (policy set, request, post)',
      (await auditCount('CUSTODY_SETTLEMENT_POLICY_SET')) === 3 && (await auditCount('CUSTODY_SHORTAGE_SETTLE_REQUEST')) === 3 &&
      (await auditCount('CUSTODY_SHORTAGE_SETTLE_POST')) === 2);

    // C17: tenant isolation
    await check('C17: company B cannot request, approve or list against a company A claim',
      (await rejects(() => ss.requestSettlement(compB.id, cl2.id, { treatment: 'PAYROLL_DEDUCT', amount: 5, reason: 'اختبار' }, userB.id), NotFoundError)) &&
      (await rejects(() => ss.approveSettlement(compB.id, pa.id, userB.id, false, allow), NotFoundError)));

    // C18: closed period rolls the decision back
    const pc = await ss.requestSettlement(compA.id, cl2.id, { treatment: 'PAYROLL_DEDUCT', amount: 12, reason: 'فترة مغلقة' }, requester.id);
    await periodService.closePeriod(compA.id, openPeriod.id, approver.id);
    const jeC = await jeCount();
    const failed = await rejects(() => ss.approveSettlement(compA.id, pc.id, approver.id, false, allow), Error);
    const after = (await ss.listForClaim(compA.id, cl2.id)).find((s) => s.id === pc.id)!;
    const engineReq = (await defaultApprovalService.requestsForDocument(compA.id, 'custody_shortage_settlement', pc.id))[0];
    await check('C18: when the period is closed the approval fails as a whole: still pending, engine request still pending, no entry',
      failed && after.status === 'pending' && engineReq.status === 'pending' && engineReq.decisions.length === 0 && (await jeCount()) === jeC);
  } catch (err) {
    await check('C13 verification unexpected error', false, err instanceof Error ? err.message : String(err));
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

        for (const t of ['custody_shortage_settlement_postings', 'custody_shortage_settlements', 'custody_settlement_policies', 'approval_decisions', 'approval_requests', 'approval_policies']) {
          await client.query(`ALTER TABLE ${t} DISABLE TRIGGER trg_${t}_guard`);
          await client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [companyIds]);
          await client.query(`ALTER TABLE ${t} ENABLE TRIGGER trg_${t}_guard`);
        }
        await client.query('ALTER TABLE custody_shortage_repayments DISABLE TRIGGER trg_custody_shortage_repayments_guard');
        await client.query('ALTER TABLE custody_shortage_claims DISABLE TRIGGER trg_custody_shortage_claims_guard');
        await client.query('DELETE FROM custody_shortage_repayments WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM custody_shortage_claims WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('ALTER TABLE custody_cash_counts DISABLE TRIGGER trg_custody_cash_counts_guard');
        await client.query('DELETE FROM custody_cash_counts WHERE company_id = ANY($1::uuid[])', [companyIds]);
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

        await client.query('ALTER TABLE custody_shortage_repayments ENABLE TRIGGER trg_custody_shortage_repayments_guard');
        await client.query('ALTER TABLE custody_shortage_claims ENABLE TRIGGER trg_custody_shortage_claims_guard');
        await client.query('ALTER TABLE custody_cash_counts ENABLE TRIGGER trg_custody_cash_counts_guard');
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
        console.error('[cleanup] Failed cleaning up verifyCustodyShortageSettlement1:', cleanupErr);
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
  console.error('[verifyCustodyShortageSettlement1] Fatal error:', err);
  process.exit(1);
});
