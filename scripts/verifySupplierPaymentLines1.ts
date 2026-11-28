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
import { defaultSupplierPaymentService } from '../src/server/purchasing/supplierPaymentService.js';
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';
import { NotFoundError, ValidationError } from '../src/server/http/errors.js';

console.log('==================================================================================');
console.log('=== VERIFYING MULTI-INVOICE SUPPLIER PAYMENTS (P1..P9) ===');
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
      username: `spl_adm_a_${unique}`,
      passwordHash: 'dummy_voucher_hash_23',
      role: 'user',
    });
    const empA = await userRepo.createUser({
      username: `spl_emp_a_${unique}`,
      passwordHash: 'dummy_voucher_hash_23',
      role: 'user',
    });
    const actorB = await userRepo.createUser({
      username: `spl_adm_b_${unique}`,
      passwordHash: 'dummy_voucher_hash_23',
      role: 'user',
    });
    userIds.push(actorA.id, empA.id, actorB.id);

    const compA = await companyRepo.create({
      code: `SPLA-${unique}`.slice(0, 20),
      nameAr: `شركة السندات أ ${unique}`,
      createdBy: actorA.id,
    });
    const compB = await companyRepo.create({
      code: `SPLB-${unique}`.slice(0, 20),
      nameAr: `شركة السندات ب ${unique}`,
      createdBy: actorB.id,
    });
    companyIds.push(compA.id, compB.id);

    await defaultMembershipStore.addMember(actorA.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(empA.id, compA.id, 'company_user', true);
    await defaultMembershipStore.addMember(actorB.id, compB.id, 'company_admin', true);

    const { accounts: accountsA } = await accountService.seedDefaultCoa(compA.id);
    await accountService.seedDefaultCoa(compB.id);

    const cashAccountA = accountsA.find((a) => a.code === '1100')!;
    const apAccountA = accountsA.find((a) => a.code === '2100') || accountsA.find((a) => a.accountType === 'liability' && a.isPostable)!;

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
    await withTenantTransaction(compA.id, async (tx) => {
      await tx.query(
        `INSERT INTO company_settings (company_id, accounts_payable_account_id) VALUES ($1, $2)
         ON CONFLICT (company_id) DO UPDATE SET accounts_payable_account_id = EXCLUDED.accounts_payable_account_id`,
        [compA.id, apAccountA.id]
      );
    });
    // Opening cash is 1000; add a big receipt-like balance so payments can be covered.
    await withTenantTransaction(compA.id, async (tx) => {
      await tx.query(`UPDATE cash_registers SET opening_balance = 100000 WHERE company_id = $1 AND id = $2`, [compA.id, registerA.id]);
    });
    const mk = async (code: string, withSetup: boolean) =>
      withTenantTransaction(compA.id, async (tx) => {
        const sup = (await tx.query<any>(`INSERT INTO purch_suppliers (company_id, code, name_ar) VALUES ($1,$2,$3) RETURNING id`, [compA.id, code, `مورد ${code}`])).rows[0].id as string;
        let grnLine: string | null = null;
        if (withSetup) {
          const wh = (await tx.query<any>(`INSERT INTO inv_warehouses (company_id, code, name_ar) VALUES ($1,$2,'مخزن') RETURNING id`, [compA.id, `W-${unique}`.slice(0, 40)])).rows[0].id;
          const it = (await tx.query<any>(`INSERT INTO inv_items (company_id, code, name_ar) VALUES ($1,$2,'صنف') RETURNING id`, [compA.id, `I-${unique}`.slice(0, 40)])).rows[0].id;
          const g = (await tx.query<any>(`INSERT INTO purch_grn (company_id, supplier_id, warehouse_id, status) VALUES ($1,$2,$3,'posted') RETURNING id`, [compA.id, sup, wh])).rows[0].id;
          grnLine = (await tx.query<any>(`INSERT INTO purch_grn_lines (grn_id, company_id, item_id, qty, unit_cost) VALUES ($1,$2,$3,1000,10) RETURNING id`, [g, compA.id, it])).rows[0].id;
          (globalThis as any).__item = it;
        }
        return { sup, grnLine };
      });
    const s1 = await mk(`S1-${unique}`.slice(0, 40), true);
    const s2 = await mk(`S2-${unique}`.slice(0, 40), false);
    const grnLine = s1.grnLine as string;
    const item = (globalThis as any).__item as string;
    const mkInvoices = async (supplierId: string, n: number, total: number) =>
      withTenantTransaction(compA.id, async (tx) => {
        const ids: string[] = [];
        for (let k = 0; k < n; k++) {
          const inv = (await tx.query<any>(
            `INSERT INTO purch_supplier_invoices (company_id, supplier_id, status, invoice_no, supplier_invoice_no, posted_at) VALUES ($1,$2,'draft',$3,$4,NULL) RETURNING id`,
            [compA.id, supplierId, `PINV-${k}-${unique}`, `SI-${k}-${unique}`]
          )).rows[0].id;
          await tx.query(`INSERT INTO purch_supplier_invoice_lines (invoice_id, company_id, grn_line_id, item_id, qty, unit_cost) VALUES ($1,$2,$3,$4,1,$5)`, [inv, compA.id, grnLine, item, total]);
          await tx.query(`UPDATE purch_supplier_invoices SET status = 'posted', posted_at = now() WHERE company_id = $1 AND id = $2`, [compA.id, inv]);
          ids.push(inv);
        }
        return ids;
      });
    const invs = await mkInvoices(s1.sup, 101, 10);
    const other = await mkInvoices(s1.sup, 0, 10);
    const [foreignInv] = await withTenantTransaction(compA.id, async (tx) => {
      const inv = (await tx.query<any>(`INSERT INTO purch_supplier_invoices (company_id, supplier_id, status, invoice_no, supplier_invoice_no, posted_at) VALUES ($1,$2,'draft','PX','SX',NULL) RETURNING id`, [compA.id, s2.sup])).rows[0].id;
      await tx.query(`INSERT INTO purch_supplier_invoice_lines (invoice_id, company_id, grn_line_id, item_id, qty, unit_cost) VALUES ($1,$2,$3,$4,1,10)`, [inv, compA.id, grnLine, item]);
      await tx.query(`UPDATE purch_supplier_invoices SET status = 'posted', posted_at = now() WHERE company_id = $1 AND id = $2`, [compA.id, inv]);
      return [inv];
    });
    void other;
    const amt = (i: number) => 1 + (i % 3);
    const mkLines = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ invoiceId: invs[from + i], amount: amt(i) }));
    const expected = (n: number) => Array.from({ length: n }, (_, i) => amt(i)).reduce((a, b) => a + b, 0);
    const P = defaultSupplierPaymentService;
    for (const n of [1, 2, 100]) {
      const c = await P.createPayment(compA.id, { supplierId: s1.sup, registerId: registerA.id, paymentDate: todayStr, lines: mkLines(n) }, actorA.id);
      await check(`P-C${n}a: payment with ${n} invoice line(s) stored with ${n} lines, header amount = sum`, c.lines?.length === n && c.amount === expected(n), `${c.lines?.length} ${c.amount}`);
      const p = await P.postPayment(compA.id, c.id, actorA.id);
      const s = await sumJe(p.journalEntryId || null);
      await check(`P-C${n}b: posts balanced JE with ${n + 1} lines (one AP debit per invoice, one credit to register)`, s.n === n + 1 && s.d === s.c && s.d === expected(n), JSON.stringify(s));
    }
    const list = await P.listPayments(compA.id);
    await check('P-L1: list exposes linesCount (1,2,100 present)', [1, 2, 100].every((n) => list.some((x) => x.linesCount === n)), JSON.stringify(list.map((x) => x.linesCount)));
    const expectErr = async (label: string, fn: () => Promise<unknown>, re: RegExp) => {
      let msg = '';
      try { await fn(); } catch (e: any) { msg = String(e.message); }
      await check(label, re.test(msg), msg || 'no error');
    };
    await expectErr('P-V1: 101 lines rejected with clear Arabic error', () => P.createPayment(compA.id, { supplierId: s1.sup, registerId: registerA.id, lines: mkLines(101) }, actorA.id), /101.*100/);
    await expectErr('P-V2: duplicate invoice in two lines rejected', () => P.createPayment(compA.id, { supplierId: s1.sup, registerId: registerA.id, lines: [{ invoiceId: invs[5], amount: 1 }, { invoiceId: invs[5], amount: 1 }] }, actorA.id), /مكررة/);
    await expectErr('P-V3: line over the open balance rejected (open is 10 - 3 = 7 for invoice #1)', () => P.createPayment(compA.id, { supplierId: s1.sup, registerId: registerA.id, lines: [{ invoiceId: invs[0], amount: 8 }] }, actorA.id), /يتجاوز الرصيد/);
    await expectErr('P-V4: invoice of another supplier rejected', () => P.createPayment(compA.id, { supplierId: s1.sup, registerId: registerA.id, lines: [{ invoiceId: foreignInv, amount: 1 }] }, actorA.id), /لا يطابق/);
    await expectErr('P-V5: zero amount line rejected', () => P.createPayment(compA.id, { supplierId: s1.sup, registerId: registerA.id, lines: [{ invoiceId: invs[3], amount: 0 }] }, actorA.id), /أكبر من الصفر/);
    const lg = await P.createPayment(compA.id, { supplierId: s1.sup, registerId: registerA.id, invoiceId: invs[50], amount: 4 }, actorA.id);
    const lgp = await P.postPayment(compA.id, lg.id, actorA.id);
    const ls = await sumJe(lgp.journalEntryId || null);
    await check('P-G1: legacy payload (invoiceId + amount) still works: 1 line, 2-line balanced JE', lg.lines?.length === 1 && ls.n === 2 && ls.d === ls.c && ls.d === 4, JSON.stringify(ls));
    const d1 = await P.createPayment(compA.id, { supplierId: s1.sup, registerId: registerA.id, lines: [{ invoiceId: invs[60], amount: 7 }] }, actorA.id);
    const d2 = await P.createPayment(compA.id, { supplierId: s1.sup, registerId: registerA.id, lines: [{ invoiceId: invs[60], amount: 7 }] }, actorA.id);
    await P.postPayment(compA.id, d1.id, actorA.id);
    await expectErr('P-G2: second draft over the same remaining balance cannot post', () => P.postPayment(compA.id, d2.id, actorA.id), /يتجاوز الرصيد/);
    const bal = await defaultCashRegisterService.getBalance(compA.id, registerA.id);
    const exp = 100000 - expected(1) - expected(2) - expected(100) - 4 - 7;
    await check('P-B1: register balance fell by the sum of all posted payments', bal.currentBalance === exp, `${bal.currentBalance} vs ${exp}`);
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

        for (const t of ['purch_supplier_payments','purch_supplier_invoice_lines','purch_supplier_invoices','purch_grn_lines','purch_grn','purch_suppliers','inv_stock_balances','inv_items','inv_warehouses']) {
          await client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [companyIds]).catch(() => undefined);
        }
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
        console.error('[cleanup] Failed cleaning up verifySupplierPaymentLines1:', cleanupErr);
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
  console.error('[verifySupplierPaymentLines1] Fatal error:', err);
  process.exit(1);
});
