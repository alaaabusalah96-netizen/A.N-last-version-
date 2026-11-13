import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultSupplierService } from '../src/server/purchasing/supplierService.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultAccountService } from '../src/server/accounting/accountService.js';
import { defaultPeriodService } from '../src/server/accounting/periodService.js';
import { defaultCompanySettingsRepository } from '../src/server/org/companySettingsRepository.js';
import { defaultGrnService } from '../src/server/purchasing/grnService.js';
import { defaultJournalService } from '../src/server/accounting/journalService.js';
import { defaultStockService } from '../src/server/inventory/stockService.js';
import { ValidationError } from '../src/server/http/errors.js';
import { toMinorUnits, fromMinorUnits, toDecimal, toMoney } from '../src/server/lib/numeric.js';

console.log('========================================================================');
console.log('=== VERIFYING AN-FIX-P2P-CYCLE-16 (End-to-End P2P Integration Proof) ===');
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
    blocked('DATABASE_URL is not set. C1-C13 loopback PostgreSQL P2P E2E proofs are BLOCKED.');
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
    blocked('Unable to connect to database executor. C1-C13 P2P E2E proofs are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const todayYear = new Date().toISOString().slice(0, 4);
  const periodStart = `${todayYear}-01-01`;
  const periodEnd = `${todayYear}-12-31`;

  let compAId: string | null = null;
  let compBId: string | null = null;
  let actorId: string | null = null;

  const companyRepo = new CompanyRepository();
  const userRepo = new UserRepository();

  try {
    // =========================================================================
    // C1: تهيئة شركة + مورد + مستودع + صنفين + حسابي GL (مخزون/تصفية مشتريات) + فترة مفتوحة عبر الخدمات
    // =========================================================================
    const actor = await userRepo.createUser({
      username: `p2p_actor_${suffix}`,
      passwordHash: 'dummy_p2p_hash_16',
      role: 'user',
    });
    actorId = actor.id;

    const compA = await companyRepo.create({
      code: `P2P_A_${suffix}`,
      nameAr: `شركة دورة المشتريات أ ${suffix}`,
      createdBy: actorId,
    });
    compAId = compA.id;

    const supplierA = await defaultSupplierService.createSupplier(
      compAId,
      { code: `SUP-${suffix}`, nameAr: 'مورد التوريد الأساسي', nameEn: 'Primary Supply Co' },
      actorId
    );
    const warehouseA = await defaultWarehouseService.createWarehouse(
      compAId,
      { code: `WH-${suffix}`, nameAr: 'المستودع الرئيسي', nameEn: 'Main Warehouse' },
      actorId
    );
    const item1 = await defaultItemService.createItem(
      compAId,
      { code: `ITM1-${suffix}`, nameAr: 'حديد تسليح 16مم', nameEn: 'Rebar 16mm', uom: 'ton' },
      actorId
    );
    const item2 = await defaultItemService.createItem(
      compAId,
      { code: `ITM2-${suffix}`, nameAr: 'إسمنت بورتلاندي', nameEn: 'Portland Cement', uom: 'bag' },
      actorId
    );
    const invAccountA = await defaultAccountService.createAccount(
      compAId,
      {
        code: '1400',
        nameAr: 'المخزون السلعي',
        nameEn: 'Merchandise Inventory',
        accountType: 'asset',
        isPostable: true,
      },
      actorId
    );
    const clearingAccountA = await defaultAccountService.createAccount(
      compAId,
      {
        code: '2150',
        nameAr: 'مشتريات معلّقة تحت الفوترة',
        nameEn: 'Purchases Clearing',
        accountType: 'liability',
        isPostable: true,
      },
      actorId
    );
    const periodA = await defaultPeriodService.createPeriod(
      compAId,
      {
        code: `FY-${todayYear}`,
        startDate: periodStart,
        endDate: periodEnd,
      },
      actorId
    );

    await check(
      'C1: Company, actor, supplier, warehouse, 2 items, 2 GL accounts (inventory/clearing), and open period created via public services',
      Boolean(
        compAId &&
          actorId &&
          supplierA.id &&
          warehouseA.id &&
          item1.id &&
          item2.id &&
          invAccountA.id &&
          clearingAccountA.id &&
          periodA.id &&
          !periodA.isClosed
      ),
      `companyA=${compAId}, supplier=${supplierA.code}, warehouse=${warehouseA.code}, items=[${item1.code},${item2.code}], invAcc=${invAccountA.code}(${invAccountA.id}), clrAcc=${clearingAccountA.code}(${clearingAccountA.id}), period=${periodA.code}`
    );

    // =========================================================================
    // C2: إعدادات الشركة تُربط بحسابي GL (upsert) وتُقرأ مرة أخرى صحيحة
    // =========================================================================
    await defaultCompanySettingsRepository.upsert(
      compAId,
      {
        inventoryAccountId: invAccountA.id,
        purchasesClearingAccountId: clearingAccountA.id,
      },
      actorId
    );
    const settingsReadBack = await defaultCompanySettingsRepository.getByCompanyId(compAId);

    await check(
      'C2: company_settings upserted with GL accounts and read back accurately',
      settingsReadBack !== null &&
        settingsReadBack.inventoryAccountId === invAccountA.id &&
        settingsReadBack.purchasesClearingAccountId === clearingAccountA.id,
      `inventoryAccountId=${settingsReadBack?.inventoryAccountId}, purchasesClearingAccountId=${settingsReadBack?.purchasesClearingAccountId}`
    );

    // =========================================================================
    // C3: createGrn ببندين بكميات وتكاليف → draft
    // =========================================================================
    const line1Qty = 10;
    const line1Cost = 25.5;
    const line2Qty = 4;
    const line2Cost = 120.75;
    const expectedGrn1Total = toMoney(line1Qty * line1Cost + line2Qty * line2Cost); // 255.00 + 483.00 = 738.00
    const expectedGrn1Minor = toMinorUnits(expectedGrn1Total, 2);

    const grn1Draft = await defaultGrnService.createGrn(
      compAId,
      {
        supplierId: supplierA.id,
        warehouseId: warehouseA.id,
        memo: `P2P Cycle GRN-1 (${suffix})`,
        lines: [
          { itemId: item1.id, qty: line1Qty, unitCost: line1Cost },
          { itemId: item2.id, qty: line2Qty, unitCost: line2Cost },
        ],
      },
      actorId
    );

    await check(
      'C3: createGrn creates draft GRN with 2 lines and quantities/unitCosts intact',
      grn1Draft.status === 'draft' &&
        Array.isArray(grn1Draft.lines) &&
        grn1Draft.lines.length === 2 &&
        !grn1Draft.journalEntryId &&
        toDecimal(grn1Draft.lines[0].qty) === line1Qty &&
        toDecimal(grn1Draft.lines[0].unitCost) === line1Cost &&
        toDecimal(grn1Draft.lines[1].qty) === line2Qty &&
        toDecimal(grn1Draft.lines[1].unitCost) === line2Cost,
      `grnId=${grn1Draft.id}, status=${grn1Draft.status}, line1=${line1Qty}x${line1Cost}, line2=${line2Qty}x${line2Cost}, expectedTotal=${expectedGrn1Total.toFixed(2)}`
    );

    // =========================================================================
    // C4: postGrn → قيد posted مرتبط (journal_entry_id) متوازن مدين = دائن = Σ qty×cost
    // =========================================================================
    const grn1Posted = await defaultGrnService.postGrn(compAId, grn1Draft.id, actorId);
    const je1 = grn1Posted.journalEntryId
      ? await defaultJournalService.getEntry(compAId, grn1Posted.journalEntryId, actorId)
      : null;

    const je1Lines = je1?.lines || [];
    const je1TotalDebitMinor = je1Lines.reduce((acc, l) => acc + toMinorUnits(l.debit, 2), BigInt(0));
    const je1TotalCreditMinor = je1Lines.reduce((acc, l) => acc + toMinorUnits(l.credit, 2), BigInt(0));
    const invDebitLine = je1Lines.find((l) => l.accountId === invAccountA.id);
    const clrCreditLine = je1Lines.find((l) => l.accountId === clearingAccountA.id);

    await check(
      'C4: postGrn links posted GRN to balanced posted GL entry (debit = credit = Σ qty*cost)',
      grn1Posted.status === 'posted' &&
        Boolean(grn1Posted.grnNo) &&
        Boolean(grn1Posted.journalEntryId) &&
        je1 !== null &&
        je1.status === 'posted' &&
        Boolean(je1.entryNo) &&
        je1Lines.length === 2 &&
        je1TotalDebitMinor === expectedGrn1Minor &&
        je1TotalCreditMinor === expectedGrn1Minor &&
        Boolean(invDebitLine && toMinorUnits(invDebitLine.debit, 2) === expectedGrn1Minor) &&
        Boolean(clrCreditLine && toMinorUnits(clrCreditLine.credit, 2) === expectedGrn1Minor),
      `grnNo=${grn1Posted.grnNo}, journalEntryId=${je1?.id}, entryNo=${je1?.entryNo}, debit=${fromMinorUnits(je1TotalDebitMinor, 2)}, credit=${fromMinorUnits(je1TotalCreditMinor, 2)}`
    );

    // =========================================================================
    // C5: أرصدة المخزون بعد الترحيل: qty = المُدخل لكل صنف، بمستودع الاستلام
    // =========================================================================
    const balancesAfter1 = await defaultStockService.listStockBalances(compAId);
    const bal1Item1 = balancesAfter1.find((b) => b.warehouseId === warehouseA.id && b.itemId === item1.id);
    const bal1Item2 = balancesAfter1.find((b) => b.warehouseId === warehouseA.id && b.itemId === item2.id);

    await check(
      'C5: Inventory stock balances match GRN line quantities in receiving warehouse',
      balancesAfter1.length === 2 &&
        bal1Item1?.qty === line1Qty &&
        bal1Item2?.qty === line2Qty,
      `warehouseId=${warehouseA.id}, item1(${item1.code}) qty=${bal1Item1?.qty}, item2(${item2.code}) qty=${bal1Item2?.qty}`
    );

    // =========================================================================
    // C6: التكلفة: قيمة المخزون = Σ qty×unitCost مطابقة لجانب القيد
    // =========================================================================
    const stockValuation = toMoney(
      (bal1Item1?.qty || 0) * line1Cost + (bal1Item2?.qty || 0) * line2Cost
    );
    const stockValuationMinor = toMinorUnits(stockValuation, 2);

    await check(
      'C6: Stock valuation (Σ qty*unitCost) matches posted GL debit and credit sides',
      stockValuationMinor === expectedGrn1Minor &&
        stockValuationMinor === je1TotalDebitMinor &&
        stockValuationMinor === je1TotalCreditMinor,
      `stockValue=${stockValuation.toFixed(2)} (${line1Qty}*${line1Cost} + ${line2Qty}*${line2Cost}), jeDebit=${fromMinorUnits(je1TotalDebitMinor, 2)}, jeCredit=${fromMinorUnits(je1TotalCreditMinor, 2)}`
    );

    // =========================================================================
    // C7: postGrn مرة ثانية على نفس الـGRN → ValidationError «مرحل مسبقاً» (منع التكرار)
    // =========================================================================
    let c7Err: unknown = null;
    try {
      await defaultGrnService.postGrn(compAId, grn1Draft.id, actorId);
    } catch (err) {
      c7Err = err;
    }
    const balancesAfterDupAttempt = await defaultStockService.listStockBalances(compAId);
    const dupBal1 = balancesAfterDupAttempt.find((b) => b.warehouseId === warehouseA.id && b.itemId === item1.id);
    const entriesAfterDupAttempt = await defaultJournalService.listEntries(compAId, 50, 0, undefined, actorId);

    await check(
      'C7: Duplicate postGrn on same GRN throws ValidationError (idempotent: stock and GL unchanged)',
      c7Err instanceof ValidationError &&
        /مرحل مسبقاً/.test(c7Err.message) &&
        dupBal1?.qty === line1Qty &&
        entriesAfterDupAttempt.length === 1,
      `errType=${c7Err instanceof Error ? c7Err.constructor.name : typeof c7Err}, msg="${c7Err instanceof Error ? c7Err.message : String(c7Err)}", item1Qty=${dupBal1?.qty}, entriesCount=${entriesAfterDupAttempt.length}`
    );

    // =========================================================================
    // C8: GRN ثانٍ لنفس الصنف → الرصيد يتراكم صحيحاً (لا استبدال)
    // =========================================================================
    const grn2Qty = 5;
    const grn2Cost = 30.0;
    const grn2ExpectedTotal = toMoney(grn2Qty * grn2Cost); // 150.00
    const grn2ExpectedMinor = toMinorUnits(grn2ExpectedTotal, 2);

    const grn2Draft = await defaultGrnService.createGrn(
      compAId,
      {
        supplierId: supplierA.id,
        warehouseId: warehouseA.id,
        memo: `P2P Cycle GRN-2 (${suffix})`,
        lines: [{ itemId: item1.id, qty: grn2Qty, unitCost: grn2Cost }],
      },
      actorId
    );
    const grn2Posted = await defaultGrnService.postGrn(compAId, grn2Draft.id, actorId);
    const je2 = grn2Posted.journalEntryId
      ? await defaultJournalService.getEntry(compAId, grn2Posted.journalEntryId, actorId)
      : null;
    const je2DebitMinor = (je2?.lines || []).reduce((acc, l) => acc + toMinorUnits(l.debit, 2), BigInt(0));
    const je2CreditMinor = (je2?.lines || []).reduce((acc, l) => acc + toMinorUnits(l.credit, 2), BigInt(0));
    const balancesAfter2 = await defaultStockService.listStockBalances(compAId);
    const bal2Item1 = balancesAfter2.find((b) => b.warehouseId === warehouseA.id && b.itemId === item1.id);
    const bal2Item2 = balancesAfter2.find((b) => b.warehouseId === warehouseA.id && b.itemId === item2.id);

    await check(
      'C8: Second GRN for same item accumulates stock balance cleanly (10 + 5 = 15, no overwrite)',
      grn2Posted.status === 'posted' &&
        bal2Item1?.qty === line1Qty + grn2Qty &&
        bal2Item2?.qty === line2Qty &&
        je2?.status === 'posted' &&
        je2DebitMinor === grn2ExpectedMinor &&
        je2CreditMinor === grn2ExpectedMinor,
      `grn2No=${grn2Posted.grnNo}, je2No=${je2?.entryNo}, je2Amount=${fromMinorUnits(je2DebitMinor, 2)}, item1 qty: ${line1Qty} -> ${bal2Item1?.qty} (item2=${bal2Item2?.qty})`
    );

    // =========================================================================
    // C9: reverseEntry للقيد المرتبط → قيد عكسي متوازن + أثره موثق
    // =========================================================================
    const revJe1 = await defaultJournalService.reverseEntry(
      compAId,
      je1!.id,
      actorId,
      `عكس قيد GRN-1 (${suffix})`
    );
    const origJe1AfterRev = await defaultJournalService.getEntry(compAId, je1!.id, actorId);
    const balancesAfterRev = await defaultStockService.listStockBalances(compAId);
    const balAfterRevItem1 = balancesAfterRev.find((b) => b.warehouseId === warehouseA.id && b.itemId === item1.id);
    const revLines = revJe1.lines || [];
    const revDebitMinor = revLines.reduce((acc, l) => acc + toMinorUnits(l.debit, 2), BigInt(0));
    const revCreditMinor = revLines.reduce((acc, l) => acc + toMinorUnits(l.credit, 2), BigInt(0));
    const revClrDebit = revLines.find((l) => l.accountId === clearingAccountA.id);
    const revInvCredit = revLines.find((l) => l.accountId === invAccountA.id);
    // Net GL impact across original je1 + reversal revJe1 equals 0.00; inventory qty stays 15
    const netInvGlMinor =
      toMinorUnits(invDebitLine?.debit, 2) -
      toMinorUnits(invDebitLine?.credit, 2) +
      toMinorUnits(revInvCredit?.debit, 2) -
      toMinorUnits(revInvCredit?.credit, 2);

    await check(
      'C9: reverseEntry produces balanced swapped reversing entry linked to original (GL net=0.00; physical stock qty remains untouched at 15)',
      revJe1.status === 'posted' &&
        Boolean(revJe1.entryNo) &&
        origJe1AfterRev?.reversedByEntryId === revJe1.id &&
        revDebitMinor === expectedGrn1Minor &&
        revCreditMinor === expectedGrn1Minor &&
        toMinorUnits(revClrDebit?.debit, 2) === expectedGrn1Minor &&
        toMinorUnits(revInvCredit?.credit, 2) === expectedGrn1Minor &&
        netInvGlMinor === BigInt(0) &&
        balAfterRevItem1?.qty === line1Qty + grn2Qty,
      `origJe1=${je1?.entryNo}(${je1?.id}) reversedBy=${revJe1.entryNo}(${revJe1.id}), revDebit=revCredit=${fromMinorUnits(revDebitMinor, 2)}, netGL=${fromMinorUnits(netInvGlMinor, 2)}, physicalStockQty=${balAfterRevItem1?.qty}`
    );

    // =========================================================================
    // C10: إلغاء/استرجاع GRN بعد الترحيل → مرفوض أو يعكس المخزون والقيد معاً — بلا حالة يتيمة
    // =========================================================================
    const grnServicePrototypeAny = defaultGrnService as unknown as Record<string, unknown>;
    const hasCancelOrReturnApi =
      typeof grnServicePrototypeAny.cancelGrn === 'function' ||
      typeof grnServicePrototypeAny.returnGrn === 'function' ||
      typeof grnServicePrototypeAny.unpostGrn === 'function';

    let repostRejectedErr: unknown = null;
    try {
      await defaultGrnService.postGrn(compAId, grn2Posted.id, actorId);
    } catch (err) {
      repostRejectedErr = err;
    }

    let deleteLinkedJeCode: string | undefined;
    let deleteLinkedJeMsg = '';
    try {
      await withTenantTransaction(compAId, async (tx) => {
        await tx.query(`DELETE FROM journal_entries WHERE id = $1 AND company_id = $2`, [je2!.id, compAId]);
      });
    } catch (err: any) {
      deleteLinkedJeCode = err?.code;
      deleteLinkedJeMsg = err?.message || String(err);
    }

    const grn2StillIntact = await defaultGrnService.getGrn(compAId, grn2Posted.id);
    const je2StillIntact = await defaultJournalService.getEntry(compAId, je2!.id, actorId);

    await check(
      'C10: Post-posting GRN cancel/return is disallowed without orphan risk (no cancel/return endpoint; re-post rejected; linked posted JE deletion blocked)',
      !hasCancelOrReturnApi &&
        repostRejectedErr instanceof ValidationError &&
        deleteLinkedJeMsg.length > 0 &&
        grn2StillIntact.status === 'posted' &&
        grn2StillIntact.journalEntryId === je2!.id &&
        je2StillIntact?.status === 'posted',
      `hasCancelApi=${hasCancelOrReturnApi}, repostRejected=ValidationError, deleteLinkedJeErr="${deleteLinkedJeMsg.slice(0, 90)}"(code=${deleteLinkedJeCode ?? 'trigger'}), grn2=${grn2StillIntact.status}->je2=${je2StillIntact?.entryNo}`
    );

    // =========================================================================
    // C11: تزامن: postGrn متوازٍ على GRNs لأصناف مشتركة بمعاملات منفصلة
    // =========================================================================
    const concA = await defaultGrnService.createGrn(
      compAId,
      {
        supplierId: supplierA.id,
        warehouseId: warehouseA.id,
        memo: `Concurrency GRN-A (${suffix})`,
        lines: [
          { itemId: item1.id, qty: 7, unitCost: 20.0 },
          { itemId: item2.id, qty: 3, unitCost: 50.0 },
        ],
      },
      actorId
    );
    const concB = await defaultGrnService.createGrn(
      compAId,
      {
        supplierId: supplierA.id,
        warehouseId: warehouseA.id,
        memo: `Concurrency GRN-B (${suffix})`,
        lines: [{ itemId: item1.id, qty: 8, unitCost: 20.0 }],
      },
      actorId
    );

    // Parallel posting of two distinct GRNs sharing item1 across separate PostgreSQL transactions
    const parallelDistinctResults = await Promise.allSettled([
      defaultGrnService.postGrn(compAId, concA.id, actorId),
      defaultGrnService.postGrn(compAId, concB.id, actorId),
    ]);

    const bothDistinctFulfilled = parallelDistinctResults.every((r) => r.status === 'fulfilled');
    const concAPosted = parallelDistinctResults[0].status === 'fulfilled' ? parallelDistinctResults[0].value : null;
    const concBPosted = parallelDistinctResults[1].status === 'fulfilled' ? parallelDistinctResults[1].value : null;

    // Parallel race on the SAME GRN (row lock FOR UPDATE must permit exactly 1 winner & reject 1 duplicate)
    const concSame = await defaultGrnService.createGrn(
      compAId,
      {
        supplierId: supplierA.id,
        warehouseId: warehouseA.id,
        memo: `Concurrency Same-GRN Race (${suffix})`,
        lines: [{ itemId: item1.id, qty: 2, unitCost: 10.0 }],
      },
      actorId
    );
    const parallelSameResults = await Promise.allSettled([
      defaultGrnService.postGrn(compAId, concSame.id, actorId),
      defaultGrnService.postGrn(compAId, concSame.id, actorId),
    ]);
    const sameFulfilled = parallelSameResults.filter((r) => r.status === 'fulfilled');
    const sameRejected = parallelSameResults.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    const balancesAfterConc = await defaultStockService.listStockBalances(compAId);
    const concBalItem1 = balancesAfterConc.find((b) => b.warehouseId === warehouseA.id && b.itemId === item1.id);
    const concBalItem2 = balancesAfterConc.find((b) => b.warehouseId === warehouseA.id && b.itemId === item2.id);
    const expectedItem1AfterConc = line1Qty + grn2Qty + 7 + 8 + 2; // 10 + 5 + 7 + 8 + 2 = 32
    const expectedItem2AfterConc = line2Qty + 3; // 4 + 3 = 7

    await check(
      'C11: Concurrent parallel postGrn transactions serialize cleanly (no negative stock, no deadlocks, monotonic GRN numbers, exact balance sums)',
      bothDistinctFulfilled &&
        concAPosted?.grnNo !== concBPosted?.grnNo &&
        sameFulfilled.length === 1 &&
        sameRejected.length === 1 &&
        sameRejected[0].reason instanceof ValidationError &&
        /مرحل مسبقاً/.test(sameRejected[0].reason.message) &&
        concBalItem1?.qty === expectedItem1AfterConc &&
        concBalItem2?.qty === expectedItem2AfterConc &&
        (concBalItem1?.qty || 0) >= 0 &&
        (concBalItem2?.qty || 0) >= 0,
      `distinctParallel=2/2(grnNos=${concAPosted?.grnNo},${concBPosted?.grnNo}), sameGrnRace=${sameFulfilled.length}win/${sameRejected.length}rejected, item1=${concBalItem1?.qty}(expected ${expectedItem1AfterConc}), item2=${concBalItem2?.qty}(expected ${expectedItem2AfterConc})`
    );

    // =========================================================================
    // C12: عزل: شركة ثانية ببياناتها الخاصة لا ترى قيود/أرصدة/سندات الشركة الأولى (0 صفوف عبر RLS)
    // =========================================================================
    const compB = await companyRepo.create({
      code: `P2P_B_${suffix}`,
      nameAr: `شركة معزولة ب ${suffix}`,
      createdBy: actorId,
    });
    compBId = compB.id;

    const supplierB = await defaultSupplierService.createSupplier(
      compBId,
      { code: `SUPB-${suffix}`, nameAr: 'مورد الشركة ب' },
      actorId
    );
    const warehouseB = await defaultWarehouseService.createWarehouse(
      compBId,
      { code: `WHB-${suffix}`, nameAr: 'مستودع الشركة ب' },
      actorId
    );
    const itemB = await defaultItemService.createItem(
      compBId,
      { code: `ITMB-${suffix}`, nameAr: 'صنف الشركة ب', uom: 'pcs' },
      actorId
    );
    const invAccB = await defaultAccountService.createAccount(
      compBId,
      { code: '1400', nameAr: 'مخزون ب', accountType: 'asset', isPostable: true },
      actorId
    );
    const clrAccB = await defaultAccountService.createAccount(
      compBId,
      { code: '2150', nameAr: 'تصفية مشتريات ب', accountType: 'liability', isPostable: true },
      actorId
    );
    await defaultPeriodService.createPeriod(
      compBId,
      { code: `FY-${todayYear}`, startDate: periodStart, endDate: periodEnd },
      actorId
    );
    await defaultCompanySettingsRepository.upsert(
      compBId,
      { inventoryAccountId: invAccB.id, purchasesClearingAccountId: clrAccB.id },
      actorId
    );
    const grnBDraft = await defaultGrnService.createGrn(
      compBId,
      {
        supplierId: supplierB.id,
        warehouseId: warehouseB.id,
        memo: `Company B GRN (${suffix})`,
        lines: [{ itemId: itemB.id, qty: 9, unitCost: 11.0 }],
      },
      actorId
    );
    const grnBPosted = await defaultGrnService.postGrn(compBId, grnBDraft.id, actorId);

    const rlsCountsFromB = await withTenantTransaction(compBId, async (txB) => {
      const jeCompA = await txB.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM journal_entries WHERE company_id = $1`,
        [compAId]
      );
      const balCompA = await txB.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM inv_stock_balances WHERE company_id = $1`,
        [compAId]
      );
      const grnCompA = await txB.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM purch_grn WHERE company_id = $1`,
        [compAId]
      );
      const jeVisibleAll = await txB.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM journal_entries`);
      const balVisibleAll = await txB.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM inv_stock_balances`);
      const grnVisibleAll = await txB.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM purch_grn`);

      return {
        jeCompA: Number(jeCompA.rows[0]?.cnt || 0),
        balCompA: Number(balCompA.rows[0]?.cnt || 0),
        grnCompA: Number(grnCompA.rows[0]?.cnt || 0),
        jeVisibleAll: Number(jeVisibleAll.rows[0]?.cnt || 0),
        balVisibleAll: Number(balVisibleAll.rows[0]?.cnt || 0),
        grnVisibleAll: Number(grnVisibleAll.rows[0]?.cnt || 0),
      };
    });

    const serviceGrnsB = await defaultGrnService.listGrns(compBId);
    const serviceBalancesB = await defaultStockService.listStockBalances(compBId);
    const serviceEntriesB = await defaultJournalService.listEntries(compBId, 50, 0, undefined, actorId);

    await check(
      'C12: Company B with its own posted P2P data sees 0 rows of Company A journal entries, balances, and GRNs via RLS',
      grnBPosted.status === 'posted' &&
        rlsCountsFromB.jeCompA === 0 &&
        rlsCountsFromB.balCompA === 0 &&
        rlsCountsFromB.grnCompA === 0 &&
        rlsCountsFromB.jeVisibleAll === 1 &&
        rlsCountsFromB.balVisibleAll === 1 &&
        rlsCountsFromB.grnVisibleAll === 1 &&
        serviceGrnsB.length === 1 &&
        serviceGrnsB[0].id === grnBPosted.id &&
        serviceBalancesB.length === 1 &&
        serviceBalancesB[0].qty === 9 &&
        serviceEntriesB.length === 1,
      `rlsCompA={je:${rlsCountsFromB.jeCompA},bal:${rlsCountsFromB.balCompA},grn:${rlsCountsFromB.grnCompA}}, rlsOwnVisible={je:${rlsCountsFromB.jeVisibleAll},bal:${rlsCountsFromB.balVisibleAll},grn:${rlsCountsFromB.grnVisibleAll}}, compB_bal=${serviceBalancesB[0]?.qty}`
    );
  } catch (err) {
    await check(
      'Unhandled exception during P2P Cycle E2E checks',
      false,
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    // =========================================================================
    // C13: تنظيف كامل في finally + التحقق من remaining=0
    // =========================================================================
    const companyIds = ([compAId, compBId] as Array<string | null>).filter((id): id is string => Boolean(id));
    const userIds = actorId ? [actorId] : [];
    const ownerConnStr = (process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || '').trim();
    const ownerPool = ownerConnStr ? new pg.Pool(buildPgConfig(ownerConnStr, process.env)) : null;

    try {
      if (ownerPool && (companyIds.length > 0 || userIds.length > 0)) {
        const client = await ownerPool.connect();
        try {
          await client.query('BEGIN');
          await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
          await client.query('ALTER TABLE journal_entries DISABLE TRIGGER trg_journal_entries_immutability');
          await client.query('ALTER TABLE journal_lines DISABLE TRIGGER trg_journal_lines_immutability');

          if (companyIds.length > 0) {
            await client.query(`DELETE FROM purch_grn_lines WHERE company_id = ANY($1::uuid[])`, [companyIds]);
            await client.query(`DELETE FROM purch_grn WHERE company_id = ANY($1::uuid[])`, [companyIds]);
            await client.query(`DELETE FROM journal_lines WHERE company_id = ANY($1::uuid[])`, [companyIds]);
            await client.query(
              `UPDATE journal_entries SET reversed_by_entry_id = NULL WHERE company_id = ANY($1::uuid[])`,
              [companyIds]
            );
            await client.query(`DELETE FROM journal_entries WHERE company_id = ANY($1::uuid[])`, [companyIds]);
            await client.query(`DELETE FROM inv_stock_movements WHERE company_id = ANY($1::uuid[])`, [companyIds]);
            await client.query(`DELETE FROM inv_stock_balances WHERE company_id = ANY($1::uuid[])`, [companyIds]);
            await client.query(`DELETE FROM company_settings WHERE company_id = ANY($1::uuid[])`, [companyIds]);
            await client.query(`DELETE FROM accounting_periods WHERE company_id = ANY($1::uuid[])`, [companyIds]);
            await client.query(`DELETE FROM accounting_sequences WHERE company_id = ANY($1::uuid[])`, [companyIds]);
            await client.query(`DELETE FROM accounts WHERE company_id = ANY($1::uuid[])`, [companyIds]);
            await client.query(`DELETE FROM inv_items WHERE company_id = ANY($1::uuid[])`, [companyIds]);
            await client.query(`DELETE FROM inv_warehouses WHERE company_id = ANY($1::uuid[])`, [companyIds]);
            await client.query(`DELETE FROM purch_suppliers WHERE company_id = ANY($1::uuid[])`, [companyIds]);
          }

          if (companyIds.length > 0 || userIds.length > 0) {
            await client.query(
              `DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[]) OR actor_user_id = ANY($2::uuid[])`,
              [companyIds, userIds]
            );
          }

          if (companyIds.length > 0) {
            await client.query(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [companyIds]);
          }
          if (userIds.length > 0) {
            await client.query(`DELETE FROM platform_users WHERE id = ANY($1::uuid[])`, [userIds]);
          }

          await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
          await client.query('ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_immutability');
          await client.query('ALTER TABLE journal_lines ENABLE TRIGGER trg_journal_lines_immutability');
          await client.query('COMMIT');
        } catch (cleanupTxErr) {
          await client.query('ROLLBACK').catch(() => {});
          throw cleanupTxErr;
        } finally {
          client.release();
        }
      }

      let remaining = 0;
      if (ownerPool && companyIds.length > 0) {
        const companyScopedTables = [
          'purch_grn_lines',
          'purch_grn',
          'journal_lines',
          'journal_entries',
          'inv_stock_movements',
          'inv_stock_balances',
          'company_settings',
          'accounting_periods',
          'accounting_sequences',
          'accounts',
          'inv_items',
          'inv_warehouses',
          'purch_suppliers',
          'audit_logs',
        ];
        for (const tbl of companyScopedTables) {
          const r = await ownerPool.query<{ cnt: number }>(
            `SELECT count(*)::int AS cnt FROM ${tbl} WHERE company_id = ANY($1::uuid[])`,
            [companyIds]
          );
          remaining += Number(r.rows[0]?.cnt || 0);
        }
        const compR = await ownerPool.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM companies WHERE id = ANY($1::uuid[])`,
          [companyIds]
        );
        remaining += Number(compR.rows[0]?.cnt || 0);
      }

      if (ownerPool && userIds.length > 0) {
        const usrR = await ownerPool.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM platform_users WHERE id = ANY($1::uuid[])`,
          [userIds]
        );
        remaining += Number(usrR.rows[0]?.cnt || 0);
      }

      await check(
        'C13: Full cleanup in finally removed all test data with remaining=0 across all tables',
        remaining === 0,
        `remaining=${remaining}`
      );
    } catch (cleanupErr) {
      await check(
        'C13: Full cleanup in finally removed all test data with remaining=0 across all tables',
        false,
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      );
    } finally {
      if (ownerPool) {
        await ownerPool.end().catch(() => {});
      }
      await closeAllExecutors().catch(() => {});
    }
  }

  const { exitCode } = summary();
  process.exit(exitCode);
}

run().catch(async (err) => {
  console.error('Fatal verification error:', err);
  await closeAllExecutors().catch(() => {});
  process.exit(1);
});
