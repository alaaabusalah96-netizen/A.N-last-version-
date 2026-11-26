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
console.log('=== VERIFYING AN-ERP-R08-P2A2 (shortage claim + repayment)      ===');
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

    // S1
    const jeBefore = await jeCount();
    const cnt = await defaultCustodyExtrasService.recordCashCount(compA.id, custody.id, { countedAmount: 940 }, requester.id);
    const claim = await defaultCustodyExtrasService.createShortageClaim(compA.id, custody.id, cnt.id, { memo: 'عجز جرد' }, approver.id);
    await check('S1: shortage claim of 60 is created from the count, status open, and posts NOTHING to the ledger',
      claim.amount === 60 && claim.outstanding === 60 && claim.repaid === 0 && claim.status === 'open' &&
      (await jeCount()) === jeBefore && (await receivableNet()) === 1000);

    // S2
    const cnt2 = await defaultCustodyExtrasService.recordCashCount(compA.id, custody.id, { countedAmount: 1000 }, requester.id);
    const cnt3 = await defaultCustodyExtrasService.recordCashCount(compA.id, custody.id, { countedAmount: 1010 }, requester.id);
    await check('S2: a second claim for the same count, or a claim for a count with no shortage or surplus, is rejected',
      (await rejects(() => defaultCustodyExtrasService.createShortageClaim(compA.id, custody.id, cnt.id, {}, approver.id), ValidationError)) &&
      (await rejects(() => defaultCustodyExtrasService.createShortageClaim(compA.id, custody.id, cnt2.id, {}, approver.id), ValidationError)) &&
      (await rejects(() => defaultCustodyExtrasService.createShortageClaim(compA.id, custody.id, cnt3.id, {}, approver.id), ValidationError)));

    // S3
    const balBefore = await regBalance();
    const part = await defaultCustodyExtrasService.repayShortage(compA.id, claim.id, { amount: 25, memo: 'سداد جزئي' }, approver.id, false);
    await check('S3: partial repayment of 25 puts cash in the register, posts Dr cash / Cr custody receivable, claim partly repaid, outstanding 35',
      part.repaid === 25 && part.outstanding === 35 && part.status === 'partly_repaid' &&
      (await regBalance()) === balBefore + 25 && (await receivableNet()) === 975 &&
      part.repayments.length === 1 && Boolean(part.repayments[0].journalEntryId));

    // S3b: ageing of the open claim (35 outstanding, created today -> 0-30 bucket), isolation per company
    const ag = await defaultCustodyExtrasService.getShortageAgeing(compA.id);
    const agFar = await defaultCustodyExtrasService.getShortageAgeing(compA.id, new Date(Date.now() + 100 * 86400000).toISOString());
    const agB = await defaultCustodyExtrasService.getShortageAgeing(compB.id);
    await check('S3b: shortage ageing shows the 35 outstanding in 0-30 days, moves to over-90 100 days later, and company B sees nothing',
      ag.total === 35 && ag.rows.length === 1 && ag.rows[0].b0_30 === 35 && ag.rows[0].claims === 1 &&
      agFar.rows[0].over90 === 35 && agFar.rows[0].b0_30 === 0 && agB.rows.length === 0 && agB.total === 0);

    // S4
    await check('S4: repayment above the outstanding amount, zero, or 3 decimals is rejected',
      (await rejects(() => defaultCustodyExtrasService.repayShortage(compA.id, claim.id, { amount: 36 }, approver.id, false), ValidationError)) &&
      (await rejects(() => defaultCustodyExtrasService.repayShortage(compA.id, claim.id, { amount: 0 }, approver.id, false), ValidationError)) &&
      (await rejects(() => defaultCustodyExtrasService.repayShortage(compA.id, claim.id, { amount: '1.005' }, approver.id, false), ValidationError)));

    // S5
    const full = await defaultCustodyExtrasService.repayShortage(compA.id, claim.id, { amount: 35 }, approver.id, false);
    await check('S5: final repayment closes the claim (repaid, outstanding 0) and the custody remaining equals the counted 940',
      full.status === 'repaid' && full.outstanding === 0 && full.repaid === 60 && (await receivableNet()) === 940 &&
      (await rejects(() => defaultCustodyExtrasService.repayShortage(compA.id, claim.id, { amount: 1 }, approver.id, false), ValidationError)));

    // S6
    const st = await defaultCustodyExtrasService.getStatement(compA.id, custody.id);
    await check('S6: statement shows the claim with 2 repayments, cash returned 60, remaining 940',
      st.shortageClaims.length === 1 && st.shortageClaims[0].repayments.length === 2 &&
      st.totals.cashReturned === 60 && st.totals.remaining === 940 &&
      st.movements.filter((m) => m.movementType === 'shortage_repay').length === 2);

    // S7
    let s7a = false, s7b = false, s7c = false, s7d = false;
    try { await withTenantTransaction(compA.id, (tx) => tx.query('DELETE FROM custody_shortage_claims WHERE company_id = $1', [compA.id])); } catch { s7a = true; }
    try { await withTenantTransaction(compA.id, (tx) => tx.query("UPDATE custody_shortage_claims SET memo = 'x' WHERE company_id = $1", [compA.id])); } catch { s7b = true; }
    try { await withTenantTransaction(compA.id, (tx) => tx.query('DELETE FROM custody_shortage_repayments WHERE company_id = $1', [compA.id])); } catch { s7c = true; }
    try { await withTenantTransaction(compA.id, (tx) => tx.query("UPDATE custody_shortage_repayments SET memo = 'x' WHERE company_id = $1", [compA.id])); } catch { s7d = true; }
    await check('S7: claims and repayments cannot be edited or deleted (DB triggers keep history)', s7a && s7b && s7c && s7d);

    // S8
    const settled = await defaultCustodyService.settleCustody(compA.id, custody.id, { lines: [lineOf(900)], cashReturn: 40 }, approver.id, false);
    await check('S8: final settle after the repayment must equal the remaining 940; receivable nets to zero',
      settled.status === 'settled' && (await receivableNet()) === 0);

    // S9
    const c2 = await newOpenCustody(200);
    const k2 = await defaultCustodyExtrasService.recordCashCount(compA.id, c2.id, { countedAmount: 150 }, requester.id);
    const cl2 = await defaultCustodyExtrasService.createShortageClaim(compA.id, c2.id, k2.id, {}, approver.id);
    await defaultCustodyService.settleCustody(compA.id, c2.id, { lines: [lineOf(150)], cashReturn: 50 }, approver.id, false);
    await check('S9: after the custody is settled, a claim can no longer be repaid',
      (await rejects(() => defaultCustodyExtrasService.repayShortage(compA.id, cl2.id, { amount: 10 }, approver.id, false), ValidationError)));

    // S10
    await check('S10: tenant isolation - company B cannot create or repay a company A claim',
      (await rejects(() => defaultCustodyExtrasService.repayShortage(compB.id, cl2.id, { amount: 1 }, userB.id, false), NotFoundError)) &&
      (await rejects(() => defaultCustodyExtrasService.createShortageClaim(compB.id, c2.id, k2.id, {}, userB.id), NotFoundError)));
  } catch (err) {
    await check('Custody P2a2 verification unexpected error', false, err instanceof Error ? err.message : String(err));
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
        console.error('[cleanup] Failed cleaning up verifyCustodyP2a2_1:', cleanupErr);
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
  console.error('[verifyCustodyP2a2_1] Fatal error:', err);
  process.exit(1);
});
