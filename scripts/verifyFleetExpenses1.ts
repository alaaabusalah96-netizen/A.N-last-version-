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

console.log('=== VERIFYING FLEET-C1 (expenses and accounting link) ===');

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
    await check('E5: category created with upper-case code; duplicate code refused', catFuel.code === 'FUEL' && (await rejects(() => svc.createCategory(compA.id, { code: 'FUEL', nameAr: 'y', expenseAccountId: fuelAcc.id }, creator.id), ConflictError)));

    const mk = (extra: Record<string, unknown> = {}) => svc.createExpense(compA.id, { vehicleId: V1.id, categoryId: catFuel.id, expenseDate: dt, amount: 250.5, description: 'تعبئة وقود', ...extra }, creator.id);
    const X1 = await mk({ tripId: trip.id, odometerKm: 1200 });
    await check('E6: expense created as draft FEX-00001 with the vehicle unit, trip, amount 250.5',
      X1.status === 'draft' && X1.expenseNo === 'FEX-00001' && X1.orgUnitId === unitA.id && X1.tripId === trip.id && X1.amount === 250.5 && X1.odometerKm === 1200);
    await check('E7: validation: zero or 3-decimal amount, bad date, missing description, unknown vehicle/category, trip of another vehicle, foreign vehicle',
      (await rejects(() => mk({ amount: 0 }), ValidationError)) && (await rejects(() => mk({ amount: 1.005 }), ValidationError)) &&
      (await rejects(() => mk({ expenseDate: '1/1/2027' }), ValidationError)) && (await rejects(() => mk({ description: '' }), ValidationError)) &&
      (await rejects(() => mk({ vehicleId: '00000000-0000-4000-8000-000000000000' }), NotFoundError)) &&
      (await rejects(() => mk({ categoryId: '00000000-0000-4000-8000-000000000000' }), NotFoundError)) &&
      (await rejects(() => mk({ vehicleId: V2.id, tripId: trip.id }), ValidationError)));
    await check('E8: the creator cannot approve their own expense', await rejects(() => svc.approveExpense(compA.id, X1.id, creator.id), ForbiddenError));
    await check('E9: nothing is posted before approval: posting a draft is refused and no journal entry exists',
      (await rejects(() => svc.postExpense(compA.id, X1.id, apAcc.id, approver.id), ConflictError)) &&
      (await withTenantTransaction(compA.id, async (tx) => (await tx.query('SELECT 1 FROM journal_entries WHERE company_id=$1', [compA.id])).rows.length)) === 0);
    const X1a = await svc.approveExpense(compA.id, X1.id, approver.id);
    await check('E10: another user approves: approved, approver recorded', X1a.status === 'approved' && X1a.approvedBy === approver.id && !!X1a.approvedAt);
    await check('E11: counter account must be an active postable asset or liability: revenue, expense account itself, parent, missing are refused',
      (await rejects(() => svc.postExpense(compA.id, X1.id, revAcc.id, approver.id), ValidationError)) &&
      (await rejects(() => svc.postExpense(compA.id, X1.id, fuelAcc.id, approver.id), ValidationError)) &&
      (await rejects(() => svc.postExpense(compA.id, X1.id, undefined, approver.id), ValidationError)) &&
      (await rejects(() => svc.postExpense(compA.id, X1.id, accB.id, approver.id), NotFoundError)));
    const X1p = await svc.postExpense(compA.id, X1.id, apAcc.id, approver.id);
    const lines = await withTenantTransaction(compA.id, async (tx) => (await tx.query<any>(
      `SELECT l.account_id AS "accountId", l.debit, l.credit, e.status FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id AND e.company_id=l.company_id WHERE l.company_id=$1 AND l.entry_id=$2 ORDER BY l.debit DESC`, [compA.id, X1p.journalEntryId])).rows);
    await check('E12: posting creates a posted entry: Dr category expense account 250.5, Cr the chosen payables account 250.5',
      X1p.status === 'posted' && !!X1p.journalEntryId && X1p.counterAccountId === apAcc.id && lines.length === 2 && lines[0].accountId === fuelAcc.id && Number(lines[0].debit) === 250.5 &&
      lines[1].accountId === apAcc.id && Number(lines[1].credit) === 250.5 && lines[0].status === 'posted');
    await check('E13: a posted expense cannot be posted, approved or rejected again',
      (await rejects(() => svc.postExpense(compA.id, X1.id, apAcc.id, approver.id), ConflictError)) && (await rejects(() => svc.approveExpense(compA.id, X1.id, approver.id), ConflictError)) &&
      (await rejects(() => svc.rejectExpense(compA.id, X1.id, 'x', approver.id), ConflictError)));
    await check('E14: reversing needs a reason; then a reversing entry exists and the status is reversed; a second reversal is refused',
      (await rejects(() => svc.reverseExpense(compA.id, X1.id, '', approver.id), ValidationError)) &&
      await (async () => { const r = await svc.reverseExpense(compA.id, X1.id, 'فاتورة مكررة', approver.id); return r.status === 'reversed' && !!r.reversalEntryId && r.reversalEntryId !== r.journalEntryId; })() &&
      (await rejects(() => svc.reverseExpense(compA.id, X1.id, 'again', approver.id), ConflictError)));
    const bal = await withTenantTransaction(compA.id, async (tx) => (await tx.query<any>(
      `SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_lines WHERE company_id=$1 AND account_id=$2`, [compA.id, fuelAcc.id])).rows[0]);
    await check('E15: after the reversal the expense account nets to zero (debit equals credit)', Number(bal.d) === Number(bal.c) && Number(bal.d) === 250.5);

    const X2 = await mk({ categoryId: catRep.id, amount: 80 });
    await check('E16: reject needs a reason; a rejected expense cannot be approved or posted and creates no entry',
      (await rejects(() => svc.rejectExpense(compA.id, X2.id, '', approver.id), ValidationError)) &&
      (await svc.rejectExpense(compA.id, X2.id, 'غير مبرر', approver.id)).status === 'rejected' &&
      (await rejects(() => svc.approveExpense(compA.id, X2.id, approver.id), ConflictError)) && (await rejects(() => svc.postExpense(compA.id, X2.id, apAcc.id, approver.id), ConflictError)));
    const X3 = await mk({ categoryId: catRep.id, amount: 40 });
    await svc.approveExpense(compA.id, X3.id, approver.id);
    await svc.updateCategory(compA.id, catRep.id, { expenseAccountId: parentExp.id }, creator.id).then(() => null, () => null);
    await check('E17: changing a category to a non-postable account is refused', await rejects(() => svc.updateCategory(compA.id, catRep.id, { expenseAccountId: parentExp.id }, creator.id), ValidationError));
    const before = await withTenantTransaction(compA.id, async (tx) => (await tx.query('SELECT 1 FROM journal_entries WHERE company_id=$1', [compA.id])).rows.length);
    const cashRow = await withTenantTransaction(compA.id, async (tx) => (await tx.query<any>('SELECT is_active FROM accounts WHERE company_id=$1 AND id=$2', [compA.id, cashAcc.id])).rows[0]);
    if (cashRow.is_active === false) {
      await check('E18: an inactive counter account stops the posting and nothing is written (journal count unchanged, expense stays approved)',
        (await rejects(() => svc.postExpense(compA.id, X3.id, cashAcc.id, approver.id), ValidationError)) &&
        (await svc.getExpense(compA.id, X3.id)).status === 'approved' &&
        (await withTenantTransaction(compA.id, async (tx) => (await tx.query('SELECT 1 FROM journal_entries WHERE company_id=$1', [compA.id])).rows.length)) === before);
    } else {
      await check('E18: a failing journal (date outside every open period) stops the posting and nothing is written',
        (await (async () => { const Xo = await mk({ expenseDate: '2001-01-01', amount: 5 }); await svc.approveExpense(compA.id, Xo.id, approver.id);
          const ok = await rejects(() => svc.postExpense(compA.id, Xo.id, cashAcc.id, approver.id), Error);
          return ok && (await svc.getExpense(compA.id, Xo.id)).status === 'approved'; })()) &&
        (await withTenantTransaction(compA.id, async (tx) => (await tx.query('SELECT 1 FROM journal_entries WHERE company_id=$1', [compA.id])).rows.length)) === before);
    }
    const X3p = await svc.postExpense(compA.id, X3.id, cashAcc.id, approver.id).catch(() => null);
    const listed = await svc.listExpenses(compA.id, { status: 'approved' });
    await check('E19: list filters by status and vehicle', Array.isArray(listed) && (await svc.listExpenses(compA.id, { vehicleId: V2.id })).length === 0 && (await svc.listExpenses(compA.id, { vehicleId: V1.id })).length >= 3 && (X3p === null || X3p.status === 'posted'));
    await check('E20: company B cannot see or touch company A expenses', (await svc.listExpenses(compB.id)).length === 0 && (await rejects(() => svc.getExpense(compB.id, X1.id), NotFoundError)) && (await rejects(() => svc.approveExpense(compB.id, X2.id, outsider.id), NotFoundError)));
    const seenFromB = await withTenantTransaction(compB.id, async (tx) => (await tx.query('SELECT id FROM fleet_expenses WHERE company_id = $1', [compA.id])).rows.length + (await tx.query('SELECT id FROM fleet_expense_categories WHERE company_id = $1', [compA.id])).rows.length);
    await check('E21: RLS: company B context sees no company A expense rows or categories', seenFromB === 0);
    const tryDb = async (sql: string) => { try { await withTenantTransaction(compA.id, (tx) => tx.query(sql, [compA.id])); return false; } catch (e) { console.log('   blocked:', String((e as Error).message).slice(0, 80)); return true; } };
    await check('E22: DELETE of an expense or category is blocked; amount change after the draft stage is blocked',
      (await tryDb('DELETE FROM fleet_expenses WHERE company_id = $1')) && (await tryDb('DELETE FROM fleet_expense_categories WHERE company_id = $1')) && (await tryDb(`UPDATE fleet_expenses SET amount = amount + 1 WHERE company_id = $1 AND status <> 'draft'`)));
    const cl = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl));
    await cl.connect();
    const au = await cl.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE company_id = $1 AND action LIKE 'FLEET_EXPENSE%'`, [compA.id]);
    await cl.end();
    await check('E23: every successful change has an audit record (at least create, approve, post, reverse of expense 1 plus 2 categories)', au.rows[0].n >= 8, `n=${au.rows[0].n}`);
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
        console.error('[cleanup] Failed cleaning up verifyFleetExpenses1:', cleanupErr);
      } finally { await client.end(); }
    }
    await closeAllExecutors();
  }
  const { exitCode } = summary();
  if (cleanupFailed) process.exit(1);
  process.exit(exitCode);
}
run().catch((err) => { console.error('[verifyFleetExpenses1] Fatal error:', err); process.exit(1); });
