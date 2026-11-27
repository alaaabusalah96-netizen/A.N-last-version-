import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultFleetService } from '../fleet/fleetService.js';
import { defaultFleetTripService } from '../fleet/fleetTripService.js';
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
