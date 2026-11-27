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
import { defaultFleetDriverPortalService, canDriverLogExpense } from '../src/server/fleet/fleetDriverPortalService.js';
import { PERMISSION_CATALOG } from '../src/server/rbac/permissions.js';
import { ROLE_PERMISSIONS } from '../src/server/rbac/roles.js';

console.log('=== VERIFYING FLEET-D (driver portal) ===');

function assertLoopbackUrl(raw: string, varName: string): void {
  const parsed = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
}

async function run() {
  await check('D1: driver may log expenses only on trips handed to them (dispatched, running, completed)',
    canDriverLogExpense('dispatched') && canDriverLogExpense('in_progress') && canDriverLogExpense('completed') && !canDriverLogExpense('draft') && !canDriverLogExpense('approved') && !canDriverLogExpense('cancelled'));
  await check('D2: fleet:driver:self is in the permission catalog and company_admin has it; company_user does not',
    PERMISSION_CATALOG.some((p) => p.code === 'fleet:driver:self') && ROLE_PERMISSIONS.company_admin.includes('fleet:driver:self' as any) && !ROLE_PERMISSIONS.company_user.includes('fleet:driver:self' as any));
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
    const mkU = (n: string) => userRepo.createUser({ username: `fd_${n}_${unique}`, passwordHash: 'dummy_fd_hash', role: 'user' });
    const office = await mkU('off'); const approver = await mkU('app'); const u1 = await mkU('d1'); const u2 = await mkU('d2'); const nodrv = await mkU('nd'); const userB = await mkU('b');
    userIds.push(office.id, approver.id, u1.id, u2.id, nodrv.id, userB.id);
    const compA = await companyRepo.create({ code: `FDA-${unique}`.slice(0, 20), nameAr: `شركة بوابة السائق أ ${unique}`, createdBy: office.id });
    const compB = await companyRepo.create({ code: `FDB-${unique}`.slice(0, 20), nameAr: `شركة بوابة السائق ب ${unique}`, createdBy: userB.id });
    companyIds.push(compA.id, compB.id);
    for (const u of [office, approver, u1, u2, nodrv]) await defaultMembershipStore.addMember(u.id, compA.id, u === office || u === approver ? 'company_admin' : 'company_user', true);
    await defaultMembershipStore.addMember(userB.id, compB.id, 'company_admin', true);
    const acc = await defaultAccountService.createAccount(compA.id, { code: `F-${unique}`.slice(0, 20), nameAr: 'وقود', accountType: 'expense' as any, isPostable: true } as any, office.id);
    const cat = await defaultFleetExpenseService.createCategory(compA.id, { code: 'FUEL', nameAr: 'وقود', expenseAccountId: acc.id }, office.id);
    const V1 = await defaultFleetService.createVehicle(compA.id, { code: 'V-1', plateNo: 'D 111' }, office.id);
    const V2 = await defaultFleetService.createVehicle(compA.id, { code: 'V-2', plateNo: 'D 222' }, office.id);
    const V3 = await defaultFleetService.createVehicle(compA.id, { code: 'V-3', plateNo: 'D 333' }, office.id);
    const D1 = await defaultFleetService.createDriver(compA.id, { fullName: 'سائق 1', licenseNo: 'L-1', licenseExpiry: '2035-01-01', userId: u1.id }, office.id);
    const D2 = await defaultFleetService.createDriver(compA.id, { fullName: 'سائق 2', licenseNo: 'L-2', licenseExpiry: '2035-01-01', userId: u2.id }, office.id);
    const stops = [{ placeName: 'أ' }, { placeName: 'ب' }];
    const w = (s: string, e: string) => ({ plannedStart: `2027-03-01T${s}:00.000Z`, plannedEnd: `2027-03-01T${e}:00.000Z` });
    const mk = async (v: string, d: string, win: any, upTo: 'draft' | 'approved' | 'dispatched') => {
      const t = await defaultFleetTripService.createTrip(compA.id, { vehicleId: v, driverId: d, purpose: 'توصيل', stops, ...win }, office.id);
      if (upTo === 'draft') return t;
      await defaultFleetTripService.approveTrip(compA.id, t.id, approver.id);
      if (upTo === 'approved') return t;
      return await defaultFleetTripService.dispatchTrip(compA.id, t.id, approver.id);
    };
    const P = defaultFleetDriverPortalService;
    const T1 = await mk(V1.id, D1.id, w('08:00', '12:00'), 'dispatched');
    const T1b = await mk(V3.id, D1.id, w('13:00', '15:00'), 'approved');
    const T1c = await mk(V3.id, D1.id, w('16:00', '18:00'), 'draft');
    const T2 = await mk(V2.id, D2.id, w('08:00', '12:00'), 'dispatched');
    await check('D3: a user with no linked driver gets nothing from the portal', (await rejects(() => P.myTrips(compA.id, nodrv.id), ForbiddenError)) && (await rejects(() => P.me(compA.id, office.id), ForbiddenError)));
    const mine = await P.myTrips(compA.id, u1.id);
    await check('D4: a driver sees only their own dispatched trip (not approved/draft trips, not another driver trip)',
      mine.length === 1 && mine[0].id === T1.id && mine[0].stops.length === 2 && !('driverId' in mine[0]));
    await check('D5: a driver cannot start or complete another driver trip (looks like not found), nor a trip not yet dispatched',
      (await rejects(() => P.startMyTrip(compA.id, u1.id, T2.id, 10), NotFoundError)) && (await rejects(() => P.startMyTrip(compA.id, u1.id, T1b.id, 10), NotFoundError)) &&
      (await rejects(() => P.completeMyTrip(compA.id, u1.id, T2.id, 10), NotFoundError)));
    await defaultFleetService.updateVehicle(compA.id, V1.id, { odometerKm: 500 }, office.id).catch(() => null);
    const st = await P.startMyTrip(compA.id, u1.id, T1.id, 600);
    await check('D6: driver starts own trip with an odometer reading: in_progress, reading saved', st.status === 'in_progress' && st.odometerStart === 600);
    await check('D7: completing with a reading below the start reading is refused; trip stays in progress',
      (await rejects(() => P.completeMyTrip(compA.id, u1.id, T1.id, 590), ValidationError)) && (await defaultFleetTripService.getTrip(compA.id, T1.id)).status === 'in_progress');
    const ex = await P.logMyExpense(compA.id, u1.id, T1.id, { categoryId: cat.id, expenseDate: '2027-03-01', amount: 120.5, description: 'وقود في الطريق' });
    await check('D8: driver logs an expense on own trip: draft, trip vehicle, created by the driver',
      ex.status === 'draft' && ex.vehicleId === V1.id && ex.tripId === T1.id && ex.createdBy === u1.id && ex.amount === 120.5);
    await check('D9: driver cannot log an expense on another driver trip or a not-yet-dispatched trip; bad amount refused',
      (await rejects(() => P.logMyExpense(compA.id, u1.id, T2.id, { categoryId: cat.id, expenseDate: '2027-03-01', amount: 5, description: 'x' }), NotFoundError)) &&
      (await rejects(() => P.logMyExpense(compA.id, u1.id, T1b.id, { categoryId: cat.id, expenseDate: '2027-03-01', amount: 5, description: 'x' }), NotFoundError)) &&
      (await rejects(() => P.logMyExpense(compA.id, u1.id, T1.id, { categoryId: cat.id, expenseDate: '2027-03-01', amount: -5, description: 'x' }), ValidationError)));
    await check('D10: the driver cannot approve their own expense (office approval stays separate)', await rejects(() => defaultFleetExpenseService.approveExpense(compA.id, ex.id, u1.id), ForbiddenError));
    const done = await P.completeMyTrip(compA.id, u1.id, T1.id, 640);
    const veh = (await defaultFleetService.listVehicles(compA.id, {})).find((x: any) => x.id === V1.id)!;
    await check('D11: completing records the end reading and moves the vehicle odometer to it', done.status === 'completed' && done.odometerEnd === 640 && Number(veh.odometerKm) === 640);
    await P.logMyExpense(compA.id, u2.id, T2.id, { categoryId: cat.id, expenseDate: '2027-03-01', amount: 30, description: 'سائق 2' });
    const my1 = await P.myExpenses(compA.id, u1.id);
    await check('D12: a driver lists only their own expenses; categories show names only', my1.length === 1 && my1[0].id === ex.id && (await P.categories(compA.id, u1.id)).every((c: any) => !('expenseAccountId' in c)));
    await withTenantTransaction(compA.id, (tx) => tx.query(`UPDATE fleet_drivers SET status='inactive' WHERE company_id=$1 AND id=$2`, [compA.id, D2.id]));
    await check('D13: an inactive driver loses portal access', await rejects(() => P.myTrips(compA.id, u2.id), ForbiddenError));
    await check('D14: tenant isolation: a company B user cannot use the portal in company A', await rejects(() => P.myTrips(compA.id, userB.id), ForbiddenError));
  } catch (err) {
    await check('Fleet D verification unexpected error', false, err instanceof Error ? err.message : String(err));
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
        console.error('[cleanup] Failed cleaning up verifyFleetDriver1:', cleanupErr);
      } finally { await client.end(); }
    }
    await closeAllExecutors();
  }
  const { exitCode } = summary();
  if (cleanupFailed) process.exit(1);
  process.exit(exitCode);
}
run().catch((err) => { console.error('[verifyFleetDriver1] Fatal error:', err); process.exit(1); });
