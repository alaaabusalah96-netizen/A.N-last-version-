import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { defaultGroupTransferService } from '../inventory/groupTransferService.js';

export const groupTransferRoutes = Router();

async function assertPermission(user: AuthenticatedRequest['user'], permission: string, companyId: string): Promise<void> {
  if (!companyId || !isUuid(companyId)) throw new ValidationError('Invalid or missing company ID format');
  const company = await defaultCompanyStore.getById(companyId);
  if (!company) throw new NotFoundError('Company not found');
  const allowed = await defaultRbacService.hasPermission(user!, permission, companyId);
  if (!allowed) throw new ForbiddenError('ليس لديك صلاحية لتنفيذ هذه العملية');
}
const cid = (req: AuthenticatedRequest) => ((req.body?.companyId as string) || (req.query.companyId as string) || '');

// GET /api/group-transfers/partners: other active companies in the same group
groupTransferRoutes.get('/partners', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertPermission(req.user, PERMISSIONS.INVENTORY_READ, companyId);
  return res.status(200).json({ status: 'ok', partners: await defaultGroupTransferService.listPartners(companyId) });
}));

// GET /api/group-transfers/accounts: this company's intercompany control accounts
groupTransferRoutes.get('/accounts', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertPermission(req.user, PERMISSIONS.COMPANY_SETTINGS_READ, companyId);
  return res.status(200).json({ status: 'ok', accounts: await defaultGroupTransferService.getAccounts(companyId) });
}));

// PUT /api/group-transfers/accounts
groupTransferRoutes.put('/accounts', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertPermission(req.user, PERMISSIONS.COMPANY_SETTINGS_WRITE, companyId);
  const { receivableAccountId, payableAccountId } = req.body || {};
  const accounts = await defaultGroupTransferService.setAccounts(companyId, { receivableAccountId, payableAccountId }, req.user!.id);
  return res.status(200).json({ status: 'ok', accounts });
}));

// GET /api/group-transfers: transfers sent or received by the company
groupTransferRoutes.get('/', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertPermission(req.user, PERMISSIONS.INVENTORY_READ, companyId);
  return res.status(200).json({ status: 'ok', transfers: await defaultGroupTransferService.list(companyId) });
}));

// GET /api/group-transfers/:id
groupTransferRoutes.get('/:id', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertPermission(req.user, PERMISSIONS.INVENTORY_READ, companyId);
  return res.status(200).json({ status: 'ok', transfer: await defaultGroupTransferService.get(companyId, req.params.id) });
}));

// POST /api/group-transfers: ship goods from this company to a sister company (at cost)
groupTransferRoutes.post('/', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertPermission(req.user, PERMISSIONS.INVENTORY_MOVEMENT, companyId);
  const { toCompanyId, fromWarehouseId, reference, memo, fxRate, entryDate, lines } = req.body || {};
  const result = await defaultGroupTransferService.ship(companyId, { toCompanyId, fromWarehouseId, reference, memo, fxRate, entryDate, lines }, req.user!.id);
  return res.status(201).json({ status: 'ok', result });
}));

// POST /api/group-transfers/:id/receive: the receiving company confirms receipt
groupTransferRoutes.post('/:id/receive', requireAuth, wrap(async (req: AuthenticatedRequest, res: Response) => {
  const companyId = cid(req);
  await assertPermission(req.user, PERMISSIONS.INVENTORY_MOVEMENT, companyId);
  const { warehouseId, entryDate, lines } = req.body || {};
  const result = await defaultGroupTransferService.receive(companyId, req.params.id, { warehouseId, entryDate, lines }, req.user!.id);
  return res.status(201).json({ status: 'ok', result });
}));
