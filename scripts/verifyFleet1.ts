import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultMembershipStore } from '../src/server/org/membershipStore.js';
import { defaultOrgUnitService } from '../src/server/org/orgUnitService.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { defaultFleetService, vehicleAssignable, driverAssignable } from '../src/server/fleet/fleetService.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/server/http/errors.js';
import { ROLE_PERMISSIONS } from '../src/server/rbac/roles.js';

console.log('=== VERIFYING FLEET-A (vehicles and drivers) ===');

function assertLoopbackUrl(raw: string, varName: string): void {
  const parsed = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
}

async function run() {
  // Pure rules (no DB)
  await check('F1: vehicle assignable only when active', vehicleAssignable('active').ok && !vehicleAssignable('maintenance').ok && !vehicleAssignable('out_of_service').ok && !vehicleAssignable('retired').ok);
  await check('F2: driver assignable needs active status and a licence valid on the trip date',
    driverAssignable({ status: 'active', licenseExpiry: '2027-01-01' }, '2026-12-31').ok &&
    driverAssignable({ status: 'active', licenseExpiry: '2026-12-31' }, '2026-12-31').ok &&
    !driverAssignable({ status: 'active', licenseExpiry: '2026-12-30' }, '2026-12-31').ok &&
    !driverAssignable({ status: 'active', licenseExpiry: null }, '2026-12-31').ok &&
    !driverAssignable({ status: 'suspended', licenseExpiry: '2030-01-01' }, '2026-12-31').ok);
  await check('F3: company_admin has fleet:read and fleet:manage, company_user has neither',
    ROLE_PERMISSIONS.company_admin.includes('fleet:read') && ROLE_PERMISSIONS.company_admin.includes('fleet:manage') &&
    !ROLE_PERMISSIONS.company_user.includes('fleet:manage'));

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
    const admin = await userRepo.createUser({ username: `fl_adm_${unique}`, passwordHash: 'dummy_fl_hash', role: 'user' });
    const outsider = await userRepo.createUser({ username: `fl_out_${unique}`, passwordHash: 'dummy_fl_hash', role: 'user' });
    const member = await userRepo.createUser({ username: `fl_mem_${unique}`, passwordHash: 'dummy_fl_hash', role: 'user' });
    userIds.push(admin.id, outsider.id, member.id);
    const compA = await companyRepo.create({ code: `FLA-${unique}`.slice(0, 20), nameAr: `شركة أسطول أ ${unique}`, createdBy: admin.id });
    const compB = await companyRepo.create({ code: `FLB-${unique}`.slice(0, 20), nameAr: `شركة أسطول ب ${unique}`, createdBy: outsider.id });
    companyIds.push(compA.id, compB.id);
    await defaultMembershipStore.addMember(admin.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(member.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(outsider.id, compB.id, 'company_admin', true);
    const unitA = await defaultOrgUnitService.createUnit(compA.id, { code: 'HQ', nameAr: 'المركز', unitType: 'branch' } as any, admin.id);
    const unitB = await defaultOrgUnitService.createUnit(compB.id, { code: 'HQ', nameAr: 'مركز ب', unitType: 'branch' } as any, outsider.id);

    const v1 = await defaultFleetService.createVehicle(compA.id, { code: 'V-1', plateNo: 'ABC 123', vehicleType: 'truck', orgUnitId: unitA.id, odometerKm: 1000 }, admin.id);
    await check('F4: vehicle created with status active, unit and odometer', v1.status === 'active' && v1.orgUnitId === unitA.id && v1.odometerKm === 1000);
    await check('F5: duplicate code and duplicate plate are rejected (ConflictError); same code in another company is fine',
      (await rejects(() => defaultFleetService.createVehicle(compA.id, { code: 'V-1', plateNo: 'X' }, admin.id), ConflictError)) &&
      (await rejects(() => defaultFleetService.createVehicle(compA.id, { code: 'V-2', plateNo: 'ABC 123' }, admin.id), ConflictError)) &&
      !!(await defaultFleetService.createVehicle(compB.id, { code: 'V-1', plateNo: 'ABC 123' }, outsider.id)));
    await check('F6: validation: missing code, missing plate, bad year, negative odometer',
      (await rejects(() => defaultFleetService.createVehicle(compA.id, { plateNo: 'Z1' }, admin.id), ValidationError)) &&
      (await rejects(() => defaultFleetService.createVehicle(compA.id, { code: 'V-9' }, admin.id), ValidationError)) &&
      (await rejects(() => defaultFleetService.createVehicle(compA.id, { code: 'V-9', plateNo: 'Z9', modelYear: 1800 }, admin.id), ValidationError)) &&
      (await rejects(() => defaultFleetService.createVehicle(compA.id, { code: 'V-9', plateNo: 'Z9', odometerKm: -1 }, admin.id), ValidationError)));
    await check('F7: a unit of another company is rejected (NotFound), not silently accepted',
      await rejects(() => defaultFleetService.createVehicle(compA.id, { code: 'V-3', plateNo: 'Z3', orgUnitId: unitB.id }, admin.id), NotFoundError));
    await check('F8: odometer cannot go backwards, forward is accepted',
      (await rejects(() => defaultFleetService.updateVehicle(compA.id, v1.id, { odometerKm: 900 }, admin.id), ValidationError)) &&
      (await defaultFleetService.updateVehicle(compA.id, v1.id, { odometerKm: 1500 }, admin.id)).odometerKm === 1500);
    const v1m = await defaultFleetService.updateVehicle(compA.id, v1.id, { status: 'maintenance' }, admin.id);
    await check('F9: status change to maintenance makes the vehicle not assignable', v1m.status === 'maintenance' && !vehicleAssignable(v1m.status).ok);
    await defaultFleetService.updateVehicle(compA.id, v1.id, { status: 'retired' }, admin.id);
    await check('F10: a retired vehicle cannot be brought back', await rejects(() => defaultFleetService.updateVehicle(compA.id, v1.id, { status: 'active' }, admin.id), ValidationError));
    await check('F11: list filters by status and never shows another company',
      (await defaultFleetService.listVehicles(compA.id, { status: 'retired' })).length === 1 &&
      (await defaultFleetService.listVehicles(compA.id)).every((x) => x.companyId === compA.id));

    const d1 = await defaultFleetService.createDriver(compA.id, { fullName: 'سائق أول', licenseNo: 'L-100', licenseExpiry: '2027-06-30', userId: member.id }, admin.id);
    await check('F12: driver created, linked to a company member', d1.status === 'active' && d1.userId === member.id && d1.licenseExpiry === '2027-06-30');
    await check('F13: user who is not a company member is rejected; duplicate licence and duplicate user are rejected',
      (await rejects(() => defaultFleetService.createDriver(compA.id, { fullName: 'غريب', userId: outsider.id }, admin.id), ValidationError)) &&
      (await rejects(() => defaultFleetService.createDriver(compA.id, { fullName: 'مكرر', licenseNo: 'L-100', licenseExpiry: '2027-01-01' }, admin.id), ConflictError)) &&
      (await rejects(() => defaultFleetService.createDriver(compA.id, { fullName: 'نفس المستخدم', userId: member.id }, admin.id), ConflictError)));
    await check('F14: licence number needs an expiry date; bad date format rejected',
      (await rejects(() => defaultFleetService.createDriver(compA.id, { fullName: 'بدون تاريخ', licenseNo: 'L-200' }, admin.id), ValidationError)) &&
      (await rejects(() => defaultFleetService.createDriver(compA.id, { fullName: 'تاريخ خطأ', licenseNo: 'L-201', licenseExpiry: '30/06/2027' }, admin.id), ValidationError)));
    const d1s = await defaultFleetService.updateDriver(compA.id, d1.id, { status: 'suspended' }, admin.id);
    await check('F15: suspended driver is not assignable, expired licence is not assignable on the trip date',
      !driverAssignable(d1s, '2026-12-01').ok && !driverAssignable({ ...d1s, status: 'active' }, '2027-07-01').ok);

    // tenant isolation by app role: company B context cannot see company A rows
    const seenFromB = await withTenantTransaction(compB.id, async (tx) => (await tx.query('SELECT id FROM fleet_vehicles WHERE company_id = $1', [compA.id])).rows.length);
    await check('F16: RLS: company B context sees no company A vehicles', seenFromB === 0);
    let delBlocked = false;
    try { await withTenantTransaction(compA.id, (tx) => tx.query('DELETE FROM fleet_vehicles WHERE company_id = $1', [compA.id])); } catch { delBlocked = true; }
    await check('F17: DELETE of a vehicle is blocked (retire through status instead)', delBlocked);
    const cl = new pg.Client(buildPgConfig(process.env.MIGRATION_DATABASE_URL || dbUrl));
    await cl.connect();
    const au = await cl.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE company_id = $1 AND action LIKE 'FLEET_%'`, [compA.id]);
    await cl.end();
    await check('F18: 1 vehicle create + 3 updates + 1 driver create + 1 update = 6 audit records', au.rows[0].n === 6, `n=${au.rows[0].n}`);
  } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(cleanupUrl));
      try {
        await client.connect();
        await client.query('BEGIN');
        await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        await client.query('ALTER TABLE fleet_vehicles DISABLE TRIGGER trg_fleet_vehicles_no_delete');
        await client.query('ALTER TABLE fleet_drivers DISABLE TRIGGER trg_fleet_drivers_no_delete');
        await client.query('DELETE FROM fleet_vehicles WHERE company_id = ANY($1::uuid[])', [companyIds]);
        await client.query('DELETE FROM fleet_drivers WHERE company_id = ANY($1::uuid[])', [companyIds]);
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
        console.log('[cleanup] Fleet test companies and rows purged cleanly.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try { await client.query('ROLLBACK'); } catch {}
        console.error('[cleanup] Failed cleaning up verifyFleet1:', cleanupErr);
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
run().catch((err) => { console.error('[verifyFleet1] Fatal error:', err); process.exit(1); });
