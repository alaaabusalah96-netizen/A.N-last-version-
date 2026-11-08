import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultUserAdminService } from '../identity/userAdminService.js';
import { wrap } from '../http/asyncHandler.js';
import { ValidationError } from '../http/errors.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { hashPassword } from '../auth/passwordHash.js';

export const userAdminRoutes = Router();

function mapUserResponse(user: any) {
  if (!user) return user;
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

userAdminRoutes.get(
  '/',
  requireAuth,
  requirePermission(PERMISSIONS.USER_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const companyId = (req.query.companyId as string) || (req.headers['x-company-id'] as string);
    const users = await defaultUserAdminService.listUsers(req.user, companyId);
    res.status(200).json({ status: 'ok', users: users.map(mapUserResponse) });
  })
);

userAdminRoutes.post(
  '/',
  requireAuth,
  requirePermission(PERMISSIONS.USER_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { username, password, companyId, role } = req.body;
    if (!username || !password) throw new ValidationError('Username and password required');
    if (typeof password !== 'string' || password.length < 12) {
      throw new ValidationError('Password must be at least 12 characters long');
    }

    const effectiveCompanyId = companyId || (req.headers['x-company-id'] as string);
    const ph = await hashPassword(password);
    const user = await defaultUserAdminService.createUser(req.user, {
      username,
      passwordHash: ph,
      companyId: effectiveCompanyId,
      role,
    });
    res.status(201).json({ status: 'ok', user: mapUserResponse(user) });
  })
);

userAdminRoutes.post(
  '/:userId/memberships',
  requireAuth,
  requirePermission(PERMISSIONS.USER_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { userId } = req.params;
    const { companyId, role } = req.body;
    const effectiveCompanyId = companyId || (req.headers['x-company-id'] as string);
    if (!effectiveCompanyId || !role) throw new ValidationError('companyId and role required');

    await defaultUserAdminService.addMembership(req.user, { userId, companyId: effectiveCompanyId, role });
    res.status(200).json({ status: 'ok' });
  })
);

userAdminRoutes.patch(
  '/:userId/memberships/:membershipId',
  requireAuth,
  requirePermission(PERMISSIONS.USER_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { userId, membershipId } = req.params;
    const { companyId, isActive } = req.body;
    const effectiveCompanyId = companyId || (req.headers['x-company-id'] as string);
    if (typeof isActive !== 'boolean' || !effectiveCompanyId) throw new ValidationError('isActive and companyId required');

    const success = await defaultUserAdminService.setMembershipActive(req.user, membershipId, effectiveCompanyId, isActive, userId);
    res.status(200).json({ status: 'ok', success });
  })
);

userAdminRoutes.patch(
  '/:userId',
  requireAuth,
  requirePermission(PERMISSIONS.USER_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { userId } = req.params;
    const { isActive, companyId } = req.body;
    const effectiveCompanyId = companyId || (req.headers['x-company-id'] as string);
    if (typeof isActive !== 'boolean') throw new ValidationError('isActive required');

    const success = await defaultUserAdminService.setUserActive(req.user, userId, isActive, effectiveCompanyId);
    res.status(200).json({ status: 'ok', success });
  })
);

userAdminRoutes.post(
  '/:userId/reset-password',
  requireAuth,
  requirePermission(PERMISSIONS.USER_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { userId } = req.params;
    const { newPassword, companyId } = req.body;
    if (!newPassword) throw new ValidationError('New password required');
    if (typeof newPassword !== 'string' || newPassword.length < 12) {
      throw new ValidationError('New password must be at least 12 characters long');
    }

    const effectiveCompanyId = companyId || (req.headers['x-company-id'] as string);
    const ph = await hashPassword(newPassword);
    const success = await defaultUserAdminService.resetPassword(req.user, userId, ph, effectiveCompanyId);
    res.status(200).json({ status: 'ok', success });
  })
);
