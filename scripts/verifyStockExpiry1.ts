import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultStockService } from '../src/server/inventory/stockService.js';
import { defaultStockDocumentService } from '../src/server/inventory/stockDocumentService.js';
import { defaultSupplyListService } from '../src/server/inventory/supplyListService.js';
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
  const wh = await defaultWarehouseService.createWarehouse(cid, { code: `W-${suffix}`, nameAr: 'مخزن', nameEn: 'wh' }, actorId);
  const mk = async (c: string) => (await defaultItemService.createItem(cid, { code: `${c}-${suffix}`, nameAr: c, nameEn: c, uom: 'pc' }, actorId)).id;
  const [a, b, c] = [await mk('A'), await mk('B'), await mk('C')];
  await ensureTestCostingProfile(cid, [a, b, c], actorId);
  const rc = (itemId: string, expiryDate?: string) =>
    defaultStockService.receiveStock(cid, { warehouseId: wh.id, itemId, qty: 10, unitCost: 5, costSource: 'MANUAL_RECEIPT', reason: 'توريد', expiryDate }, actorId);
  await rc(a, '2030-06-30');
  await rc(b);
  await rc(c, '2020-01-01');
  const r = await defaultSupplyListService.report(cid, {});
  const row = (i: string) => r.rows.find((x) => x.itemId === i);
  await check('EX-1 three receipts listed', r.rows.length === 3, String(r.rows.length));
  await check('EX-2 item with expiry shows the date and status valid', row(a)?.expiryDate === '2030-06-30' && row(a)?.status === 'valid');
  await check('EX-3 item without expiry shows "بدون تاريخ صلاحية"', row(b)?.expiryLabel === 'بدون تاريخ صلاحية' && row(b)?.status === 'none');
  await check('EX-4 past expiry is flagged expired', row(c)?.status === 'expired');
  const f = await defaultSupplyListService.report(cid, { expiringBy: '2025-01-01' });
  await check('EX-5 expiringBy filter returns only the expired one', f.rows.length === 1 && f.rows[0].itemId === c);
  const f2 = await defaultSupplyListService.report(cid, { itemId: b });
  await check('EX-6 item filter', f2.rows.length === 1);
  const fut = await defaultSupplyListService.report(cid, { from: '2999-01-01' });
  await check('EX-7 future period is empty', fut.rows.length === 0);
  const bad = await rejects(() => rc(a, '2030-13-45'));
  await check('EX-8 invalid expiry date rejected', bad !== null, String(bad));
  const bad2 = await rejects(() => defaultSupplyListService.report(cid, { from: 'x' }));
  await check('EX-9 invalid report filter rejected', bad2 !== null);
  const doc = await defaultStockDocumentService.postDocument(cid, {
    docType: 'receipt', warehouseId: wh.id, reason: 'مستند توريد', costSource: 'MANUAL_RECEIPT',
    lines: [{ itemId: a, qty: 2, unitCost: 5, expiryDate: '2031-01-31' }, { itemId: b, qty: 3, unitCost: 5 }],
  } as any, actorId);
  await check('EX-10 receipt document with 2 lines', doc.lineCount === 2);
  const r2 = await defaultSupplyListService.report(cid, {});
  await check('EX-11 document line expiry is stored, other line has none', r2.rows.some((x) => x.expiryDate === '2031-01-31') && r2.rows.length === 5);
  const x = await defaultSupplyListService.report(other, {});
  await check('EX-12 other company sees no rows (isolation)', x.rows.length === 0);

  const { exitCode } = summary();
  await closeAllExecutors().catch(() => {});
  process.exit(exitCode);
}
main().catch(async (e) => { console.error('FATAL', e); await closeAllExecutors().catch(() => {}); process.exit(1); });
