import pg from 'pg';
import { check, blocked, summary, CookieJarFetch, loginAs } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { hashPassword } from '../src/server/auth/passwordHash.js';
import { defaultMembershipStore } from '../src/server/org/membershipStore.js';
import { AccountService } from '../src/server/accounting/accountService.js';
import { PeriodService } from '../src/server/accounting/periodService.js';
import { defaultCompanySettingsService } from '../src/server/org/companySettingsService.js';
import { defaultCashRegisterService } from '../src/server/cash/cashRegisterService.js';

console.log('=========================================================================');
console.log('=== VERIFYING AN-CASH-CUSTODY-VOUCHERS-REPORTS-23 (HTTP E2E H1..H8)   ===');
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
  const baseUrl = (process.env.VERIFY_APP_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. HTTP E2E checks H1..H8 are BLOCKED.');
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

  const reachable = await isHttpAppReachable(baseUrl);
  if (!reachable) {
    blocked(`Running app server not reachable at ${baseUrl}/api/health. HTTP E2E checks H1..H8 are BLOCKED.`);
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Unable to connect to database executor. HTTP E2E checks H1..H8 are BLOCKED.');
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

    const commonPass = 'CashHttpPass123!';
    const passwordHash = await hashPassword(commonPass);

    const adminUser = await userRepo.createUser({
      username: `cash_http_adm_${unique}`,
      passwordHash,
      role: 'user',
    });
    const empUser = await userRepo.createUser({
      username: `cash_http_emp_${unique}`,
      passwordHash,
      role: 'user',
    });
    const otherCompanyUser = await userRepo.createUser({
      username: `cash_http_other_${unique}`,
      passwordHash,
      role: 'user',
    });
    userIds.push(adminUser.id, empUser.id, otherCompanyUser.id);

    const compA = await companyRepo.create({
      code: `CHTA-${unique}`.slice(0, 20),
      nameAr: `شركة اختبار HTTP أ ${unique}`,
      createdBy: adminUser.id,
    });
    const compB = await companyRepo.create({
      code: `CHTB-${unique}`.slice(0, 20),
      nameAr: `شركة اختبار HTTP ب ${unique}`,
      createdBy: otherCompanyUser.id,
    });
    companyIds.push(compA.id, compB.id);

    await defaultMembershipStore.addMember(adminUser.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(empUser.id, compA.id, 'company_user', true);
    await defaultMembershipStore.addMember(otherCompanyUser.id, compB.id, 'company_admin', true);

    const { accounts: accountsA } = await accountService.seedDefaultCoa(compA.id);
    await accountService.seedDefaultCoa(compB.id);

    const headerAssetA = accountsA.find((a) => a.code === '1000')!;
    const cashAccountA = accountsA.find((a) => a.code === '1100')!;
    const secondAssetA = accountsA.find((a) => a.code === '1200')!;
    const revenueAccountA = accountsA.find((a) => a.code === '4100')!;
    const expenseAccountA = accountsA.find((a) => a.code === '5100')!;
    const custodyRecA = await accountService.createAccount(compA.id, {
      code: '1260',
      nameAr: 'ذمة عهد الموظفين HTTP',
      accountType: 'asset',
      parentId: headerAssetA.id,
      isPostable: true,
    });

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(year, now.getUTCMonth() + 1, 0)).getUTCDate();
    const todayStr = now.toISOString().slice(0, 10);

    await periodService.createPeriod(
      compA.id,
      {
        code: `${year}-${month}`,
        startDate: `${year}-${month}-01`,
        endDate: `${year}-${month}-${String(lastDay).padStart(2, '0')}`,
      },
      adminUser.id
    );

    await defaultCompanySettingsService.upsertSettings(adminUser.id, compA.id, {
      custodyReceivableAccountId: custodyRecA.id,
    });

    const registerA = await defaultCashRegisterService.createRegister(
      compA.id,
      {
        code: `HTTP-REG-${unique}`.slice(0, 30),
        nameAr: 'صندوق HTTP الرئيسي',
        glAccountId: cashAccountA.id,
        openingBalance: 2000,
      },
      adminUser.id
    );

    // H1: GET /api/cash/registers without session -> 401
    const jarUnauth = new CookieJarFetch();
    const resH1 = await jarUnauth.fetch(`${baseUrl}/api/cash/registers?companyId=${compA.id}`);
    await check(`H1: GET /api/cash/registers without session returns 401 (got ${resH1.status})`, resH1.status === 401);

    // Login as company_user (empUser) & company_admin (adminUser)
    const jarEmp = new CookieJarFetch();
    const { csrfToken: csrfEmp } = await loginAs(jarEmp, baseUrl, empUser.username, commonPass);

    const jarAdmin = new CookieJarFetch();
    const { csrfToken: csrfAdmin } = await loginAs(jarAdmin, baseUrl, adminUser.username, commonPass);

    // H2: company_user GET /api/cash/registers -> 200
    const resH2 = await jarEmp.fetch(`${baseUrl}/api/cash/registers?companyId=${compA.id}`);
    const bodyH2 = await resH2.json().catch(() => ({}));
    await check(
      `H2: Authenticated company_user GET /api/cash/registers returns 200`,
      resH2.status === 200 && Array.isArray(bodyH2.registers) && bodyH2.registers.some((r: any) => r.id === registerA.id)
    );

    // H3: company_user POST /api/cash/custodies -> 201 (CUSTODY_REQUEST)
    const resH3 = await jarEmp.fetch(`${baseUrl}/api/cash/custodies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfEmp,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        companyId: compA.id,
        employeeUserId: empUser.id,
        registerId: registerA.id,
        amount: 600,
        purpose: 'اختبار رحلة العهدة عبر HTTP',
        requestDate: todayStr,
      }),
    });
    const bodyH3 = await resH3.json().catch(() => ({}));
    const createdCustodyId = bodyH3.custody?.id;
    await check(
      `H3: company_user POST /api/cash/custodies returns 201 (got ${resH3.status})`,
      resH3.status === 201 && Boolean(createdCustodyId)
    );

    // H4: company_user POST /api/cash/custodies/:id/approve -> 403 (missing CUSTODY_APPROVE)
    const resH4 = await jarEmp.fetch(`${baseUrl}/api/cash/custodies/${createdCustodyId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfEmp,
        Origin: baseUrl,
      },
      body: JSON.stringify({ companyId: compA.id }),
    });
    await check(
      `H4: company_user POST /api/cash/custodies/:id/approve returns 403 FORBIDDEN (got ${resH4.status})`,
      resH4.status === 403
    );

    // H5: company_user POST /api/cash/registers -> 403 (missing CASH_WRITE)
    const resH5 = await jarEmp.fetch(`${baseUrl}/api/cash/registers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfEmp,
        Origin: baseUrl,
      },
      body: JSON.stringify({
        companyId: compA.id,
        code: `ILL-${unique}`.slice(0, 20),
        nameAr: 'صندوق غير مصرح',
        glAccountId: secondAssetA.id,
        openingBalance: 0,
      }),
    });
    await check(
      `H5: company_user POST /api/cash/registers returns 403 FORBIDDEN (got ${resH5.status})`,
      resH5.status === 403
    );

    // H6: CSRF enforcement: POST without x-csrf-token -> 403
    const resH6 = await jarEmp.fetch(`${baseUrl}/api/cash/custodies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: baseUrl,
      },
      body: JSON.stringify({
        companyId: compA.id,
        employeeUserId: empUser.id,
        registerId: registerA.id,
        amount: 50,
        purpose: 'اختبار CSRF بدون رمز',
      }),
    });
    await check(
      `H6: POST /api/cash/custodies without x-csrf-token is rejected with 403 CSRF (got ${resH6.status})`,
      resH6.status === 403
    );

    // H7: Cross-company access GET /api/cash/custodies?companyId=compB -> 403
    const resH7 = await jarEmp.fetch(`${baseUrl}/api/cash/custodies?companyId=${compB.id}`);
    await check(
      `H7: company_user accessing another company GET /api/cash/custodies?companyId=compB returns 403 (got ${resH7.status})`,
      resH7.status === 403
    );

    // H8: Full HTTP lifecycle: approve -> disburse -> settle -> balance + voucher HTTP check
    const resApprove = await jarAdmin.fetch(`${baseUrl}/api/cash/custodies/${createdCustodyId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfAdmin, Origin: baseUrl },
      body: JSON.stringify({ companyId: compA.id }),
    });
    const resDisburse = await jarAdmin.fetch(`${baseUrl}/api/cash/custodies/${createdCustodyId}/disburse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfAdmin, Origin: baseUrl },
      body: JSON.stringify({ companyId: compA.id }),
    });
    const resSettle = await jarAdmin.fetch(`${baseUrl}/api/cash/custodies/${createdCustodyId}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfAdmin, Origin: baseUrl },
      body: JSON.stringify({
        companyId: compA.id,
        lines: [{ expenseAccountId: expenseAccountA.id, amount: 450, memo: 'فواتير مهمة HTTP' }],
        cashReturn: 150,
      }),
    });

    // Also post a receipt voucher via HTTP and verify unified register balance & movements endpoint
    const resRcvCreate = await jarAdmin.fetch(`${baseUrl}/api/cash/receipt-vouchers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfAdmin, Origin: baseUrl },
      body: JSON.stringify({
        companyId: compA.id,
        registerId: registerA.id,
        voucherDate: todayStr,
        amount: 250,
        contraAccountId: revenueAccountA.id,
        reference: 'HTTP-CRV',
      }),
    });
    const bodyRcvCreate = await resRcvCreate.json().catch(() => ({}));
    const resRcvPost = await jarAdmin.fetch(
      `${baseUrl}/api/cash/receipt-vouchers/${bodyRcvCreate.voucher?.id}/post`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfAdmin, Origin: baseUrl },
        body: JSON.stringify({ companyId: compA.id }),
      }
    );

    const resBalance = await jarAdmin.fetch(`${baseUrl}/api/cash/registers/${registerA.id}/balance?companyId=${compA.id}`);
    const bodyBalance = await resBalance.json().catch(() => ({}));
    // Expected balance = 2000 (opening) - 600 (disburse) + 150 (cashReturn) + 250 (receipt voucher) = 1800
    const h8Ok =
      resApprove.status === 200 &&
      resDisburse.status === 200 &&
      resSettle.status === 200 &&
      resRcvCreate.status === 201 &&
      resRcvPost.status === 200 &&
      resBalance.status === 200 &&
      bodyBalance.balance?.currentBalance === 1800;
    await check(
      `H8: Full HTTP cycle (approve/disburse/settle + receipt voucher) returns 200s and GET /balance === 1800 (got ${bodyBalance.balance?.currentBalance})`,
      h8Ok
    );
  } catch (err) {
    await check('HTTP E2E verification unexpected error', false, err instanceof Error ? err.message : String(err));
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
          await client.query('DELETE FROM user_sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }

        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines ENABLE TRIGGER trg_journal_lines_immutability');
        await client.query('COMMIT');
        console.log('[cleanup] HTTP E2E test companies, sessions, vouchers, custodies, and journal entries purged cleanly.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch (rbErr) {
          console.error('[cleanup] Rollback error:', rbErr);
        }
        console.error('[cleanup] Failed cleaning up verifyCashHttp1:', cleanupErr);
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
  console.error('[verifyCashHttp1] Fatal error:', err);
  process.exit(1);
});
