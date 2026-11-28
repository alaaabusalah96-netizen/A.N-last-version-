import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultWarehouseService } from '../inventory/warehouseService.js';
import { defaultItemService } from '../inventory/itemService.js';
import { defaultStockService } from '../inventory/stockService.js';
import { defaultStockDocumentService } from '../inventory/stockDocumentService.js';
import { defaultStocktakeService } from '../inventory/stocktakeService.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';

import { inventoryValuationRoutes } from '../inventory/inventoryValuationRoutes.js';

export const inventoryRoutes = Router();

inventoryRoutes.use('/', inventoryValuationRoutes);

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


inventoryRoutes.put(
  '/warehouses/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_WRITE, companyId);
    const id = req.params.id;
    if (!isUuid(id)) throw new ValidationError('Invalid ID format');
    const { nameAr, nameEn, isActive } = req.body || {};
    const warehouse = await defaultWarehouseService.updateWarehouse(companyId, id, { nameAr, nameEn, isActive }, user.id);
    return res.status(200).json({ status: 'ok', warehouse });
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

    const { code, nameAr, nameEn, uom, customValues } = req.body;
    const item = await defaultItemService.createItem(
      companyId,
      {
        code,
        nameAr,
        nameEn,
        uom,
        customValues: Array.isArray(customValues) ? customValues : undefined,
      },
      user.id
    );

    return res.status(201).json({ status: 'ok', item });
  })
);


inventoryRoutes.put(
  '/items/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_WRITE, companyId);
    const id = req.params.id;
    if (!isUuid(id)) throw new ValidationError('Invalid ID format');
    const { nameAr, nameEn, isActive } = req.body || {};
    const item = await defaultItemService.updateItem(companyId, id, { nameAr, nameEn, isActive }, user.id);
    return res.status(200).json({ status: 'ok', item });
  })
);

inventoryRoutes.get(
  '/items/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const itemId = req.params.id;

    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const item = await defaultItemService.getItem(companyId, itemId);
    return res.status(200).json({ status: 'ok', item });
  })
);

inventoryRoutes.get(
  '/items/:id/stock',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const itemId = req.params.id;

    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const balances = await defaultStockService.listStockBalancesByItem(companyId, itemId);
    return res.status(200).json({ status: 'ok', balances });
  })
);

inventoryRoutes.get(
  '/items/:id/movements',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const itemId = req.params.id;

    const warehouseId = (req.query.warehouseId as string) || undefined;
    const fromDate = (req.query.from as string) || (req.query.fromDate as string) || undefined;
    const toDate = (req.query.to as string) || (req.query.toDate as string) || undefined;
    const movementType = (req.query.type as string) || (req.query.movementType as string) || undefined;

    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_READ, companyId);

    const movements = await defaultStockService.listStockMovementsByItem(companyId, itemId, {
      warehouseId,
      fromDate,
      toDate,
      movementType,
    });
    return res.status(200).json({ status: 'ok', movements });
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

    const { warehouseId, itemId, qty, unitCost, costSource, reason, memo, entryDate, expenseAccountId } = req.body;
    const result = await defaultStockService.receiveStock(
      companyId,
      {
        warehouseId,
        itemId,
        qty: Number(qty),
        unitCost: unitCost !== undefined && unitCost !== null && unitCost !== '' ? Number(unitCost) : undefined,
        costSource,
        reason,
        memo,
        entryDate,
        expenseAccountId,
      },
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

    const { warehouseId, itemId, qty, reason, memo, entryDate, expenseAccountId } = req.body;
    const result = await defaultStockService.issueStock(
      companyId,
      { warehouseId, itemId, qty: Number(qty), reason, memo, entryDate, expenseAccountId },
      user.id
    );

    return res.status(201).json({ status: 'ok', ...result });
  })
);

inventoryRoutes.post(
  '/adjustments',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';

    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_VALUATION_ADJUST, companyId);

    const { warehouseId, itemId, adjustmentType, direction, qty, unitCost, costSource, reason, memo, entryDate, expenseAccountId } = req.body;
    const result = await defaultStockService.adjustStock(
      companyId,
      {
        warehouseId,
        itemId,
        adjustmentType,
        direction,
        qty: Number(qty),
        unitCost: unitCost !== undefined && unitCost !== null && unitCost !== '' ? Number(unitCost) : undefined,
        costSource,
        reason,
        memo,
        entryDate,
        expenseAccountId,
      },
      user.id
    );

    return res.status(201).json({ status: 'ok', ...result });
  })
);

inventoryRoutes.post(
  '/transfers',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';

    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_MOVEMENT, companyId);

    const { sourceWarehouseId, destWarehouseId, itemId, qty, memo } = req.body;
    const result = await defaultStockService.transfer(
      companyId,
      { sourceWarehouseId, destWarehouseId, itemId, qty: Number(qty), memo },
      user.id
    );

    return res.status(201).json({ status: 'ok', ...result });
  })
);


// Multi-line stock documents (receipt / issue / adjustment / transfer): header + lines[], all or nothing.
inventoryRoutes.post(
  '/documents',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const docType = req.body?.docType;
    if (!['receipt', 'issue', 'adjustment', 'transfer'].includes(docType)) {
      throw new ValidationError('docType يجب أن يكون receipt أو issue أو adjustment أو transfer');
    }
    await assertInventoryPermission(
      user,
      docType === 'adjustment' ? PERMISSIONS.INVENTORY_VALUATION_ADJUST : PERMISSIONS.INVENTORY_MOVEMENT,
      companyId
    );
    const b = req.body || {};
    if (!Array.isArray(b.lines)) throw new ValidationError('lines يجب أن تكون مصفوفة');
    const num = (v: any) => (v !== undefined && v !== null && v !== '' ? Number(v) : undefined);
    const docInput = {
        docType,
        warehouseId: b.warehouseId,
        sourceWarehouseId: b.sourceWarehouseId,
        destWarehouseId: b.destWarehouseId,
        reason: b.reason,
        memo: b.memo,
        costSource: b.costSource,
        entryDate: b.entryDate,
        expenseAccountId: b.expenseAccountId,
        adjustmentType: b.adjustmentType,
        lines: b.lines.map((l: any) => ({
          itemId: l?.itemId,
          qty: Number(l?.qty),
          unitCost: num(l?.unitCost),
          costSource: l?.costSource,
          reason: l?.reason,
          memo: l?.memo,
          warehouseId: l?.warehouseId,
          direction: l?.direction,
          adjustmentType: l?.adjustmentType,
          expenseAccountId: l?.expenseAccountId,
        })),
      };
    const wantsAsync = b.async === true || b.async === 'true' || String(req.query.async || '') === 'true';
    if (wantsAsync) {
      const job = await defaultStockDocumentService.createJob(companyId, docInput, user.id);
      // Claim before answering so the job is already "running" when the client first polls; the
      // posting itself continues after the response (polls keep the process busy).
      const claim = await defaultStockDocumentService.claimJob(companyId, job.id);
      if (claim) void defaultStockDocumentService.executeJob(companyId, job.id, claim).catch(() => undefined);
      return res.status(202).json({ status: 'accepted', jobId: job.id, jobStatus: job.status, lineCount: job.lineCount });
    }
    const result = await defaultStockDocumentService.postDocument(companyId, docInput, user.id);
    return res.status(201).json({ status: 'ok', ...result });
  })
);

// Poll a background document job (queued / running / done / failed).
inventoryRoutes.get(
  '/documents/jobs/:jobId',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    if (!companyId || !isUuid(companyId)) throw new ValidationError('Invalid or missing company ID format');
    // 1) authorize first (before anything about the job is revealed: existence or type),
    // 2) pure read, 3) type-specific check, 4) only then let the job move forward.
    // A caller with neither inventory permission gets 403 whatever the job id is. A caller who has one
    // but not the permission for this job's type gets the same 404 as for a missing job.
    const company = await defaultCompanyStore.getById(companyId);
    if (!company) throw new NotFoundError('Company not found');
    const canMove = await defaultRbacService.hasPermission(user, PERMISSIONS.INVENTORY_MOVEMENT, companyId);
    const canAdjust = await defaultRbacService.hasPermission(user, PERMISSIONS.INVENTORY_VALUATION_ADJUST, companyId);
    if (!canMove && !canAdjust) {
      throw new ForbiddenError(`Access denied: Missing required permission '${PERMISSIONS.INVENTORY_MOVEMENT}' for this company`);
    }
    const existing = await defaultStockDocumentService.readJob(companyId, req.params.jobId);
    const allowedForType = existing ? (existing.docType === 'adjustment' ? canAdjust : canMove) : false;
    if (!existing || !allowedForType) throw new NotFoundError('مهمة الترحيل غير موجودة');
    const job = await defaultStockDocumentService.advanceJob(companyId, req.params.jobId);
    if (!job) throw new NotFoundError('مهمة الترحيل غير موجودة');
    return res.status(200).json({ status: 'ok', job });
  })
);

// Physical stocktake sheets: snapshot, count entry, variance report. Counting never posts to stock or the ledger.
inventoryRoutes.get(
  '/stocktakes',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_READ, companyId);
    return res.status(200).json({ status: 'ok', stocktakes: await defaultStocktakeService.list(companyId) });
  })
);

inventoryRoutes.post(
  '/stocktakes',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_MOVEMENT, companyId);
    const { warehouseId, memo, countDate } = req.body || {};
    const stocktake = await defaultStocktakeService.create(companyId, { warehouseId, memo, countDate }, user.id);
    return res.status(201).json({ status: 'ok', stocktake });
  })
);

inventoryRoutes.get(
  '/stocktakes/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_READ, companyId);
    return res.status(200).json({ status: 'ok', stocktake: await defaultStocktakeService.get(companyId, req.params.id) });
  })
);

inventoryRoutes.put(
  '/stocktakes/:id/counts',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_MOVEMENT, companyId);
    const counts = (Array.isArray(req.body?.counts) ? req.body.counts : []).map((c: any) => ({
      itemId: c?.itemId,
      countedQty: c?.countedQty === null || c?.countedQty === '' || c?.countedQty === undefined ? null : Number(c.countedQty),
    }));
    const stocktake = await defaultStocktakeService.saveCounts(companyId, req.params.id, counts, user.id);
    return res.status(200).json({ status: 'ok', stocktake });
  })
);

inventoryRoutes.post(
  '/stocktakes/:id/close',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_MOVEMENT, companyId);
    return res.status(200).json({ status: 'ok', stocktake: await defaultStocktakeService.close(companyId, req.params.id, user.id) });
  })
);

inventoryRoutes.post(
  '/stocktakes/:id/cancel',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    await assertInventoryPermission(user, PERMISSIONS.INVENTORY_MOVEMENT, companyId);
    return res.status(200).json({ status: 'ok', stocktake: await defaultStocktakeService.cancel(companyId, req.params.id, user.id) });
  })
);
