import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultInventoryValuationService } from './inventoryValuationService.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';

export const inventoryValuationRoutes = Router();

async function assertValuationPermission(
  user: AuthenticatedRequest['user'],
  permission: string,
  companyId: string
): Promise<void> {
  if (!companyId || !isUuid(companyId)) {
    throw new ValidationError('Invalid or missing company ID format');
  }

  const company = await defaultCompanyStore.getById(companyId);
  if (!company) {
    throw new NotFoundError('Company not found');
  }

  const allowed = await defaultRbacService.hasPermission(user!, permission, companyId);
  if (!allowed) {
    throw new ForbiddenError(`Access denied: Missing required permission '${permission}' for this company`);
  }
}

inventoryValuationRoutes.get(
  '/costing-profiles',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const profiles = await defaultInventoryValuationService.listProfiles(companyId);
    return res.status(200).json({ status: 'ok', profiles });
  })
);

inventoryValuationRoutes.post(
  '/costing-profiles',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_WRITE, companyId);

    const { name, costingMethod, isDefault } = req.body;
    const profile = await defaultInventoryValuationService.createProfile(
      companyId,
      { name, costingMethod, isDefault },
      user.id
    );
    return res.status(201).json({ status: 'ok', profile });
  })
);

inventoryValuationRoutes.get(
  '/items/:id/costing-profile',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const itemId = req.params.id;
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const assignment = await defaultInventoryValuationService.getItemAssignment(companyId, itemId);
    return res.status(200).json({ status: 'ok', assignment });
  })
);

inventoryValuationRoutes.post(
  '/items/:id/costing-profile',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const itemId = req.params.id;
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_WRITE, companyId);

    const { profileId } = req.body;
    const assignment = await defaultInventoryValuationService.assignItemProfile(
      companyId,
      itemId,
      profileId,
      user.id
    );
    return res.status(200).json({ status: 'ok', assignment });
  })
);

inventoryValuationRoutes.get(
  '/warehouse-valuations',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const balances = await defaultInventoryValuationService.getWarehouseValuationBalances(companyId);
    return res.status(200).json({ status: 'ok', balances });
  })
);
