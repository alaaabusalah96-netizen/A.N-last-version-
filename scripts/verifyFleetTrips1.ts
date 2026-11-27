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
import { defaultFleetTripService, canTripMove, windowsOverlap } from '../src/server/fleet/fleetTripService.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../src/server/http/errors.js';
import { ROLE_PERMISSIONS } from '../src/server/rbac/roles.js';

console.log('=== VERIFYING FLEET-B (trips and approval) ===');

function assertLoopbackUrl(raw: string, varName: string): void {
  const parsed = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
}

async function run() {
  // Pure rules (no DB)
  await check('T1: allowed moves: draft->approved/rejected/cancelled, approved->dispatched/cancelled, dispatched->in_progress/cancelled, in_progress->completed only',
    canTripMove('draft', 'approved') && canTripMove('draft', 'rejected') && canTripMove('approved', 'dispatched') && canTripMove('dispatched', 'in_progress') &&
    canTripMove('in_progress', 'completed') && !canTripMove('in_progress', 'cancelled') && !canTripMove('completed', 'cancelled') &&
    !canTripMove('rejected', 'approved') && !canTripMove('draft', 'dispatched') && !canTripMove('cancelled', 'draft'));
  await check('T2: windows overlap when each starts before the other ends; touching edges do not overlap',
    windowsOverlap('2027-03-01T08:00:00Z', '2027-03-01T12:00:00Z', '2027-03-01T10:00:00Z', '2027-03-01T14:00:00Z') &&
    !windowsOverlap('2027-03-01T08:00:00Z', '2027-03-01T12:00:00Z', '2027-03-01T12:00:00Z', '2027-03-01T16:00:00Z') &&
    windowsOverlap('2027-03-01T08:00:00Z', '2027-03-01T18:00:00Z', '2027-03-01T09:00:00Z', '2027-03-01T10:00:00Z'));
  await check('T3: company_admin has the three trip permissions, company_user has none',
    ['fleet:trip:create', 'fleet:trip:approve', 'fleet:trip:dispatch'].every((p) => ROLE_PERMISSIONS.company_admin.includes(p as any) && !ROLE_PERMISSIONS.company_user.includes(p as any)));

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim() === '') {
    blocked('DATABASE_URL is not set. Live DB checks F4.. are BLOCKED.');
    process.exit(summary().exitCode);
    return;
  }
  try {
    assertLoopbackUrl(dbUrl, 'DATABASE_URL');
    if (process.env.MIGRATION_DATABASE_URL) assertLoopbackUrl(process.env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL');
  } catch (err) {
    blocked(err instanceof Error ? err.message : String(err));
    process.exit(summary().exitCode);
    return;
  }
  const executor = await getDefaultExecutor();
  if (!executor) {
    blocked('Unable to connect to database executor. Live DB checks F4.. are BLOCKED.');
    process.exit(summary().exitCode);
    return;
  }

  const unique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const companyIds: string[] = [];
  const userIds: string[] = [];
  let cleanupFailed = false;
  const rejects = async (fn: () => Promise<unknown>, cls: any) => { try { await fn(); return false; } catch (e) { return e instanceof cls; } };

  try {
    const companyRepo = new CompanyRepository();
    const userRepo = new UserRepository();
    const creator = await userRepo.createUser({ username: `ft_cr_${unique}`, passwordHash: 'dummy_ft_hash', role: 'user' });
    const approver = await userRepo.createUser({ username: `ft_ap_${unique}`, passwordHash: 'dummy_ft_hash', role: 'user' });
    const outsider = await userRepo.createUser({ username: `ft_out_${unique}`, passwordHash: 'dummy_ft_hash', role: 'user' });
    userIds.push(creator.id, approver.id, outsider.id);
    const compA = await companyRepo.create({ code: `FTA-${unique}`.slice(0, 20), nameAr: `شركة رحلات أ ${unique}`, createdBy: creator.id });
    const compB = await companyRepo.create({ code: `FTB-${unique}`.slice(0, 20), nameAr: `شركة رحلات ب ${unique}`, createdBy: outsider.id });
    companyIds.push(compA.id, compB.id);
    await defaultMembershipStore.addMember(creator.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(approver.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(outsider.id, compB.id, 'company_admin', true);
    const unitA = await defaultOrgUnitService.createUnit(compA.id, { code: 'HQ', nameAr: 'المركز', unitType: 'branch' } as any, creator.id);

    const V1 = await defaultFleetService.createVehicle(compA.id, { code: 'V-1', plateNo: 'T 111', odometerKm: 1000 }, creator.id);
    const V2 = await defaultFleetService.createVehicle(compA.id, { code: 'V-2', plateNo: 'T 222' }, creator.id);
    const V3 = await defaultFleetService.createVehicle(compA.id, { code: 'V-3', plateNo: 'T 333' }, creator.id);
    await defaultFleetService.updateVehicle(compA.id, V2.id, { status: 'maintenance' }, creator.id);
    const VB = await defaultFleetService.createVehicle(compB.id, { code: 'V-1', plateNo: 'B 111' }, outsider.id);
    const D1 = await defaultFleetService.createDriver(compA.id, { fullName: 'سائق 1', licenseNo: 'L-1', licenseExpiry: '2030-01-01' }, creator.id);
    const D2 = await defaultFleetService.createDriver(compA.id, { fullName: 'سائق منتهي', licenseNo: 'L-2', licenseExpiry: '2025-01-01' }, creator.id);
    const D3 = await defaultFleetService.createDriver(compA.id, { fullName: 'سائق 3', licenseNo: 'L-3', licenseExpiry: '2030-01-01' }, creator.id);
    const stops = [{ placeName: 'المخزن الرئيسي' }, { placeName: 'فرع الإسكندرية' }];
    const w = (s: string, e: string) => ({ plannedStart: `2027-03-01T${s}:00.000Z`, plannedEnd: `2027-03-01T${e}:00.000Z` });
    const mk = (v: string, d: string, win: { plannedStart: string; plannedEnd: string }, extra: Record<string, unknown> = {}) =>
      defaultFleetTripService.createTrip(compA.id, { vehicleId: v, driverId: d, purpose: 'توصيل بضاعة', stops, orgUnitId: unitA.id, ...win, ...extra }, creator.id);

    const A = await mk(V1.id, D1.id, w('08:00', '12:00'));
    await check('T4: trip created as draft with number TRP-00001, unit, creator and 2 ordered stops',
      A.status === 'draft' && A.tripNo === 'TRP-00001' && A.orgUnitId === unitA.id && A.requestedBy === creator.id && (A.stops || []).length === 2 && A.stops![0].placeName === 'المخزن الرئيسي');
    await check('T5: validation: one stop only, end before start, missing purpose, bad date, unknown vehicle, vehicle of another company',
      (await rejects(() => mk(V1.id, D1.id, w('08:00', '12:00'), { stops: [{ placeName: 'x' }] }), ValidationError)) &&
      (await rejects(() => mk(V1.id, D1.id, w('12:00', '08:00')), ValidationError)) &&
      (await rejects(() => mk(V1.id, D1.id, w('08:00', '12:00'), { purpose: '' }), ValidationError)) &&
      (await rejects(() => mk(V1.id, D1.id, { plannedStart: '01/03/2027', plannedEnd: '02/03/2027' }), ValidationError)) &&
      (await rejects(() => mk('00000000-0000-4000-8000-000000000000', D1.id, w('08:00', '12:00')), NotFoundError)) &&
      (await rejects(() => mk(VB.id, D1.id, w('08:00', '12:00')), NotFoundError)));
    await check('T6: the creator cannot approve their own trip', await rejects(() => defaultFleetTripService.approveTrip(compA.id, A.id, creator.id), ForbiddenError));
    const Aa = await defaultFleetTripService.approveTrip(compA.id, A.id, approver.id);
    await check('T7: another user approves: status approved, approver recorded', Aa.status === 'approved' && Aa.approvedBy === approver.id && !!Aa.approvedAt);

    const B = await mk(V1.id, D3.id, w('10:00', '14:00'));
    await check('T8: same vehicle in an overlapping window cannot be approved (ConflictError)', await rejects(() => defaultFleetTripService.approveTrip(compA.id, B.id, approver.id), ConflictError));
    const C = await mk(V3.id, D1.id, w('09:00', '11:00'));
    await check('T9: same driver in an overlapping window cannot be approved (ConflictError)', await rejects(() => defaultFleetTripService.approveTrip(compA.id, C.id, approver.id), ConflictError));
    const Dm = await mk(V2.id, D3.id, w('15:00', '17:00'));
    await check('T10: vehicle in maintenance cannot be approved (ValidationError)', await rejects(() => defaultFleetTripService.approveTrip(compA.id, Dm.id, approver.id), ValidationError));
    const E = await mk(V3.id, D2.id, w('15:00', '17:00'));
    await check('T11: driver with an expired licence cannot be approved (ValidationError)', await rejects(() => defaultFleetTripService.approveTrip(compA.id, E.id, approver.id), ValidationError));
    const D = await mk(V1.id, D1.id, w('12:00', '16:00'));
    const Da = await defaultFleetTripService.approveTrip(compA.id, D.id, approver.id);
    await check('T12: a trip that starts exactly when the other ends is approved (touching edges)', Da.status === 'approved');

    await check('T13: reject needs a reason, then the trip is rejected and cannot be approved again',
      (await rejects(() => defaultFleetTripService.rejectTrip(compA.id, B.id, '', approver.id), ValidationError)) &&
      (await defaultFleetTripService.rejectTrip(compA.id, B.id, 'الفترة محجوزة', approver.id)).status === 'rejected' &&
      (await rejects(() => defaultFleetTripService.approveTrip(compA.id, B.id, approver.id), ConflictError)));
    await check('T14: a draft cannot be dispatched or started directly',
      (await rejects(() => defaultFleetTripService.dispatchTrip(compA.id, C.id, approver.id), ConflictError)) &&
      (await rejects(() => defaultFleetTripService.startTrip(compA.id, C.id, 1000, approver.id), ConflictError)));

    const Ad = await defaultFleetTripService.dispatchTrip(compA.id, A.id, approver.id);
    await check('T15: approved trip is dispatched', Ad.status === 'dispatched' && !!Ad.dispatchedAt);
    await check('T16: start: odometer below the vehicle reading is rejected, missing odometer is rejected',
      (await rejects(() => defaultFleetTripService.startTrip(compA.id, A.id, 900, approver.id), ValidationError)) &&
      (await rejects(() => defaultFleetTripService.startTrip(compA.id, A.id, undefined, approver.id), ValidationError)));
    const As = await defaultFleetTripService.startTrip(compA.id, A.id, 1000, approver.id);
    await check('T17: trip starts with odometer 1000', As.status === 'in_progress' && As.odometerStart === 1000 && !!As.startedAt);
    await check('T18: a trip in progress cannot be cancelled, and completion cannot go below the start reading',
      (await rejects(() => defaultFleetTripService.cancelTrip(compA.id, A.id, 'سبب', approver.id), ConflictError)) &&
      (await rejects(() => defaultFleetTripService.completeTrip(compA.id, A.id, 990, approver.id), ValidationError)));
    const Ac = await defaultFleetTripService.completeTrip(compA.id, A.id, 1120, approver.id);
    const vAfter = (await defaultFleetService.listVehicles(compA.id)).find((x) => x.id === V1.id)!;
    await check('T19: completion stores the end reading and moves the vehicle odometer to 1120', Ac.status === 'completed' && Ac.odometerEnd === 1120 && vAfter.odometerKm === 1120);

    await check('T20: cancel needs a reason; a cancelled trip frees the vehicle and driver',
      (await rejects(() => defaultFleetTripService.cancelTrip(compA.id, D.id, '', approver.id), ValidationError)) &&
      (await defaultFleetTripService.cancelTrip(compA.id, D.id, 'ألغيت من العميل', approver.id)).status === 'cancelled');
    const F = await mk(V1.id, D1.id, w('13:00', '15:00'));
    await check('T21: after the cancel, an overlapping trip for the same vehicle and driver is approved', (await defaultFleetTripService.approveTrip(compA.id, F.id, approver.id)).status === 'approved');

    const listAll = await defaultFleetTripService.listTrips(compA.id);
    const listDone = await defaultFleetTripService.listTrips(compA.id, { status: 'completed' });
    const got = await defaultFleetTripService.getTrip(compA.id, A.id);
    await check('T22: list returns only company A trips, filters by status, get returns ordered stops',
      listAll.length === 7 && listAll.every((x) => x.companyId === compA.id) && listDone.length === 1 && listDone[0].id === A.id && got.stops!.map((s) => s.stopNo).join() === '1,2');
    await check('T23: invalid status filter is rejected', await rejects(() => defaultFleetTripService.listTrips(compA.id, { status: 'nope' }), ValidationError));

    const seenFromB = await withTenantTransaction(compB.id, async (tx) => (await tx.query('SELECT id FROM fleet_trips WHERE company_id = $1', [compA.id])).rows.length);
    await check('T24: RLS: company B context sees no company A trips', seenFromB === 0);
    const tryDb = async (sql: string) => { try { await withTenantTransaction(compA.id, (tx) => tx.query(sql, [compA.id])); return false; } catch (e) { console.log('   blocked:', String((e as Error).message).slice(0, 80)); return true; } };
    await check('T25: DELETE of a trip or a stop is blocked; UPDATE of a stop is blocked (write-once)',
      (await tryDb('DELETE FROM fleet_trips WHERE company_id = $1')) && (await tryDb('DELETE FROM fleet_trip_stops WHERE company_id = $1')) && (await tryDb(`UPDATE fleet_trip_stops SET place_name = 'x' WHERE company_id = $1`)));
    const cl = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl));
    await cl.connect();
    const au = await cl.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE company_id = $1 AND action LIKE 'FLEET_TRIP_%'`, [compA.id]);
    await cl.end();
    await check('T26: every successful change has one audit record (6 create, 3 approve, 1 reject, 1 dispatch, 1 start, 1 complete, 1 cancel = 15)', au.rows[0].n === 15, `n=${au.rows[0].n}`);
  } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(cleanupUrl));
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE fleet_trip_stops DISABLE TRIGGER trg_fleet_trip_stops_no_delete');
        await client.query('ALTER TABLE fleet_trips DISABLE TRIGGER trg_fleet_trips_no_delete');
        await client.query('ALTER TABLE fleet_vehicles DISABLE TRIGGER trg_fleet_vehicles_no_delete');
        await client.query('ALTER TABLE fleet_drivers DISABLE TRIGGER trg_fleet_drivers_no_delete');
        await client.query('DELETE FROM fleet_trip_stops WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM fleet_trips WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM fleet_vehicles WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM fleet_drivers WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('ALTER TABLE fleet_trip_stops ENABLE TRIGGER trg_fleet_trip_stops_no_delete');
        await client.query('ALTER TABLE fleet_trips ENABLE TRIGGER trg_fleet_trips_no_delete');
        await client.query('ALTER TABLE fleet_vehicles ENABLE TRIGGER trg_fleet_vehicles_no_delete');
        await client.query('ALTER TABLE fleet_drivers ENABLE TRIGGER trg_fleet_drivers_no_delete');
        await client.query('DELETE FROM org_units WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM company_memberships WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM audit_logs WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
        if (userIds.length > 0) {
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }
        await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await client.query('COMMIT');
        console.log('[cleanup] Fleet trip test companies and rows purged cleanly.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try { await client.query('ROLLBACK'); } catch {}
        console.error('[cleanup] Failed cleaning up verifyFleetTrips1:', cleanupErr);
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
run().catch((err) => { console.error('[verifyFleetTrips1] Fatal error:', err); process.exit(1); });
