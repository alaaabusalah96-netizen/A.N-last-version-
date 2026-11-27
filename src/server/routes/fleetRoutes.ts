import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultFleetService } from '../fleet/fleetService.js';
import { defaultFleetTripService } from '../fleet/fleetTripService.js';
import { defaultFleetMaintenanceService } from '../fleet/fleetMaintenanceService.js';
import { defaultFleetTrackService } from '../fleet/fleetTrackService.js';
import { defaultFleetDriverPortalService } from '../fleet/fleetDriverPortalService.js';
import { defaultFleetExpenseService } from '../fleet/fleetExpenseService.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';

export const fleetRoutes = Router();

async function assertFleetPermission(user: AuthenticatedRequest['user'], permission: string, companyId: string): Promise<void> {
  if (!companyId || !isUuid(companyId)) throw new ValidationError('Invalid or missing company ID format');
  const company = await defaultCompanyStore.getById(companyId);
  if (!company) throw new NotFoundError('Company not found');
  const allowed = await defaultRbacService.hasPermission(user!, permission, companyId);
  if (!allowed) throw new ForbiddenError(`Access denied: Missing required permission '${permission}' for this company`);
}
const cid = (req: AuthenticatedRequest) => (req.body?.companyId as string) || (req.query.companyId as string) || '';

fleetRoutes.get('/vehicles', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_READ, companyId);
  res.json({ status: 'ok', vehicles: await defaultFleetService.listVehicles(companyId, { status: (req.query.status as string) || undefined }) });
}));
fleetRoutes.post('/vehicles', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_MANAGE, companyId);
  res.status(201).json({ status: 'ok', vehicle: await defaultFleetService.createVehicle(companyId, req.body || {}, req.user!.id) });
}));
fleetRoutes.patch('/vehicles/:id', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_MANAGE, companyId);
  res.json({ status: 'ok', vehicle: await defaultFleetService.updateVehicle(companyId, req.params.id, req.body || {}, req.user!.id) });
}));
fleetRoutes.get('/drivers', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_READ, companyId);
  res.json({ status: 'ok', drivers: await defaultFleetService.listDrivers(companyId, { status: (req.query.status as string) || undefined }) });
}));
fleetRoutes.post('/drivers', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_MANAGE, companyId);
  res.status(201).json({ status: 'ok', driver: await defaultFleetService.createDriver(companyId, req.body || {}, req.user!.id) });
}));
fleetRoutes.patch('/drivers/:id', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_MANAGE, companyId);
  res.json({ status: 'ok', driver: await defaultFleetService.updateDriver(companyId, req.params.id, req.body || {}, req.user!.id) });
}));

// Phase (b): trips and approval
fleetRoutes.get('/trips', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_READ, companyId);
  res.json({ status: 'ok', trips: await defaultFleetTripService.listTrips(companyId, {
    status: (req.query.status as string) || undefined, vehicleId: (req.query.vehicleId as string) || undefined, driverId: (req.query.driverId as string) || undefined }) });
}));
fleetRoutes.get('/trips/:id', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_READ, companyId);
  res.json({ status: 'ok', trip: await defaultFleetTripService.getTrip(companyId, req.params.id) });
}));
fleetRoutes.post('/trips', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_TRIP_CREATE, companyId);
  res.status(201).json({ status: 'ok', trip: await defaultFleetTripService.createTrip(companyId, req.body || {}, req.user!.id) });
}));
fleetRoutes.post('/trips/:id/approve', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_TRIP_APPROVE, companyId);
  res.json({ status: 'ok', trip: await defaultFleetTripService.approveTrip(companyId, req.params.id, req.user!.id) });
}));
fleetRoutes.post('/trips/:id/reject', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_TRIP_APPROVE, companyId);
  res.json({ status: 'ok', trip: await defaultFleetTripService.rejectTrip(companyId, req.params.id, req.body?.reason, req.user!.id) });
}));
fleetRoutes.post('/trips/:id/dispatch', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_TRIP_DISPATCH, companyId);
  res.json({ status: 'ok', trip: await defaultFleetTripService.dispatchTrip(companyId, req.params.id, req.user!.id) });
}));
fleetRoutes.post('/trips/:id/start', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_TRIP_DISPATCH, companyId);
  res.json({ status: 'ok', trip: await defaultFleetTripService.startTrip(companyId, req.params.id, req.body?.odometerStart, req.user!.id) });
}));
fleetRoutes.post('/trips/:id/complete', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_TRIP_DISPATCH, companyId);
  res.json({ status: 'ok', trip: await defaultFleetTripService.completeTrip(companyId, req.params.id, req.body?.odometerEnd, req.user!.id) });
}));
fleetRoutes.post('/trips/:id/cancel', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_TRIP_DISPATCH, companyId);
  res.json({ status: 'ok', trip: await defaultFleetTripService.cancelTrip(companyId, req.params.id, req.body?.reason, req.user!.id) });
}));

// Phase (c1): expenses and accounting link
const isAdmin = (req: AuthenticatedRequest) => req.user!.role === 'platform_admin';
fleetRoutes.get('/expense-categories', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_READ, companyId);
  res.json({ status: 'ok', categories: await defaultFleetExpenseService.listCategories(companyId) });
}));
fleetRoutes.post('/expense-categories', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_EXPENSE_CREATE, companyId);
  res.status(201).json({ status: 'ok', category: await defaultFleetExpenseService.createCategory(companyId, req.body || {}, req.user!.id) });
}));
fleetRoutes.patch('/expense-categories/:id', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_EXPENSE_CREATE, companyId);
  res.json({ status: 'ok', category: await defaultFleetExpenseService.updateCategory(companyId, req.params.id, req.body || {}, req.user!.id) });
}));
fleetRoutes.get('/expenses', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_READ, companyId);
  res.json({ status: 'ok', expenses: await defaultFleetExpenseService.listExpenses(companyId, {
    status: (req.query.status as string) || undefined, vehicleId: (req.query.vehicleId as string) || undefined, tripId: (req.query.tripId as string) || undefined }) });
}));
fleetRoutes.get('/expenses/:id', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_READ, companyId);
  res.json({ status: 'ok', expense: await defaultFleetExpenseService.getExpense(companyId, req.params.id) });
}));
fleetRoutes.post('/expenses', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_EXPENSE_CREATE, companyId);
  res.status(201).json({ status: 'ok', expense: await defaultFleetExpenseService.createExpense(companyId, req.body || {}, req.user!.id) });
}));
fleetRoutes.post('/expenses/:id/approve', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_EXPENSE_APPROVE, companyId);
  res.json({ status: 'ok', expense: await defaultFleetExpenseService.approveExpense(companyId, req.params.id, req.user!.id) });
}));
fleetRoutes.post('/expenses/:id/reject', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_EXPENSE_APPROVE, companyId);
  res.json({ status: 'ok', expense: await defaultFleetExpenseService.rejectExpense(companyId, req.params.id, req.body?.reason, req.user!.id) });
}));
fleetRoutes.post('/expenses/:id/post', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_EXPENSE_POST, companyId);
  res.json({ status: 'ok', expense: await defaultFleetExpenseService.postExpense(companyId, req.params.id, req.body?.counterAccountId, req.user!.id, isAdmin(req)) });
}));
fleetRoutes.post('/expenses/:id/pay-from-custody', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_EXPENSE_POST, companyId);
  await assertFleetPermission(req.user!, PERMISSIONS.CUSTODY_REQUEST, companyId);
  const u = req.user!;
  res.json({ status: 'ok', expense: await defaultFleetExpenseService.payFromCustody(companyId, req.params.id, req.body?.custodyId, u.id, u.role === 'platform_admin') });
}));
fleetRoutes.post('/expenses/:id/reverse', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_EXPENSE_POST, companyId);
  res.json({ status: 'ok', expense: await defaultFleetExpenseService.reverseExpense(companyId, req.params.id, req.body?.reason, req.user!.id, isAdmin(req)) });
}));
// Phase (d): driver portal. A driver sees and acts only on their own trips (resolved from the login, never from the request).
fleetRoutes.get('/my/profile', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_DRIVER_SELF, companyId);
  res.json({ status: 'ok', driver: await defaultFleetDriverPortalService.me(companyId, req.user!.id) });
}));
fleetRoutes.get('/my/trips', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_DRIVER_SELF, companyId);
  res.json({ status: 'ok', trips: await defaultFleetDriverPortalService.myTrips(companyId, req.user!.id) });
}));
fleetRoutes.post('/my/trips/:id/start', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_DRIVER_SELF, companyId);
  res.json({ status: 'ok', trip: await defaultFleetDriverPortalService.startMyTrip(companyId, req.user!.id, req.params.id, req.body?.odometerStart) });
}));
fleetRoutes.post('/my/trips/:id/complete', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_DRIVER_SELF, companyId);
  res.json({ status: 'ok', trip: await defaultFleetDriverPortalService.completeMyTrip(companyId, req.user!.id, req.params.id, req.body?.odometerEnd) });
}));
fleetRoutes.post('/my/trips/:id/expenses', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_DRIVER_SELF, companyId);
  res.status(201).json({ status: 'ok', expense: await defaultFleetDriverPortalService.logMyExpense(companyId, req.user!.id, req.params.id, req.body || {}) });
}));
fleetRoutes.post('/my/trips/:id/positions', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_DRIVER_SELF, companyId);
  res.status(201).json({ status: 'ok', position: await defaultFleetDriverPortalService.logMyPosition(companyId, req.user!.id, req.params.id, req.body || {}) });
}));
fleetRoutes.get('/trips/:id/track', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_TRACK_READ, companyId);
  res.json({ status: 'ok', ...(await defaultFleetTrackService.tripTrack(companyId, req.params.id)) });
}));
fleetRoutes.get('/maintenance/due', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_READ, companyId);
  res.json({ status: 'ok', ...(await defaultFleetMaintenanceService.due(companyId, { soonDays: req.query.soonDays, soonKm: req.query.soonKm })) });
}));
fleetRoutes.get('/vehicles/:id/maintenance', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_READ, companyId);
  res.json({ status: 'ok', records: await defaultFleetMaintenanceService.listForVehicle(companyId, req.params.id) });
}));
fleetRoutes.post('/vehicles/:id/maintenance', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_MANAGE, companyId);
  res.status(201).json({ status: 'ok', record: await defaultFleetMaintenanceService.create(companyId, req.params.id, req.body || {}, req.user!.id) });
}));
fleetRoutes.post('/maintenance/:id/void', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_MANAGE, companyId);
  res.json({ status: 'ok', record: await defaultFleetMaintenanceService.void(companyId, req.params.id, req.body?.reason) });
}));
fleetRoutes.get('/my/expenses', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_DRIVER_SELF, companyId);
  res.json({ status: 'ok', expenses: await defaultFleetDriverPortalService.myExpenses(companyId, req.user!.id) });
}));
fleetRoutes.get('/my/expense-categories', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertFleetPermission(req.user!, PERMISSIONS.FLEET_DRIVER_SELF, companyId);
  res.json({ status: 'ok', categories: await defaultFleetDriverPortalService.categories(companyId, req.user!.id) });
}));
