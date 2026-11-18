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
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_COSTING_PROFILE_WRITE, companyId);

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
  '/costing-assignments',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const assignments = await defaultInventoryValuationService.listItemAssignments(companyId);
    return res.status(200).json({ status: 'ok', assignments });
  })
);

inventoryValuationRoutes.get(
  '/unassigned-items',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const items = await defaultInventoryValuationService.listUnassignedItems(companyId);
    return res.status(200).json({ status: 'ok', items });
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
    if (!itemId || !isUuid(itemId)) {
      throw new ValidationError('Invalid item ID format');
    }

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
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_COSTING_ASSIGN, companyId);
    if (!itemId || !isUuid(itemId)) {
      throw new ValidationError('Invalid item ID format');
    }

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
  '/valuation-setup-status',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const summary = await defaultInventoryValuationService.getSetupStatus(companyId);
    return res.status(200).json({ status: 'ok', summary });
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

inventoryValuationRoutes.get(
  '/cost-layers',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const warehouseId = (req.query.warehouseId as string) || undefined;
    const itemId = (req.query.itemId as string) || undefined;
    if (warehouseId && !isUuid(warehouseId)) throw new ValidationError('Invalid warehouseId format');
    if (itemId && !isUuid(itemId)) throw new ValidationError('Invalid itemId format');
    const includeExhausted = req.query.includeExhausted === 'true';

    const layers = await defaultInventoryValuationService.listCostLayers(companyId, {
      warehouseId,
      itemId,
      includeExhausted,
    });
    return res.status(200).json({ status: 'ok', layers });
  })
);

inventoryValuationRoutes.get(
  '/valuation-movements',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const warehouseId = (req.query.warehouseId as string) || undefined;
    const itemId = (req.query.itemId as string) || undefined;
    if (warehouseId && !isUuid(warehouseId)) throw new ValidationError('Invalid warehouseId format');
    if (itemId && !isUuid(itemId)) throw new ValidationError('Invalid itemId format');
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    const movements = await defaultInventoryValuationService.listValuationMovements(companyId, {
      warehouseId,
      itemId,
      limit,
    });
    return res.status(200).json({ status: 'ok', movements });
  })
);

inventoryValuationRoutes.get(
  '/valuation-movements/:id/allocations',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const movementId = req.params.id;
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_READ, companyId);
    if (!movementId || !isUuid(movementId)) {
      throw new ValidationError('Invalid valuation movement ID format');
    }

    const allocations = await defaultInventoryValuationService.listAllocationsForMovement(companyId, movementId);
    return res.status(200).json({ status: 'ok', allocations });
  })
);

inventoryValuationRoutes.get(
  '/cost-adjustments',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const adjustments = await defaultInventoryValuationService.listCostAdjustments(companyId);
    return res.status(200).json({ status: 'ok', adjustments });
  })
);

inventoryValuationRoutes.get(
  '/opening-valuations',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const openings = await defaultInventoryValuationService.listOpeningValuations(companyId);
    return res.status(200).json({ status: 'ok', openings });
  })
);

inventoryValuationRoutes.post(
  '/opening-valuations',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_WRITE, companyId);

    const { warehouseId, itemId, quantity, totalCost, unitCost, reason, evidenceRef } = req.body;
    const opening = await defaultInventoryValuationService.createOpeningValuation(
      companyId,
      { warehouseId, itemId, quantity, totalCost, unitCost, reason, evidenceRef },
      user.id
    );
    return res.status(201).json({ status: 'ok', opening });
  })
);

inventoryValuationRoutes.post(
  '/opening-valuations/:id/approve',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const openingId = req.params.id;
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_OPENING_APPROVE, companyId);
    if (!openingId || !isUuid(openingId)) {
      throw new ValidationError('Invalid opening valuation ID format');
    }

    const opening = await defaultInventoryValuationService.approveOpeningValuation(
      companyId,
      openingId,
      user.id,
      user.role === 'platform_admin'
    );
    return res.status(200).json({ status: 'ok', opening });
  })
);

inventoryValuationRoutes.post(
  '/opening-valuations/:id/reject',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const openingId = req.params.id;
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_OPENING_APPROVE, companyId);
    if (!openingId || !isUuid(openingId)) {
      throw new ValidationError('Invalid opening valuation ID format');
    }

    const { rejectionReason } = req.body;
    const opening = await defaultInventoryValuationService.rejectOpeningValuation(
      companyId,
      openingId,
      rejectionReason,
      user.id
    );
    return res.status(200).json({ status: 'ok', opening });
  })
);

inventoryValuationRoutes.get(
  '/valuation-reconciliations',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const reconciliations = await defaultInventoryValuationService.listReconciliations(companyId);
    return res.status(200).json({ status: 'ok', reconciliations });
  })
);

inventoryValuationRoutes.post(
  '/valuation-reconciliations/run',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertValuationPermission(user, PERMISSIONS.INVENTORY_VALUATION_RECONCILE, companyId);

    const { warehouseId, itemId, costingMethod, periodId, notes } = req.body || {};
    const reconciliation = await defaultInventoryValuationService.runReconciliation(
      companyId,
      { warehouseId, itemId, costingMethod, periodId, notes },
      user.id
    );
    return res.status(201).json({ status: 'ok', reconciliation });
  })
);
