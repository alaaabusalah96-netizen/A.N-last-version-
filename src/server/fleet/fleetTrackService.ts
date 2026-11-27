import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';

/** Limits that keep GPS data sane and the table small. */
export const MIN_SECONDS_BETWEEN_POSITIONS = 10;
export const MAX_POSITIONS_PER_TRIP = 3000;
export const MAX_ACCURACY_M = 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface PositionInput { latitude: number; longitude: number; accuracyM: number | null; recordedAt: Date }

/** Pure validation of one reported position. Throws ValidationError with an Arabic message. */
export function parsePosition(raw: Record<string, unknown>, now: Date = new Date()): PositionInput {
  const num = (v: unknown): number | null => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : null;
  const lat = num(raw?.latitude); const lng = num(raw?.longitude);
  if (lat === null || lat < -90 || lat > 90) throw new ValidationError('خط العرض غير صالح');
  if (lng === null || lng < -180 || lng > 180) throw new ValidationError('خط الطول غير صالح');
  if (lat === 0 && lng === 0) throw new ValidationError('الموقع (0,0) غير صالح');
  let acc: number | null = null;
  if (raw?.accuracyM !== undefined && raw?.accuracyM !== null && raw?.accuracyM !== '') {
    acc = num(raw.accuracyM);
    if (acc === null || acc < 0) throw new ValidationError('دقة الموقع غير صالحة');
    if (acc > MAX_ACCURACY_M) throw new ValidationError(`دقة الموقع ضعيفة (أكثر من ${MAX_ACCURACY_M} متر)، لم يُسجَّل`);
  }
  const when = raw?.recordedAt ? new Date(String(raw.recordedAt)) : now;
  if (Number.isNaN(when.getTime())) throw new ValidationError('وقت الموقع غير صالح');
  if (when.getTime() > now.getTime() + FUTURE_SKEW_MS) throw new ValidationError('وقت الموقع في المستقبل');
  return { latitude: Math.round(lat * 1e6) / 1e6, longitude: Math.round(lng * 1e6) / 1e6, accuracyM: acc === null ? null : Math.round(acc * 10) / 10, recordedAt: when };
}

/** Great-circle distance in km (haversine). */
export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const R = 6371; const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude); const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Estimated path length from ordered points. A GPS estimate only: the odometer stays the official distance. */
export function pathKm(points: Array<{ latitude: number; longitude: number }>): number {
  let km = 0; for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i]);
  return Math.round(km * 100) / 100;
}

export class FleetTrackService {
  /** A driver records a position on their own RUNNING trip. Called from the driver portal; ownership is resolved from the login. */
  async recordPosition(companyId: string, driverId: string, tripId: string, raw: Record<string, unknown>, tx: DbExecutor): Promise<{ id: string }> {
    if (!tripId || !isUuid(tripId)) throw new ValidationError('معرف الرحلة غير صالح');
    const p = parsePosition(raw);
    const t = (await tx.query<any>(`SELECT driver_id AS "driverId", status FROM fleet_trips WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId, tripId])).rows[0];
    if (!t || t.driverId !== driverId) throw new NotFoundError('الرحلة غير موجودة');
    if (t.status !== 'in_progress') throw new ConflictError('لا يُسجَّل الموقع إلا أثناء رحلة جارية');
    const last = (await tx.query<any>(`SELECT count(*)::int AS n, EXTRACT(EPOCH FROM (now() - max(created_at))) AS ago FROM fleet_trip_positions WHERE company_id=$1 AND trip_id=$2`, [companyId, tripId])).rows[0];
    if (last.n >= MAX_POSITIONS_PER_TRIP) throw new ConflictError('تم بلوغ الحد الأقصى لنقاط الرحلة');
    if (last.ago !== null && Number(last.ago) < MIN_SECONDS_BETWEEN_POSITIONS) throw new ConflictError(`الحد الأدنى ${MIN_SECONDS_BETWEEN_POSITIONS} ثوان بين نقطتين`);
    const r = (await tx.query<any>(
      `INSERT INTO fleet_trip_positions (company_id, trip_id, driver_id, latitude, longitude, accuracy_m, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [companyId, tripId, driverId, p.latitude, p.longitude, p.accuracyM, p.recordedAt.toISOString()])).rows[0];
    return { id: r.id };
  }

  /** Office read: the recorded path of a trip (any status). Needs the fleet:track:read permission at the route. */
  async tripTrack(companyId: string, tripId: string): Promise<{ trip: any; points: Array<{ latitude: number; longitude: number; accuracyM: number | null; recordedAt: string }>; estimatedKm: number }> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (!tripId || !isUuid(tripId)) throw new ValidationError('معرف الرحلة غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const trip = (await tx.query<any>(`SELECT id, trip_no AS "tripNo", status, purpose, vehicle_id AS "vehicleId", driver_id AS "driverId", odometer_start AS "odometerStart", odometer_end AS "odometerEnd" FROM fleet_trips WHERE company_id=$1 AND id=$2`, [companyId, tripId])).rows[0];
      if (!trip) throw new NotFoundError('الرحلة غير موجودة');
      const rows = (await tx.query<any>(`SELECT latitude, longitude, accuracy_m AS "accuracyM", recorded_at AS "recordedAt" FROM fleet_trip_positions WHERE company_id=$1 AND trip_id=$2 ORDER BY created_at, id LIMIT ${MAX_POSITIONS_PER_TRIP}`, [companyId, tripId])).rows;
      const points = rows.map((r: any) => ({ latitude: Number(r.latitude), longitude: Number(r.longitude), accuracyM: r.accuracyM === null ? null : Number(r.accuracyM), recordedAt: new Date(r.recordedAt).toISOString() }));
      return { trip: { ...trip, odometerStart: trip.odometerStart === null ? null : Number(trip.odometerStart), odometerEnd: trip.odometerEnd === null ? null : Number(trip.odometerEnd) }, points, estimatedKm: pathKm(points) };
    });
  }
}
export const defaultFleetTrackService = new FleetTrackService();
