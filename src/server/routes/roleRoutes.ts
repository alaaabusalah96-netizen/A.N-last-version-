import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { wrap } from '../http/asyncHandler.js';
import { ValidationError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { PERMISSION_CATALOG, PERMISSIONS } from '../rbac/permissions.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { defaultRoleService } from '../rbac/roleService.js';

function assertUuidParam(val: string | undefined, label: string): string {
  if (!val || !isUuid(val)) {
    throw new ValidationError(`Invalid ${label} format`);
  }
  return val;
}

// ---- Company-scoped role management routes (mounted under /api/companies/:companyId) ----
export const companyRoleRoutes = Router({ mergeParams: true });

// GET /api/companies/:companyId/roles
companyRoleRoutes.get(
  '/roles',
  requireAuth,
  requirePermission(PERMISSIONS.ROLES_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertUuidParam(req.params.companyId, 'company ID');
    const roles = await defaultRoleService.listRoles(companyId);
    return res.status(200).json({ status: 'ok', roles });
  })
);

// POST /api/companies/:companyId/roles
companyRoleRoutes.post(
  '/roles',
  requireAuth,
  requirePermission(PERMISSIONS.ROLES_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertUuidParam(req.params.companyId, 'company ID');
    const role = await defaultRoleService.createRole(companyId, req.body, req.user!.id);
    return res.status(201).json({ status: 'ok', role });
  })
);

// PATCH /api/companies/:companyId/roles/:roleId
companyRoleRoutes.patch(
  '/roles/:roleId',
  requireAuth,
  requirePermission(PERMISSIONS.ROLES_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertUuidParam(req.params.companyId, 'company ID');
    const roleId = assertUuidParam(req.params.roleId, 'role ID');
    const role = await defaultRoleService.updateRole(companyId, roleId, req.body, req.user!.id);
    return res.status(200).json({ status: 'ok', role });
  })
);

// PUT /api/companies/:companyId/roles/:roleId/permissions
companyRoleRoutes.put(
  '/roles/:roleId/permissions',
  requireAuth,
  requirePermission(PERMISSIONS.ROLES_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertUuidParam(req.params.companyId, 'company ID');
    const roleId = assertUuidParam(req.params.roleId, 'role ID');
    const codes = req.body && Array.isArray(req.body.permissions) ? req.body.permissions : req.body;
    const permissions = await defaultRoleService.setPermissions(
      companyId,
      roleId,
      codes,
      req.user!.id,
      req.user!.role
    );
    return res.status(200).json({ status: 'ok', permissions });
  })
);

// POST /api/companies/:companyId/roles/:roleId/active
companyRoleRoutes.post(
  '/roles/:roleId/active',
  requireAuth,
  requirePermission(PERMISSIONS.ROLES_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = assertUuidParam(req.params.companyId, 'company ID');
    const roleId = assertUuidParam(req.params.roleId, 'role ID');
    const isActive = req.body?.isActive;
    const role = await defaultRoleService.setActive(companyId, roleId, isActive, req.user!.id);
    return res.status(200).json({ status: 'ok', role });
  })
);

// ---- Global RBAC permissions catalog (mounted under /api/rbac) ----
export const rbacRoutes = Router();

// GET /api/rbac/permissions
rbacRoutes.get(
  '/permissions',
  requireAuth,
  requirePermission(PERMISSIONS.ROLES_READ),
  wrap(async (_req: AuthenticatedRequest, res: Response) => {
    return res.status(200).json({ status: 'ok', permissions: PERMISSION_CATALOG });
  })
);
