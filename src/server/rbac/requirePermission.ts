import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../auth/authMiddleware.js';
import { PermissionCode } from './permissions.js';
import { defaultRbacService, RbacService } from './rbacService.js';

/**
 * Middleware factory requiring a specific permission.
 * Validates against user role and optional company context (from params, query, or body).
 * Returns 403 Forbidden if not authorized.
 */
export function requirePermission(
  permission: PermissionCode,
  rbacService: RbacService = defaultRbacService
) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required before checking permissions',
      });
      return;
    }

    const companyId =
      req.params.companyId ||
      req.params.id ||
      (req.query.companyId as string) ||
      req.body?.companyId;

    const allowed = await rbacService.hasPermission(req.user, permission, companyId);
    if (!allowed) {
      res.status(403).json({
        error: 'Forbidden',
        message: `Missing required permission: '${permission}'`,
      });
      return;
    }

    next();
  };
}
