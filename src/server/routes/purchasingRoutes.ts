import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultSupplierService } from '../purchasing/supplierService.js';
import { defaultGrnService } from '../purchasing/grnService.js';
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
