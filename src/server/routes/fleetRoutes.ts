import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultFleetService } from '../fleet/fleetService.js';
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
