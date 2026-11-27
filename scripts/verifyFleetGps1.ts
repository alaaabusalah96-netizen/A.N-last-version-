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
import { defaultFleetDriverPortalService } from '../src/server/fleet/fleetDriverPortalService.js';
import { defaultFleetTrackService, parsePosition, haversineKm, pathKm, MAX_POSITIONS_PER_TRIP } from '../src/server/fleet/fleetTrackService.js';
import { PERMISSION_CATALOG } from '../src/server/rbac/permissions.js';
import { ROLE_PERMISSIONS } from '../src/server/rbac/roles.js';

console.log('=== VERIFYING FLEET-E (GPS positions) ===');

function assertLoopbackUrl(raw: string, varName: string): void {
  const parsed = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
}

async function run() {
  const ok = (f: () => unknown) => { try { f(); return true; } catch (e) { return e instanceof ValidationError; } };
  const bad = (f: () => unknown) => { try { f(); return false; } catch (e) { return e instanceof ValidationError; } };
  await check('E1: position parsing accepts a normal point and rounds to 6 decimals', (() => { const p = parsePosition({ latitude: 30.0444196, longitude: '31.2357116', accuracyM: 12.34 }); return p.latitude === 30.04442 && p.longitude === 31.235712 && p.accuracyM === 12.3; })());
  await check('E2: bad points are rejected (out of range, 0/0, NaN, poor accuracy, future time)',
    bad(() => parsePosition({ latitude: 91, longitude: 10 })) && bad(() => parsePosition({ latitude: 10, longitude: 181 })) && bad(() => parsePosition({ latitude: 0, longitude: 0 })) && bad(() => parsePosition({ latitude: 'x', longitude: 1 })) &&
    bad(() => parsePosition({ latitude: 30, longitude: 31, accuracyM: 5000 })) && bad(() => parsePosition({ latitude: 30, longitude: 31, recordedAt: new Date(Date.now() + 3600e3).toISOString() })) && ok(() => parsePosition({ latitude: 30, longitude: 31 })));
  await check('E3: haversine: Cairo to Alexandria is about 180 km and the path sums legs', (() => { const d = haversineKm({ latitude: 30.0444, longitude: 31.2357 }, { latitude: 31.2001, longitude: 29.9187 }); return d > 170 && d < 190 && pathKm([]) === 0 && pathKm([{ latitude: 30, longitude: 31 }]) === 0; })());
  await check('E4: the position cap per trip is bounded', MAX_POSITIONS_PER_TRIP > 0 && MAX_POSITIONS_PER_TRIP <= 5000);
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
    const T = await mk(V1.id, D1.id, w('08:00', '12:00'), 'dispatched');
    const T2 = await mk(V2.id, D2.id, w('08:00', '12:00'), 'dispatched');
    const pos = (n: number) => ({ latitude: 30.04 + n * 0.001, longitude: 31.23 + n * 0.001, accuracyM: 8 });
    await check('E5: a position cannot be logged before the trip is started', await rejects(() => P.logMyPosition(compA.id, u1.id, T.id, pos(0)), ConflictError));
    await P.startMyTrip(compA.id, u1.id, T.id, 100); await P.startMyTrip(compA.id, u2.id, T2.id, 100);
    const r1 = await P.logMyPosition(compA.id, u1.id, T.id, pos(1));
    await check('E6: the driver logs a position on their own running trip', !!r1.id);
    await check('E7: a second point within the minimum interval is refused', await rejects(() => P.logMyPosition(compA.id, u1.id, T.id, pos(2)), ConflictError));
    await check('E8: another driver cannot log a position on this trip (looks missing), nor a user without a driver', await rejects(() => P.logMyPosition(compA.id, u2.id, T.id, pos(2)), NotFoundError) && await rejects(() => P.logMyPosition(compA.id, nodrv.id, T.id, pos(2)), ForbiddenError));
    await check('E9: a bad point is refused before touching the trip', await rejects(() => P.logMyPosition(compA.id, u1.id, T.id, { latitude: 500, longitude: 1 }), ValidationError));
    const c = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl)); await c.connect();
    await c.query(`ALTER TABLE fleet_trip_positions DISABLE TRIGGER trg_fleet_trip_positions_no_update`);
    await c.query(`UPDATE fleet_trip_positions SET created_at = created_at - interval '1 minute' WHERE trip_id=$1`, [T.id]);
    await c.query(`ALTER TABLE fleet_trip_positions ENABLE TRIGGER trg_fleet_trip_positions_no_update`); await c.end();
    await P.logMyPosition(compA.id, u1.id, T.id, pos(2)); await P.logMyPosition(compA.id, u2.id, T2.id, pos(5)).catch(() => undefined);
    const trk = await defaultFleetTrackService.tripTrack(compA.id, T.id);
    await check('E10: the office read returns the ordered path with an estimated distance', trk.points.length === 2 && trk.points[0].latitude === 30.041 && trk.points[1].latitude === 30.042 && trk.estimatedKm > 0 && trk.estimatedKm < 1 && trk.trip.id === T.id);
    await check('E11: tenant isolation: the track of a company A trip is invisible from company B', await rejects(() => defaultFleetTrackService.tripTrack(compB.id, T.id), NotFoundError));
    await P.completeMyTrip(compA.id, u1.id, T.id, 150);
    await check('E12: after completion no more positions are accepted but the path stays readable', await rejects(() => P.logMyPosition(compA.id, u1.id, T.id, pos(3)), ConflictError) && (await defaultFleetTrackService.tripTrack(compA.id, T.id)).points.length === 2);
    const c2 = new pg.Client(buildPgConfig(dbUrl)); await c2.connect(); await c2.query('BEGIN');
    await c2.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [compA.id]);
    const upd = await c2.query(`UPDATE fleet_trip_positions SET latitude = 1 WHERE trip_id=$1`, [T.id]).then(() => false, () => true);
    await c2.query('ROLLBACK'); await c2.query('BEGIN'); await c2.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [compA.id]);
    const del = await c2.query(`DELETE FROM fleet_trip_positions WHERE trip_id=$1`, [T.id]).then(() => false, () => true);
    await c2.query('ROLLBACK'); await c2.end();
    await check('E13: positions are write-once: update and delete are blocked by the database', upd && del);
  } catch (err) {
    await check('Fleet D verification unexpected error', false, err instanceof Error ? err.message : String(err));
  } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(cleanupUrl));
      try {
        await client.connect();
        await client.query('BEGIN');
        const trg = ['fleet_expenses:trg_fleet_expenses_no_delete', 'fleet_expense_categories:trg_fleet_expense_categories_no_delete', 'fleet_trip_positions:trg_fleet_trip_positions_no_delete', 'fleet_trip_stops:trg_fleet_trip_stops_no_delete', 'fleet_trips:trg_fleet_trips_no_delete', 'fleet_vehicles:trg_fleet_vehicles_no_delete', 'fleet_drivers:trg_fleet_drivers_no_delete', 'audit_logs:audit_logs_immutable', 'journal_entries:trg_journal_entries_immutability', 'journal_lines:trg_journal_lines_immutability'];
        for (const t of trg) { const [tb, tr] = t.split(':'); await client.query(`ALTER TABLE ${tb} DISABLE TRIGGER ${tr}`); }
        for (const tb of ['fleet_trip_positions', 'fleet_expenses', 'fleet_expense_categories', 'fleet_trip_stops', 'fleet_trips', 'fleet_vehicles', 'fleet_drivers', 'journal_lines', 'journal_entries'])
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
        console.error('[cleanup] Failed cleaning up verifyFleetGps1:', cleanupErr);
      } finally { await client.end(); }
    }
    await closeAllExecutors();
  }
  const { exitCode } = summary();
  if (cleanupFailed) process.exit(1);
  process.exit(exitCode);
}
run().catch((err) => { console.error('[verifyFleetDriver1] Fatal error:', err); process.exit(1); });
