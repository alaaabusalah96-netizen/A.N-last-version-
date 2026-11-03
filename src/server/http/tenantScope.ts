import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../auth/authMiddleware.js';
import { PermissionCode } from '../rbac/permissions.js';
import { defaultRbacService, RbacService } from '../rbac/rbacService.js';
import { tenantContextStorage } from '../db/tenantContext.js';
import { isUuid } from './validators.js';
import { ValidationError } from './errors.js';

/**
 * Middleware requiring active user access to a specific tenant company.
 * Reads companyId from req.params.companyId only.
 * Wraps the execution of downstream handlers inside tenantContextStorage.
 */
export function requireCompanyAccess(
  permission: PermissionCode,
  rbacService: RbacService = defaultRbacService
) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required before accessing tenant resources',
      });
      return;
    }

    const companyId = req.params.companyId;

    if (!companyId || !isUuid(companyId)) {
      throw new ValidationError('Invalid or missing company ID in path parameter');
    }

    const allowed = await rbacService.hasPermission(req.user, permission, companyId);
    if (!allowed) {
      res.status(403).json({
        error: 'Forbidden',
        message: `Missing required permission '${permission}' for the requested company`,
      });
      return;
    }

    (req as any).companyId = companyId;

    tenantContextStorage.run({ companyId, userId: req.user.id }, () => {
      next();
    });
  };
}
