import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultMembershipStore } from '../src/server/org/membershipStore.js';
import { defaultOrgUnitService } from '../src/server/org/orgUnitService.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { defaultFleetService } from '../src/server/fleet/fleetService.js';
import { defaultFleetExpenseService, canExpenseMove, parseAmount } from '../src/server/fleet/fleetExpenseService.js';
import { defaultFleetTripService } from '../src/server/fleet/fleetTripService.js';
import { defaultAccountService } from '../src/server/accounting/accountService.js';
import { defaultPeriodService } from '../src/server/accounting/periodService.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../src/server/http/errors.js';
import { ROLE_PERMISSIONS } from '../src/server/rbac/roles.js';

console.log('=== VERIFYING FLEET expense lines (081) ===');

function assertLoopbackUrl(raw: string, varName: string): void {
  const parsed = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
}

async function run() {
  await check('E1: allowed moves: draft->approved/rejected, approved->posted/rejected, posted->reversed only; final states are final',
    canExpenseMove('draft', 'approved') && canExpenseMove('draft', 'rejected') && canExpenseMove('approved', 'posted') && canExpenseMove('approved', 'rejected') &&
    canExpenseMove('posted', 'reversed') && !canExpenseMove('draft', 'posted') && !canExpenseMove('posted', 'rejected') && !canExpenseMove('reversed', 'posted') && !canExpenseMove('rejected', 'approved'));
  let amtOk = parseAmount(10.5) === 10.5 && parseAmount('99.99') === 99.99;
  for (const bad of [0, -5, 'abc', 1.234, NaN, null]) { try { parseAmount(bad); amtOk = false; } catch (e) { if (!(e instanceof ValidationError)) amtOk = false; } }
  await check('E2: amount must be greater than zero with at most 2 decimals', amtOk);
  await check('E3: company_admin has the three expense permissions, company_user has none',
    ['fleet:expense:create', 'fleet:expense:approve', 'fleet:expense:post'].every((p) => ROLE_PERMISSIONS.company_admin.includes(p as any) && !ROLE_PERMISSIONS.company_user.includes(p as any)));

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') { blocked('DATABASE_URL is not set. Live DB checks are BLOCKED.'); process.exit(summary().exitCode); return; }
  try {
    assertLoopbackUrl(dbUrl, 'DATABASE_URL');
    if (process.env.MIGRATION_DATABASE_URL) assertLoopbackUrl(process.env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL');
  } catch (err) { blocked(err instanceof Error ? err.message : String(err)); process.exit(summary().exitCode); return; }
  const executor = await getDefaultExecutor();
  if (!executor) { blocked('Unable to connect to database executor. Live DB checks are BLOCKED.'); process.exit(summary().exitCode); return; }

  const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const companyIds: string[] = [];
  const userIds: string[] = [];
  let cleanupFailed = false;
  const rejects = async (fn: () => Promise<unknown>, cls: any) => { try { await fn(); return false; } catch (e) { return e instanceof cls; } };

  try {
    const companyRepo = new CompanyRepository();
    const userRepo = new UserRepository();
    const creator = await userRepo.createUser({ username: `fx_cr_${unique}`, passwordHash: 'dummy_fx_hash', role: 'user' });
    const approver = await userRepo.createUser({ username: `fx_ap_${unique}`, passwordHash: 'dummy_fx_hash', role: 'user' });
    const outsider = await userRepo.createUser({ username: `fx_out_${unique}`, passwordHash: 'dummy_fx_hash', role: 'user' });
    userIds.push(creator.id, approver.id, outsider.id);
    const compA = await companyRepo.create({ code: `FXA-${unique}`.slice(0, 20), nameAr: `شركة مصروفات أ ${unique}`, createdBy: creator.id });
    const compB = await companyRepo.create({ code: `FXB-${unique}`.slice(0, 20), nameAr: `شركة مصروفات ب ${unique}`, createdBy: outsider.id });
    companyIds.push(compA.id, compB.id);
    await defaultMembershipStore.addMember(creator.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(approver.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(outsider.id, compB.id, 'company_admin', true);
    const unitA = await defaultOrgUnitService.createUnit(compA.id, { code: 'HQ', nameAr: 'المركز', unitType: 'branch' } as any, creator.id);

    const now = new Date();
    const y = now.getUTCFullYear(); const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate();
    await defaultPeriodService.createPeriod(compA.id, { code: `${y}-${m}-FX-${unique}`, startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${String(lastDay).padStart(2, '0')}` }, creator.id);
    const dt = `${y}-${m}-${String(Math.min(now.getUTCDate(), lastDay)).padStart(2, '0')}`;
    const acc = (code: string, type: string, extra: Record<string, unknown> = {}) =>
      defaultAccountService.createAccount(compA.id, { code: `${code}-${unique}`.slice(0, 20), nameAr: code, accountType: type as any, isPostable: true, ...extra } as any, creator.id);
    const fuelAcc = await acc('FUEL', 'expense');
    const repairAcc = await acc('REPAIR', 'expense');
    const apAcc = await acc('AP', 'liability');
    const cashAcc = await acc('CASH', 'asset');
    const revAcc = await acc('REV', 'revenue');
    const parentExp = await acc('PEXP', 'expense', { isPostable: false });
    const accB = await defaultAccountService.createAccount(compB.id, { code: `BX-${unique}`.slice(0, 20), nameAr: 'ب', accountType: 'expense', isPostable: true } as any, outsider.id);

    const V1 = await defaultFleetService.createVehicle(compA.id, { code: 'V-1', plateNo: 'X 111', orgUnitId: unitA.id }, creator.id);
    const V2 = await defaultFleetService.createVehicle(compA.id, { code: 'V-2', plateNo: 'X 222' }, creator.id);
    const D1 = await defaultFleetService.createDriver(compA.id, { fullName: 'سائق 1', licenseNo: 'L-1', licenseExpiry: '2035-01-01' }, creator.id);
    const trip = await defaultFleetTripService.createTrip(compA.id, { vehicleId: V1.id, driverId: D1.id, purpose: 'توصيل', stops: [{ placeName: 'أ' }, { placeName: 'ب' }],
      plannedStart: '2027-03-01T08:00:00.000Z', plannedEnd: '2027-03-01T12:00:00.000Z' }, creator.id);

    const svc = defaultFleetExpenseService;
    await check('E4: category must map to an expense account: revenue, parent (non-postable), foreign-company and unknown accounts are refused',
      (await rejects(() => svc.createCategory(compA.id, { code: 'BAD1', nameAr: 'x', expenseAccountId: revAcc.id }, creator.id), ValidationError)) &&
      (await rejects(() => svc.createCategory(compA.id, { code: 'BAD2', nameAr: 'x', expenseAccountId: parentExp.id }, creator.id), ValidationError)) &&
      (await rejects(() => svc.createCategory(compA.id, { code: 'BAD3', nameAr: 'x', expenseAccountId: accB.id }, creator.id), NotFoundError)) &&
      (await rejects(() => svc.createCategory(compA.id, { code: 'BAD4', nameAr: 'x', expenseAccountId: '00000000-0000-4000-8000-000000000000' }, creator.id), NotFoundError)));
    const catFuel = await svc.createCategory(compA.id, { code: 'fuel', nameAr: 'وقود', expenseAccountId: fuelAcc.id }, creator.id);
    const catRep = await svc.createCategory(compA.id, { code: 'REPAIR', nameAr: 'صيانة', expenseAccountId: repairAcc.id }, creator.id);

    const catFuel2 = catFuel, catRep2 = catRep;
    const mkL = (lines: any[], extra: Record<string, unknown> = {}) => svc.createExpense(compA.id, { vehicleId: V1.id, expenseDate: dt, description: 'مصروف متعدد', lines, ...extra }, creator.id);
    const jeLines = async (je: string) => withTenantTransaction(compA.id, async (tx) => (await tx.query<any>(`SELECT account_id AS "accountId", debit, credit FROM journal_lines WHERE company_id=$1 AND entry_id=$2`, [compA.id, je])).rows);
    const results: Record<number, string> = {};
    for (const n of [1, 2, 100]) {
      const lines = Array.from({ length: n }, (_, i) => ({ categoryId: i % 2 === 0 ? catFuel2.id : catRep2.id, amount: 1 + (i % 3), description: `سطر ${i + 1}` }));
      const sum = lines.reduce((a, l) => a + l.amount, 0);
      const X = await mkL(lines);
      const ok1 = X.lines?.length === n && X.amount === sum && X.linesCount === n && X.status === 'draft';
      await svc.approveExpense(compA.id, X.id, approver.id);
      const P = await svc.postExpense(compA.id, X.id, apAcc.id, approver.id);
      const jl = await jeLines(P.journalEntryId!);
      const d = jl.reduce((a: number, l: any) => a + Number(l.debit), 0), c = jl.reduce((a: number, l: any) => a + Number(l.credit), 0);
      const okJe = jl.length === n + 1 && Math.abs(d - c) < 1e-9 && Math.abs(d - sum) < 1e-9 && jl.filter((l: any) => Number(l.debit) > 0).length === n;
      await check(`L${n}: expense with ${n} line(s): header amount = sum (${sum}), JE has ${n + 1} lines (one debit per line + one credit) and balances`, ok1 && okJe, `lines=${jl.length} d=${d} c=${c}`);
      results[n] = X.id;
    }
    await check('L4: 101 lines rejected with a clear Arabic message (nothing created)', await (async () => {
      const before = (await svc.listExpenses(compA.id)).length;
      const lines = Array.from({ length: 101 }, () => ({ categoryId: catFuel2.id, amount: 1 }));
      let msg = ''; try { await mkL(lines); } catch (e: any) { msg = e instanceof ValidationError ? e.message : 'WRONG:' + e.message; }
      return msg.includes('101') && msg.includes('100') && (await svc.listExpenses(compA.id)).length === before;
    })());
    await check('L5: line validation: empty list, zero/3-decimal amount, unknown or missing category are refused with the line number',
      (await rejects(() => mkL([]), ValidationError)) && (await rejects(() => mkL([{ categoryId: catFuel2.id, amount: 0 }]), ValidationError)) &&
      (await rejects(() => mkL([{ categoryId: catFuel2.id, amount: 1 }, { categoryId: catFuel2.id, amount: 1.005 }]), ValidationError)) &&
      (await rejects(() => mkL([{ categoryId: '00000000-0000-4000-8000-000000000000', amount: 1 }]), NotFoundError)) &&
      (await rejects(() => mkL([{ amount: 1 }]), ValidationError)));
    await check('L6: legacy single categoryId+amount still works and shows as one line; list shows linesCount',
      await (async () => { const X = await svc.createExpense(compA.id, { vehicleId: V1.id, categoryId: catFuel2.id, expenseDate: dt, amount: 12.5, description: 'قديم' }, creator.id);
        const l = await svc.listExpenses(compA.id); const row = l.find((x) => x.id === X.id); const l100 = l.find((x) => x.id === results[100]);
        return X.lines?.length === 1 && X.amount === 12.5 && row?.linesCount === 1 && l100?.linesCount === 100; })());
    await check('L7: counter account equal to ANY line expense account is refused',
      await (async () => { const X = await mkL([{ categoryId: catFuel2.id, amount: 5 }, { categoryId: catRep2.id, amount: 6 }]); await svc.approveExpense(compA.id, X.id, approver.id);
        return (await rejects(() => svc.postExpense(compA.id, X.id, repairAcc.id, approver.id), ValidationError)) && (await svc.getExpense(compA.id, X.id)).status === 'approved'; })());
    const tryDb = async (sql: string) => { try { await withTenantTransaction(compA.id, (tx) => tx.query(sql, [compA.id])); return false; } catch { return true; } };
    await check('L8: lines are immutable (UPDATE blocked) and invisible to another company (RLS)',
      (await tryDb('UPDATE fleet_expense_lines SET amount = amount + 1 WHERE company_id = $1')) && (await tryDb('DELETE FROM fleet_expenses WHERE company_id = $1')) &&
      (await withTenantTransaction(compB.id, async (tx) => (await tx.query('SELECT 1 FROM fleet_expense_lines WHERE company_id = $1', [compA.id])).rows.length)) === 0);
    await check('L9: reversing a multi-line expense nets every expense account to zero',
      await (async () => { await svc.reverseExpense(compA.id, results[100], 'اختبار', approver.id);
        const r = (await withTenantTransaction(compA.id, async (tx) => (await tx.query<any>(`SELECT account_id, SUM(debit)-SUM(credit) AS net FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id AND e.company_id=l.company_id WHERE l.company_id=$1 AND e.id IN (SELECT journal_entry_id FROM fleet_expenses WHERE id=$2 UNION SELECT reversal_entry_id FROM fleet_expenses WHERE id=$2) GROUP BY account_id`, [compA.id, results[100]])).rows));
        return r.length === 3 && r.every((x: any) => Number(x.net) === 0); })());
    } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(cleanupUrl));
      try {
        await client.connect();
        await client.query('BEGIN');
        const trg = ['fleet_expenses:trg_fleet_expenses_no_delete', 'fleet_expense_categories:trg_fleet_expense_categories_no_delete', 'fleet_trip_stops:trg_fleet_trip_stops_no_delete', 'fleet_trips:trg_fleet_trips_no_delete', 'fleet_vehicles:trg_fleet_vehicles_no_delete', 'fleet_drivers:trg_fleet_drivers_no_delete', 'audit_logs:audit_logs_immutable', 'journal_entries:trg_journal_entries_immutability', 'journal_lines:trg_journal_lines_immutability'];
        for (const t of trg) { const [tb, tr] = t.split(':'); await client.query(`ALTER TABLE ${tb} DISABLE TRIGGER ${tr}`); }
        for (const tb of ['fleet_expenses', 'fleet_expense_categories', 'fleet_trip_stops', 'fleet_trips', 'fleet_vehicles', 'fleet_drivers', 'journal_lines', 'journal_entries'])
          await client.query(`DELETE FROM ${tb} WHERE company_id = ANY($1::uuid[])`, [companyIds]);
        for (const tb of ['accounting_periods', 'accounting_sequences', 'accounts', 'org_units', 'company_memberships', 'audit_logs'])
          await client.query(`DELETE FROM ${tb} WHERE company_id = ANY($1::uuid[])`, [companyIds]);
        await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
        if (userIds.length > 0) {
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }
        for (const t of trg) { const [tb, tr] = t.split(':'); await client.query(`ALTER TABLE ${tb} ENABLE TRIGGER ${tr}`); }
        await client.query('COMMIT');
        console.log('[cleanup] Fleet expense test companies and rows purged cleanly.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try { await client.query('ROLLBACK'); } catch {}
        console.error('[cleanup] Failed cleaning up verifyFleetExpenseLines1:', cleanupErr);
      } finally { await client.end(); }
    }
    await closeAllExecutors();
  }
  const { exitCode } = summary();
  if (cleanupFailed) process.exit(1);
  process.exit(exitCode);
}
run().catch((err) => { console.error('[verifyFleetExpenseLines1] Fatal error:', err); process.exit(1); });
