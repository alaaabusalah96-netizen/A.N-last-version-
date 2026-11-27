import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { defaultOrgUnitRepository, OrgUnitRepository } from '../org/orgUnitRepository.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { vehicleAssignable, driverAssignable } from './fleetService.js';

export const TRIP_STATUSES = ['draft', 'approved', 'rejected', 'dispatched', 'in_progress', 'completed', 'cancelled'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];
/** Trips in these statuses hold the vehicle and the driver for their planned window. */
export const HOLDING_STATUSES: TripStatus[] = ['approved', 'dispatched', 'in_progress'];

export interface TripStop { stopNo: number; placeName: string }
export interface TripView {
  id: string; companyId: string; seq: number; tripNo: string; orgUnitId: string | null; vehicleId: string; driverId: string;
  purpose: string; plannedStart: string; plannedEnd: string; status: TripStatus; requestedBy: string; approvedBy: string | null;
  approvedAt: string | null; rejectReason: string | null; cancelReason: string | null; dispatchedAt: string | null; startedAt: string | null;
  completedAt: string | null; odometerStart: number | null; odometerEnd: number | null; notes: string | null; stops?: TripStop[];
}

/** Pure rule: allowed status moves. A trip in progress can only be completed. */
export const TRIP_TRANSITIONS: Record<TripStatus, TripStatus[]> = {
  draft: ['approved', 'rejected', 'cancelled'],
  approved: ['dispatched', 'cancelled'],
  dispatched: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [], rejected: [], cancelled: [],
};
export const canTripMove = (from: TripStatus, to: TripStatus): boolean => TRIP_TRANSITIONS[from]?.includes(to) ?? false;

/** Pure rule: two planned windows collide when each starts before the other ends (touching edges do not collide). */
export function windowsOverlap(aStart: string | Date, aEnd: string | Date, bStart: string | Date, bEnd: string | Date): boolean {
  return new Date(aStart).getTime() < new Date(bEnd).getTime() && new Date(bStart).getTime() < new Date(aEnd).getTime();
}

const TCOLS = `id, company_id AS "companyId", seq, trip_no AS "tripNo", org_unit_id AS "orgUnitId", vehicle_id AS "vehicleId", driver_id AS "driverId",
  purpose, planned_start AS "plannedStart", planned_end AS "plannedEnd", status, requested_by AS "requestedBy", approved_by AS "approvedBy",
  approved_at AS "approvedAt", reject_reason AS "rejectReason", cancel_reason AS "cancelReason", dispatched_at AS "dispatchedAt",
  started_at AS "startedAt", completed_at AS "completedAt", odometer_start AS "odometerStart", odometer_end AS "odometerEnd", notes`;
const iso = (v: any) => (v === null || v === undefined ? null : new Date(v).toISOString());
const num = (v: any) => (v === null || v === undefined ? null : Number(v));
const toTrip = (r: any): TripView => ({ ...r, plannedStart: iso(r.plannedStart)!, plannedEnd: iso(r.plannedEnd)!, approvedAt: iso(r.approvedAt),
  dispatchedAt: iso(r.dispatchedAt), startedAt: iso(r.startedAt), completedAt: iso(r.completedAt), odometerStart: num(r.odometerStart), odometerEnd: num(r.odometerEnd) });

const text = (v: unknown, max: number, label: string, required = false): string | null => {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) { if (required) throw new ValidationError(`${label} مطلوب`); return null; }
  if (typeof v !== 'string') throw new ValidationError(`${label} غير صالح`);
  const t = v.trim();
  if (t.length > max) throw new ValidationError(`${label} أطول من ${max} حرفا`);
  return t;
};
const stamp = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) || Number.isNaN(Date.parse(v))) throw new ValidationError(`${label} يجب أن يكون تاريخا ووقتا بصيغة ISO`);
  return new Date(v).toISOString();
};
const km = (v: unknown, label: string): number => {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n) || n < 0) throw new ValidationError(`${label} يجب أن تكون صفرا أو أكثر`);
  return n;
};

export class FleetTripService {
  constructor(
    private auditService: Pick<AuditService, 'record'> = defaultAuditService,
    private orgUnitRepo: Pick<OrgUnitRepository, 'findById'> = defaultOrgUnitRepository
  ) {}

  private async checkUnit(companyId: string, orgUnitId: unknown, tx: DbExecutor): Promise<string | null> {
    if (orgUnitId === undefined || orgUnitId === null || orgUnitId === '') return null;
    if (typeof orgUnitId !== 'string' || !isUuid(orgUnitId)) throw new ValidationError('معرف الوحدة التنظيمية غير صالح');
    const unit = await this.orgUnitRepo.findById(companyId, orgUnitId, tx);
    if (!unit) throw new NotFoundError('الوحدة التنظيمية غير موجودة في هذه الشركة');
    if (!unit.isActive) throw new ValidationError('الوحدة التنظيمية معطّلة');
    return unit.id;
  }

  /** Lock vehicle and driver, then check both can take the trip window. Throws a clear Arabic reason. */
  private async assertResourcesFree(companyId: string, trip: { id: string | null; vehicleId: string; driverId: string; plannedStart: string; plannedEnd: string }, tx: DbExecutor): Promise<void> {
    const v = (await tx.query<any>(`SELECT status FROM fleet_vehicles WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId, trip.vehicleId])).rows[0];
    if (!v) throw new NotFoundError('المركبة غير موجودة');
    const d = (await tx.query<any>(`SELECT status, to_char(license_expiry,'YYYY-MM-DD') AS "licenseExpiry" FROM fleet_drivers WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId, trip.driverId])).rows[0];
    if (!d) throw new NotFoundError('السائق غير موجود');
    const va = vehicleAssignable(v.status);
    if (!va.ok) throw new ValidationError(va.reason || 'المركبة غير صالحة للتعيين');
    const da = driverAssignable(d, trip.plannedEnd.slice(0, 10));
    if (!da.ok) throw new ValidationError(da.reason || 'السائق غير صالح للتعيين');
    const clash = (await tx.query<any>(
      `SELECT trip_no AS "tripNo", vehicle_id AS "vehicleId" FROM fleet_trips
        WHERE company_id=$1 AND status = ANY($2::text[]) AND id IS DISTINCT FROM $3::uuid
          AND (vehicle_id=$4 OR driver_id=$5) AND planned_start < $7::timestamptz AND planned_end > $6::timestamptz
        LIMIT 1`,
      [companyId, HOLDING_STATUSES, trip.id, trip.vehicleId, trip.driverId, trip.plannedStart, trip.plannedEnd]
    )).rows[0];
    if (clash) throw new ConflictError(`تعارض في الوقت مع الرحلة ${clash.tripNo}: ${clash.vehicleId === trip.vehicleId ? 'المركبة' : 'السائق'} محجوز في نفس الفترة`);
  }

  private async lockTrip(companyId: string, id: string, tx: DbExecutor): Promise<any> {
    if (!id || !isUuid(id)) throw new ValidationError('معرف الرحلة غير صالح');
    const t = (await tx.query<any>(`SELECT ${TCOLS} FROM fleet_trips WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId, id])).rows[0];
    if (!t) throw new NotFoundError('الرحلة غير موجودة');
    return t;
  }
  private move(t: any, to: TripStatus): void {
    if (!canTripMove(t.status, to)) throw new ConflictError(`لا يمكن نقل الرحلة من حالة «${t.status}» إلى «${to}»`);
  }
  private async audit(companyId: string, actorId: string, action: string, id: string, metadata: Record<string, unknown>, tx: DbExecutor) {
    await this.auditService.record({ actorUserId: actorId || null, companyId, action, entityType: 'fleet_trips', entityId: id, metadata }, { executor: tx });
  }
  private async reload(companyId: string, id: string, tx: DbExecutor): Promise<TripView> {
    return toTrip((await tx.query<any>(`SELECT ${TCOLS} FROM fleet_trips WHERE company_id=$1 AND id=$2`, [companyId, id])).rows[0]);
  }

  async createTrip(companyId: string, input: Record<string, unknown>, actorId: string): Promise<TripView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (typeof input.vehicleId !== 'string' || !isUuid(input.vehicleId)) throw new ValidationError('المركبة مطلوبة');
    if (typeof input.driverId !== 'string' || !isUuid(input.driverId)) throw new ValidationError('السائق مطلوب');
    const purpose = text(input.purpose, 200, 'غرض الرحلة', true)!;
    const plannedStart = stamp(input.plannedStart, 'بداية الرحلة');
    const plannedEnd = stamp(input.plannedEnd, 'نهاية الرحلة');
    if (Date.parse(plannedEnd) <= Date.parse(plannedStart)) throw new ValidationError('نهاية الرحلة يجب أن تكون بعد بدايتها');
    const notes = text(input.notes, 500, 'الملاحظات');
    const stopsIn = Array.isArray(input.stops) ? input.stops : [];
    if (stopsIn.length < 2) throw new ValidationError('الرحلة تحتاج نقطتين على الأقل (انطلاق ووصول)');
    if (stopsIn.length > 20) throw new ValidationError('عدد النقاط أكبر من 20');
    const stops = stopsIn.map((s: any, i: number) => ({ stopNo: i + 1, placeName: text(s?.placeName, 200, `اسم النقطة ${i + 1}`, true)! }));
    return await withTenantTransaction(companyId, async (tx) => {
      const orgUnitId = await this.checkUnit(companyId, input.orgUnitId, tx);
      const v = (await tx.query<any>(`SELECT status FROM fleet_vehicles WHERE company_id=$1 AND id=$2`, [companyId, input.vehicleId])).rows[0];
      if (!v) throw new NotFoundError('المركبة غير موجودة في هذه الشركة');
      const d = (await tx.query<any>(`SELECT status FROM fleet_drivers WHERE company_id=$1 AND id=$2`, [companyId, input.driverId])).rows[0];
      if (!d) throw new NotFoundError('السائق غير موجود في هذه الشركة');
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['fleet_trip_seq:' + companyId]);
      const seq = Number((await tx.query<any>(`SELECT COALESCE(MAX(seq),0)+1 AS n FROM fleet_trips WHERE company_id=$1`, [companyId])).rows[0].n);
      const tripNo = 'TRP-' + String(seq).padStart(5, '0');
      const row = (await tx.query<any>(
        `INSERT INTO fleet_trips (company_id, seq, trip_no, org_unit_id, vehicle_id, driver_id, purpose, planned_start, planned_end, requested_by, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [companyId, seq, tripNo, orgUnitId, input.vehicleId, input.driverId, purpose, plannedStart, plannedEnd, actorId, notes]
      )).rows[0];
      for (const s of stops) {
        await tx.query(`INSERT INTO fleet_trip_stops (company_id, trip_id, stop_no, place_name) VALUES ($1,$2,$3,$4)`, [companyId, row.id, s.stopNo, s.placeName]);
      }
      await this.audit(companyId, actorId, 'FLEET_TRIP_CREATED', row.id, { tripNo, vehicleId: input.vehicleId, driverId: input.driverId, plannedStart, plannedEnd, stops: stops.length }, tx);
      const out = await this.reload(companyId, row.id, tx);
      out.stops = stops;
      return out;
    });
  }

  async approveTrip(companyId: string, id: string, actorId: string): Promise<TripView> {
    return await withTenantTransaction(companyId, async (tx) => {
      const t = await this.lockTrip(companyId, id, tx);
      this.move(t, 'approved');
      if (t.requestedBy === actorId) throw new ForbiddenError('لا يجوز اعتماد رحلة أنشأها نفس المستخدم');
      await this.assertResourcesFree(companyId, { id, vehicleId: t.vehicleId, driverId: t.driverId, plannedStart: iso(t.plannedStart)!, plannedEnd: iso(t.plannedEnd)! }, tx);
      await tx.query(`UPDATE fleet_trips SET status='approved', approved_by=$3, approved_at=now(), updated_at=now() WHERE company_id=$1 AND id=$2`, [companyId, id, actorId]);
      await this.audit(companyId, actorId, 'FLEET_TRIP_APPROVED', id, { tripNo: t.tripNo }, tx);
      return await this.reload(companyId, id, tx);
    });
  }

  async rejectTrip(companyId: string, id: string, reason: unknown, actorId: string): Promise<TripView> {
    const why = text(reason, 300, 'سبب الرفض', true)!;
    return await withTenantTransaction(companyId, async (tx) => {
      const t = await this.lockTrip(companyId, id, tx);
      this.move(t, 'rejected');
      await tx.query(`UPDATE fleet_trips SET status='rejected', rejected_by=$3, rejected_at=now(), reject_reason=$4, updated_at=now() WHERE company_id=$1 AND id=$2`, [companyId, id, actorId, why]);
      await this.audit(companyId, actorId, 'FLEET_TRIP_REJECTED', id, { tripNo: t.tripNo, reason: why }, tx);
      return await this.reload(companyId, id, tx);
    });
  }

  async dispatchTrip(companyId: string, id: string, actorId: string): Promise<TripView> {
    return await withTenantTransaction(companyId, async (tx) => {
      const t = await this.lockTrip(companyId, id, tx);
      this.move(t, 'dispatched');
      await this.assertResourcesFree(companyId, { id, vehicleId: t.vehicleId, driverId: t.driverId, plannedStart: iso(t.plannedStart)!, plannedEnd: iso(t.plannedEnd)! }, tx);
      await tx.query(`UPDATE fleet_trips SET status='dispatched', dispatched_by=$3, dispatched_at=now(), updated_at=now() WHERE company_id=$1 AND id=$2`, [companyId, id, actorId]);
      await this.audit(companyId, actorId, 'FLEET_TRIP_DISPATCHED', id, { tripNo: t.tripNo }, tx);
      return await this.reload(companyId, id, tx);
    });
  }

  async startTrip(companyId: string, id: string, odometerStart: unknown, actorId: string): Promise<TripView> {
    const odo = km(odometerStart, 'قراءة العداد عند الانطلاق');
    return await withTenantTransaction(companyId, async (tx) => {
      const t = await this.lockTrip(companyId, id, tx);
      this.move(t, 'in_progress');
      const v = (await tx.query<any>(`SELECT odometer_km AS "odometerKm" FROM fleet_vehicles WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId, t.vehicleId])).rows[0];
      if (odo < Number(v.odometerKm)) throw new ValidationError(`قراءة العداد (${odo}) أقل من القراءة المسجلة للمركبة (${Number(v.odometerKm)})`);
      await tx.query(`UPDATE fleet_trips SET status='in_progress', odometer_start=$3, started_at=now(), updated_at=now() WHERE company_id=$1 AND id=$2`, [companyId, id, odo]);
      await this.audit(companyId, actorId, 'FLEET_TRIP_STARTED', id, { tripNo: t.tripNo, odometerStart: odo }, tx);
      return await this.reload(companyId, id, tx);
    });
  }

  async completeTrip(companyId: string, id: string, odometerEnd: unknown, actorId: string): Promise<TripView> {
    const odo = km(odometerEnd, 'قراءة العداد عند الوصول');
    return await withTenantTransaction(companyId, async (tx) => {
      const t = await this.lockTrip(companyId, id, tx);
      this.move(t, 'completed');
      if (odo < Number(t.odometerStart)) throw new ValidationError(`قراءة الوصول (${odo}) أقل من قراءة الانطلاق (${Number(t.odometerStart)})`);
      await tx.query(`UPDATE fleet_trips SET status='completed', odometer_end=$3, completed_at=now(), updated_at=now() WHERE company_id=$1 AND id=$2`, [companyId, id, odo]);
      await tx.query(`UPDATE fleet_vehicles SET odometer_km = GREATEST(odometer_km, $3), updated_at=now() WHERE company_id=$1 AND id=$2`, [companyId, t.vehicleId, odo]);
      await this.audit(companyId, actorId, 'FLEET_TRIP_COMPLETED', id, { tripNo: t.tripNo, odometerStart: Number(t.odometerStart), odometerEnd: odo, distanceKm: odo - Number(t.odometerStart) }, tx);
      return await this.reload(companyId, id, tx);
    });
  }

  async cancelTrip(companyId: string, id: string, reason: unknown, actorId: string): Promise<TripView> {
    const why = text(reason, 300, 'سبب الإلغاء', true)!;
    return await withTenantTransaction(companyId, async (tx) => {
      const t = await this.lockTrip(companyId, id, tx);
      this.move(t, 'cancelled');
      await tx.query(`UPDATE fleet_trips SET status='cancelled', cancelled_by=$3, cancelled_at=now(), cancel_reason=$4, updated_at=now() WHERE company_id=$1 AND id=$2`, [companyId, id, actorId, why]);
      await this.audit(companyId, actorId, 'FLEET_TRIP_CANCELLED', id, { tripNo: t.tripNo, fromStatus: t.status, reason: why }, tx);
      return await this.reload(companyId, id, tx);
    });
  }

  async listTrips(companyId: string, filter: { status?: string; vehicleId?: string; driverId?: string } = {}): Promise<TripView[]> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (filter.status && !(TRIP_STATUSES as readonly string[]).includes(filter.status)) throw new ValidationError('حالة الرحلة غير صالحة');
    if (filter.vehicleId && !isUuid(filter.vehicleId)) throw new ValidationError('معرف المركبة غير صالح');
    if (filter.driverId && !isUuid(filter.driverId)) throw new ValidationError('معرف السائق غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const r = await tx.query<any>(
        `SELECT ${TCOLS} FROM fleet_trips WHERE company_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::uuid IS NULL OR vehicle_id=$3) AND ($4::uuid IS NULL OR driver_id=$4)
          ORDER BY planned_start DESC, seq DESC LIMIT 500`,
        [companyId, filter.status || null, filter.vehicleId || null, filter.driverId || null]
      );
      return r.rows.map(toTrip);
    });
  }

  async getTrip(companyId: string, id: string): Promise<TripView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (!id || !isUuid(id)) throw new ValidationError('معرف الرحلة غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const r = (await tx.query<any>(`SELECT ${TCOLS} FROM fleet_trips WHERE company_id=$1 AND id=$2`, [companyId, id])).rows[0];
      if (!r) throw new NotFoundError('الرحلة غير موجودة');
      const stops = (await tx.query<any>(`SELECT stop_no AS "stopNo", place_name AS "placeName" FROM fleet_trip_stops WHERE company_id=$1 AND trip_id=$2 ORDER BY stop_no`, [companyId, id])).rows;
      const t = toTrip(r); t.stops = stops.map((s: any) => ({ stopNo: Number(s.stopNo), placeName: s.placeName }));
      return t;
    });
  }
}
export const defaultFleetTripService = new FleetTripService();
