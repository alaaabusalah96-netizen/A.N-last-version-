import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { defaultFleetTripService, TripView } from './fleetTripService.js';
import { defaultFleetExpenseService, ExpenseView } from './fleetExpenseService.js';

/** Trips a driver may see in the portal: dispatched (ready to start), running, and finished. Drafts, approvals and cancelled trips are office matters. */
export const DRIVER_VISIBLE_TRIP_STATUSES = ['dispatched', 'in_progress', 'completed'] as const;
/** Pure rule: a driver may attach an expense to a trip that has been handed to them (not before dispatch). */
export const canDriverLogExpense = (tripStatus: string): boolean => (DRIVER_VISIBLE_TRIP_STATUSES as readonly string[]).includes(tripStatus);

const TCOLS = `id, trip_no AS "tripNo", vehicle_id AS "vehicleId", purpose, planned_start AS "plannedStart", planned_end AS "plannedEnd", status,
  started_at AS "startedAt", completed_at AS "completedAt", odometer_start AS "odometerStart", odometer_end AS "odometerEnd"`;

/**
 * Driver portal (phase d). Every call resolves the caller to the fleet driver linked to their login (fleet_drivers.user_id); a user with no linked,
 * active driver gets nothing. A driver only ever sees and acts on trips assigned to them. Start/complete reuse the trip service so odometer and status
 * rules are the same as the office screen. Expenses are always drafts created by the driver; approval and posting stay with office roles.
 */
export class FleetDriverPortalService {
  private async driverOf(companyId: string, userId: string, tx: DbExecutor): Promise<{ id: string; fullName: string }> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    const d = (await tx.query<any>(`SELECT id, full_name AS "fullName", status FROM fleet_drivers WHERE company_id=$1 AND user_id=$2`, [companyId, userId])).rows[0];
    if (!d) throw new ForbiddenError('حسابك غير مرتبط بسائق في هذه الشركة');
    if (d.status !== 'active') throw new ForbiddenError('حساب السائق غير نشط');
    return { id: d.id, fullName: d.fullName };
  }
  private async ownTrip(companyId: string, tripId: string, driverId: string, tx: DbExecutor): Promise<any> {
    if (!tripId || !isUuid(tripId)) throw new ValidationError('معرف الرحلة غير صالح');
    const t = (await tx.query<any>(`SELECT ${TCOLS}, driver_id AS "driverId" FROM fleet_trips WHERE company_id=$1 AND id=$2`, [companyId, tripId])).rows[0];
    // A trip of another driver looks exactly like a missing one.
    if (!t || t.driverId !== driverId || !canDriverLogExpense(t.status)) throw new NotFoundError('الرحلة غير موجودة');
    return t;
  }

  async me(companyId: string, userId: string): Promise<{ driverId: string; fullName: string }> {
    return await withTenantTransaction(companyId, async (tx) => { const d = await this.driverOf(companyId, userId, tx); return { driverId: d.id, fullName: d.fullName }; });
  }

  async myTrips(companyId: string, userId: string): Promise<any[]> {
    return await withTenantTransaction(companyId, async (tx) => {
      const d = await this.driverOf(companyId, userId, tx);
      const rows = (await tx.query<any>(
        `SELECT ${TCOLS} FROM fleet_trips WHERE company_id=$1 AND driver_id=$2 AND status = ANY($3::text[]) ORDER BY planned_start DESC LIMIT 100`,
        [companyId, d.id, DRIVER_VISIBLE_TRIP_STATUSES as unknown as string[]])).rows;
      const stops = rows.length ? (await tx.query<any>(`SELECT trip_id AS "tripId", stop_no AS "stopNo", place_name AS "placeName" FROM fleet_trip_stops WHERE company_id=$1 AND trip_id = ANY($2::uuid[]) ORDER BY stop_no`, [companyId, rows.map((r: any) => r.id)])).rows : [];
      return rows.map((r: any) => ({ ...r, odometerStart: r.odometerStart === null ? null : Number(r.odometerStart), odometerEnd: r.odometerEnd === null ? null : Number(r.odometerEnd),
        stops: stops.filter((s: any) => s.tripId === r.id).map((s: any) => ({ stopNo: Number(s.stopNo), placeName: s.placeName })) }));
    });
  }

  async startMyTrip(companyId: string, userId: string, tripId: string, odometerStart: unknown): Promise<TripView> {
    return await withTenantTransaction(companyId, async (tx) => {
      const d = await this.driverOf(companyId, userId, tx);
      await this.ownTrip(companyId, tripId, d.id, tx);
      return await defaultFleetTripService.startTrip(companyId, tripId, odometerStart, userId);
    });
  }

  async completeMyTrip(companyId: string, userId: string, tripId: string, odometerEnd: unknown): Promise<TripView> {
    return await withTenantTransaction(companyId, async (tx) => {
      const d = await this.driverOf(companyId, userId, tx);
      await this.ownTrip(companyId, tripId, d.id, tx);
      return await defaultFleetTripService.completeTrip(companyId, tripId, odometerEnd, userId);
    });
  }

  /** Always a draft, on the trip's own vehicle; the driver cannot pick another vehicle or approve anything. */
  async logMyExpense(companyId: string, userId: string, tripId: string, input: Record<string, unknown>): Promise<ExpenseView> {
    return await withTenantTransaction(companyId, async (tx) => {
      const d = await this.driverOf(companyId, userId, tx);
      const t = await this.ownTrip(companyId, tripId, d.id, tx);
      return await defaultFleetExpenseService.createExpense(companyId, {
        vehicleId: t.vehicleId, tripId, categoryId: input?.categoryId, expenseDate: input?.expenseDate, amount: input?.amount,
        description: input?.description, referenceNo: input?.referenceNo,
      }, userId);
    });
  }

  async myExpenses(companyId: string, userId: string): Promise<any[]> {
    return await withTenantTransaction(companyId, async (tx) => {
      await this.driverOf(companyId, userId, tx);
      return (await tx.query<any>(
        `SELECT id, expense_no AS "expenseNo", trip_id AS "tripId", category_id AS "categoryId", to_char(expense_date,'YYYY-MM-DD') AS "expenseDate", amount, description, status, reject_reason AS "rejectReason"
           FROM fleet_expenses WHERE company_id=$1 AND created_by=$2 ORDER BY seq DESC LIMIT 100`, [companyId, userId])).rows.map((r: any) => ({ ...r, amount: Number(r.amount) }));
    });
  }

  /** Active categories the driver can pick (names only, no accounts). */
  async categories(companyId: string, userId: string): Promise<Array<{ id: string; nameAr: string }>> {
    return await withTenantTransaction(companyId, async (tx) => {
      await this.driverOf(companyId, userId, tx);
      return (await tx.query<any>(`SELECT id, name_ar AS "nameAr" FROM fleet_expense_categories WHERE company_id=$1 AND is_active ORDER BY name_ar`, [companyId])).rows;
    });
  }
}
export const defaultFleetDriverPortalService = new FleetDriverPortalService();
