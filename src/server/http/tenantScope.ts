import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../auth/authMiddleware.js';
import { PermissionCode } from '../rbac/permissions.js';
import { defaultRbacService, RbacService } from '../rbac/rbacService.js';
import { tenantContextStorage } from '../db/tenantContext.js';
import { isUuid } from './validators.js';
import { ValidationError, UnauthorizedError, ForbiddenError } from './errors.js';
import { wrap } from './asyncHandler.js';

/**
 * Middleware requiring active user access to a specific tenant company.
 * Reads companyId from req.params.companyId only.
 * Wraps the execution of downstream handlers inside tenantContextStorage.
 */
export function requireCompanyAccess(
  permission: PermissionCode,
  rbacService: RbacService = defaultRbacService
) {
  return wrap(async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required before accessing tenant resources');
    }

    const companyId = req.params.companyId;

    if (!companyId || !isUuid(companyId)) {
      throw new ValidationError('Invalid or missing company ID in path parameter');
    }

    const allowed = await rbacService.hasPermission(req.user, permission, companyId);
    if (!allowed) {
      throw new ForbiddenError(`Missing required permission '${permission}' for the requested company`);
    }

    (req as any).companyId = companyId;

    tenantContextStorage.run({ companyId, userId: req.user.id }, () => {
      next();
    });
  });
}
