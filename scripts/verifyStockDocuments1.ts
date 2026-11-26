import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultAccountService } from '../src/server/accounting/accountService.js';
import { defaultPeriodService } from '../src/server/accounting/periodService.js';
import { defaultCompanySettingsRepository } from '../src/server/org/companySettingsRepository.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultStockService } from '../src/server/inventory/stockService.js';
import { defaultStockDocumentService } from '../src/server/inventory/stockDocumentService.js';
import { defaultInventoryValuationRepository } from '../src/server/inventory/inventoryValuationRepository.js';

console.log('=== VERIFYING AN-ERP: MULTI-LINE STOCK DOCUMENTS (100 lines, atomic, cumulative balance) ===');

function assertLoopbackUrl(raw: string, varName: string): void {
  const parsed = new URL(raw);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
  }
}

async function run() {
  const rootDir = process.cwd();
  const mig = path.join(rootDir, 'database/migrations/066_inventory_stock_documents.sql');
  const ownership = fs.readFileSync(path.join(rootDir, 'database/table_ownership.json'), 'utf8');
  await check(
    'D0: migration 066 defines inv_stock_documents with FORCE RLS and table_ownership registration',
    fs.existsSync(mig) &&
      fs.readFileSync(mig, 'utf8').includes('FORCE ROW LEVEL SECURITY') &&
      ownership.includes('"inv_stock_documents"')
  );

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live stock document checks are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }
  try {
    assertLoopbackUrl(dbUrl, 'DATABASE_URL');
    if (process.env.MIGRATION_DATABASE_URL) assertLoopbackUrl(process.env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL');
  } catch (err) {
    blocked(err instanceof Error ? err.message : String(err));
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }
  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Database executor unavailable. Live stock document checks are BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
    return;
  }

  const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const companyIds: string[] = [];
  const userIds: string[] = [];
  let cleanupFailed = false;
  const N = 100;

  try {
    const companyRepo = new CompanyRepository();
    const userRepo = new UserRepository();
    const user = await userRepo.createUser({ username: `sd_usr_${unique}`, passwordHash: 'dummy_hash_sd_1', role: 'platform_admin' });
    userIds.push(user.id);
    const comp1 = await companyRepo.create({ code: `SD1-${unique}`.slice(0, 20), nameAr: `شركة مستندات المخزون ${unique}`, createdBy: user.id });
    companyIds.push(comp1.id);
    const comp2 = await companyRepo.create({ code: `SD2-${unique}`.slice(0, 20), nameAr: `شركة عزل ${unique}`, createdBy: user.id });
    companyIds.push(comp2.id);
    const companyId = comp1.id;

    const invAcc = await defaultAccountService.createAccount(companyId, { code: '1130', nameAr: 'المخزون', accountType: 'asset', isPostable: true }, user.id);
    const adjAcc = await defaultAccountService.createAccount(companyId, { code: '5120', nameAr: 'فروق وتسويات المخزون', accountType: 'expense', isPostable: true }, user.id);
    await defaultCompanySettingsRepository.upsert(companyId, { inventoryAccountId: invAcc.id, inventoryAdjustmentAccountId: adjAcc.id }, user.id);

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate();
    await defaultPeriodService.createPeriod(
      companyId,
      { code: `${y}-${m}-SD-${unique}`, startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${String(lastDay).padStart(2, '0')}` },
      user.id
    );

    const wh1 = await defaultWarehouseService.createWarehouse(companyId, { code: `W1-${unique}`.slice(0, 20), nameAr: 'مستودع 1' }, user.id);
    const wh2 = await defaultWarehouseService.createWarehouse(companyId, { code: `W2-${unique}`.slice(0, 20), nameAr: 'مستودع 2' }, user.id);
    const profile = await defaultInventoryValuationRepository.createProfile(companyId, {
      name: 'MA Profile SD',
      costingMethod: 'PERPETUAL_MOVING_AVERAGE',
      isDefault: true,
    });
    const items: Array<{ id: string }> = [];
    for (let i = 0; i < N; i++) {
      const it = await defaultItemService.createItem(companyId, { code: `SD${i}-${unique}`.slice(0, 20), nameAr: `صنف ${i}`, uom: 'قطعة' }, user.id);
      await defaultInventoryValuationRepository.assignItemProfile(companyId, it.id, profile.id, user.id);
      items.push(it);
    }
    const qtyOf = async (wh: string, itemId: string) => {
      const bal = (await defaultStockService.listStockBalancesByItem(companyId, itemId)).find((b) => b.warehouseId === wh);
      return bal ? Number(bal.qty) : 0;
    };
    const docCount = async () => {
      const r = await withTenantTransaction(companyId, (tx) => tx.query<any>('SELECT count(*)::int AS n FROM inv_stock_documents WHERE company_id = $1', [companyId]));
      return r.rows[0].n;
    };

    // D1: receipt with 100 lines in one document
    const receipt = await defaultStockDocumentService.postDocument(
      companyId,
      {
        docType: 'receipt', warehouseId: wh1.id, reason: 'استلام مستند متعدد الأسطر', costSource: 'opening_count',
        lines: items.map((it, i) => ({ itemId: it.id, qty: 10 + i, unitCost: 5 })),
      },
      user.id
    );
    let allReceived = true;
    for (let i = 0; i < N; i++) if ((await qtyOf(wh1.id, items[i].id)) !== 10 + i) allReceived = false;
    await check('D1: receipt document with 100 lines posts all lines and balances', receipt.lineCount === N && receipt.lines.length === N && allReceived);

    // D2: issue 100 lines
    const issue = await defaultStockDocumentService.postDocument(
      companyId,
      { docType: 'issue', warehouseId: wh1.id, reason: 'صرف مستند 100 سطر', lines: items.map((it) => ({ itemId: it.id, qty: 5 })) },
      user.id
    );
    let allIssued = true;
    for (let i = 0; i < N; i++) if ((await qtyOf(wh1.id, items[i].id)) !== 5 + i) allIssued = false;
    await check('D2: issue document with 100 lines posts all lines and reduces balances', issue.lineCount === N && allIssued);

    // D3: atomic, line 100 exceeds balance (balance of last item is 104)
    const before = await docCount();
    let msg = '';
    try {
      await defaultStockDocumentService.postDocument(
        companyId,
        {
          docType: 'issue', warehouseId: wh1.id, reason: 'اختبار الذرية',
          lines: items.map((it, i) => ({ itemId: it.id, qty: i === N - 1 ? 100000 : 1 })),
        },
        user.id
      );
    } catch (e: any) {
      msg = String(e?.message || e);
    }
    let unchanged = true;
    for (let i = 0; i < N; i++) if ((await qtyOf(wh1.id, items[i].id)) !== 5 + i) unchanged = false;
    await check(
      'D3: failing line 100 rejects the whole document with the line number and leaves balances and documents unchanged',
      msg.includes('السطر 100') && unchanged && (await docCount()) === before,
      msg
    );

    // D4: cumulative check, the same item repeated
    let msg4 = '';
    try {
      await defaultStockDocumentService.postDocument(
        companyId,
        { docType: 'issue', warehouseId: wh1.id, reason: 'تراكمي', lines: [{ itemId: items[0].id, qty: 3 }, { itemId: items[0].id, qty: 3 }] },
        user.id
      );
    } catch (e: any) {
      msg4 = String(e?.message || e);
    }
    await check('D4: repeated item is checked cumulatively (3+3 against balance 5 fails on line 2) and nothing is posted', msg4.includes('السطر 2') && (await qtyOf(wh1.id, items[0].id)) === 5, msg4);

    // D5: adjustment (increase) 100 lines and transfer 100 lines
    const adj = await defaultStockDocumentService.postDocument(
      companyId,
      {
        docType: 'adjustment', warehouseId: wh1.id, reason: 'تسوية جرد', adjustmentType: 'adjustment', costSource: 'stock_count',
        lines: items.map((it) => ({ itemId: it.id, qty: 1, direction: 'increase' as const, unitCost: 5 })),
      },
      user.id
    );
    const tr = await defaultStockDocumentService.postDocument(
      companyId,
      { docType: 'transfer', sourceWarehouseId: wh1.id, destWarehouseId: wh2.id, memo: 'تحويل 100 سطر', lines: items.map((it) => ({ itemId: it.id, qty: 2 })) },
      user.id
    );
    let okTr = true;
    for (let i = 0; i < N; i++) {
      if ((await qtyOf(wh2.id, items[i].id)) !== 2 || (await qtyOf(wh1.id, items[i].id)) !== 5 + i + 1 - 2) okTr = false;
    }
    await check('D5: adjustment (100 lines) and transfer (100 lines) post and move balances correctly', adj.lineCount === N && tr.lineCount === N && okTr);

    // D6: each document links all of its movements, numbering is unique
    const link = await withTenantTransaction(companyId, (tx) => tx.query<any>(
      'SELECT document_id, count(*)::int AS n, count(DISTINCT line_no)::int AS lines FROM inv_stock_movements WHERE company_id = $1 AND document_id IS NOT NULL GROUP BY document_id',
      [companyId]
    ));
    await check(
      'D6: movements are linked to their documents with line numbers',
      link.rows.length === 4 && link.rows.every((r: any) => r.lines === N)
    );

    // D7: validations (empty, too many, bad qty)
    let emptyRejected = false;
    try {
      await defaultStockDocumentService.postDocument(companyId, { docType: 'issue', warehouseId: wh1.id, lines: [] }, user.id);
    } catch {
      emptyRejected = true;
    }
    let zeroRejected = false;
    try {
      await defaultStockDocumentService.postDocument(companyId, { docType: 'issue', warehouseId: wh1.id, reason: 'x', lines: [{ itemId: items[0].id, qty: 0 }] }, user.id);
    } catch {
      zeroRejected = true;
    }
    await check('D7: empty document and zero quantity are rejected', emptyRejected && zeroRejected);

    // D8: RLS isolation
    const other = await withTenantTransaction(comp2.id, (tx) => tx.query<any>('SELECT count(*)::int AS n FROM inv_stock_documents'));
    const own = await withTenantTransaction(companyId, (tx) => tx.query<any>('SELECT count(*)::int AS n FROM inv_stock_documents'));
    await check('D8: RLS: company 2 sees no documents while company 1 sees its 4', other.rows[0].n === 0 && own.rows[0].n === 4);

    // D9: named-field validation messages (fail before any DB work)
    const msgOf = async (input: any) => {
      try { await defaultStockDocumentService.postDocument(companyId, input, user.id); return ''; } catch (e: any) { return String(e?.message || e); }
    };
    const mReceipt = await msgOf({ docType: 'receipt', warehouseId: wh1.id, reason: 'x', lines: [{ itemId: items[0].id, qty: 1, unitCost: 5 }] });
    const mAdj = await msgOf({ docType: 'adjustment', warehouseId: wh1.id, reason: 'x', lines: [{ itemId: items[0].id, qty: 1 }] });
    await check(
      'D9: missing costSource / direction are rejected with the field and line named',
      mReceipt.includes('السطر 1') && mReceipt.includes('costSource') && mAdj.includes('السطر 1') && mAdj.includes('direction'),
      `${mReceipt} | ${mAdj}`
    );

    // D10: background job for a large document: queued -> done, same posting engine, balances move
    const before0 = await qtyOf(wh1.id, items[0].id);
    const job = await defaultStockDocumentService.createJob(
      companyId,
      { docType: 'issue', warehouseId: wh1.id, reason: 'صرف خلفي', lines: items.slice(0, 55).map((it) => ({ itemId: it.id, qty: 1 })) },
      user.id
    );
    void defaultStockDocumentService.runJob(companyId, job.id);
    let jobState = await defaultStockDocumentService.getJob(companyId, job.id);
    for (let i = 0; i < 90 && jobState && jobState.status !== 'done' && jobState.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      jobState = await defaultStockDocumentService.getJob(companyId, job.id);
    }
    await check(
      'D10: background job posts a 55-line document once (done, result, balance reduced by 1)',
      !!jobState && jobState.status === 'done' && jobState.result?.lineCount === 55 && (await qtyOf(wh1.id, items[0].id)) === before0 - 1,
      JSON.stringify({ s: jobState?.status, e: jobState?.errorMessage })
    );
    // second runJob on a finished job is a no-op (claim is exclusive)
    await defaultStockDocumentService.runJob(companyId, job.id);
    await check('D11: re-running a finished job posts nothing again', (await qtyOf(wh1.id, items[0].id)) === before0 - 1);

    // D12: a failing job ends as failed with the line named and posts nothing
    const bad = await defaultStockDocumentService.createJob(
      companyId,
      { docType: 'issue', warehouseId: wh1.id, reason: 'x', lines: [...items.slice(0, 54).map((it) => ({ itemId: it.id, qty: 1 })), { itemId: items[0].id, qty: 100000 }] },
      user.id
    );
    await defaultStockDocumentService.runJob(companyId, bad.id);
    const badState = await defaultStockDocumentService.getJob(companyId, bad.id);
    await check(
      'D12: failing background job is marked failed with the line named and nothing is posted',
      badState?.status === 'failed' && (badState.errorMessage || '').includes('السطر 55') && (await qtyOf(wh1.id, items[0].id)) === before0 - 1,
      badState?.errorMessage || ''
    );

    // D13: one journal entry per document, a debit and credit line per item line, every valuation movement linked
    let qCount = 0;
    const origQuery = (pg.Client.prototype as any).query;
    (pg.Client.prototype as any).query = function (...a: any[]) { qCount++; return origQuery.apply(this, a); };
    const t0 = Date.now();
    const rcpt = await defaultStockDocumentService.postDocument(
      companyId,
      { docType: 'receipt', warehouseId: wh2.id, reason: 'استلام قيد واحد', costSource: 'supplier_invoice', lines: items.map((it, i) => ({ itemId: it.id, qty: 3, unitCost: 4 + i })) },
      user.id
    );
    const elapsed = Date.now() - t0;
    (pg.Client.prototype as any).query = origQuery;
    console.log(`[perf] 100-line receipt: ${qCount} queries (${(qCount / N).toFixed(1)} per line), ${elapsed} ms locally`);
    const docRow = await withTenantTransaction(companyId, (tx) => tx.query<any>('SELECT journal_entry_id FROM inv_stock_documents WHERE company_id = $1 AND id = $2', [companyId, rcpt.documentId]));
    const jeId = docRow.rows[0]?.journal_entry_id;
    const jl = await withTenantTransaction(companyId, (tx) => tx.query<any>(
      'SELECT count(*)::int AS n, sum(debit)::numeric AS d, sum(credit)::numeric AS c FROM journal_lines WHERE company_id = $1 AND entry_id = $2', [companyId, jeId]));
    const jes = await withTenantTransaction(companyId, (tx) => tx.query<any>(
      'SELECT count(DISTINCT journal_entry_id)::int AS n, count(*)::int AS m FROM inv_valuation_movements WHERE company_id = $1 AND journal_entry_id = $2', [companyId, jeId]));
    const expectedTotal = items.reduce((a, _it, i) => a + 3 * (4 + i), 0);
    await check(
      'D13: one journal entry per document: 200 lines (Dr+Cr per item), balanced, total = sum of item costs, all 100 valuation movements linked to it',
      !!jeId && jl.rows[0].n === 2 * N && Number(jl.rows[0].d) === expectedTotal && Number(jl.rows[0].c) === expectedTotal && jes.rows[0].m === N,
      JSON.stringify({ jeId: !!jeId, lines: jl.rows[0].n, d: jl.rows[0].d, c: jl.rows[0].c, linked: jes.rows[0].m })
    );
    const perItem = await withTenantTransaction(companyId, (tx) => tx.query<any>(
      `SELECT count(DISTINCT line_memo)::int AS n FROM journal_lines WHERE company_id = $1 AND entry_id = $2 AND debit > 0`, [companyId, jeId]));
    await check('D14: item detail is kept: every item has its own debit line', perItem.rows[0].n === N);
    // old single-line posting is unchanged (its own JE per movement)
    const single = await defaultStockService.receiveStock(
      companyId,
      { warehouseId: wh2.id, itemId: items[0].id, qty: 1, unitCost: 9, costSource: 'supplier_invoice', reason: 'استلام فردي' },
      user.id
    );
    await check('D15: single-line receive still posts its own journal entry', !!single.journalEntryId && single.journalEntryId !== jeId);
  } catch (err) {
    console.error('[verifyStockDocuments1] Live test error:', err);
    await check('Live stock document suite execution', false, err instanceof Error ? err.message : String(err));
  } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(cleanupUrl, process.env));
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE journal_entries DISABLE TRIGGER trg_journal_entries_immutability');
        await client.query('ALTER TABLE journal_lines DISABLE TRIGGER trg_journal_lines_immutability');
        const del = (t: string) => client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [companyIds]);
        await client.query(
          `DELETE FROM inv_cost_allocations
           WHERE company_id = ANY($1::uuid[])
             AND (cost_layer_id IN (SELECT id FROM inv_cost_layers WHERE company_id = ANY($1::uuid[]))
               OR valuation_movement_id IN (SELECT id FROM inv_valuation_movements WHERE company_id = ANY($1::uuid[])))`,
          [companyIds]
        );
        await client.query('UPDATE inv_stock_documents SET journal_entry_id = NULL WHERE company_id = ANY($1::uuid[])', [companyIds]);
        for (const t of [
          'inv_valuation_reconciliations', 'inv_ma_source_events', 'inv_ma_source_balances', 'inv_cost_layers',
          'inv_valuation_movements', 'inv_valuation_balances', 'inv_item_costing_profiles', 'inv_costing_profiles',
          'journal_lines', 'journal_entries', 'inv_stock_movements', 'inv_stock_document_jobs', 'inv_stock_documents', 'inv_stock_balances',
          'company_settings', 'accounting_periods', 'accounting_sequences', 'accounts', 'inv_items', 'inv_warehouses', 'audit_logs',
        ]) {
          await del(t);
        }
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
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        console.error('[cleanup] Failed cleaning up verifyStockDocuments1:', cleanupErr);
      } finally {
        await client.end();
      }
    }
    await closeAllExecutors();
  }
  const { exitCode } = summary();
  if (cleanupFailed) process.exit(1);
  process.exit(exitCode);
}

run().catch((err) => {
  console.error('[verifyStockDocuments1] Fatal error:', err);
  process.exit(1);
});
