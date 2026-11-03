import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { requireCompanyAccess } from '../http/tenantScope.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultTenantDemoRepository } from '../org/tenantDemoRepository.js';
import { tenantContextStorage } from '../db/tenantContext.js';
import { wrap } from '../http/asyncHandler.js';
import { ValidationError } from '../http/errors.js';

export const tenantDemoRoutes = Router({ mergeParams: true });

// GET /api/companies/:companyId/demo-items
tenantDemoRoutes.get(
  '/',
  requireAuth,
  requireCompanyAccess(PERMISSIONS.COMPANY_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = req.params.companyId;
    const activeContextCompanyId = tenantContextStorage.getCurrentCompanyId();

    const items = await defaultTenantDemoRepository.listItems(companyId);

    return res.status(200).json({
      status: 'ok',
      companyId,
      activeContextCompanyId,
      items,
    });
  })
);

// POST /api/companies/:companyId/demo-items
tenantDemoRoutes.post(
  '/',
  requireAuth,
  requireCompanyAccess(PERMISSIONS.COMPANY_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = req.params.companyId;
    const { label } = req.body || {};

    if (!label || typeof label !== 'string' || label.trim().length < 1 || label.trim().length > 255) {
      throw new ValidationError('Label is required (1-255 characters)');
    }

    const item = await defaultTenantDemoRepository.createItem(companyId, label);

    return res.status(201).json({
      status: 'ok',
      item,
    });
  })
);
