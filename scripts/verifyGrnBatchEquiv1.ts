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
import { ensureTestCostingProfile } from './helpers/ensureTestCostingProfile.js';

import { GrnService } from '../src/server/purchasing/grnService.js';
import { defaultInventoryValuationRepository } from '../src/server/inventory/inventoryValuationRepository.js';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !['localhost', '127.0.0.1', '::1'].includes(new URL(dbUrl).hostname)) {
    blocked('DATABASE_URL missing or not loopback. GRN batch equivalence is BLOCKED.');
    const { exitCode } = summary();
    process.exit(exitCode);
  }
  const executor = await getDefaultExecutor();
  if (!executor) { blocked('no executor'); const { exitCode } = summary(); process.exit(exitCode); }
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const year = new Date().toISOString().slice(0, 4);
  const actor = await new UserRepository().createUser({ username: `eq_actor_${suffix}`, passwordHash: 'dummy_eq_hash', role: 'user' });
  const actorId = actor.id;
  const comp = await new CompanyRepository().create({ code: `EQ_${suffix}`, nameAr: `شركة تكافؤ ${suffix}`, createdBy: actorId });
  const cid = comp.id;
  const sup = await defaultSupplierService.createSupplier(cid, { code: `S-${suffix}`, nameAr: 'مورد', nameEn: 'Sup' }, actorId);
  const whBatch = await defaultWarehouseService.createWarehouse(cid, { code: `WB-${suffix}`, nameAr: 'دفعي', nameEn: 'batch' }, actorId);
  const whLine = await defaultWarehouseService.createWarehouse(cid, { code: `WL-${suffix}`, nameAr: 'فردي', nameEn: 'perline' }, actorId);
  const mk = async (c: string) => (await defaultItemService.createItem(cid, { code: `${c}-${suffix}`, nameAr: c, nameEn: c, uom: 'pc' }, actorId)).id;
  const [i1, i2, i3] = [await mk('A'), await mk('B'), await mk('C')];
  const fifo = await defaultInventoryValuationRepository.createProfile(cid, { name: 'FIFO', costingMethod: 'FIFO', isDefault: true });
  const ma = await defaultInventoryValuationRepository.createProfile(cid, { name: 'MA', costingMethod: 'PERPETUAL_MOVING_AVERAGE', isDefault: false });
  await defaultInventoryValuationRepository.assignItemProfile(cid, i1, fifo.id, actorId);
  await defaultInventoryValuationRepository.assignItemProfile(cid, i2, ma.id, actorId);
  await defaultInventoryValuationRepository.assignItemProfile(cid, i3, fifo.id, actorId);
  const inv = await defaultAccountService.createAccount(cid, { code: '1400', nameAr: 'مخزون', nameEn: 'Inv', accountType: 'asset', isPostable: true }, actorId);
  const clr = await defaultAccountService.createAccount(cid, { code: '2150', nameAr: 'تصفية', nameEn: 'Clr', accountType: 'liability', isPostable: true }, actorId);
  await defaultPeriodService.createPeriod(cid, { code: `FY-${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` }, actorId);
  await defaultCompanySettingsRepository.upsert(cid, { inventoryAccountId: inv.id, purchasesClearingAccountId: clr.id }, actorId);

  const batchSvc = defaultGrnService;
  const lineSvc = new GrnService(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { perLineReceipt: true });

  const warm = [
    { itemId: i1, qty: 7, unitCost: 4.5 },
    { itemId: i2, qty: 3, unitCost: 9.25 },
  ];
  const main = [
    { itemId: i1, qty: 10, unitCost: 5 },
    { itemId: i2, qty: 4, unitCost: 7.5 },
    { itemId: i1, qty: 3, unitCost: 6.25 },
    { itemId: i3, qty: 2, unitCost: 100 },
    { itemId: i2, qty: 6, unitCost: 8 },
    { itemId: i1, qty: 1, unitCost: 5.5 },
    { itemId: i2, qty: 0.5, unitCost: 8.125 },
  ];
  for (const [svc, wh] of [[batchSvc, whBatch.id], [lineSvc, whLine.id]] as const) {
    for (const lines of [warm, main]) {
      const g = await svc.createGrn(cid, { supplierId: sup.id, warehouseId: wh, lines }, actorId);
      await svc.postGrn(cid, g.id, actorId);
    }
  }

  const snap = async (wh: string) => withTenantTransaction(cid, async (tx) => {
    const q = async (sql: string) => (await tx.query<any>(sql, [cid, wh])).rows;
    const lineNo = `(SELECT line_no FROM purch_grn_lines gl WHERE gl.id = X.source_line_id)`;
    return {
      valBal: await q(`SELECT item_id, quantity::text, total_cost::text, unit_cost::text FROM inv_valuation_balances WHERE company_id=$1 AND warehouse_id=$2 ORDER BY item_id`),
      layers: await q(`SELECT item_id, original_qty::text, remaining_qty::text, unit_cost::text, total_cost::text, source_type, is_exhausted, ${lineNo.replace('X.', 'inv_cost_layers.')} AS ln, (SELECT grn_no FROM purch_grn WHERE id = inv_cost_layers.source_id) AS gno FROM inv_cost_layers WHERE company_id=$1 AND warehouse_id=$2 ORDER BY item_id, ln, gno`),
      movs: await q(`SELECT item_id, movement_type, qty::text, unit_cost::text, total_cost::text, source_type, reason, cost_source, costing_method, created_by, ${lineNo.replace('X.', 'inv_valuation_movements.')} AS ln, (SELECT grn_no FROM purch_grn WHERE id = inv_valuation_movements.source_id) AS gno FROM inv_valuation_movements WHERE company_id=$1 AND warehouse_id=$2 ORDER BY gno, ln`),
      ma: await q(`SELECT item_id, received_qty::text, remaining_qty::text, consumed_qty::text, original_value::text, remaining_value::text, consumed_value::text, (grn_id IS NOT NULL) AS has_grn, (grn_line_id IS NOT NULL) AS has_grn_line, ${lineNo.replace('X.', 'inv_ma_source_balances.')} AS ln FROM inv_ma_source_balances WHERE company_id=$1 AND warehouse_id=$2 ORDER BY item_id, ln`),
      maEv: await q(`SELECT item_id, event_type, quantity::text, value_delta::text, (reference_movement_id IS NOT NULL) AS has_ref FROM inv_ma_source_events WHERE company_id=$1 AND warehouse_id=$2 ORDER BY item_id, value_delta, quantity`),
      stockBal: await q(`SELECT item_id, qty::text FROM inv_stock_balances WHERE company_id=$1 AND warehouse_id=$2 ORDER BY item_id`),
      stockMov: await q(`SELECT item_id, movement_type, qty::text, memo IS NOT NULL AS has_memo, created_by FROM inv_stock_movements WHERE company_id=$1 AND warehouse_id=$2 ORDER BY item_id, qty`),
    };
  });
  const a = await snap(whBatch.id);
  const b = await snap(whLine.id);
  // per-warehouse ids differ (item ids same). memo/journal differ only by GRN number text, so compare structure.
  for (const k of Object.keys(a) as (keyof typeof a)[]) {
    const norm = (rows: any[]) => JSON.stringify(rows.map((r) => { const { gno, reason, ...rest } = r; return { ...rest, reasonHasGrnNo: typeof reason === 'string' && reason.startsWith('ترحيل سند استلام ') }; }));
    await check(`EQ-${k}: batch result identical to per-line result (${(a[k] as any[]).length} rows)`, norm(a[k] as any[]) === norm(b[k] as any[]),
      (a[k] as any[]).length === 0 ? 'EMPTY' : norm(a[k] as any[]).slice(0, 160) + ' | ' + norm(b[k] as any[]).slice(0, 160));
  }
  await check('EQ-nonempty: layers, movements, MA balances and stock rows were actually produced', a.layers.length > 0 && a.movs.length === 9 && a.ma.length > 0 && a.stockBal.length === 3, `layers=${a.layers.length} movs=${a.movs.length} ma=${a.ma.length}`);

  // journals: both GRNs per warehouse must have same debit/credit totals
  const jt = async (wh: string) => withTenantTransaction(cid, async (tx) => (await tx.query<any>(
    `SELECT jl.account_id, SUM(jl.debit)::text d, SUM(jl.credit)::text c FROM purch_grn g JOIN journal_lines jl ON jl.entry_id = g.journal_entry_id WHERE g.company_id=$1 AND g.warehouse_id=$2 GROUP BY jl.account_id ORDER BY jl.account_id`, [cid, wh])).rows);
  const ja = JSON.stringify(await jt(whBatch.id));
  const jb = JSON.stringify(await jt(whLine.id));
  await check('EQ-journal: journal debit/credit totals identical', ja === jb && ja.length > 5, ja.slice(0, 200));

  const { exitCode } = summary();
  await closeAllExecutors().catch(() => {});
  process.exit(exitCode);
}
main().catch(async (e) => { console.error('FATAL', e); await closeAllExecutors().catch(() => {}); process.exit(1); });
