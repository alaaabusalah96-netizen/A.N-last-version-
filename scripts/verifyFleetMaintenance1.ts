import pg from 'pg';
import { check, blocked, summary } from './lib/testkit.js';
import { buildPgConfig } from '../src/server/db/connection.js';
import { getDefaultExecutor, closeAllExecutors } from '../src/server/db/index.js';
import { CompanyRepository } from '../src/server/org/companyRepository.js';
import { UserRepository } from '../src/server/auth/userRepository.js';
import { defaultMembershipStore } from '../src/server/org/membershipStore.js';
import { withTenantTransaction } from '../src/server/db/transactionManager.js';
import { defaultFleetService } from '../src/server/fleet/fleetService.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../src/server/http/errors.js';
import { defaultFleetMaintenanceService as M, parseMaintenance, dueState } from '../src/server/fleet/fleetMaintenanceService.js';
import { PERMISSION_CATALOG } from '../src/server/rbac/permissions.js';
import { ROLE_PERMISSIONS } from '../src/server/rbac/roles.js';

console.log('=== VERIFYING FLEET-F (vehicle maintenance and due tracking) ===');

function assertLoopbackUrl(raw: string, varName: string): void {
  const parsed = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) throw new Error(`${varName} host '${parsed.hostname}' is not loopback. Refusing destructive test run.`);
}

async function run() {
  const bad = (f: () => unknown) => { try { f(); return false; } catch (e) { return e instanceof ValidationError; } };
  const good = { kind: 'service', performedOn: '2027-01-10', odometerKm: 50000, cost: 1200.5, nextDueDate: '2027-07-10', nextDueKm: 60000 };
  await check('F1: a normal record parses and keeps the figures', (() => { const m = parseMaintenance(good); return m.kind === 'service' && m.cost === 1200.5 && m.nextDueKm === 60000 && m.vendor === null; })());
  await check('F2: bad records are rejected (kind, date, negative cost, due before performed, due km not above odometer)',
    bad(() => parseMaintenance({ ...good, kind: 'x' })) && bad(() => parseMaintenance({ ...good, performedOn: '2027-02-30' })) && bad(() => parseMaintenance({ ...good, performedOn: '' })) &&
    bad(() => parseMaintenance({ ...good, cost: -1 })) && bad(() => parseMaintenance({ ...good, nextDueDate: '2026-12-31' })) && bad(() => parseMaintenance({ ...good, nextDueKm: 50000 })));
  await check('F3: due state is overdue when the date passed or the odometer reached the limit',
    dueState({ nextDueDate: '2027-01-01', nextDueKm: null }, 0, '2027-01-02') === 'overdue' && dueState({ nextDueDate: null, nextDueKm: 60000 }, 60000, '2027-01-02') === 'overdue');
  await check('F4: due state is due_soon inside the configurable window and ok outside it',
    dueState({ nextDueDate: '2027-01-20', nextDueKm: null }, 0, '2027-01-02') === 'due_soon' && dueState({ nextDueDate: '2027-01-20', nextDueKm: null }, 0, '2027-01-02', 10) === 'ok' &&
    dueState({ nextDueDate: null, nextDueKm: 60500 }, 60000, '2027-01-02') === 'due_soon' && dueState({ nextDueDate: '2028-01-01', nextDueKm: 90000 }, 1000, '2027-01-02') === 'ok');
  await check('F5: office roles carry fleet:read and fleet:manage and the permissions are in the catalog',
    ['fleet:read', 'fleet:manage'].every((p) => PERMISSION_CATALOG.some((c) => c.code === p)) && ROLE_PERMISSIONS.company_admin.includes('fleet:manage' as any));
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
    const mkU = (n: string) => userRepo.createUser({ username: `fm_${n}_${unique}`, passwordHash: 'dummy_fm_hash', role: 'user' });
    const office = await mkU('off'); const userB = await mkU('b');
    userIds.push(office.id, userB.id);
    const compA = await companyRepo.create({ code: `FMA-${unique}`.slice(0, 20), nameAr: `شركة صيانة أ ${unique}`, createdBy: office.id });
    const compB = await companyRepo.create({ code: `FMB-${unique}`.slice(0, 20), nameAr: `شركة صيانة ب ${unique}`, createdBy: userB.id });
    companyIds.push(compA.id, compB.id);
    await defaultMembershipStore.addMember(office.id, compA.id, 'company_admin', true);
    await defaultMembershipStore.addMember(userB.id, compB.id, 'company_admin', true);
    const V1 = await defaultFleetService.createVehicle(compA.id, { code: 'V-1', plateNo: 'M 111', odometerKm: 59800 } as any, office.id);
    const V2 = await defaultFleetService.createVehicle(compA.id, { code: 'V-2', plateNo: 'M 222' }, office.id);
    const r1 = await M.create(compA.id, V1.id, { kind: 'service', performedOn: '2020-01-10', odometerKm: 50000, cost: 900, nextDueKm: 60000 }, office.id);
    await check('F6: a record is saved with the right figures', r1.status === 'active' && r1.cost === 900 && r1.nextDueKm === 60000 && r1.performedOn === '2020-01-10');
    await check('F7: a record for a vehicle of another company is refused', await rejects(() => M.create(compB.id, V1.id, good, userB.id), NotFoundError));
    const r2 = await M.create(compA.id, V1.id, { kind: 'insurance', performedOn: '2020-02-01', cost: 5000, nextDueDate: '2020-03-01' }, office.id);
    await M.create(compA.id, V2.id, { kind: 'license', performedOn: '2020-02-01', nextDueDate: '2099-01-01' }, office.id);
    const due = await M.due(compA.id);
    const byKind = (k: string) => due.items.find((i: any) => i.kind === k && i.vehicleId === V1.id);
    await check('F8: the due list flags the passed insurance date as overdue and a near odometer limit as due_soon, far dates stay ok',
      byKind('insurance')?.state === 'overdue' && byKind('service')?.state === 'due_soon' && due.items.find((i: any) => i.vehicleId === V2.id)?.state === 'ok' && due.items[0].state === 'overdue');
    const wide = await M.due(compA.id, { soonKm: 100 });
    await check('F9: the window is configurable and bad windows are rejected', wide.items.find((i: any) => i.kind === 'service')?.state === 'ok' && await rejects(() => M.due(compA.id, { soonDays: -1 }), ValidationError));
    await check('F10: tenant isolation: company B sees no maintenance of company A', (await M.due(compB.id)).items.length === 0 && await rejects(() => M.listForVehicle(compB.id, V1.id), NotFoundError));
    const r3 = await M.create(compA.id, V1.id, { kind: 'service', performedOn: '2020-06-01', odometerKm: 59900, nextDueKm: 70000 }, office.id);
    const due2 = await M.due(compA.id);
    await check('F11: only the latest record per kind drives the due state', due2.items.filter((i: any) => i.vehicleId === V1.id && i.kind === 'service').length === 1 && byKindOf(due2, V1.id, 'service')?.id === r3.id && byKindOf(due2, V1.id, 'service')?.state === 'ok');
    await check('F12: voiding needs a reason, works once, and a voided record stops driving the due state',
      await rejects(() => M.void(compA.id, r2.id, ''), ValidationError) && (await M.void(compA.id, r2.id, 'إدخال خاطئ')).status === 'voided' && await rejects(() => M.void(compA.id, r2.id, 'مرة ثانية'), ConflictError) &&
      !(await M.due(compA.id)).items.some((i: any) => i.kind === 'insurance') && (await M.listForVehicle(compA.id, V1.id)).length === 3);
    const c2 = new pg.Client(buildPgConfig(dbUrl)); await c2.connect(); await c2.query('BEGIN');
    await c2.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [compA.id]);
    const edit = await c2.query(`UPDATE fleet_vehicle_maintenance SET cost = 1 WHERE id=$1`, [r1.id]).then(() => false, () => true);
    await c2.query('ROLLBACK'); await c2.query('BEGIN'); await c2.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [compA.id]);
    const del = await c2.query(`DELETE FROM fleet_vehicle_maintenance WHERE id=$1`, [r1.id]).then(() => false, () => true);
    await c2.query('ROLLBACK'); await c2.query('BEGIN'); await c2.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [compB.id]);
    const seen = (await c2.query(`SELECT count(*)::int AS n FROM fleet_vehicle_maintenance`)).rows[0].n;
    await c2.query('ROLLBACK'); await c2.end();
    await check('F13: records cannot be edited or deleted by the database, and another tenant sees zero rows', edit && del && seen === 0);
  } catch (err) {
    await check('Fleet F verification unexpected error', false, err instanceof Error ? err.message : String(err));
  } finally {
    const cleanupUrl = process.env.MIGRATION_DATABASE_URL || dbUrl;
    if (cleanupUrl && companyIds.length > 0) {
      const client = new pg.Client(buildPgConfig(cleanupUrl));
      try {
        await client.connect();
        await client.query('BEGIN');
        const trg = ['fleet_vehicle_maintenance:trg_fleet_vehicle_maintenance_no_delete', 'fleet_vehicles:trg_fleet_vehicles_no_delete', 'audit_logs:audit_logs_immutable'];
        for (const t of trg) { const [tb, tr] = t.split(':'); await client.query(`ALTER TABLE ${tb} DISABLE TRIGGER ${tr}`); }
        for (const tb of ['fleet_vehicle_maintenance', 'fleet_vehicles'])
          await client.query(`DELETE FROM ${tb} WHERE company_id = ANY($1::uuid[])`, [companyIds]);
        for (const tb of ['company_memberships', 'audit_logs'])
          await client.query(`DELETE FROM ${tb} WHERE company_id = ANY($1::uuid[])`, [companyIds]);
        await client.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
        if (userIds.length > 0) {
          await client.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1::uuid[])', [userIds]);
          await client.query('DELETE FROM platform_users WHERE id = ANY($1::uuid[])', [userIds]);
        }
        for (const t of trg) { const [tb, tr] = t.split(':'); await client.query(`ALTER TABLE ${tb} ENABLE TRIGGER ${tr}`); }
        await client.query('COMMIT');
        console.log('[cleanup] Fleet maintenance test companies and rows purged cleanly.');
      } catch (cleanupErr) {
        cleanupFailed = true;
        try { await client.query('ROLLBACK'); } catch {}
        console.error('[cleanup] Failed cleaning up verifyFleetMaintenance1:', cleanupErr);
      } finally { await client.end(); }
    }
    await closeAllExecutors();
  }
  const { exitCode } = summary();
  if (cleanupFailed) process.exit(1);
  process.exit(exitCode);
}
function byKindOf(due: any, vehicleId: string, kind: string) { return due.items.find((i: any) => i.vehicleId === vehicleId && i.kind === kind); }
run();
