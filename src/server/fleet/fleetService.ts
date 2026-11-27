import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { defaultOrgUnitRepository, OrgUnitRepository } from '../org/orgUnitRepository.js';
import { defaultMembershipStore, MembershipStore } from '../org/membershipStore.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';

export const VEHICLE_STATUSES = ['active', 'maintenance', 'out_of_service', 'retired'] as const;
export const DRIVER_STATUSES = ['active', 'suspended', 'inactive'] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export interface VehicleView {
  id: string; companyId: string; orgUnitId: string | null; code: string; plateNo: string; vehicleType: string;
  make: string | null; model: string | null; modelYear: number | null; odometerKm: number; status: VehicleStatus; notes: string | null;
}
export interface DriverView {
  id: string; companyId: string; userId: string | null; orgUnitId: string | null; fullName: string; phone: string | null;
  licenseNo: string | null; licenseExpiry: string | null; status: DriverStatus;
}

/** Pure rule: a vehicle can be put on a trip only while it is active. */
export function vehicleAssignable(status: VehicleStatus): { ok: boolean; reason?: string } {
  if (status === 'active') return { ok: true };
  const why: Record<string, string> = { maintenance: 'المركبة في الصيانة', out_of_service: 'المركبة خارج الخدمة (عطل)', retired: 'المركبة مستبعدة' };
  return { ok: false, reason: why[status] || 'حالة المركبة لا تسمح بالتعيين' };
}

/** Pure rule: a driver can drive only while active and with a licence valid on the trip date (YYYY-MM-DD). */
export function driverAssignable(d: { status: DriverStatus; licenseExpiry: string | null }, onDate: string): { ok: boolean; reason?: string } {
  if (d.status !== 'active') return { ok: false, reason: d.status === 'suspended' ? 'السائق موقوف' : 'السائق غير نشط' };
  if (!d.licenseExpiry) return { ok: false, reason: 'لا يوجد تاريخ انتهاء للرخصة' };
  if (d.licenseExpiry < onDate) return { ok: false, reason: 'رخصة السائق منتهية في تاريخ الرحلة' };
  return { ok: true };
}

const str = (v: unknown, max: number, label: string, required = false): string | null => {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (required) throw new ValidationError(`${label} مطلوب`);
    return null;
  }
  if (typeof v !== 'string') throw new ValidationError(`${label} غير صالح`);
  const t = v.trim();
  if (t.length > max) throw new ValidationError(`${label} أطول من ${max} حرفا`);
  return t;
};
const isoDate = (v: unknown, label: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) throw new ValidationError(`${label} يجب أن يكون بصيغة YYYY-MM-DD`);
  return v;
};

const VCOLS = `id, company_id AS "companyId", org_unit_id AS "orgUnitId", code, plate_no AS "plateNo", vehicle_type AS "vehicleType",
  make, model, model_year AS "modelYear", odometer_km AS "odometerKm", status, notes`;
const DCOLS = `id, company_id AS "companyId", user_id AS "userId", org_unit_id AS "orgUnitId", full_name AS "fullName", phone,
  license_no AS "licenseNo", to_char(license_expiry, 'YYYY-MM-DD') AS "licenseExpiry", status`;
const toVehicle = (r: any): VehicleView => ({ ...r, modelYear: r.modelYear === null ? null : Number(r.modelYear), odometerKm: Number(r.odometerKm) });

export class FleetService {
  constructor(
    private auditService: Pick<AuditService, 'record'> = defaultAuditService,
    private orgUnitRepo: Pick<OrgUnitRepository, 'findById'> = defaultOrgUnitRepository,
    private membershipStore: Pick<MembershipStore, 'hasMembership'> = defaultMembershipStore
  ) {}

  private async checkUnit(companyId: string, orgUnitId: unknown, tx: DbExecutor): Promise<string | null> {
    if (orgUnitId === undefined || orgUnitId === null || orgUnitId === '') return null;
    if (typeof orgUnitId !== 'string' || !isUuid(orgUnitId)) throw new ValidationError('معرف الوحدة التنظيمية غير صالح');
    const unit = await this.orgUnitRepo.findById(companyId, orgUnitId, tx);
    if (!unit) throw new NotFoundError('الوحدة التنظيمية غير موجودة في هذه الشركة');
    if (!unit.isActive) throw new ValidationError('الوحدة التنظيمية معطّلة');
    return unit.id;
  }

  private dup(err: any, what: string): never {
    if (err?.code === '23505') throw new ConflictError(`${what} مستخدم بالفعل في هذه الشركة`);
    throw err;
  }

  async createVehicle(companyId: string, input: Record<string, unknown>, actorId: string): Promise<VehicleView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    const code = str(input.code, 30, 'كود المركبة', true)!;
    const plateNo = str(input.plateNo, 30, 'رقم اللوحة', true)!;
    const vehicleType = str(input.vehicleType, 30, 'نوع المركبة') || 'car';
    const make = str(input.make, 60, 'الماركة'); const model = str(input.model, 60, 'الموديل'); const notes = str(input.notes, 500, 'الملاحظات');
    let modelYear: number | null = null;
    if (input.modelYear !== undefined && input.modelYear !== null && input.modelYear !== '') {
      modelYear = Number(input.modelYear);
      if (!Number.isInteger(modelYear) || modelYear < 1950 || modelYear > 2100) throw new ValidationError('سنة الصنع غير صالحة');
    }
    let odo = 0;
    if (input.odometerKm !== undefined && input.odometerKm !== null && input.odometerKm !== '') {
      odo = Number(input.odometerKm);
      if (!Number.isFinite(odo) || odo < 0) throw new ValidationError('قراءة العداد يجب أن تكون صفرا أو أكثر');
    }
    return await withTenantTransaction(companyId, async (tx) => {
      const orgUnitId = await this.checkUnit(companyId, input.orgUnitId, tx);
      let row: any;
      try {
        row = (await tx.query<any>(
          `INSERT INTO fleet_vehicles (company_id, org_unit_id, code, plate_no, vehicle_type, make, model, model_year, odometer_km, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${VCOLS}`,
          [companyId, orgUnitId, code, plateNo, vehicleType, make, model, modelYear, odo, notes, actorId]
        )).rows[0];
      } catch (e) { this.dup(e, 'كود المركبة أو رقم اللوحة'); }
      await this.auditService.record(
        { actorUserId: actorId || null, companyId, action: 'FLEET_VEHICLE_CREATED', entityType: 'fleet_vehicles', entityId: row.id, metadata: { code, plateNo, orgUnitId } },
        { executor: tx }
      );
      return toVehicle(row);
    });
  }

  async updateVehicle(companyId: string, id: string, input: Record<string, unknown>, actorId: string): Promise<VehicleView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (!id || !isUuid(id)) throw new ValidationError('معرف المركبة غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const cur = (await tx.query<any>(`SELECT ${VCOLS} FROM fleet_vehicles WHERE company_id = $1 AND id = $2 FOR UPDATE`, [companyId, id])).rows[0];
      if (!cur) throw new NotFoundError('المركبة غير موجودة');
      let status: VehicleStatus = cur.status;
      if (input.status !== undefined) {
        if (!(VEHICLE_STATUSES as readonly string[]).includes(input.status as string)) throw new ValidationError('حالة المركبة غير صالحة');
        if (cur.status === 'retired' && input.status !== 'retired') throw new ValidationError('المركبة المستبعدة لا يمكن إعادتها للخدمة');
        status = input.status as VehicleStatus;
      }
      let odo = Number(cur.odometerKm);
      if (input.odometerKm !== undefined) {
        const n = Number(input.odometerKm);
        if (!Number.isFinite(n) || n < 0) throw new ValidationError('قراءة العداد غير صالحة');
        if (n < odo) throw new ValidationError(`قراءة العداد (${n}) أقل من القراءة المسجلة (${odo}). العداد لا يرجع للخلف`);
        odo = n;
      }
      const orgUnitId = input.orgUnitId === undefined ? cur.orgUnitId : await this.checkUnit(companyId, input.orgUnitId, tx);
      const plateNo = input.plateNo === undefined ? cur.plateNo : str(input.plateNo, 30, 'رقم اللوحة', true)!;
      const notes = input.notes === undefined ? cur.notes : str(input.notes, 500, 'الملاحظات');
      let row: any;
      try {
        row = (await tx.query<any>(
          `UPDATE fleet_vehicles SET status=$3, odometer_km=$4, org_unit_id=$5, plate_no=$6, notes=$7, updated_at=now()
            WHERE company_id=$1 AND id=$2 RETURNING ${VCOLS}`,
          [companyId, id, status, odo, orgUnitId, plateNo, notes]
        )).rows[0];
      } catch (e) { this.dup(e, 'رقم اللوحة'); }
      await this.auditService.record(
        { actorUserId: actorId || null, companyId, action: 'FLEET_VEHICLE_UPDATED', entityType: 'fleet_vehicles', entityId: id,
          metadata: { fromStatus: cur.status, toStatus: status, fromOdometerKm: Number(cur.odometerKm), toOdometerKm: odo } },
        { executor: tx }
      );
      return toVehicle(row);
    });
  }

  async listVehicles(companyId: string, filter: { status?: string } = {}): Promise<VehicleView[]> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (filter.status && !(VEHICLE_STATUSES as readonly string[]).includes(filter.status)) throw new ValidationError('حالة المركبة غير صالحة');
    return await withTenantTransaction(companyId, async (tx) => {
      const r = await tx.query<any>(
        `SELECT ${VCOLS} FROM fleet_vehicles WHERE company_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY code`,
        [companyId, filter.status || null]
      );
      return r.rows.map(toVehicle);
    });
  }

  async createDriver(companyId: string, input: Record<string, unknown>, actorId: string): Promise<DriverView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    const fullName = str(input.fullName, 120, 'اسم السائق', true)!;
    const phone = str(input.phone, 30, 'الهاتف');
    const licenseNo = str(input.licenseNo, 40, 'رقم الرخصة');
    const licenseExpiry = isoDate(input.licenseExpiry, 'انتهاء الرخصة');
    if (licenseNo && !licenseExpiry) throw new ValidationError('تاريخ انتهاء الرخصة مطلوب مع رقمها');
    let userId: string | null = null;
    if (input.userId !== undefined && input.userId !== null && input.userId !== '') {
      if (typeof input.userId !== 'string' || !isUuid(input.userId)) throw new ValidationError('معرف المستخدم غير صالح');
      userId = input.userId;
    }
    return await withTenantTransaction(companyId, async (tx) => {
      if (userId && !(await this.membershipStore.hasMembership(userId, companyId, tx))) throw new ValidationError('المستخدم ليس عضوا في هذه الشركة');
      const orgUnitId = await this.checkUnit(companyId, input.orgUnitId, tx);
      let row: any;
      try {
        row = (await tx.query<any>(
          `INSERT INTO fleet_drivers (company_id, user_id, org_unit_id, full_name, phone, license_no, license_expiry, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${DCOLS}`,
          [companyId, userId, orgUnitId, fullName, phone, licenseNo, licenseExpiry, actorId]
        )).rows[0];
      } catch (e) { this.dup(e, 'رقم الرخصة أو حساب المستخدم'); }
      await this.auditService.record(
        { actorUserId: actorId || null, companyId, action: 'FLEET_DRIVER_CREATED', entityType: 'fleet_drivers', entityId: row.id, metadata: { fullName, userId, orgUnitId } },
        { executor: tx }
      );
      return row as DriverView;
    });
  }

  async updateDriver(companyId: string, id: string, input: Record<string, unknown>, actorId: string): Promise<DriverView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (!id || !isUuid(id)) throw new ValidationError('معرف السائق غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const cur = (await tx.query<any>(`SELECT ${DCOLS} FROM fleet_drivers WHERE company_id = $1 AND id = $2 FOR UPDATE`, [companyId, id])).rows[0];
      if (!cur) throw new NotFoundError('السائق غير موجود');
      let status: DriverStatus = cur.status;
      if (input.status !== undefined) {
        if (!(DRIVER_STATUSES as readonly string[]).includes(input.status as string)) throw new ValidationError('حالة السائق غير صالحة');
        status = input.status as DriverStatus;
      }
      const phone = input.phone === undefined ? cur.phone : str(input.phone, 30, 'الهاتف');
      const licenseNo = input.licenseNo === undefined ? cur.licenseNo : str(input.licenseNo, 40, 'رقم الرخصة');
      const licenseExpiry = input.licenseExpiry === undefined ? cur.licenseExpiry : isoDate(input.licenseExpiry, 'انتهاء الرخصة');
      if (licenseNo && !licenseExpiry) throw new ValidationError('تاريخ انتهاء الرخصة مطلوب مع رقمها');
      const orgUnitId = input.orgUnitId === undefined ? cur.orgUnitId : await this.checkUnit(companyId, input.orgUnitId, tx);
      let row: any;
      try {
        row = (await tx.query<any>(
          `UPDATE fleet_drivers SET status=$3, phone=$4, license_no=$5, license_expiry=$6, org_unit_id=$7, updated_at=now()
            WHERE company_id=$1 AND id=$2 RETURNING ${DCOLS}`,
          [companyId, id, status, phone, licenseNo, licenseExpiry, orgUnitId]
        )).rows[0];
      } catch (e) { this.dup(e, 'رقم الرخصة'); }
      await this.auditService.record(
        { actorUserId: actorId || null, companyId, action: 'FLEET_DRIVER_UPDATED', entityType: 'fleet_drivers', entityId: id, metadata: { fromStatus: cur.status, toStatus: status } },
        { executor: tx }
      );
      return row as DriverView;
    });
  }

  async listDrivers(companyId: string, filter: { status?: string } = {}): Promise<DriverView[]> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (filter.status && !(DRIVER_STATUSES as readonly string[]).includes(filter.status)) throw new ValidationError('حالة السائق غير صالحة');
    return await withTenantTransaction(companyId, async (tx) => {
      const r = await tx.query<any>(
        `SELECT ${DCOLS} FROM fleet_drivers WHERE company_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY full_name`,
        [companyId, filter.status || null]
      );
      return r.rows as DriverView[];
    });
  }
}
export const defaultFleetService = new FleetService();
