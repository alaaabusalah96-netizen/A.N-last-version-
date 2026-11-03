import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../auth/authMiddleware.js';
import { wrap } from '../http/asyncHandler.js';

/**
 * Middleware requiring the user to hold the 'platform_admin' role.
 * Restricts platform-wide tenant management actions (like creating new companies).
 */
export const requirePlatformAdmin = wrap(async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication session required',
    });
    return;
  }

  if (req.user.role !== 'platform_admin') {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Platform administrator role required to perform this action',
    });
    return;
  }

  next();
});
