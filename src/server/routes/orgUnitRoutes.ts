import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultOrgUnitService } from '../org/orgUnitService.js';
import { wrap } from '../http/asyncHandler.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { isUuid } from '../http/validators.js';
import { ValidationError } from '../http/errors.js';

export const orgUnitRoutes = Router({ mergeParams: true });

// GET /api/companies/:companyId/org-units
orgUnitRoutes.get(
  '/org-units',
  requireAuth,
  requirePermission(PERMISSIONS.ORG_UNITS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId } = req.params;
    if (!isUuid(companyId)) throw new ValidationError('Invalid company ID format');

    const units = await defaultOrgUnitService.listUnits(companyId);
    return res.status(200).json({ status: 'ok', units });
  })
);

// POST /api/companies/:companyId/org-units
orgUnitRoutes.post(
  '/org-units',
  requireAuth,
  requirePermission(PERMISSIONS.ORG_UNITS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId } = req.params;
    if (!isUuid(companyId)) throw new ValidationError('Invalid company ID format');

    const actorId = req.user!.id;
    const unit = await defaultOrgUnitService.createUnit(companyId, req.body, actorId);
    return res.status(201).json({ status: 'ok', unit });
  })
);

// PATCH /api/companies/:companyId/org-units/:id
orgUnitRoutes.patch(
  '/org-units/:id',
  requireAuth,
  requirePermission(PERMISSIONS.ORG_UNITS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId, id } = req.params;
    if (!isUuid(companyId) || !isUuid(id)) throw new ValidationError('Invalid UUID format');

    const actorId = req.user!.id;
    const unit = await defaultOrgUnitService.updateUnit(companyId, id, req.body, actorId);
    return res.status(200).json({ status: 'ok', unit });
  })
);

// GET /api/companies/:companyId/org-scopes?userId=...
orgUnitRoutes.get(
  '/org-scopes',
  requireAuth,
  requirePermission(PERMISSIONS.ORG_UNITS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId } = req.params;
    const userId = (req.query.userId as string) || req.user!.id;

    if (!isUuid(companyId) || !isUuid(userId)) throw new ValidationError('Invalid UUID format');

    const scopes = await defaultOrgUnitService.listUserScopes(companyId, userId);
    return res.status(200).json({ status: 'ok', scopes });
  })
);

// PUT /api/companies/:companyId/org-scopes/:userId
orgUnitRoutes.put(
  '/org-scopes/:userId',
  requireAuth,
  requirePermission(PERMISSIONS.ORG_UNITS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId, userId } = req.params;
    if (!isUuid(companyId) || !isUuid(userId)) throw new ValidationError('Invalid UUID format');

    const actorId = req.user!.id;
    const scopes = await defaultOrgUnitService.setUserScopes(companyId, userId, req.body, actorId);
    return res.status(200).json({ status: 'ok', scopes });
  })
);
