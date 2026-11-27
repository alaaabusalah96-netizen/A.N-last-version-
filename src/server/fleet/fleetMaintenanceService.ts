import { withTenantTransaction } from '../db/transactionManager.js';
import { NotFoundError, ValidationError, ConflictError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';

export const MAINTENANCE_KINDS = ['service', 'repair', 'inspection', 'tires', 'insurance', 'license', 'other'] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];
export const DEFAULT_SOON_DAYS = 30;
export const DEFAULT_SOON_KM = 1000;

export interface MaintenanceInput {
  kind: MaintenanceKind; performedOn: string; odometerKm: number | null; cost: number; vendor: string | null; notes: string | null;
  nextDueDate: string | null; nextDueKm: number | null;
}

const dateOnly = (v: unknown, label: string, required: boolean): string | null => {
  if (v === undefined || v === null || v === '') { if (required) throw new ValidationError(`${label} مطلوب`); return null; }
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw new ValidationError(`${label} غير صالح`);
  return s;
};
const numOrNull = (v: unknown, label: string, max = 1e9): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new ValidationError(`${label} غير صالح`);
  return Math.round(n * 100) / 100;
};

/** Pure validation of one maintenance record. Throws ValidationError with an Arabic message. */
export function parseMaintenance(raw: Record<string, unknown>): MaintenanceInput {
  const kind = String(raw?.kind ?? '') as MaintenanceKind;
  if (!(MAINTENANCE_KINDS as readonly string[]).includes(kind)) throw new ValidationError('نوع السجل غير صالح');
  const performedOn = dateOnly(raw.performedOn, 'تاريخ التنفيذ', true)!;
  const odometerKm = numOrNull(raw.odometerKm, 'قراءة العداد');
  const cost = numOrNull(raw.cost, 'التكلفة', 1e12) ?? 0;
  const nextDueDate = dateOnly(raw.nextDueDate, 'تاريخ الاستحقاق القادم', false);
  const nextDueKm = numOrNull(raw.nextDueKm, 'العداد المستحق القادم');
  if (nextDueDate && nextDueDate < performedOn) throw new ValidationError('تاريخ الاستحقاق القادم قبل تاريخ التنفيذ');
  if (nextDueKm !== null && odometerKm !== null && nextDueKm <= odometerKm) throw new ValidationError('العداد المستحق القادم يجب أن يكون أكبر من قراءة العداد الحالية');
  const txt = (v: unknown, max: number, label: string): string | null => { if (v === undefined || v === null || String(v).trim() === '') return null; const s = String(v).trim(); if (s.length > max) throw new ValidationError(`${label} طويل جداً`); return s; };
  return { kind, performedOn, odometerKm, cost, vendor: txt(raw.vendor, 120, 'الجهة'), notes: txt(raw.notes, 2000, 'الملاحظات'), nextDueDate, nextDueKm };
}

export type DueState = 'overdue' | 'due_soon' | 'ok';
/** Pure due calculation. Overdue when the date has passed or the odometer reached the limit; due_soon inside the configurable window. */
export function dueState(rec: { nextDueDate: string | null; nextDueKm: number | null }, vehicleKm: number, today: string, soonDays = DEFAULT_SOON_DAYS, soonKm = DEFAULT_SOON_KM): DueState {
  let state: DueState = 'ok';
  if (rec.nextDueDate) {
    const days = Math.floor((new Date(`${rec.nextDueDate}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000);
    if (days < 0) return 'overdue';
    if (days <= soonDays) state = 'due_soon';
  }
  if (rec.nextDueKm !== null) {
    if (vehicleKm >= rec.nextDueKm) return 'overdue';
    if (rec.nextDueKm - vehicleKm <= soonKm) state = 'due_soon';
  }
  return state;
}

const COLS = `id, vehicle_id AS "vehicleId", kind, to_char(performed_on,'YYYY-MM-DD') AS "performedOn", odometer_km AS "odometerKm", cost, vendor, notes,
  to_char(next_due_date,'YYYY-MM-DD') AS "nextDueDate", next_due_km AS "nextDueKm", status, void_reason AS "voidReason", created_at AS "createdAt"`;
const view = (r: any) => ({ ...r, odometerKm: r.odometerKm === null ? null : Number(r.odometerKm), cost: Number(r.cost), nextDueKm: r.nextDueKm === null ? null : Number(r.nextDueKm) });

export class FleetMaintenanceService {
  async create(companyId: string, vehicleId: string, raw: Record<string, unknown>, userId: string) {
    if (!isUuid(companyId) || !isUuid(vehicleId)) throw new ValidationError('المعرف غير صالح');
    const m = parseMaintenance(raw);
    return await withTenantTransaction(companyId, async (tx) => {
      const v = (await tx.query<any>(`SELECT id FROM fleet_vehicles WHERE company_id=$1 AND id=$2`, [companyId, vehicleId])).rows[0];
      if (!v) throw new NotFoundError('المركبة غير موجودة');
      const r = (await tx.query<any>(
        `INSERT INTO fleet_vehicle_maintenance (company_id, vehicle_id, kind, performed_on, odometer_km, cost, vendor, notes, next_due_date, next_due_km, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${COLS}`,
        [companyId, vehicleId, m.kind, m.performedOn, m.odometerKm, m.cost, m.vendor, m.notes, m.nextDueDate, m.nextDueKm, userId])).rows[0];
      return view(r);
    });
  }

  async listForVehicle(companyId: string, vehicleId: string) {
    if (!isUuid(companyId) || !isUuid(vehicleId)) throw new ValidationError('المعرف غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const v = (await tx.query<any>(`SELECT id FROM fleet_vehicles WHERE company_id=$1 AND id=$2`, [companyId, vehicleId])).rows[0];
      if (!v) throw new NotFoundError('المركبة غير موجودة');
      return (await tx.query<any>(`SELECT ${COLS} FROM fleet_vehicle_maintenance WHERE company_id=$1 AND vehicle_id=$2 ORDER BY performed_on DESC, created_at DESC LIMIT 500`, [companyId, vehicleId])).rows.map(view);
    });
  }

  async void(companyId: string, id: string, reason: unknown) {
    if (!isUuid(companyId) || !isUuid(id)) throw new ValidationError('المعرف غير صالح');
    const why = String(reason ?? '').trim();
    if (why.length < 3) throw new ValidationError('سبب الإلغاء مطلوب');
    return await withTenantTransaction(companyId, async (tx) => {
      const cur = (await tx.query<any>(`SELECT status FROM fleet_vehicle_maintenance WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId, id])).rows[0];
      if (!cur) throw new NotFoundError('السجل غير موجود');
      if (cur.status !== 'active') throw new ConflictError('السجل ملغى بالفعل');
      const r = (await tx.query<any>(`UPDATE fleet_vehicle_maintenance SET status='voided', void_reason=$3, voided_at=now() WHERE company_id=$1 AND id=$2 RETURNING ${COLS}`, [companyId, id, why.slice(0, 500)])).rows[0];
      return view(r);
    });
  }

  /** Per vehicle and kind, the latest active record that has a next-due date or km, with its computed state. Worst states first. */
  async due(companyId: string, opts: { soonDays?: unknown; soonKm?: unknown } = {}) {
    if (!isUuid(companyId)) throw new ValidationError('المعرف غير صالح');
    const soonDays = opts.soonDays === undefined || opts.soonDays === '' ? DEFAULT_SOON_DAYS : Number(opts.soonDays);
    const soonKm = opts.soonKm === undefined || opts.soonKm === '' ? DEFAULT_SOON_KM : Number(opts.soonKm);
    if (!Number.isFinite(soonDays) || soonDays < 0 || soonDays > 365) throw new ValidationError('نافذة الأيام غير صالحة');
    if (!Number.isFinite(soonKm) || soonKm < 0 || soonKm > 100000) throw new ValidationError('نافذة الكيلومترات غير صالحة');
    return await withTenantTransaction(companyId, async (tx) => {
      const today = (await tx.query<any>(`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS d`)).rows[0].d as string;
      const rows = (await tx.query<any>(
        `SELECT DISTINCT ON (m.vehicle_id, m.kind) m.id, m.vehicle_id AS "vehicleId", m.kind, to_char(m.performed_on,'YYYY-MM-DD') AS "performedOn",
                to_char(m.next_due_date,'YYYY-MM-DD') AS "nextDueDate", m.next_due_km AS "nextDueKm", v.code, v.plate_no AS "plateNo", v.odometer_km AS "vehicleKm"
           FROM fleet_vehicle_maintenance m JOIN fleet_vehicles v ON v.company_id = m.company_id AND v.id = m.vehicle_id
          WHERE m.company_id=$1 AND m.status='active' AND v.status <> 'retired'
          ORDER BY m.vehicle_id, m.kind, m.performed_on DESC, m.created_at DESC`, [companyId])).rows;
      const order: Record<DueState, number> = { overdue: 0, due_soon: 1, ok: 2 };
      const items = rows.filter((r: any) => r.nextDueDate || r.nextDueKm !== null).map((r: any) => {
        const vehicleKm = Number(r.vehicleKm); const nextDueKm = r.nextDueKm === null ? null : Number(r.nextDueKm);
        return { ...r, vehicleKm, nextDueKm, state: dueState({ nextDueDate: r.nextDueDate, nextDueKm }, vehicleKm, today, soonDays, soonKm) };
      });
      items.sort((a: any, b: any) => order[a.state as DueState] - order[b.state as DueState] || String(a.nextDueDate ?? '9999').localeCompare(String(b.nextDueDate ?? '9999')));
      return { today, soonDays, soonKm, items };
    });
  }
}
export const defaultFleetMaintenanceService = new FleetMaintenanceService();
