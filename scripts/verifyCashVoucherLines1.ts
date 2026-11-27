import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultMembershipStore } from '../src/server/org/membershipStore.js';
import { AccountService } from '../src/server/accounting/accountService.js';
import { PeriodService } from '../src/server/accounting/periodService.js';
import { defaultJournalRepository } from '../src/server/accounting/journalRepository.js';
import { defaultCashRegisterService } from '../src/server/cash/cashRegisterService.js';
import { defaultCustodyService } from '../src/server/cash/custodyService.js';
import { defaultVoucherService } from '../src/server/cash/voucherService.js';
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';
import { NotFoundError, ValidationError } from '../src/server/http/errors.js';

console.log('==================================================================================');
console.log('=== VERIFYING MULTI-LINE CASH VOUCHERS (M1..M9) ===');
console.log('==================================================================================');

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
    blocked('DATABASE_URL is not set. Live DB checks V1..V11 are BLOCKED.');
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
    blocked('Unable to connect to database executor. Live DB checks V1..V11 are BLOCKED.');
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

    const actorA = await userRepo.createUser({
      username: `vch_adm_a_${unique}`,
      passwordHash: 'dummy_voucher_hash_23',
      role: 'user',
    });
    const empA = await userRepo.createUser({
      username: `vch_emp_a_${unique}`,
      passwordHash: 'dummy_voucher_hash_23',
      role: 'user',
    });
    const actorB = await userRepo.createUser({
      username: `vch_adm_b_${unique}`,
      passwordHash: 'dummy_voucher_hash_23',
      role: 'user',
    });
    userIds.push(actorA.id, empA.id, actorB.id);

    const compA = await companyRepo.create({
      code: `VCHA-${unique}`.slice(0, 20),
      nameAr: `شركة السندات أ ${unique}`,
      createdBy: actorA.id,
    });
    const compB = await companyRepo.create({
      code: `VCHB-${unique}`.slice(0, 20),
      nameAr: `شركة السندات ب ${unique}`,
      createdBy: actorB.id,
    });
    companyIds.push(compA.id, compB.id);

    await defaultMembershipStore.addMember(actorA.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(empA.id, compA.id, 'company_user', true);
    await defaultMembershipStore.addMember(actorB.id, compB.id, 'company_admin', true);

    const { accounts: accountsA } = await accountService.seedDefaultCoa(compA.id);
    await accountService.seedDefaultCoa(compB.id);

    const headerAssetA = accountsA.find((a) => a.code === '1000')!; // non-postable
    const cashAccountA = accountsA.find((a) => a.code === '1100')!; // postable asset
    const revenueAccountA = accountsA.find((a) => a.code === '4100')!; // postable revenue
    const expenseAccountA = accountsA.find((a) => a.code === '5100')!; // postable expense

    const inactiveExpenseA = await accountService.createAccount(compA.id, {
      code: '5999',
      nameAr: 'مصروف موقوف',
      accountType: 'expense',
      parentId: accountsA.find((a) => a.code === '5000')!.id,
      isPostable: true,
    });
    await withTenantTransaction(compA.id, async (tx) => {
      await tx.query('UPDATE accounts SET is_active = false WHERE company_id = $1 AND id = $2', [
        compA.id,
        inactiveExpenseA.id,
      ]);
    });

    const custodyReceivableA = await accountService.createAccount(compA.id, {
      code: '1255',
      nameAr: 'ذمة عهد الموظفين',
      accountType: 'asset',
      parentId: headerAssetA.id,
      isPostable: true,
    });

    // Open accounting period covering today + full current month
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(year, now.getUTCMonth() + 1, 0)).getUTCDate();
    const todayStr = now.toISOString().slice(0, 10);
    const startOfMonth = `${year}-${month}-01`;
    const endOfMonth = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

    await periodService.createPeriod(
      compA.id,
      {
        code: `${year}-${month}`,
        startDate: startOfMonth,
        endDate: endOfMonth,
      },
      actorA.id
    );

    const registerA = await defaultCashRegisterService.createRegister(
      compA.id,
      {
        code: `CASH-V-${unique}`.slice(0, 30),
        nameAr: 'صندوق السندات الرئيسي',
        glAccountId: cashAccountA.id,
        openingBalance: 1000,
      },
      actorA.id
    );

    const sumJe = async (jeId: string | null) => {
      const je = jeId ? await defaultJournalRepository.findById(compA.id, jeId) : null;
      const lines: any[] = (je as any)?.lines || [];
      const d = lines.reduce((a, l) => a + Number(l.debit || 0), 0);
      const c = lines.reduce((a, l) => a + Number(l.credit || 0), 0);
      return { n: lines.length, d: Math.round(d * 100) / 100, c: Math.round(c * 100) / 100 };
    };
    const mkLines = (n: number, acct: string) => Array.from({ length: n }, (_, i) => ({ accountId: acct, amount: 1 + (i % 3), memo: `بند ${i + 1}` }));
    const expectedTotal = (n: number) => Array.from({ length: n }, (_, i) => 1 + (i % 3)).reduce((a, b) => a + b, 0);
    let bal = 1000;
    for (const n of [1, 2, 100]) {
      const rv = await defaultVoucherService.createReceiptVoucher(compA.id, { registerId: registerA.id, voucherDate: todayStr, lines: mkLines(n, revenueAccountA.id) }, actorA.id);
      await check(`M-R${n}a: receipt with ${n} line(s) stored with ${n} lines, header amount = sum`, (rv.lines?.length === n) && rv.amount === expectedTotal(n));
      const rp = await defaultVoucherService.postReceiptVoucher(compA.id, rv.id, actorA.id, false);
      const s = await sumJe(rp.journalEntryId);
      await check(`M-R${n}b: receipt ${n} line(s) posts balanced JE with ${n + 1} lines`, s.n === n + 1 && s.d === s.c && s.d === expectedTotal(n), JSON.stringify(s));
      bal += expectedTotal(n);
    }
    const b1 = await defaultCashRegisterService.getBalance(compA.id, registerA.id);
    await check('M-R4: register balance rose by the sum of all receipt lines', b1.currentBalance === bal, `${b1.currentBalance} vs ${bal}`);
    for (const n of [1, 2, 100]) {
      const pv = await defaultVoucherService.createPaymentVoucher(compA.id, { registerId: registerA.id, voucherDate: todayStr, lines: mkLines(n, expenseAccountA.id) }, actorA.id);
      const pp = await defaultVoucherService.postPaymentVoucher(compA.id, pv.id, actorA.id, false);
      const s = await sumJe(pp.journalEntryId);
      await check(`M-P${n}: payment ${n} line(s) posts balanced JE with ${n + 1} lines (one debit per line, one credit to register)`, s.n === n + 1 && s.d === s.c && s.d === expectedTotal(n), JSON.stringify(s));
      bal -= expectedTotal(n);
    }
    const b2 = await defaultCashRegisterService.getBalance(compA.id, registerA.id);
    await check('M-P4: register balance fell by the sum of all payment lines', b2.currentBalance === bal, `${b2.currentBalance} vs ${bal}`);
    for (const kind of ['receipt', 'payment'] as const) {
      const create = kind === 'receipt' ? defaultVoucherService.createReceiptVoucher.bind(defaultVoucherService) : defaultVoucherService.createPaymentVoucher.bind(defaultVoucherService);
      let msg = '';
      try { await create(compA.id, { registerId: registerA.id, voucherDate: todayStr, lines: mkLines(101, expenseAccountA.id) }, actorA.id); } catch (e: any) { msg = String(e.message); }
      await check(`M-X101-${kind}: 101 lines rejected with clear Arabic message`, msg.includes('100') && msg.includes('الحد الأقصى'), msg.slice(0, 80));
      let bad = '';
      try { await create(compA.id, { registerId: registerA.id, voucherDate: todayStr, lines: [{ accountId: expenseAccountA.id, amount: 5 }, { accountId: headerAssetA.id, amount: 5 }] }, actorA.id); } catch (e: any) { bad = String(e.message); }
      await check(`M-BAD-${kind}: a non-postable account on any line rejects the whole voucher`, bad.includes('غير قابل للترحيل'), bad.slice(0, 80));
    }
    const legacy = await defaultVoucherService.createReceiptVoucher(compA.id, { registerId: registerA.id, voucherDate: todayStr, amount: 7, contraAccountId: revenueAccountA.id }, actorA.id);
    const lp = await defaultVoucherService.postReceiptVoucher(compA.id, legacy.id, actorA.id, false);
    const ls = await sumJe(lp.journalEntryId);
    await check('M-LEG: legacy single amount + contraAccountId payload still works (1 line, JE 2 lines)', legacy.lines?.length === 1 && ls.n === 2 && ls.d === 7 && ls.c === 7, JSON.stringify(ls));
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

        await client.query('DELETE FROM cash_receipt_vouchers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM cash_payment_vouchers WHERE company_id = ANY($1::uuid[])', [companyIds]);
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

        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines ENABLE TRIGGER trg_journal_lines_immutability');
        await client.query('COMMIT');
        console.log('[cleanup] Test companies, vouchers, custodies, and journal entries purged cleanly.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch (rbErr) {
          console.error('[cleanup] Rollback error:', rbErr);
        }
        console.error('[cleanup] Failed cleaning up verifyCashVoucherLines1:', cleanupErr);
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
  console.error('[verifyCashVoucherLines1] Fatal error:', err);
  process.exit(1);
});
