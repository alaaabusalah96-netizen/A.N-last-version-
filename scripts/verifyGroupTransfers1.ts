import { check, blocked, summary } from './lib/testkit.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultCompanyGroupService as groups } from '../src/server/org/companyGroupService.js';
import { defaultWarehouseService } from '../src/server/inventory/warehouseService.js';
import { defaultItemService } from '../src/server/inventory/itemService.js';
import { defaultStockService } from '../src/server/inventory/stockService.js';
import { defaultGroupTransferService as svc } from '../src/server/inventory/groupTransferService.js';
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
    blocked('DATABASE_URL missing or not loopback. Group transfer test is BLOCKED.');
    process.exit(summary().exitCode);
  }
  const ex = await getDefaultExecutor();
  if (!ex) { blocked('no executor'); process.exit(summary().exitCode); }
  const sfx = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const users = new UserRepository();
  const mkU = async (n: string, role: any = 'user') => (await users.createUser({ username: `t_${n}_${sfx}`, passwordHash: 'dummy_hash', role })).id;
  const [adminId, actor] = [await mkU('pa', 'platform_admin'), await mkU('wh')];
  const PA = { id: adminId, role: 'platform_admin' };
  const year = new Date().toISOString().slice(0, 4);

  const mkCompany = async (tag: string, currency: string) => {
    const cid = (await new CompanyRepository().create({ code: `${tag}_${sfx}`, nameAr: `شركة ${tag}`, createdBy: adminId })).id;
    const inv = await defaultAccountService.createAccount(cid, { code: '1130', nameAr: 'المخزون', accountType: 'asset', isPostable: true }, actor);
    const adj = await defaultAccountService.createAccount(cid, { code: '5120', nameAr: 'تسويات', accountType: 'expense', isPostable: true }, actor);
    const rec = await defaultAccountService.createAccount(cid, { code: '1510', nameAr: 'ذمم مجموعة مدينة', accountType: 'asset', isPostable: true }, actor);
    const pay = await defaultAccountService.createAccount(cid, { code: '2510', nameAr: 'ذمم مجموعة دائنة', accountType: 'liability', isPostable: true }, actor);
    await defaultPeriodService.createPeriod(cid, { code: `FY-${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` }, actor);
    await defaultCompanySettingsRepository.upsert(cid, { inventoryAccountId: inv.id, inventoryAdjustmentAccountId: adj.id, defaultCurrencyCode: currency } as any, actor);
    const wh = await defaultWarehouseService.createWarehouse(cid, { code: `W-${sfx}`, nameAr: 'مخزن', nameEn: 'wh' }, actor);
    const mk = async (c: string) => (await defaultItemService.createItem(cid, { code: `${c}-${sfx}`, nameAr: c, nameEn: c, uom: 'pc' }, actor)).id;
    const items: Record<string, string> = { A: await mk('A'), B: await mk('B') };
    await ensureTestCostingProfile(cid, Object.values(items), actor);
    return { cid, inv: inv.id, rec: rec.id, pay: pay.id, wh: wh.id, items, mk };
  };
  const S = await mkCompany('S', 'EGP');
  const R = await mkCompany('R', 'EGP');
  const F = await mkCompany('F', 'USD');
  const O = await mkCompany('O', 'EGP'); // not in the group
  const g = await groups.create(PA, { code: `TG_${sfx}`, nameAr: 'مجموعة تحويل' });
  for (const c of [S, R, F]) await groups.addCompany(PA, g.id, c.cid);

  const seed = (c: typeof S, item: string, qty: number, cost = 5) =>
    defaultStockService.receiveStock(c.cid, { warehouseId: c.wh, itemId: item, qty, unitCost: cost, costSource: 'MANUAL_RECEIPT', reason: 'seed' }, actor);
  await seed(S, S.items.A, 100); await seed(S, S.items.B, 100);
  const qtyOf = (c: typeof S, item: string) => withTenantTransaction(c.cid, async (tx) => Number((await tx.query<any>(`SELECT COALESCE(sum(qty),0)::text q FROM inv_stock_balances WHERE company_id=$1 AND item_id=$2`, [c.cid, item])).rows[0].q));
  const jl = (c: typeof S, jeId: string) => withTenantTransaction(c.cid, async (tx) => (await tx.query<any>(`SELECT account_id as a, debit::float8 d, credit::float8 c FROM journal_lines WHERE company_id=$1 AND entry_id=$2`, [c.cid, jeId])).rows);
  const rowCount = () => ex.query<any>(`SELECT count(*)::int n FROM group_transfers WHERE from_company_id=$1`, [S.cid]).then((r) => r.rows[0].n);
  const shipIn = (ref: string, lines: any[], to = R.cid, extra: any = {}) => svc.ship(S.cid, { toCompanyId: to, fromWarehouseId: S.wh, reference: ref, lines, ...extra }, actor);

  const e1 = await rejects(() => shipIn(`R1_${sfx}`, [{ itemId: S.items.A, qty: 1 }]));
  await check('GT-1 ship refused while the sender has no intercompany receivable account', !!e1 && e1.includes('MISSING_ACCOUNTING_MAPPING'), e1 || '');
  const e2 = await rejects(() => svc.setAccounts(S.cid, { receivableAccountId: S.pay, payableAccountId: null }, actor));
  await check('GT-2 receivable account must be an asset account', !!e2, e2 || '');
  const e2b = await rejects(() => svc.setAccounts(S.cid, { receivableAccountId: S.rec, payableAccountId: S.rec }, actor));
  await check('GT-3 receivable and payable cannot be the same account', !!e2b, e2b || '');
  for (const c of [S, R, F]) await svc.setAccounts(c.cid, { receivableAccountId: c.rec, payableAccountId: c.pay }, actor);
  const acc = await svc.getAccounts(S.cid);
  await check('GT-4 accounts saved and read back', acc.receivableAccountId === S.rec && acc.payableAccountId === S.pay);
  await ex.query(`UPDATE company_intercompany_accounts SET payable_account_id = NULL WHERE company_id = $1`, [R.cid]).catch(() => {});
  const accR = await svc.getAccounts(R.cid);
  if (accR.payableAccountId) {
    await withTenantTransaction(R.cid, async (tx) => { await tx.query(`UPDATE company_intercompany_accounts SET payable_account_id = NULL WHERE company_id = $1`, [R.cid]); });
  }
  const e3 = await rejects(() => shipIn(`R2_${sfx}`, [{ itemId: S.items.A, qty: 1 }]));
  await check('GT-5 ship refused while the receiver has no payable account', !!e3 && e3.includes('الشركة المستلمة'), e3 || '');
  await svc.setAccounts(R.cid, { receivableAccountId: R.rec, payableAccountId: R.pay }, actor);

  const t1 = await shipIn(`T1_${sfx}`, [{ itemId: S.items.A, qty: 10 }]);
  await check('GT-6 ship 10 units at cost: status shipped, total cost 50', t1.status === 'shipped' && t1.totalCost === 50, JSON.stringify(t1));
  await check('GT-7 sender stock fell 100 to 90; receiver stock still 0', (await qtyOf(S, S.items.A)) === 90 && (await qtyOf(R, R.items.A)) === 0);
  const d1 = await svc.get(S.cid, t1.id);
  const sj = await jl(S, (await ex.query<any>(`SELECT ship_journal_id j FROM group_transfer_lines WHERE transfer_id=$1`, [t1.id])).rows[0].j);
  await check('GT-8 sender journal: debit receivable 50, credit inventory 50',
    sj.some((l: any) => l.a === S.rec && l.d === 50) && sj.some((l: any) => l.a === S.inv && l.c === 50), JSON.stringify(sj));
  await check('GT-9 transfer line carries both item ids by code', d1.lines.length === 1 && d1.lines[0].unitCost === 5 && d1.direction === 'out');

  const wrongWh = await rejects(() => svc.receive(R.cid, t1.id, { warehouseId: S.wh }, actor));
  await check('GT-10 receive into a warehouse of another company rejected', !!wrongWh, wrongWh || '');
  const wrongCo = await rejects(() => svc.receive(S.cid, t1.id, { warehouseId: S.wh }, actor));
  await check('GT-11 the sender cannot receive its own transfer', !!wrongCo, wrongCo || '');
  const r1 = await svc.receive(R.cid, t1.id, { warehouseId: R.wh }, actor);
  await check('GT-12 receive in full: status received, cost 50', r1.status === 'received' && r1.totalCost === 50, JSON.stringify(r1));
  await check('GT-13 receiver stock is 10', (await qtyOf(R, R.items.A)) === 10);
  const rj = await jl(R, (await ex.query<any>(`SELECT receive_journal_id j FROM group_transfer_lines WHERE transfer_id=$1`, [t1.id])).rows[0].j);
  await check('GT-14 receiver journal: debit inventory 50, credit payable 50',
    rj.some((l: any) => l.a === R.inv && l.d === 50) && rj.some((l: any) => l.a === R.pay && l.c === 50), JSON.stringify(rj));
  const again = await rejects(() => svc.receive(R.cid, t1.id, { warehouseId: R.wh }, actor));
  await check('GT-15 receiving twice is rejected and stock stays 10', !!again && (await qtyOf(R, R.items.A)) === 10, again || '');

  const before = await rowCount();
  const tooMuch = await rejects(() => shipIn(`T2_${sfx}`, [{ itemId: S.items.B, qty: 5 }, { itemId: S.items.A, qty: 1000 }]));
  await check('GT-16 shipping more than the stock fails as a whole (no row, B stock unchanged 100)', !!tooMuch && (await rowCount()) === before && (await qtyOf(S, S.items.B)) === 100, tooMuch || '');
  const dup = await rejects(() => shipIn(`T1_${sfx}`, [{ itemId: S.items.A, qty: 1 }]));
  await check('GT-17 duplicate reference rejected', !!dup && dup.includes('المرجع'), dup || '');
  const out = await rejects(() => shipIn(`T3_${sfx}`, [{ itemId: S.items.A, qty: 1 }], O.cid));
  await check('GT-18 transfer to a company outside the group rejected', !!out && out.includes('نفس المجموعة'), out || '');
  const self = await rejects(() => shipIn(`T4_${sfx}`, [{ itemId: S.items.A, qty: 1 }], S.cid));
  await check('GT-19 transfer to the same company rejected', !!self, self || '');
  const none = await rejects(() => shipIn(`T5_${sfx}`, []));
  await check('GT-20 empty document rejected', !!none, none || '');
  const lines101 = Array.from({ length: 101 }, (_, i) => ({ itemId: i % 2 ? S.items.A : S.items.B, qty: 1 }));
  const e101 = await rejects(() => shipIn(`T6_${sfx}`, lines101));
  await check('GT-21 101 lines rejected with a clear error', !!e101 && e101.includes('100'), e101 || '');
  const dupItem = await rejects(() => shipIn(`T7_${sfx}`, [{ itemId: S.items.A, qty: 1 }, { itemId: S.items.A, qty: 2 }]));
  await check('GT-22 repeated item rejected', !!dupItem, dupItem || '');
  const zero = await rejects(() => shipIn(`T8_${sfx}`, [{ itemId: S.items.A, qty: 0 }]));
  await check('GT-23 zero quantity rejected', !!zero, zero || '');
  const orphan = await S.mk('ONLY_S');
  await ensureTestCostingProfile(S.cid, [orphan], actor);
  await seed(S, orphan, 5);
  const noMap = await rejects(() => shipIn(`T9_${sfx}`, [{ itemId: orphan, qty: 1 }]));
  await check('GT-24 item that does not exist in the receiver company is rejected with its code', !!noMap && noMap.includes('الشركة المستلمة'), noMap || '');
  await check('GT-25 rejected shipments left stock unchanged (A 90, orphan 5)', (await qtyOf(S, S.items.A)) === 90 && (await qtyOf(S, orphan)) === 5);

  const t2 = await shipIn(`T10_${sfx}`, [{ itemId: S.items.A, qty: 10 }, { itemId: S.items.B, qty: 4 }]);
  const d2 = await svc.get(R.cid, t2.id);
  const lineA = d2.lines.find((l: any) => l.itemCode.startsWith('A-'));
  const over = await rejects(() => svc.receive(R.cid, t2.id, { warehouseId: R.wh, lines: [{ lineId: lineA.id, qtyReceived: 11 }] }, actor));
  await check('GT-26 received quantity above shipped rejected, transfer still shipped', !!over && (await svc.get(R.cid, t2.id)).status === 'shipped', over || '');
  const r2 = await svc.receive(R.cid, t2.id, { warehouseId: R.wh, lines: [{ lineId: lineA.id, qtyReceived: 8 }] }, actor);
  await check('GT-27 shortage: status received_short, cost 8x5 + 4x5 = 60', r2.status === 'received_short' && r2.totalCost === 60, JSON.stringify(r2));
  await check('GT-28 receiver stock A 10+8 = 18, B 4', (await qtyOf(R, R.items.A)) === 18 && (await qtyOf(R, R.items.B)) === 4);
  const d2b = await svc.get(S.cid, t2.id);
  await check('GT-29 sender view shows shipped 10 and received 8 for the short line', d2b.direction === 'out' && d2b.lines.find((l: any) => l.itemCode.startsWith('A-')).qtyReceived === 8);

  const lst = await svc.list(R.cid);
  await check('GT-30 list for the receiver shows 2 inbound transfers', lst.length === 2 && lst.every((x: any) => x.direction === 'in'), String(lst.length));
  const lstO = await svc.list(O.cid);
  await check('GT-31 an outside company sees no transfers', lstO.length === 0);
  const peek = await rejects(() => svc.get(O.cid, t1.id));
  await check('GT-32 an outside company cannot open a transfer', !!peek, peek || '');
  const partners = await svc.listPartners(S.cid);
  await check('GT-33 partners are the 2 other companies of the group (no outsider)', partners.length === 2 && !partners.some((p) => p.id === O.cid));

  const noFx = await rejects(() => shipIn(`T11_${sfx}`, [{ itemId: S.items.A, qty: 1 }], F.cid));
  await check('GT-34 different currencies require an explicit rate', !!noFx && noFx.includes('سعر التحويل'), noFx || '');
  const wrongFx = await rejects(() => shipIn(`T12_${sfx}`, [{ itemId: S.items.A, qty: 1 }], R.cid, { fxRate: 2 }));
  await check('GT-35 same currency with a rate other than 1 rejected', !!wrongFx, wrongFx || '');
  const t3 = await shipIn(`T13_${sfx}`, [{ itemId: S.items.A, qty: 2 }], F.cid, { fxRate: 0.02 });
  const r3 = await svc.receive(F.cid, t3.id, { warehouseId: F.wh }, actor);
  const d3 = await svc.get(F.cid, t3.id);
  await check('GT-36 cross currency: stored currencies EGP/USD, rate 0.02, receiver unit cost 5 x 0.02 = 0.1',
    d3.fromCurrency === 'EGP' && d3.toCurrency === 'USD' && d3.fxRate === 0.02 && d3.lines[0].receivedUnitCost === 0.1 && r3.totalCost === 0.2, JSON.stringify([d3.fromCurrency, d3.toCurrency, d3.fxRate, d3.lines[0].receivedUnitCost, r3.totalCost]));

  await groups.update(PA, g.id, { isActive: false });
  const inactive = await rejects(() => shipIn(`T14_${sfx}`, [{ itemId: S.items.A, qty: 1 }]));
  await check('GT-37 an inactive group cannot ship', !!inactive && inactive.includes('نفس المجموعة'), inactive || '');
  const audit = await ex.query<any>(`SELECT count(*)::int n FROM audit_logs WHERE action IN ('GROUP_TRANSFER_SHIP','GROUP_TRANSFER_RECEIVE') AND company_id = ANY($1)`, [[S.cid, R.cid, F.cid]]);
  await check('GT-38 audit rows written for ship and receive (6)', audit.rows[0].n === 6, String(audit.rows[0].n));

  const { exitCode } = summary();
  await closeAllExecutors().catch(() => {});
  process.exit(exitCode);
}
main().catch(async (e) => { console.error('FATAL', e); await closeAllExecutors().catch(() => {}); process.exit(1); });
