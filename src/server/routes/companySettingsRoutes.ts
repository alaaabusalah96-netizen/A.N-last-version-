import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultCompanySettingsService } from '../org/companySettingsService.js';
import { wrap } from '../http/asyncHandler.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { ValidationError } from '../http/errors.js';

// Account-mapping fields: these (and only these) can be saved with accounting.mapping.write.
export const ACCOUNT_MAPPING_FIELDS = [
  'inventoryAccountId',
  'purchasesClearingAccountId',
  'accountsPayableAccountId',
  'inventoryAdjustmentAccountId',
  'openingBalanceEquityAccountId',
  'custodyReceivableAccountId',
  'cogsAccountId',
  'vatPayableAccountId',
  'vatInputAccountId',
] as const;

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

// PUT /api/companies/:companyId/settings/mapping
// Accounting-mapping fields only, for roles that own the chart mapping but not the whole company settings.
companySettingsRoutes.put('/settings/mapping',
  requireAuth,
  requirePermission(PERMISSIONS.ACCOUNTING_MAPPING_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId } = req.params;
    const actorId = req.user!.id;
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const allowed = new Set<string>(ACCOUNT_MAPPING_FIELDS);
    const extra = Object.keys(body).filter((k) => !allowed.has(k));
    if (extra.length > 0) {
      throw new ValidationError(`هذا المسار يقبل حقول الربط المحاسبي فقط. حقول غير مسموحة: ${extra.join(', ')}`);
    }
    if (Object.keys(body).length === 0) {
      throw new ValidationError('لا توجد حقول ربط محاسبي للحفظ');
    }
    const settings = await defaultCompanySettingsService.upsertSettings(actorId, companyId, body);
    return res.status(200).json({ status: 'ok', settings });
  })
);
