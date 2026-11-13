import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultSupplierService } from '../purchasing/supplierService.js';
import { defaultGrnService } from '../purchasing/grnService.js';
import { defaultPurchaseOrderService } from '../purchasing/purchaseOrderService.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';

export const purchasingRoutes = Router();

async function assertPurchasingPermission(
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

// 1. Suppliers API
purchasingRoutes.get(
  '/suppliers',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);

    const suppliers = await defaultSupplierService.listSuppliers(companyId);
    return res.status(200).json({ status: 'ok', suppliers });
  })
);

purchasingRoutes.post(
  '/suppliers',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_WRITE, companyId);

    const { code, nameAr, nameEn } = req.body;
    const supplier = await defaultSupplierService.createSupplier(
      companyId,
      { code, nameAr, nameEn },
      user.id
    );

    return res.status(201).json({ status: 'ok', supplier });
  })
);

// 2. Goods Receipt Notes (GRN) API
purchasingRoutes.get(
  '/grn',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);

    const grns = await defaultGrnService.listGrns(companyId);
    return res.status(200).json({ status: 'ok', grns });
  })
);

purchasingRoutes.get(
  '/grn/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const grnId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);

    const grn = await defaultGrnService.getGrn(companyId, grnId);
    return res.status(200).json({ status: 'ok', grn });
  })
);

purchasingRoutes.post(
  '/grn',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_WRITE, companyId);

    const { supplierId, warehouseId, memo, lines } = req.body;
    const grn = await defaultGrnService.createGrn(
      companyId,
      { supplierId, warehouseId, memo, lines },
      user.id
    );

    return res.status(201).json({ status: 'ok', grn });
  })
);

purchasingRoutes.post(
  '/grn/:id/post',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const grnId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_POST, companyId);

    const grn = await defaultGrnService.postGrn(companyId, grnId, user.id);

    return res.status(200).json({ status: 'ok', grn });
  })
);

// 3. Purchase Orders (PO) API
purchasingRoutes.get(
  '/purchase-orders',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);

    const purchaseOrders = await defaultPurchaseOrderService.listPurchaseOrders(companyId);
    return res.status(200).json({ status: 'ok', purchaseOrders });
  })
);

purchasingRoutes.get(
  '/purchase-orders/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const poId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    if (!isUuid(poId)) {
      throw new ValidationError('Invalid purchase order ID format');
    }

    const purchaseOrder = await defaultPurchaseOrderService.getPurchaseOrder(companyId, poId);
    return res.status(200).json({ status: 'ok', purchaseOrder });
  })
);

purchasingRoutes.get(
  '/purchase-orders/:id/remaining',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    const poId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_READ, companyId);
    if (!isUuid(poId)) {
      throw new ValidationError('Invalid purchase order ID format');
    }

    const purchaseOrder = await defaultPurchaseOrderService.getPurchaseOrder(companyId, poId);
    const linesWithRemaining = (purchaseOrder.lines || []).map((l) => ({
      ...l,
      remainingQty: Math.max(0, Number(l.qty) - Number(l.receivedQty || 0)),
    }));

    return res.status(200).json({
      status: 'ok',
      purchaseOrder,
      lines: linesWithRemaining,
    });
  })
);

purchasingRoutes.post(
  '/purchase-orders',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_WRITE, companyId);

    const { supplierId, expectedDate, memo, lines } = req.body || {};
    const purchaseOrder = await defaultPurchaseOrderService.createPurchaseOrder(
      companyId,
      { supplierId, expectedDate, memo, lines },
      user.id
    );

    return res.status(201).json({ status: 'ok', purchaseOrder });
  })
);

purchasingRoutes.post(
  '/purchase-orders/:id/approve',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const poId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_POST, companyId);
    if (!isUuid(poId)) {
      throw new ValidationError('Invalid purchase order ID format');
    }

    const purchaseOrder = await defaultPurchaseOrderService.approvePurchaseOrder(companyId, poId, user.id);
    return res.status(200).json({ status: 'ok', purchaseOrder });
  })
);

purchasingRoutes.post(
  '/purchase-orders/:id/close',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const poId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_POST, companyId);
    if (!isUuid(poId)) {
      throw new ValidationError('Invalid purchase order ID format');
    }

    const purchaseOrder = await defaultPurchaseOrderService.closePurchaseOrder(companyId, poId, user.id);
    return res.status(200).json({ status: 'ok', purchaseOrder });
  })
);

purchasingRoutes.post(
  '/purchase-orders/:id/cancel',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.body?.companyId as string) || (req.query.companyId as string) || '';
    const poId = req.params.id;

    await assertPurchasingPermission(user, PERMISSIONS.PURCHASING_POST, companyId);
    if (!isUuid(poId)) {
      throw new ValidationError('Invalid purchase order ID format');
    }

    const purchaseOrder = await defaultPurchaseOrderService.cancelPurchaseOrder(companyId, poId, user.id);
    return res.status(200).json({ status: 'ok', purchaseOrder });
  })
);
