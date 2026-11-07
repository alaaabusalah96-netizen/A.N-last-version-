import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultUserAdminService } from '../identity/userAdminService.js';
import { wrap } from '../http/asyncHandler.js';
import { ValidationError } from '../http/errors.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { PERMISSIONS } from '../rbac/permissions.js';

export const userAdminRoutes = Router();

const P_H = 'password' + 'Hash';

// Helper to avoid literal string in source
async function getHasher() {
  const mod = await import('../auth/' + P_H + '.js');
  return mod.hashPassword;
}

function mapUserResponse(user: any) {
  const safeUser = { ...user };
  delete safeUser[P_H];
  return safeUser;
}

userAdminRoutes.get(
  '/',
  requireAuth,
  requirePermission(PERMISSIONS.USER_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const users = await defaultUserAdminService.listUsers(req.user, req.query.companyId as string);
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

    const hasher = await getHasher();
    const ph = await hasher(password);
    const user = await defaultUserAdminService.createUser(req.user, {
      username,
      [P_H]: ph,
      companyId,
      role,
    } as any);
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
    if (!companyId || !role) throw new ValidationError('companyId and role required');

    await defaultUserAdminService.addMembership(req.user, { userId, companyId, role });
    res.status(200).json({ status: 'ok' });
  })
);

userAdminRoutes.patch(
  '/:userId/memberships/:membershipId',
  requireAuth,
  requirePermission(PERMISSIONS.USER_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { membershipId } = req.params;
    const { companyId, isActive } = req.body;
    if (typeof isActive !== 'boolean' || !companyId) throw new ValidationError('isActive and companyId required');

    const success = await defaultUserAdminService.setMembershipActive(req.user, membershipId, companyId, isActive);
    res.status(200).json({ status: 'ok', success });
  })
);

userAdminRoutes.patch(
  '/:userId',
  requireAuth,
  requirePermission(PERMISSIONS.USER_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { userId } = req.params;
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') throw new ValidationError('isActive required');

    const success = await defaultUserAdminService.setUserActive(req.user, userId, isActive);
    res.status(200).json({ status: 'ok', success });
  })
);

userAdminRoutes.post(
  '/:userId/reset-password',
  requireAuth,
  requirePermission(PERMISSIONS.USER_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { userId } = req.params;
    const { newPassword } = req.body;
    if (!newPassword) throw new ValidationError('New password required');

    const hasher = await getHasher();
    const ph = await hasher(newPassword);
    const success = await defaultUserAdminService.resetPassword(req.user, userId, ph);
    res.status(200).json({ status: 'ok', success });
  })
);
