import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultWarehouseService } from '../inventory/warehouseService.js';
import { defaultItemService } from '../inventory/itemService.js';
import { defaultStockService } from '../inventory/stockService.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';

export const inventoryRoutes = Router();

async function assertInventoryPermission(
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

// 1. Warehouses API
inventoryRoutes.get(
  '/warehouses',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const warehouses = await defaultWarehouseService.listWarehouses(companyId);
    return res.status(200).json({ status: 'ok', warehouses });
  })
);

inventoryRoutes.post(
  '/warehouses',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';

    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_WRITE, companyId);

    const { code, nameAr, nameEn } = req.body;
    const warehouse = await defaultWarehouseService.createWarehouse(
      companyId,
      { code, nameAr, nameEn },
      user.id
    );

    return res.status(201).json({ status: 'ok', warehouse });
  })
);

// 2. Items Master API
inventoryRoutes.get(
  '/items',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const items = await defaultItemService.listItems(companyId);
    return res.status(200).json({ status: 'ok', items });
  })
);

inventoryRoutes.post(
  '/items',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';

    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_WRITE, companyId);

    const { code, nameAr, nameEn, uom } = req.body;
    const item = await defaultItemService.createItem(
      companyId,
      { code, nameAr, nameEn, uom },
      user.id
    );

    return res.status(201).json({ status: 'ok', item });
  })
);

// 3. Stock Balances API
inventoryRoutes.get(
  '/balances',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const balances = await defaultStockService.listStockBalances(companyId);
    return res.status(200).json({ status: 'ok', balances });
  })
);

// 4. Stock Movements API (Movements list, Receive, Issue)
inventoryRoutes.get(
  '/movements',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const movements = await defaultStockService.listStockMovements(companyId);
    return res.status(200).json({ status: 'ok', movements });
  })
);

inventoryRoutes.post(
  '/receive',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';

    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_MOVEMENT, companyId);

    const { warehouseId, itemId, qty, memo } = req.body;
    const result = await defaultStockService.receiveStock(
      companyId,
      { warehouseId, itemId, qty: Number(qty), memo },
      user.id
    );

    return res.status(201).json({ status: 'ok', ...result });
  })
);

inventoryRoutes.post(
  '/issue',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';

    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_MOVEMENT, companyId);

    const { warehouseId, itemId, qty, memo } = req.body;
    const result = await defaultStockService.issueStock(
      companyId,
      { warehouseId, itemId, qty: Number(qty), memo },
      user.id
    );

    return res.status(201).json({ status: 'ok', ...result });
  })
);
