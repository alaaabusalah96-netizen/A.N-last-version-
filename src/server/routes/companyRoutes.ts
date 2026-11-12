import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultMembershipStore } from '../org/membershipStore.js';
import { defaultCompanyService } from '../org/companyService.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { requirePlatformAdmin } from '../rbac/requirePlatformAdmin.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid, isValidCompanyCode } from '../http/validators.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../http/errors.js';
import { companySettingsRoutes } from './companySettingsRoutes.js';
import { orgUnitRoutes } from './orgUnitRoutes.js';
import { companyConfigRoutes } from './configRoutes.js';
import { companyRoleRoutes } from './roleRoutes.js';
import { customFieldRoutes } from './customFieldRoutes.js';

export const companyRoutes = Router();

// Nest settings, org-units, roles, custom-fields and configuration-platform routes
companyRoutes.use('/:companyId', companySettingsRoutes);
companyRoutes.use('/:companyId', orgUnitRoutes);
companyRoutes.use('/:companyId', companyConfigRoutes);
companyRoutes.use('/:companyId', companyRoleRoutes);
companyRoutes.use('/:companyId', customFieldRoutes);

// GET /api/companies — requireAuth + company:read
companyRoutes.get(
  '/',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    if (user.role === 'platform_admin') {
      const allCompanies = await defaultCompanyStore.list();
      return res.status(200).json({ status: 'ok', companies: allCompanies });
    }

    // Non-platform user: return only companies where they hold active membership
    const userMemberships = await defaultMembershipStore.listByUser(user.id);
    const companyIds = userMemberships.map((m) => m.companyId);
    const allCompanies = await defaultCompanyStore.list();
    const filtered = allCompanies.filter((c) => companyIds.includes(c.id));

    return res.status(200).json({ status: 'ok', companies: filtered });
  })
);

// POST /api/companies — requireAuth + platform_admin ONLY
companyRoutes.post(
  '/',
  requireAuth,
  requirePlatformAdmin,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { code, nameAr, nameEn } = req.body || {};

    if (!code || !isValidCompanyCode(code)) {
      throw new ValidationError('Company code is required (1-50 characters, alphanumeric, hyphen, or underscore)');
    }

    if (!nameAr || typeof nameAr !== 'string' || nameAr.trim().length < 1 || nameAr.trim().length > 255) {
      throw new ValidationError('Arabic name is required (1-255 characters)');
    }

    if (nameEn !== undefined && nameEn !== null && (typeof nameEn !== 'string' || nameEn.trim().length > 255)) {
      throw new ValidationError('English name must not exceed 255 characters');
    }

    const createdCompany = await defaultCompanyService.createCompanyWithAdmin(
      {
        code: code.trim(),
        nameAr: nameAr.trim(),
        nameEn: nameEn?.trim() || undefined,
        createdBy: user.id,
      },
      user.id,
      req.ip || req.socket.remoteAddress
    );

    return res.status(201).json({ status: 'ok', company: createdCompany });
  })
);

// GET /api/companies/:id — requireAuth + existence check -> permission check
companyRoutes.get(
  '/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Invalid company ID format');
    }

    const company = await defaultCompanyStore.getById(id);

    if (!company) {
      throw new NotFoundError('Company not found');
    }

    // Verify user has active membership and COMPANY_READ permission (replaces standalone hasMembership check)
    // Note: defaultRbacService.hasPermission internally validates active hasMembership and role permissions
    const user = req.user!;
    const allowed = await defaultRbacService.hasPermission(user, PERMISSIONS.COMPANY_READ, id);
    if (!allowed) {
      throw new ForbiddenError('Forbidden');
    }

    return res.status(200).json({ status: 'ok', company });
  })
);
