import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultStocktakeService } from '../src/server/inventory/stocktakeService.js';

async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e: any) { return String(e?.message || e); }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !['localhost', '127.0.0.1', '::1'].includes(new URL(dbUrl).hostname)) {
    blocked('DATABASE_URL missing or not loopback. Stocktake test is BLOCKED.');
    process.exit(summary().exitCode);
  }
  const executor = await getDefaultExecutor();
  if (!executor) { blocked('no executor'); process.exit(summary().exitCode); }
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const actor = await new UserRepository().createUser({ username: `st_actor_${suffix}`, passwordHash: 'dummy_st_hash', role: 'user' });
  const actorId = actor.id;
  const comp = await new CompanyRepository().create({ code: `ST_${suffix}`, nameAr: `شركة جرد ${suffix}`, createdBy: actorId });
  const cid = comp.id;
  const other = await new CompanyRepository().create({ code: `SO_${suffix}`, nameAr: `شركة أخرى ${suffix}`, createdBy: actorId });
  const wh = await defaultWarehouseService.createWarehouse(cid, { code: `W-${suffix}`, nameAr: 'مخزن', nameEn: 'wh' }, actorId);
  const mk = async (c: string) => (await defaultItemService.createItem(cid, { code: `${c}-${suffix}`, nameAr: c, nameEn: c, uom: 'pc' }, actorId)).id;
  const [a, b, c] = [await mk('A'), await mk('B'), await mk('C')];
  await withTenantTransaction(cid, async (tx) => {
    await tx.query(`INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty) VALUES ($1,$2,$3,10),($1,$2,$4,5)`, [cid, wh.id, a, b]);
  });

  const st = await defaultStocktakeService.create(cid, { warehouseId: wh.id, memo: 'جرد اختبار' }, actorId);
  await check('ST-1 snapshot has all 3 active items, number 1', st.lines.length === 3 && st.stocktakeNo === 1, `${st.lines.length}/${st.stocktakeNo}`);
  const q = (id: string) => st.lines.find((l) => l.itemId === id)!;
  await check('ST-2 system qty snapshot (10, 5, 0)', Number(q(a).systemQty) === 10 && Number(q(b).systemQty) === 5 && Number(q(c).systemQty) === 0);
  await check('ST-3 nothing counted yet, variance null', st.lines.every((l) => l.countedQty === null && l.varianceQty === null) && st.summary.uncounted === 3);
  const dup = await rejects(() => defaultStocktakeService.create(cid, { warehouseId: wh.id }, actorId));
  await check('ST-4 second open sheet for same warehouse rejected', !!dup && dup.includes('مفتوح'), dup || '');
  const foreign = await rejects(() => defaultStocktakeService.create(other.id, { warehouseId: wh.id }, actorId));
  await check('ST-5 warehouse of another company rejected', !!foreign, foreign || '');

  const d = await defaultStocktakeService.saveCounts(cid, st.id, [
    { itemId: a, countedQty: 8 }, { itemId: b, countedQty: 5 }, { itemId: c, countedQty: 2 },
  ], actorId);
  await check('ST-6 variance computed: -2, 0, +2', Number(d.lines.find((l) => l.itemId === a)!.varianceQty) === -2 && Number(d.lines.find((l) => l.itemId === b)!.varianceQty) === 0 && Number(d.lines.find((l) => l.itemId === c)!.varianceQty) === 2);
  await check('ST-7 summary shortage1 surplus1 matched1', d.summary.shortage === 1 && d.summary.surplus === 1 && d.summary.matched === 1 && d.summary.uncounted === 0);
  const neg = await rejects(() => defaultStocktakeService.saveCounts(cid, st.id, [{ itemId: a, countedQty: -1 }], actorId));
  await check('ST-8 negative count rejected', !!neg, neg || '');
  const bad = await rejects(() => defaultStocktakeService.saveCounts(cid, st.id, [{ itemId: '00000000-0000-4000-8000-000000000000', countedQty: 1 }], actorId));
  await check('ST-9 item outside sheet rejected', !!bad, bad || '');
  const cleared = await defaultStocktakeService.saveCounts(cid, st.id, [{ itemId: c, countedQty: null }], actorId);
  await check('ST-10 clearing a count returns it to uncounted', cleared.lines.find((l) => l.itemId === c)!.countedQty === null);

  const bal = await withTenantTransaction(cid, async (tx) => (await tx.query<any>(`SELECT item_id, qty::text q FROM inv_stock_balances WHERE company_id=$1 AND warehouse_id=$2 ORDER BY q`, [cid, wh.id])).rows);
  const mov = await withTenantTransaction(cid, async (tx) => (await tx.query<any>(`SELECT COUNT(*)::int n FROM inv_stock_movements WHERE company_id=$1`, [cid])).rows[0].n);
  await check('ST-11 counting never changes balances or posts movements', bal.length === 2 && Number(bal.find((r: any) => r.item_id === a).q) === 10 && mov === 0, `bal=${bal.length} mov=${mov}`);

  const closed = await defaultStocktakeService.close(cid, st.id, actorId);
  await check('ST-12 close sets status closed', closed.status === 'closed' && !!closed.closedAt);
  const after = await rejects(() => defaultStocktakeService.saveCounts(cid, st.id, [{ itemId: a, countedQty: 1 }], actorId));
  await check('ST-13 counts rejected after close', !!after, after || '');
  const again = await rejects(() => defaultStocktakeService.close(cid, st.id, actorId));
  await check('ST-14 closing twice rejected', !!again, again || '');
  const st2 = await defaultStocktakeService.create(cid, { warehouseId: wh.id }, actorId);
  await check('ST-15 new sheet allowed after close, number 2', st2.stocktakeNo === 2);
  const cx = await defaultStocktakeService.cancel(cid, st2.id, actorId);
  await check('ST-16 cancel sets cancelled', cx.status === 'cancelled');
  const lst = await defaultStocktakeService.list(cid);
  await check('ST-17 list shows 2 sheets newest first', lst.length === 2 && lst[0].stocktakeNo === 2);
  const crossList = await defaultStocktakeService.list(other.id);
  await check('ST-18 other company sees none (isolation)', crossList.length === 0);
  const crossGet = await rejects(() => defaultStocktakeService.get(other.id, st.id));
  await check('ST-19 other company cannot read sheet', !!crossGet, crossGet || '');

  const { exitCode } = summary();
  await closeAllExecutors().catch(() => {});
  process.exit(exitCode);
}
main().catch(async (e) => { console.error('FATAL', e); await closeAllExecutors().catch(() => {}); process.exit(1); });
