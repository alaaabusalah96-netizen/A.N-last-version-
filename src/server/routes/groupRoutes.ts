import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { requirePlatformAdmin } from '../rbac/requirePlatformAdmin.js';
import { wrap } from '../http/asyncHandler.js';
import { defaultCompanyGroupService } from '../org/companyGroupService.js';

export const groupRoutes = Router();

const actorOf = (req: AuthenticatedRequest) => ({ id: req.user!.id, role: req.user!.role });
const ipOf = (req: AuthenticatedRequest) => req.ip || req.socket.remoteAddress;

// Group-level access is checked in the service (group membership), not by a company permission.

// GET /api/groups: groups the signed-in user belongs to (all groups for a platform admin)
groupRoutes.get(
  '/',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const groups = await defaultCompanyGroupService.listForActor(actorOf(req));
    return res.status(200).json({ status: 'ok', groups });
  })
);

// POST /api/groups: platform admin only
groupRoutes.post(
  '/',
  requireAuth,
  requirePlatformAdmin,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { code, nameAr, nameEn } = req.body || {};
    const group = await defaultCompanyGroupService.create(actorOf(req), { code, nameAr, nameEn }, ipOf(req));
    return res.status(201).json({ status: 'ok', group });
  })
);

// GET /api/groups/:groupId: members, companies and users (group members only)
groupRoutes.get(
  '/:groupId',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const group = await defaultCompanyGroupService.get(actorOf(req), req.params.groupId);
    return res.status(200).json({ status: 'ok', group });
  })
);

// PUT /api/groups/:groupId: rename (group admin) or activate/deactivate (platform admin)
groupRoutes.put(
  '/:groupId',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { nameAr, nameEn, isActive } = req.body || {};
    await defaultCompanyGroupService.update(actorOf(req), req.params.groupId, { nameAr, nameEn, isActive }, ipOf(req));
    return res.status(200).json({ status: 'ok' });
  })
);

// POST /api/groups/:groupId/companies: platform admin only
groupRoutes.post(
  '/:groupId/companies',
  requireAuth,
  requirePlatformAdmin,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    await defaultCompanyGroupService.addCompany(actorOf(req), req.params.groupId, String(req.body?.companyId || ''), ipOf(req));
    return res.status(201).json({ status: 'ok' });
  })
);

// DELETE /api/groups/:groupId/companies/:companyId: platform admin only
groupRoutes.delete(
  '/:groupId/companies/:companyId',
  requireAuth,
  requirePlatformAdmin,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    await defaultCompanyGroupService.removeCompany(actorOf(req), req.params.groupId, req.params.companyId, ipOf(req));
    return res.status(200).json({ status: 'ok' });
  })
);

// POST /api/groups/:groupId/users: add a group user by username (group admin or platform admin)
groupRoutes.post(
  '/:groupId/users',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { username, role } = req.body || {};
    await defaultCompanyGroupService.setUserByUsername(actorOf(req), req.params.groupId, String(username || ''), role, ipOf(req));
    return res.status(201).json({ status: 'ok' });
  })
);

// PUT /api/groups/:groupId/users/:userId: group admin or platform admin
groupRoutes.put(
  '/:groupId/users/:userId',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { role, isActive } = req.body || {};
    await defaultCompanyGroupService.setUser(actorOf(req), req.params.groupId, req.params.userId, role, isActive !== false, ipOf(req));
    return res.status(200).json({ status: 'ok' });
  })
);

// DELETE /api/groups/:groupId/users/:userId: group admin or platform admin
groupRoutes.delete(
  '/:groupId/users/:userId',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    await defaultCompanyGroupService.removeUser(actorOf(req), req.params.groupId, req.params.userId, ipOf(req));
    return res.status(200).json({ status: 'ok' });
  })
);
