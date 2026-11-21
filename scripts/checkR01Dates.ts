import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultMembershipStore } from '../src/server/org/membershipStore.js';
import { defaultAccountService } from '../src/server/accounting/accountService.js';
import { defaultPeriodService } from '../src/server/accounting/periodService.js';
import { defaultJournalService } from '../src/server/accounting/journalService.js';
import { defaultCompanySettingsRepository } from '../src/server/org/companySettingsRepository.js';
import { defaultSupplierService } from '../src/server/purchasing/supplierService.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultGrnService } from '../src/server/purchasing/grnService.js';
import { defaultInvoiceService } from '../src/server/purchasing/invoiceService.js';
import { defaultCustomerService } from '../src/server/sales/customerService.js';
import { defaultSalesInvoiceService } from '../src/server/sales/salesInvoiceService.js';
import { defaultCashRegisterService } from '../src/server/cash/cashRegisterService.js';
import { defaultVoucherService } from '../src/server/cash/voucherService.js';
import { defaultCustodyService } from '../src/server/cash/custodyService.js';
import { defaultBankAccountService } from '../src/server/banking/bankAccountService.js';
import { defaultBankReconcileService } from '../src/server/banking/bankReconcileService.js';
import { resolveCompanyToday, getBusinessDateToday } from '../src/server/lib/calendarDate.js';
import { ValidationError } from '../src/server/http/errors.js';
import { ensureTestCostingProfile } from './helpers/ensureTestCostingProfile.js';

console.log('========================================================================');
console.log(`=== AN-ERP-R01-DATES LIVE PG REGRESSION (TZ=${process.env.TZ || 'unset'}) ===`);
console.log('========================================================================');

function assertLoopbackUrl(raw: string, varName: string): URL {
  const parsed = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(`${varName} host '${parsed.hostname}' is not loopback.`);
  }
  return parsed;
}

async function expectValidationError(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (err) {
    return err instanceof ValidationError;
  }
}

async function run() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    blocked('DATABASE_URL is not set');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  try {
    assertLoopbackUrl(dbUrl, 'DATABASE_URL');
  } catch (err) {
    blocked(err instanceof Error ? err.message : String(err));
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Unable to connect to database executor.');
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

    const userA = await userRepo.createUser({
      username: `r01_a_${unique}`,
      passwordHash: 'dummy_r01_hash',
      role: 'platform_admin',
    });
    const userB = await userRepo.createUser({
      username: `r01_b_${unique}`,
      passwordHash: 'dummy_r01_hash',
      role: 'platform_admin',
    });
    userIds.push(userA.id, userB.id);

    const compA = await companyRepo.create({
      code: `R01-${unique}`.slice(0, 20),
      nameAr: `شركة اختبار التواريخ R01 ${unique}`,
      createdBy: userA.id,
    });
    companyIds.push(compA.id);
    const companyId = compA.id;
    const actorId = userA.id;
    await defaultMembershipStore.addMember(userA.id, companyId, 'company_admin', true);
    await defaultMembershipStore.addMember(userB.id, companyId, 'company_user', true);

    // 1. Setup GL Accounts & Company Settings
    const cashAcc = await defaultAccountService.createAccount(
      companyId,
      { code: `CSH-${unique}`.slice(0, 20), nameAr: 'نقدية بالصندوق', accountType: 'asset', isPostable: true },
      actorId
    );
    const bankGl = await defaultAccountService.createAccount(
      companyId,
      { code: `BNK-${unique}`.slice(0, 20), nameAr: 'حساب البنك', accountType: 'asset', isPostable: true },
      actorId
    );
    const invAcc = await defaultAccountService.createAccount(
      companyId,
      { code: `INV-${unique}`.slice(0, 20), nameAr: 'المخزون', accountType: 'asset', isPostable: true },
      actorId
    );
    const clrAcc = await defaultAccountService.createAccount(
      companyId,
      { code: `CLR-${unique}`.slice(0, 20), nameAr: 'المشتريات المعلقة', accountType: 'liability', isPostable: true },
      actorId
    );
    const apAcc = await defaultAccountService.createAccount(
      companyId,
      { code: `AP-${unique}`.slice(0, 20), nameAr: 'الموردون', accountType: 'liability', isPostable: true },
      actorId
    );
    const arAcc = await defaultAccountService.createAccount(
      companyId,
      { code: `AR-${unique}`.slice(0, 20), nameAr: 'العملاء', accountType: 'asset', isPostable: true },
      actorId
    );
    const revAcc = await defaultAccountService.createAccount(
      companyId,
      { code: `REV-${unique}`.slice(0, 20), nameAr: 'الإيرادات', accountType: 'revenue', isPostable: true },
      actorId
    );
    const expAcc = await defaultAccountService.createAccount(
      companyId,
      { code: `EXP-${unique}`.slice(0, 20), nameAr: 'مصروفات عمومية', accountType: 'expense', isPostable: true },
      actorId
    );

    await defaultCompanySettingsRepository.upsert(
      companyId,
      {
        timezone: 'Africa/Cairo',
        inventoryAccountId: invAcc.id,
        purchasesClearingAccountId: clrAcc.id,
        accountsPayableAccountId: apAcc.id,
      },
      actorId
    );

    // 2. Periods across exact calendar boundaries & leap day 2028-02-29
    const marPeriod = await defaultPeriodService.createPeriod(
      companyId,
      { code: `2026-03-${unique}`, startDate: '2026-03-01', endDate: '2026-03-31' },
      actorId
    );
    const closedJanPeriod = await defaultPeriodService.createPeriod(
      companyId,
      { code: `2026-01-${unique}`, startDate: '2026-01-01', endDate: '2026-01-31' },
      actorId
    );
    await defaultPeriodService.closePeriod(companyId, closedJanPeriod.id, actorId);

    const leapPeriod = await defaultPeriodService.createPeriod(
      companyId,
      { code: `2028-02-${unique}`, startDate: '2028-02-01', endDate: '2028-02-29' },
      actorId
    );
    const decPeriod = await defaultPeriodService.createPeriod(
      companyId,
      { code: `2026-12-${unique}`, startDate: '2026-12-01', endDate: '2026-12-31' },
      actorId
    );

    // Current Cairo year/month period for omitted-date defaults
    const cairoToday = await resolveCompanyToday(companyId);
    const [curY, curM] = cairoToday.split('-');
    const curMonthPrefix = `${curY}-${curM}`;
    if (!['2026-03', '2026-01', '2028-02', '2026-12'].includes(curMonthPrefix)) {
      const lastDayCur = new Date(Date.UTC(Number(curY), Number(curM), 0)).getUTCDate();
      await defaultPeriodService.createPeriod(
        companyId,
        {
          code: `CUR-${unique}`,
          startDate: `${curY}-${curM}-01`,
          endDate: `${curY}-${curM}-${String(lastDayCur).padStart(2, '0')}`,
        },
        actorId
      );
    }

    await check(
      'R01-L1: Accounting periods preserve exact YYYY-MM-DD boundaries including 2028-02-29',
      marPeriod.startDate === '2026-03-01' &&
        marPeriod.endDate === '2026-03-31' &&
        leapPeriod.endDate === '2028-02-29' &&
        decPeriod.endDate === '2026-12-31'
    );

    // 3. Invalid calendar dates rejected cleanly
    const invPeriodFeb29 = await expectValidationError(() =>
      defaultPeriodService.createPeriod(
        companyId,
        { code: `INV-FEB-${unique}`, startDate: '2026-02-29', endDate: '2026-03-31' },
        actorId
      )
    );
    const invJeApr31 = await expectValidationError(() =>
      defaultJournalService.createDraftEntry(
        companyId,
        {
          entryDate: '2026-04-31',
          lines: [
            { accountId: cashAcc.id, debit: 50, credit: 0 },
            { accountId: revAcc.id, debit: 0, credit: 50 },
          ],
        },
        actorId,
        true
      )
    );
    const invJeM13 = await expectValidationError(() =>
      defaultJournalService.createDraftEntry(
        companyId,
        {
          entryDate: '2026-13-01',
          lines: [
            { accountId: cashAcc.id, debit: 50, credit: 0 },
            { accountId: revAcc.id, debit: 0, credit: 50 },
          ],
        },
        actorId,
        true
      )
    );
    await check(
      'R01-L2: Invalid calendar dates (2026-02-29, 2026-04-31, 2026-13-01) rejected with ValidationError',
      invPeriodFeb29 && invJeApr31 && invJeM13
    );

    // 4. Boundary Journal Entry round-trip + closed period guard + out-of-range guard
    const jeStart = await defaultJournalService.createDraftEntry(
      companyId,
      {
        entryDate: '2026-03-01',
        memo: 'Boundary start',
        lines: [
          { accountId: cashAcc.id, debit: 100, credit: 0 },
          { accountId: revAcc.id, debit: 0, credit: 100 },
        ],
      },
      actorId,
      true
    );
    const postedStart = await defaultJournalService.postEntry(companyId, jeStart.id, actorId, true);

    const jeLeap = await defaultJournalService.createDraftEntry(
      companyId,
      {
        entryDate: '2028-02-29',
        memo: 'Leap boundary',
        lines: [
          { accountId: cashAcc.id, debit: 200, credit: 0 },
          { accountId: revAcc.id, debit: 0, credit: 200 },
        ],
      },
      actorId,
      true
    );
    const postedLeap = await defaultJournalService.postEntry(companyId, jeLeap.id, actorId, true);

    const jeClosedDraft = await defaultJournalService.createDraftEntry(
      companyId,
      {
        entryDate: '2026-01-31',
        memo: 'Closed period boundary',
        lines: [
          { accountId: cashAcc.id, debit: 75, credit: 0 },
          { accountId: revAcc.id, debit: 0, credit: 75 },
        ],
      },
      actorId,
      true
    );
    const closedRejected = await expectValidationError(() =>
      defaultJournalService.postEntry(companyId, jeClosedDraft.id, actorId, true)
    );

    const jeUncoveredDraft = await defaultJournalService.createDraftEntry(
      companyId,
      {
        entryDate: '2026-04-01',
        memo: 'No covering period',
        lines: [
          { accountId: cashAcc.id, debit: 75, credit: 0 },
          { accountId: revAcc.id, debit: 0, credit: 75 },
        ],
      },
      actorId,
      true
    );
    const uncoveredRejected = await expectValidationError(() =>
      defaultJournalService.postEntry(companyId, jeUncoveredDraft.id, actorId, true)
    );

    await check(
      'R01-L3: Journal entries round-trip exact 2026-03-01 & 2028-02-29 across TZ while closed/uncovered periods block',
      jeStart.entryDate === '2026-03-01' &&
        postedStart.entryDate === '2026-03-01' &&
        postedLeap.entryDate === '2028-02-29' &&
        closedRejected &&
        uncoveredRejected
    );

    // 5. Purchasing & Sales Invoices exact calendar dates
    const supplier = await defaultSupplierService.createSupplier(
      companyId,
      { code: `SUP-${unique}`.slice(0, 20), nameAr: 'مورد R01' },
      actorId
    );
    const wh = await defaultWarehouseService.createWarehouse(
      companyId,
      { code: `WH-${unique}`.slice(0, 20), nameAr: 'مستودع R01' },
      actorId
    );
    const item = await defaultItemService.createItem(
      companyId,
      { code: `ITM-${unique}`.slice(0, 20), nameAr: 'صنف R01', uom: 'حبة' },
      actorId
    );
    await ensureTestCostingProfile(companyId, [item.id], actorId);

    const grn = await defaultGrnService.createGrn(
      companyId,
      {
        supplierId: supplier.id,
        warehouseId: wh.id,
        lines: [{ itemId: item.id, qty: 5, unitCost: 100 }],
      },
      actorId
    );
    await defaultGrnService.postGrn(companyId, grn.id, actorId);
    const grnLineId = (await defaultGrnService.getGrn(companyId, grn.id)).lines![0].id;

    const pInv = await defaultInvoiceService.createInvoice(
      companyId,
      {
        supplierId: supplier.id,
        supplierInvoiceNo: `PINV-${unique}`,
        invoiceDate: '2026-03-01',
        dueDate: '2026-03-31',
        lines: [{ grnLineId, qty: 2, unitCost: 100 }],
      },
      actorId
    );
    const pInvPosted = await defaultInvoiceService.postInvoice(companyId, pInv.id, actorId);
    const pInvBadDate = await expectValidationError(() =>
      defaultInvoiceService.createInvoice(
        companyId,
        {
          supplierId: supplier.id,
          supplierInvoiceNo: `PINV-BAD-${unique}`,
          invoiceDate: '2026-02-29',
          lines: [{ grnLineId, qty: 1, unitCost: 100 }],
        },
        actorId
      )
    );

    const customer = await defaultCustomerService.createCustomer(
      companyId,
      { code: `CST-${unique}`.slice(0, 20), nameAr: 'عميل R01' },
      actorId
    );
    const sInv = await defaultSalesInvoiceService.createInvoice(
      companyId,
      {
        customerId: customer.id,
        invoiceDate: '2026-03-01',
        dueDate: '2026-03-31',
        lines: [{ itemId: item.id, qty: 1, unitPrice: 150, taxRate: 0 }],
      },
      actorId
    );
    const sInvBadDate = await expectValidationError(() =>
      defaultSalesInvoiceService.createInvoice(
        companyId,
        {
          customerId: customer.id,
          invoiceDate: '2026-04-31',
          lines: [{ itemId: item.id, qty: 1, unitPrice: 150, taxRate: 0 }],
        },
        actorId
      )
    );

    await check(
      'R01-L4: Purchase & Sales invoices preserve exact 2026-03-01/2026-03-31 dates and reject invalid dates',
      pInv.invoiceDate === '2026-03-01' &&
        pInv.dueDate === '2026-03-31' &&
        pInvPosted.invoiceDate === '2026-03-01' &&
        sInv.invoiceDate === '2026-03-01' &&
        sInv.dueDate === '2026-03-31' &&
        pInvBadDate &&
        sInvBadDate
    );

    // 6. Cash vouchers, Custody, Banking & Timezone consistency
    const reg = await defaultCashRegisterService.createRegister(
      companyId,
      { code: `CR-${unique}`.slice(0, 20), nameAr: 'صندوق R01', glAccountId: cashAcc.id, openingBalance: 1000 },
      actorId
    );
    const vchMarch = await defaultVoucherService.createReceiptVoucher(
      companyId,
      {
        registerId: reg.id,
        contraAccountId: revAcc.id,
        amount: 50,
        voucherDate: '2026-03-01',
      },
      actorId
    );
    const vchOmitted = await defaultVoucherService.createReceiptVoucher(
      companyId,
      {
        registerId: reg.id,
        contraAccountId: revAcc.id,
        amount: 25,
      },
      actorId
    );
    const cus = await defaultCustodyService.requestCustody(
      companyId,
      {
        employeeUserId: userB.id,
        registerId: reg.id,
        amount: 100,
        purpose: 'اختبار العهدة R01',
        requestDate: '2028-02-29',
      },
      actorId
    );
    const vchBadDate = await expectValidationError(() =>
      defaultVoucherService.createReceiptVoucher(
        companyId,
        {
          registerId: reg.id,
          contraAccountId: revAcc.id,
          amount: 10,
          voucherDate: '2026-02-29',
        },
        actorId
      )
    );

    const bankAcc = await defaultBankAccountService.createAccount(
      companyId,
      {
        code: `BA-${unique}`.slice(0, 20),
        nameAr: 'بنك R01',
        bankName: 'بنك الاختبار',
        currencyCode: 'EGP',
        glAccountId: bankGl.id,
        openingBalance: 0,
      },
      actorId
    );
    const [stmtLine] = await defaultBankReconcileService.addStatementLines(
      companyId,
      bankAcc.id,
      [{ statementDate: '2026-03-01', description: 'إيداع', debitAmount: 0, creditAmount: 100 }],
      actorId
    );
    const bankBadDate = await expectValidationError(() =>
      defaultBankReconcileService.addStatementLines(
        companyId,
        bankAcc.id,
        [{ statementDate: '2026-02-29', description: 'خطأ', debitAmount: 0, creditAmount: 10 }],
        actorId
      )
    );

    const lateNightInstant = new Date('2026-03-01T22:30:00.000Z');
    const expectedCairoToday = getBusinessDateToday('Africa/Cairo', lateNightInstant);
    const expectedNyToday = getBusinessDateToday('America/New_York', lateNightInstant);

    await check(
      'R01-L5: Cash, Custody, Bank statement dates and company timezone (Africa/Cairo 22:30Z = next day) behave consistently',
      vchMarch.voucherDate === '2026-03-01' &&
        vchOmitted.voucherDate === cairoToday &&
        cus.requestDate === '2028-02-29' &&
        stmtLine.statementDate === '2026-03-01' &&
        vchBadDate &&
        bankBadDate &&
        expectedCairoToday === '2026-03-02' &&
        expectedNyToday === '2026-03-01'
    );
  } catch (err) {
    console.error('[checkR01Dates] Fatal test error:', err);
    blocked(err instanceof Error ? err.message : String(err));
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

        await client.query('DELETE FROM fin_bank_statement_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM fin_bank_reconciliations WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM fin_bank_accounts WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM cash_receipt_vouchers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM cash_payment_vouchers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM custody_movements WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM custody_records WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM cash_registers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_invoice_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_invoices WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM sales_customers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_supplier_invoice_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_supplier_invoices WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_grn_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_grn WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_cost_adjustments WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_cost_allocations WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_valuation_movements WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_cost_layers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_valuation_balances WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_item_costing_profiles WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_costing_profiles WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_stock_movements WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_stock_balances WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM journal_lines WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM journal_entries WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM company_settings WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounting_periods WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounting_sequences WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM accounts WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_items WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM inv_warehouses WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM purch_suppliers WHERE company_id = ANY($1::uuid[])', [companyIds]);
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
      } catch (cleanupErr) {
        cleanupFailed = true;
        try {
          await client.query('ROLLBACK');
        } catch (_rollbackErr) {
          console.error('[cleanup] rollback error:', _rollbackErr);
        }
        console.error('[cleanup] Failed cleaning up checkR01Dates:', cleanupErr);
      } finally {
        await client.end();
      }
    }
    await closeAllExecutors();
  }

  const { exitCode } = summary();
  if (cleanupFailed) {
    console.error('[cleanup] Cleanup failed. Failing test.');
    process.exit(1);
  }
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[checkR01Dates] Fatal error:', err);
  process.exit(1);
});
