import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultCompanySettingsService } from '../org/companySettingsService.js';
import { wrap } from '../http/asyncHandler.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { PERMISSIONS } from '../rbac/permissions.js';

export const companySettingsRoutes = Router({ mergeParams: true });

// GET /api/companies/:companyId/settings
companySettingsRoutes.get('/settings',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId } = req.params;
    const settings = await defaultCompanySettingsService.getSettings(companyId);
    return res.status(200).json({ status: 'ok', settings });
  })
);

// PUT /api/companies/:companyId/settings
companySettingsRoutes.put('/settings',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId } = req.params;
    const actorId = req.user!.id;
    const settings = await defaultCompanySettingsService.upsertSettings(actorId, companyId, req.body);
    return res.status(200).json({ status: 'ok', settings });
  })
);
