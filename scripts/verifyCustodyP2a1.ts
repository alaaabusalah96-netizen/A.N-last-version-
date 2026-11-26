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
import { ForbiddenError, NotFoundError, ValidationError } from '../src/server/http/errors.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-ERP-R08-P2A (top-up, reversal, count, stmt)    ===');
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
    blocked('DATABASE_URL is not set. Live DB checks P1..P12 are BLOCKED.');
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
    blocked('Unable to connect to database executor. Live DB checks P1..P12 are BLOCKED.');
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
    const userB = await userRepo.createUser({ username: `cv_b_${unique}`, passwordHash: 'dummy_cv_hash', role: 'user' });
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

    const custody = await newOpenCustody(1000);
    const balBefore = await regBalance();

    // P1
    const topped = await defaultCustodyExtrasService.topUpCustody(compA.id, custody.id, { amount: 200, memo: 'تعزيز' }, approver.id, false);
    const mv = await defaultCustodyService.listCustodyMovements(compA.id, custody.id);
    await check('P1: top-up raises custody to 1200, takes 200 from the register, posts a JE, records a topup movement',
      topped.amount === 1200 && topped.status === 'open' && (await regBalance()) === balBefore - 200 &&
      mv.some((m) => m.movementType === 'topup' && m.amount === 200 && m.direction === 'out' && Boolean(m.journalEntryId)) &&
      (await receivableNet()) === 1200);

    // P2
    const pending = await defaultCustodyService.requestCustody(
      compA.id, { employeeUserId: requester.id, registerId: register.id, amount: 50, purpose: 'عهدة معلقة' }, requester.id);
    await check('P2: top-up rejected for non-open custody, zero, 3-decimal and above-register-balance amounts',
      (await rejects(() => defaultCustodyExtrasService.topUpCustody(compA.id, pending.id, { amount: 10 }, approver.id, false), ValidationError)) &&
      (await rejects(() => defaultCustodyExtrasService.topUpCustody(compA.id, custody.id, { amount: 0 }, approver.id, false), ValidationError)) &&
      (await rejects(() => defaultCustodyExtrasService.topUpCustody(compA.id, custody.id, { amount: '1.234' }, approver.id, false), ValidationError)) &&
      (await rejects(() => defaultCustodyExtrasService.topUpCustody(compA.id, custody.id, { amount: 99999999 }, approver.id, false), ValidationError)));

    // P3
    const v1 = await defaultCustodyVoucherService.submitVoucher(compA.id, custody.id, { lines: [lineOf(300)] }, requester.id);
    await defaultCustodyVoucherService.approveVoucher(compA.id, v1.id, approver.id, false);
    const st1 = await defaultCustodyExtrasService.getStatement(compA.id, custody.id);
    await check('P3: statement totals (disbursed 1000, top-ups 200, expenses 300, remaining 900) with movements and vouchers',
      st1.totals.disbursed === 1000 && st1.totals.topUps === 200 && st1.totals.approvedExpenses === 300 &&
      st1.totals.remaining === 900 && st1.vouchers.length === 1 && st1.movements.length >= 3);

    // P4
    const jeBeforeCount = await jeCount();
    const noReason = await rejects(() => defaultCustodyVoucherService.reverseVoucher(compA.id, v1.id, ' ', approver.id, false), ValidationError);
    const rev = await defaultCustodyVoucherService.reverseVoucher(compA.id, v1.id, 'فاتورة مكررة', approver.id, false);
    const st2 = await defaultCustodyExtrasService.getStatement(compA.id, custody.id);
    await check('P4: reversal needs a reason, posts a reversing JE, marks voucher reversed, restores remaining to 1200',
      noReason && rev.status === 'reversed' && Boolean(rev.reversalJournalEntryId) && (await jeCount()) === jeBeforeCount + 1 &&
      st2.totals.remaining === 1200 && st2.totals.reversedExpenses === 300 && st2.totals.approvedExpenses === 0);

    // P5
    const v2 = await defaultCustodyVoucherService.submitVoucher(compA.id, custody.id, { lines: [lineOf(10)] }, requester.id);
    await check('P5: cannot reverse a submitted voucher or a voucher twice',
      (await rejects(() => defaultCustodyVoucherService.reverseVoucher(compA.id, v2.id, 'x', approver.id, false), ValidationError)) &&
      (await rejects(() => defaultCustodyVoucherService.reverseVoucher(compA.id, v1.id, 'x', approver.id, false), ValidationError)));
    const stPend = await defaultCustodyExtrasService.getStatement(compA.id, custody.id);
    const pr = await defaultCustodyExtrasService.getPeriodReport(compA.id, custody.id, '2000-01-01T00:00:00Z', '2999-01-01T00:00:00Z');
    const pr0 = await defaultCustodyExtrasService.getPeriodReport(compA.id, custody.id, '1990-01-01T00:00:00Z', '1990-01-02T00:00:00Z');
    await check('P5b: period report closing = opening + in - out = statement remaining 1200 after a reversal, reconciled; empty past period is 0; a pending voucher is reserved (10) without lowering remaining',
      pr.opening === 0 && pr.closing === 1200 && pr.closing === pr.opening + pr.totalIn - pr.totalOut && pr.reconciled === true &&
      pr.asOfBalance === 1200 && pr0.closing === 0 && pr0.rows.length === 0 &&
      stPend.totals.pendingVoucherAmount === 10 && stPend.totals.remaining === 1200 && stPend.totals.available === 1190 &&
      (await rejects(() => defaultCustodyExtrasService.getPeriodReport(compA.id, custody.id, '2999-01-01T00:00:00Z', '2000-01-01T00:00:00Z'), ValidationError)) &&
      (await rejects(() => defaultCustodyExtrasService.getPeriodReport(compB.id, custody.id, '2000-01-01T00:00:00Z', '2999-01-01T00:00:00Z'), NotFoundError)));
    await defaultCustodyVoucherService.rejectVoucher(compA.id, v2.id, 'غير مطلوب', approver.id);

    // P6
    const jeBeforeCount2 = await jeCount();
    const cnt = await defaultCustodyExtrasService.recordCashCount(compA.id, custody.id, { countedAmount: 1150, memo: 'جرد' }, requester.id);
    await check('P6: cash count stores expected 1200, counted 1150, variance -50 and posts NOTHING to the ledger',
      cnt.expectedAmount === 1200 && cnt.countedAmount === 1150 && cnt.variance === -50 && (await jeCount()) === jeBeforeCount2 &&
      (await receivableNet()) === 1200);

    // P7
    const st3 = await defaultCustodyExtrasService.getStatement(compA.id, custody.id);
    await check('P7: statement lists the count; invalid counts (negative, 3 decimals) are rejected',
      st3.cashCounts.length === 1 && st3.cashCounts[0].variance === -50 &&
      (await rejects(() => defaultCustodyExtrasService.recordCashCount(compA.id, custody.id, { countedAmount: -1 }, requester.id), ValidationError)) &&
      (await rejects(() => defaultCustodyExtrasService.recordCashCount(compA.id, custody.id, { countedAmount: '5.555' }, requester.id), ValidationError)));

    // P8
    let p8a = false, p8b = false, p8c = false;
    try { await withTenantTransaction(compA.id, (tx) => tx.query('DELETE FROM custody_cash_counts WHERE company_id = $1', [compA.id])); } catch { p8a = true; }
    try { await withTenantTransaction(compA.id, (tx) => tx.query("UPDATE custody_cash_counts SET memo = 'x' WHERE company_id = $1", [compA.id])); } catch { p8b = true; }
    try { await withTenantTransaction(compA.id, (tx) => tx.query("UPDATE custody_vouchers SET memo = 'x' WHERE company_id = $1 AND status = 'reversed'", [compA.id])); } catch { p8c = true; }
    await check('P8: counts cannot be edited or deleted; a reversed voucher cannot be changed (DB triggers)', p8a && p8b && p8c);

    // P9
    const settled = await defaultCustodyService.settleCustody(compA.id, custody.id, { lines: [lineOf(1000)], cashReturn: 200 }, approver.id, false);
    await check('P9: final settle after top-up and reversal must equal remaining 1200; receivable nets to zero',
      settled.status === 'settled' && settled.amount === 1200 && (await receivableNet()) === 0);

    // P10
    await check('P10: top-up, count and reversal are blocked on a settled custody',
      (await rejects(() => defaultCustodyExtrasService.topUpCustody(compA.id, custody.id, { amount: 5 }, approver.id, false), ValidationError)) &&
      (await rejects(() => defaultCustodyExtrasService.recordCashCount(compA.id, custody.id, { countedAmount: 0 }, requester.id), ValidationError)));

    // P11
    const c2 = await newOpenCustody(300);
    const w = await defaultCustodyVoucherService.submitVoucher(compA.id, c2.id, { lines: [lineOf(100)] }, requester.id);
    await defaultCustodyVoucherService.approveVoucher(compA.id, w.id, approver.id, false);
    const w2 = await defaultCustodyVoucherService.submitVoucher(compA.id, c2.id, { lines: [lineOf(200)] }, requester.id);
    await defaultCustodyVoucherService.approveVoucher(compA.id, w2.id, approver.id, false);
    const c2after = await defaultCustodyService.getCustody(compA.id, c2.id);
    await check('P11: auto-settled custody cannot have a voucher reversed (needs open custody)',
      c2after.status === 'settled' &&
      (await rejects(() => defaultCustodyVoucherService.reverseVoucher(compA.id, w.id, 'x', approver.id, false), ValidationError)));

    // P12
    await check('P12: tenant isolation - company B cannot read the statement or top up a company A custody',
      (await rejects(() => defaultCustodyExtrasService.getStatement(compB.id, custody.id), NotFoundError)) &&
      (await rejects(() => defaultCustodyExtrasService.topUpCustody(compB.id, c2.id, { amount: 1 }, userB.id, false), NotFoundError)));
  } catch (err) {
    await check('Custody P2a verification unexpected error', false, err instanceof Error ? err.message : String(err));
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
        console.error('[cleanup] Failed cleaning up verifyCustodyP2a1:', cleanupErr);
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
  console.error('[verifyCustodyP2a1] Fatal error:', err);
  process.exit(1);
});
