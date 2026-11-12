import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { defaultCustomFieldService } from '../customization/customFieldService.js';
import { defaultItemService } from '../inventory/itemService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError } from '../http/errors.js';

export const customFieldRoutes = Router({ mergeParams: true });

function assertCompanyParam(req: AuthenticatedRequest): string {
  const { companyId } = req.params;
  if (!companyId || !isUuid(companyId)) {
    throw new ValidationError('Invalid company ID format');
  }
  return companyId;
}

// GET /api/companies/:companyId/custom-fields?entityType=item
customFieldRoutes.get(
  '/custom-fields',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const entityType = typeof req.query.entityType === 'string' && req.query.entityType.trim()
      ? req.query.entityType.trim()
      : 'item';
    const includeInactive = req.query.includeInactive === 'true' || req.query.includeInactive === '1';

    const [fields, userCanWrite] = await Promise.all([
      defaultCustomFieldService.getDefinitions(companyId, entityType, includeInactive),
      defaultRbacService.hasPermission(req.user!, PERMISSIONS.COMPANY_SETTINGS_WRITE, companyId),
    ]);

    return res.status(200).json({ status: 'ok', fields, userCanWrite });
  })
);

// POST /api/companies/:companyId/custom-fields
customFieldRoutes.post(
  '/custom-fields',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const field = await defaultCustomFieldService.createField(companyId, req.body, req.user!.id);
    return res.status(201).json({ status: 'ok', field });
  })
);

// PATCH /api/companies/:companyId/custom-fields/:fieldId
customFieldRoutes.patch(
  '/custom-fields/:fieldId',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const fieldId = String(req.params.fieldId || '');
    const field = await defaultCustomFieldService.updateField(companyId, fieldId, req.body, req.user!.id);
    return res.status(200).json({ status: 'ok', field });
  })
);

// POST /api/companies/:companyId/custom-fields/:fieldId/active
customFieldRoutes.post(
  '/custom-fields/:fieldId/active',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const fieldId = String(req.params.fieldId || '');
    if (typeof req.body?.isActive !== 'boolean') {
      throw new ValidationError('الحقل isActive (boolean) مطلوب');
    }
    const field = await defaultCustomFieldService.setActive(
      companyId,
      fieldId,
      req.body.isActive,
      req.user!.id
    );
    return res.status(200).json({ status: 'ok', field });
  })
);

// GET /api/companies/:companyId/custom-values/:entityId
customFieldRoutes.get(
  '/custom-values/:entityId',
  requireAuth,
  requirePermission(PERMISSIONS.INVENTORY_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const entityId = String(req.params.entityId || '');
    if (!entityId || !isUuid(entityId)) {
      throw new ValidationError('معرّف الكيان غير صالح');
    }

    const [values, fields, userCanWrite] = await Promise.all([
      defaultCustomFieldService.getValues(companyId, entityId, 'item'),
      defaultCustomFieldService.getDefinitions(companyId, 'item', false),
      defaultRbacService.hasPermission(req.user!, PERMISSIONS.INVENTORY_WRITE, companyId),
    ]);

    return res.status(200).json({ status: 'ok', values, fields, userCanWrite });
  })
);

// PUT /api/companies/:companyId/custom-values/:entityId
customFieldRoutes.put(
  '/custom-values/:entityId',
  requireAuth,
  requirePermission(PERMISSIONS.INVENTORY_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertCompanyParam(req);
    const entityId = String(req.params.entityId || '');
    if (!entityId || !isUuid(entityId)) {
      throw new ValidationError('معرّف الكيان غير صالح');
    }

    // Verify target item exists within the same company
    await defaultItemService.getItem(companyId, entityId);

    const rawValues = req.body?.values;
    const saved = await defaultCustomFieldService.setValues(
      companyId,
      entityId,
      rawValues,
      req.user!.id,
      'item'
    );

    return res.status(200).json({ status: 'ok', values: saved });
  })
);
