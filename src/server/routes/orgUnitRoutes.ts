import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultOrgUnitService } from '../org/orgUnitService.js';
import { wrap } from '../http/asyncHandler.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { isUuid } from '../http/validators.js';
import { ValidationError } from '../http/errors.js';
import { UserOrgScope } from '../org/orgUnitTypes.js';

function mapScopeResponse(sc: UserOrgScope) {
  return {
    orgUnitId: sc.orgUnitId,
    code: sc.code ?? sc.orgUnitCode ?? '',
    nameAr: sc.nameAr ?? sc.orgUnitNameAr ?? '',
    unitType: sc.unitType ?? null,
    path: sc.path ?? '',
    includeDescendants: sc.includeDescendants,
    accessLevel: sc.accessLevel,
    roleId: sc.roleId ?? null,
    roleCode: sc.roleCode ?? null,
    validFrom: sc.validFrom ?? null,
    validUntil: sc.validUntil ?? null,
    delegatedBy: sc.delegatedBy ?? null,
    reason: sc.reason ?? null,
    // Preserve legacy field aliases for existing consumers
    companyId: sc.companyId,
    userId: sc.userId,
    orgUnitCode: sc.orgUnitCode ?? sc.code ?? '',
    orgUnitNameAr: sc.orgUnitNameAr ?? sc.nameAr ?? '',
    createdAt: sc.createdAt,
  };
}

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

// GET /api/companies/:companyId/org-units/:unitId/members
orgUnitRoutes.get(
  '/org-units/:unitId/members',
  requireAuth,
  requirePermission(PERMISSIONS.ORG_UNITS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId, unitId } = req.params;
    if (!isUuid(companyId) || !isUuid(unitId)) throw new ValidationError('Invalid UUID format');

    const members = await defaultOrgUnitService.listUnitMembers(companyId, unitId);
    return res.status(200).json({ status: 'ok', members });
  })
);

// GET /api/companies/:companyId/me/scopes
orgUnitRoutes.get(
  '/me/scopes',
  requireAuth,
  requirePermission(PERMISSIONS.ORG_UNITS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId } = req.params;
    if (!isUuid(companyId)) throw new ValidationError('Invalid company ID format');

    const userId = req.user!.id;
    const [allScopes, effectiveScopes] = await Promise.all([
      defaultOrgUnitService.listUserScopes(companyId, userId),
      defaultOrgUnitService.getEffectiveScopes(companyId, userId),
    ]);

    return res.status(200).json({
      status: 'ok',
      isCompanyWide: req.user!.role === 'platform_admin' || allScopes.length === 0,
      hasConfiguredScopes: allScopes.length > 0,
      scopes: effectiveScopes.map(mapScopeResponse),
    });
  })
);

// GET /api/companies/:companyId/users/:userId/scopes
orgUnitRoutes.get(
  '/users/:userId/scopes',
  requireAuth,
  requirePermission(PERMISSIONS.ORG_UNITS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId, userId } = req.params;
    if (!isUuid(companyId) || !isUuid(userId)) throw new ValidationError('Invalid UUID format');

    const [scopes, effectiveScopes] = await Promise.all([
      defaultOrgUnitService.listUserScopes(companyId, userId),
      defaultOrgUnitService.getEffectiveScopes(companyId, userId),
    ]);

    return res.status(200).json({
      status: 'ok',
      isCompanyWide: scopes.length === 0,
      scopes: scopes.map(mapScopeResponse),
      effectiveScopes: effectiveScopes.map(mapScopeResponse),
    });
  })
);

// PUT /api/companies/:companyId/users/:userId/scopes
orgUnitRoutes.put(
  '/users/:userId/scopes',
  requireAuth,
  requirePermission(PERMISSIONS.ORG_UNITS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId, userId } = req.params;
    if (!isUuid(companyId) || !isUuid(userId)) throw new ValidationError('Invalid UUID format');

    const scopes = await defaultOrgUnitService.setUserScopes(
      companyId,
      userId,
      req.body,
      req.user!.id,
      req.user!.role
    );
    return res.status(200).json({
      status: 'ok',
      isCompanyWide: scopes.length === 0,
      scopes: scopes.map(mapScopeResponse),
    });
  })
);

// Legacy compatibility: GET /api/companies/:companyId/org-scopes?userId=...
orgUnitRoutes.get(
  '/org-scopes',
  requireAuth,
  requirePermission(PERMISSIONS.ORG_UNITS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId } = req.params;
    const userId = (req.query.userId as string) || req.user!.id;

    if (!isUuid(companyId) || !isUuid(userId)) throw new ValidationError('Invalid UUID format');

    const scopes = await defaultOrgUnitService.listUserScopes(companyId, userId);
    return res.status(200).json({ status: 'ok', scopes: scopes.map(mapScopeResponse) });
  })
);

// Legacy compatibility: PUT /api/companies/:companyId/org-scopes/:userId
orgUnitRoutes.put(
  '/org-scopes/:userId',
  requireAuth,
  requirePermission(PERMISSIONS.ORG_UNITS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId, userId } = req.params;
    if (!isUuid(companyId) || !isUuid(userId)) throw new ValidationError('Invalid UUID format');

    const actorId = req.user!.id;
    const scopes = await defaultOrgUnitService.setUserScopes(
      companyId,
      userId,
      req.body,
      actorId,
      req.user!.role
    );
    return res.status(200).json({ status: 'ok', scopes: scopes.map(mapScopeResponse) });
  })
);
