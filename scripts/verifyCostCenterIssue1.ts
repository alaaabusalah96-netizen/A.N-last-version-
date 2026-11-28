import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultStockService } from '../src/server/inventory/stockService.js';
import { defaultStockDocumentService } from '../src/server/inventory/stockDocumentService.js';
import { defaultCostCenterIssueReportService } from '../src/server/inventory/costCenterIssueReportService.js';
import { OrgUnitService } from '../src/server/org/orgUnitService.js';
import { defaultAccountService } from '../src/server/accounting/accountService.js';
import { defaultPeriodService } from '../src/server/accounting/periodService.js';
import { defaultCompanySettingsRepository } from '../src/server/org/companySettingsRepository.js';
import { ensureTestCostingProfile } from './helpers/ensureTestCostingProfile.js';

async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e: any) { return String(e?.message || e); }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !['localhost', '127.0.0.1', '::1'].includes(new URL(dbUrl).hostname)) {
    blocked('DATABASE_URL missing or not loopback. Cost center issue test is BLOCKED.');
    process.exit(summary().exitCode);
  }
  const executor = await getDefaultExecutor();
  if (!executor) { blocked('no executor'); process.exit(summary().exitCode); }
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const actor = await new UserRepository().createUser({ username: `cc_actor_${suffix}`, passwordHash: 'dummy_cc_hash', role: 'user' });
  const actorId = actor.id;
  const cid = (await new CompanyRepository().create({ code: `CC_${suffix}`, nameAr: `شركة مركز ${suffix}`, createdBy: actorId })).id;
  const other = (await new CompanyRepository().create({ code: `CD_${suffix}`, nameAr: `شركة ثانية ${suffix}`, createdBy: actorId })).id;
  const year = new Date().toISOString().slice(0, 4);
  const invAcc = await defaultAccountService.createAccount(cid, { code: '1130', nameAr: 'المخزون', accountType: 'asset', isPostable: true }, actorId);
  const adjAcc = await defaultAccountService.createAccount(cid, { code: '5120', nameAr: 'تسويات المخزون', accountType: 'expense', isPostable: true }, actorId);
  await defaultPeriodService.createPeriod(cid, { code: `FY-${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` }, actorId);
  await defaultCompanySettingsRepository.upsert(cid, { inventoryAccountId: invAcc.id, inventoryAdjustmentAccountId: adjAcc.id }, actorId);
  const orgSvc = new OrgUnitService();
  const cc1 = await orgSvc.createUnit(cid, { code: `CC1-${suffix}`, nameAr: 'مركز 1', unitType: 'cost_center' }, actorId);
  const cc2 = await orgSvc.createUnit(cid, { code: `CC2-${suffix}`, nameAr: 'مركز 2', unitType: 'cost_center' }, actorId);
  const br = await orgSvc.createUnit(cid, { code: `BR-${suffix}`, nameAr: 'فرع', unitType: 'branch' }, actorId);
  const ccOff = await orgSvc.createUnit(cid, { code: `CC3-${suffix}`, nameAr: 'مركز موقوف', unitType: 'cost_center', isActive: false }, actorId);
  const otherCc = await orgSvc.createUnit(other, { code: `CCO-${suffix}`, nameAr: 'مركز شركة أخرى', unitType: 'cost_center' }, actorId);
  const wh = await defaultWarehouseService.createWarehouse(cid, { code: `W-${suffix}`, nameAr: 'مخزن', nameEn: 'wh' }, actorId);
  const mk = async (c: string) => (await defaultItemService.createItem(cid, { code: `${c}-${suffix}`, nameAr: c, nameEn: c, uom: 'pc' }, actorId)).id;
  const [a, b] = [await mk('A'), await mk('B')];
  await ensureTestCostingProfile(cid, [a, b], actorId);
  for (const it of [a, b]) {
    await defaultStockService.receiveStock(cid, { warehouseId: wh.id, itemId: it, qty: 100, unitCost: 5, costSource: 'MANUAL_RECEIPT', reason: 'seed' }, actorId);
  }

  const iss = (itemId: string, qty: number, costCenterId?: string) =>
    defaultStockService.issueStock(cid, { warehouseId: wh.id, itemId, qty, reason: 'صرف اختبار', costCenterId }, actorId);
  await iss(a, 10, cc1.id);
  await iss(a, 5, cc1.id);
  await iss(b, 7, cc2.id);
  await iss(a, 3); // no cost center: must not appear in the report

  const r = await defaultCostCenterIssueReportService.report(cid, {});
  const row = (c: string, i: string) => r.rows.find((x) => x.costCenterId === c && x.itemId === i);
  await check('CC-1 report groups by cost center and item (2 rows)', r.rows.length === 2, String(r.rows.length));
  await check('CC-2 cc1/item A qty 15 in 2 issues', Number(row(cc1.id, a)?.totalQty) === 15 && row(cc1.id, a)?.issueCount === 2);
  await check('CC-3 cost = qty x FIFO cost (15 x 5 = 75)', Number(row(cc1.id, a)?.totalCost) === 75, row(cc1.id, a)?.totalCost);
  await check('CC-4 cc2/item B qty 7 cost 35', Number(row(cc2.id, b)?.totalQty) === 7 && Number(row(cc2.id, b)?.totalCost) === 35);
  await check('CC-5 issue without cost center is excluded; totals 22 / 110', Number(r.totals.totalQty) === 22 && Number(r.totals.totalCost) === 110, JSON.stringify(r.totals));

  const f1 = await defaultCostCenterIssueReportService.report(cid, { costCenterId: cc2.id });
  await check('CC-6 filter by cost center', f1.rows.length === 1 && f1.rows[0].itemId === b);
  const f2 = await defaultCostCenterIssueReportService.report(cid, { itemId: a });
  await check('CC-7 filter by item', f2.rows.length === 1 && f2.rows[0].costCenterId === cc1.id);
  const today = new Date().toISOString().slice(0, 10);
  const f3 = await defaultCostCenterIssueReportService.report(cid, { from: today, to: today });
  await check('CC-8 period containing today returns all', f3.rows.length === 2);
  const f4 = await defaultCostCenterIssueReportService.report(cid, { from: '2000-01-01', to: '2000-12-31' });
  await check('CC-9 period in the past returns nothing', f4.rows.length === 0 && Number(f4.totals.totalQty) === 0);
  const badRange = await rejects(() => defaultCostCenterIssueReportService.report(cid, { from: '2026-02-01', to: '2026-01-01' }));
  await check('CC-10 from after to rejected', !!badRange, badRange || '');
  const badDate = await rejects(() => defaultCostCenterIssueReportService.report(cid, { from: 'abc' }));
  await check('CC-11 invalid date rejected', !!badDate, badDate || '');

  const eBranch = await rejects(() => iss(a, 1, br.id));
  await check('CC-12 branch is not accepted as cost center', !!eBranch && eBranch.includes('ليست مركز تكلفة'), eBranch || '');
  const eOff = await rejects(() => iss(a, 1, ccOff.id));
  await check('CC-13 inactive cost center rejected', !!eOff && eOff.includes('غير نشط'), eOff || '');
  const eOther = await rejects(() => iss(a, 1, otherCc.id));
  await check('CC-14 cost center of another company rejected', !!eOther, eOther || '');
  const bal = await withTenantTransaction(cid, async (tx) => (await tx.query<any>(`SELECT qty::text q FROM inv_stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3`, [cid, wh.id, a])).rows[0].q);
  await check('CC-15 rejected issues did not change stock (A = 100-18 = 82)', Number(bal) === 82, bal);

  const doc = await defaultStockDocumentService.postDocument(cid, {
    docType: 'issue', warehouseId: wh.id, reason: 'مستند صرف', costCenterId: cc1.id,
    lines: [{ itemId: a, qty: 2 }, { itemId: b, qty: 4, costCenterId: cc2.id }],
  } as any, actorId);
  await check('CC-16 document created with 2 lines', doc.lineCount === 2);
  const r2 = await defaultCostCenterIssueReportService.report(cid, {});
  await check('CC-17 document header cost center applies to lines without own (cc1/A = 17)', Number(r2.rows.find((x) => x.costCenterId === cc1.id && x.itemId === a)?.totalQty) === 17);
  await check('CC-18 line cost center overrides header (cc2/B = 11)', Number(r2.rows.find((x) => x.costCenterId === cc2.id && x.itemId === b)?.totalQty) === 11);

  const crossReport = await defaultCostCenterIssueReportService.report(other, {});
  await check('CC-19 other company sees no rows (isolation)', crossReport.rows.length === 0);

  const { exitCode } = summary();
  await closeAllExecutors().catch(() => {});
  process.exit(exitCode);
}
main().catch(async (e) => { console.error('FATAL', e); await closeAllExecutors().catch(() => {}); process.exit(1); });
