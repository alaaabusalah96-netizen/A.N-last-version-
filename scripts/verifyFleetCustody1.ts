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
import { defaultCustodyVoucherService } from '../src/server/cash/custodyVoucherService.js';
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../src/server/http/errors.js';
import { defaultFleetService } from '../src/server/fleet/fleetService.js';
import { defaultFleetExpenseService } from '../src/server/fleet/fleetExpenseService.js';

console.log('========================================================================');
console.log('=== VERIFYING FLEET-C2 (fleet expenses paid from custody) ===');
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
  if (!dbUrl || dbUrl.trim() === '') { blocked('DATABASE_URL is not set. Live DB checks are BLOCKED.'); process.exit(summary().exitCode); return; }
  try {
    assertLoopbackUrl(dbUrl, 'DATABASE_URL');
    if (process.env.MIGRATION_DATABASE_URL) assertLoopbackUrl(process.env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL');
  } catch (err) { blocked(err instanceof Error ? err.message : String(err)); process.exit(summary().exitCode); return; }
  const executor = await getDefaultExecutor();
  if (!executor) { blocked('Unable to connect to database executor. Live DB checks are BLOCKED.'); process.exit(summary().exitCode); return; }

  const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const companyIds: string[] = [];
  const userIds: string[] = [];
  let cleanupFailed = false;
  const rejects = async (fn: () => Promise<unknown>, cls: any) => { try { await fn(); return false; } catch (e) { return e instanceof cls; } };
  try {
    const companyRepo = new CompanyRepository();
    const userRepo = new UserRepository();
    const accountService = new AccountService();
    const periodService = new PeriodService();
    const holder = await userRepo.createUser({ username: `fc_h_${unique}`, passwordHash: 'dummy_fc_hash', role: 'user' });
    const approver = await userRepo.createUser({ username: `fc_a_${unique}`, passwordHash: 'dummy_fc_hash', role: 'user' });
    const other = await userRepo.createUser({ username: `fc_o_${unique}`, passwordHash: 'dummy_fc_hash', role: 'user' });
    const userB = await userRepo.createUser({ username: `fc_b_${unique}`, passwordHash: 'dummy_fc_hash', role: 'user' });
    userIds.push(holder.id, approver.id, other.id, userB.id);
    const compA = await companyRepo.create({ code: `FCA-${unique}`.slice(0, 20), nameAr: `شركة عهدة أسطول أ ${unique}`, createdBy: holder.id });
    const compB = await companyRepo.create({ code: `FCB-${unique}`.slice(0, 20), nameAr: `شركة عهدة أسطول ب ${unique}`, createdBy: userB.id });
    companyIds.push(compA.id, compB.id);
    for (const u of [holder, approver, other]) await defaultMembershipStore.addMember(u.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(userB.id, compB.id, 'company_admin', true);
    const { accounts } = await accountService.seedDefaultCoa(compA.id);
    await accountService.seedDefaultCoa(compB.id);
    const headerAsset = accounts.find((a) => a.code === '1000')!;
    const cashAccount = accounts.find((a) => a.code === '1100')!;
    const expenseAccount = accounts.find((a) => a.code === '5100')!;
    const custodyReceivable = await accountService.createAccount(compA.id, { code: '1250', nameAr: 'ذمة عهد الموظفين', accountType: 'asset', parentId: headerAsset.id, isPostable: true });
    const now = new Date();
    const year = now.getUTCFullYear(); const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(year, now.getUTCMonth() + 1, 0)).getUTCDate();
    await periodService.createPeriod(compA.id, { code: `${year}-${month}`, startDate: `${year}-${month}-01`, endDate: `${year}-${month}-${String(lastDay).padStart(2, '0')}` }, holder.id);
    const dt = `${year}-${month}-${String(Math.min(now.getUTCDate(), lastDay)).padStart(2, '0')}`;
    const register = await defaultCashRegisterService.createRegister(compA.id, { code: `REG-FC-${unique}`.slice(0, 30), nameAr: 'خزينة', glAccountId: cashAccount.id, openingBalance: 100000 }, holder.id);
    await defaultCompanySettingsService.upsertSettings(holder.id, compA.id, { custodyReceivableAccountId: custodyReceivable.id });
    const newCustody = async (amount: number) => {
      const c = await defaultCustodyService.requestCustody(compA.id, { employeeUserId: holder.id, registerId: register.id, amount, purpose: 'عهدة أسطول' }, holder.id);
      await defaultCustodyService.approveCustody(compA.id, c.id, approver.id, false);
      return await defaultCustodyService.disburseCustody(compA.id, c.id, approver.id, false);
    };
    const V1 = await defaultFleetService.createVehicle(compA.id, { code: 'V-1', plateNo: 'C 111' }, holder.id);
    const svc = defaultFleetExpenseService;
    const cat = await svc.createCategory(compA.id, { code: 'FUEL', nameAr: 'وقود', expenseAccountId: expenseAccount.id }, holder.id);
    const approvedExpense = async (amount: number) => {
      const x = await svc.createExpense(compA.id, { vehicleId: V1.id, categoryId: cat.id, expenseDate: dt, amount, description: 'وقود من العهدة' }, holder.id);
      return await svc.approveExpense(compA.id, x.id, approver.id);
    };
    const net = async (accountId: string) => withTenantTransaction(compA.id, async (tx) =>
      Number((await tx.query<any>('SELECT COALESCE(SUM(debit - credit),0)::text AS n FROM journal_lines WHERE company_id=$1 AND account_id=$2', [compA.id, accountId])).rows[0].n));

    const custody = await newCustody(1000);
    const recBefore = await net(custodyReceivable.id);
    const expBefore = await net(expenseAccount.id);
    const X1 = await approvedExpense(250.5);
    const draftX = await svc.createExpense(compA.id, { vehicleId: V1.id, categoryId: cat.id, expenseDate: dt, amount: 5, description: 'مسودة' }, holder.id);
    await check('C1: a draft expense cannot be paid from custody; only approved ones',
      await rejects(() => svc.payFromCustody(compA.id, draftX.id, custody.id, holder.id), ConflictError));
    await check('C2: only the custody holder may spend from it (another user is refused)',
      await rejects(() => svc.payFromCustody(compA.id, X1.id, custody.id, other.id), ForbiddenError));
    const X1p = await svc.payFromCustody(compA.id, X1.id, custody.id, holder.id);
    const vouchers = await defaultCustodyVoucherService.listVouchers(compA.id, custody.id);
    await check('C3: paying from custody submits a one-line voucher for the same amount, links it, and posts nothing yet',
      X1p.status === 'approved' && X1p.custodyVoucherId === vouchers[0]?.id && vouchers.length === 1 && vouchers[0].status === 'submitted' &&
      vouchers[0].totalAmount === 250.5 && vouchers[0].lines[0].expenseAccountId === expenseAccount.id &&
      (await net(custodyReceivable.id)) === recBefore && (await net(expenseAccount.id)) === expBefore);
    await check('C4: a linked expense cannot be paid twice, posted directly, rejected or reversed from the fleet screen',
      (await rejects(() => svc.payFromCustody(compA.id, X1.id, custody.id, holder.id), ConflictError)) &&
      (await rejects(() => svc.postExpense(compA.id, X1.id, cashAccount.id, approver.id), ConflictError)) &&
      (await rejects(() => svc.rejectExpense(compA.id, X1.id, 'x', approver.id), ConflictError)) &&
      (await rejects(() => svc.reverseExpense(compA.id, X1.id, 'x', approver.id), ConflictError)));
    await check('C5: the voucher submitter cannot approve their own voucher (separation of duties)',
      await rejects(() => defaultCustodyVoucherService.approveVoucher(compA.id, vouchers[0].id, holder.id, false), ForbiddenError));
    await defaultCustodyVoucherService.approveVoucher(compA.id, vouchers[0].id, approver.id, false);
    const X1c = await svc.getExpense(compA.id, X1.id);
    const vAfter = (await defaultCustodyVoucherService.listVouchers(compA.id, custody.id))[0];
    await check('C6: approving the voucher posts the fleet expense with the same journal entry, counter = custody receivable',
      X1c.status === 'posted' && X1c.journalEntryId === vAfter.journalEntryId && X1c.counterAccountId === custodyReceivable.id && X1c.postedBy === approver.id);
    await check('C7: ledger: expense account +250.50 debit and custody receivable -250.50 credit, exactly once',
      (await net(expenseAccount.id)) - expBefore === 250.5 && (await net(custodyReceivable.id)) - recBefore === -250.5);
    const X2 = await approvedExpense(100);
    const X2p = await svc.payFromCustody(compA.id, X2.id, custody.id, holder.id);
    await defaultCustodyVoucherService.rejectVoucher(compA.id, X2p.custodyVoucherId!, 'غير مقبول', approver.id);
    const X2r = await svc.getExpense(compA.id, X2.id);
    await check('C8: a rejected voucher frees the expense (link cleared, still approved, no journal entry)',
      X2r.status === 'approved' && X2r.custodyVoucherId === null && X2r.journalEntryId === null);
    const X2post = await svc.postExpense(compA.id, X2.id, cashAccount.id, approver.id);
    await check('C9: the freed expense can then be posted the normal way', X2post.status === 'posted');
    const X3 = await approvedExpense(300);
    const X3p = await svc.payFromCustody(compA.id, X3.id, custody.id, holder.id);
    await defaultCustodyVoucherService.approveVoucher(compA.id, X3p.custodyVoucherId!, approver.id, false);
    await defaultCustodyVoucherService.reverseVoucher(compA.id, X3p.custodyVoucherId!, 'خطأ في الإدخال', approver.id, false);
    const X3r = await svc.getExpense(compA.id, X3.id);
    await check('C10: reversing the voucher reverses the fleet expense (reversal entry, reason kept) and the ledger nets to zero for it',
      X3r.status === 'reversed' && !!X3r.reversalEntryId && X3r.reverseReason === 'خطأ في الإدخال' && (await net(expenseAccount.id)) - expBefore === 250.5 + 100);
    const X4 = await approvedExpense(900);
    await check('C11: an amount above the custody remaining balance is refused and nothing is linked (atomic)',
      (await rejects(() => svc.payFromCustody(compA.id, X4.id, custody.id, holder.id), ValidationError)) &&
      (await svc.getExpense(compA.id, X4.id)).custodyVoucherId === null &&
      (await defaultCustodyVoucherService.listVouchers(compA.id, custody.id)).length === 3);
    const pendingC = await defaultCustodyService.requestCustody(compA.id, { employeeUserId: holder.id, registerId: register.id, amount: 50, purpose: 'غير مصروفة' }, holder.id);
    await check('C12: a custody that is not open (not disbursed) is refused; unknown custody is not found',
      (await rejects(() => svc.payFromCustody(compA.id, X4.id, pendingC.id, holder.id), ValidationError)) &&
      (await rejects(() => svc.payFromCustody(compA.id, X4.id, '00000000-0000-4000-8000-000000000000', holder.id), NotFoundError)) &&
      (await rejects(() => svc.payFromCustody(compA.id, X4.id, 'bad', holder.id), ValidationError)));
    await check('C13: tenant isolation: company B cannot pay a company A expense from a custody',
      await rejects(() => svc.payFromCustody(compB.id, X4.id, custody.id, userB.id), NotFoundError));
    const cl = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl));
    await cl.connect();
    const au = await cl.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE company_id = $1 AND action = 'FLEET_EXPENSE_CUSTODY_SUBMITTED'`, [compA.id]);
    await cl.end();
    await check('C14: every custody payment request has an audit record (3 submitted)', au.rows[0].n === 3, `n=${au.rows[0].n}`);
  } catch (err) {
    await check('Fleet C2 verification unexpected error', false, err instanceof Error ? err.message : String(err));
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
        for (const t of ['fleet_expenses','fleet_expense_categories','fleet_vehicles']) await client.query(`ALTER TABLE ${t} DISABLE TRIGGER trg_${t}_no_delete`);
        for (const t of ['fleet_expenses','fleet_expense_categories','fleet_vehicles']) await client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [companyIds]);
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

        for (const t of ['fleet_expenses','fleet_expense_categories','fleet_vehicles']) await client.query(`ALTER TABLE ${t} ENABLE TRIGGER trg_${t}_no_delete`);
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
        console.error('[cleanup] Failed cleaning up verifyFleetCustody1:', cleanupErr);
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
  console.error('[verifyFleetCustody1] Fatal error:', err);
  process.exit(1);
});
