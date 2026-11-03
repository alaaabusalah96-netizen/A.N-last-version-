import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultMembershipStore } from '../org/membershipStore.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { requirePlatformAdmin } from '../rbac/requirePlatformAdmin.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid, isValidCompanyCode } from '../http/validators.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { defaultAuditService } from '../audit/auditService.js';
import { getDefaultExecutor } from '../db/index.js';

export const companyRoutes = Router();

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

    const executor = await getDefaultExecutor();
    if (!executor) {
      throw new Error('DB_UNAVAILABLE: Database executor required');
    }

    let createdCompany: any;

    await executor.withTransaction(async (tx) => {
      // 1. Create company
      createdCompany = await defaultCompanyStore.create({
        code: code.trim(),
        nameAr: nameAr.trim(),
        nameEn: nameEn?.trim() || undefined,
        createdBy: user.id,
      });

      // 2. Grant creator company_admin membership
      await defaultMembershipStore.addMember(user.id, createdCompany.id, 'company_admin', true);

      // 3. Audit log (Required inside same transaction)
      await defaultAuditService.record(
        {
          actorUserId: user.id,
          companyId: createdCompany.id,
          action: 'company.create',
          entityType: 'company',
          entityId: createdCompany.id,
          ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
          metadata: { code: createdCompany.code, nameAr: createdCompany.nameAr },
        },
        { mode: 'required', executor: tx }
      );
    });

    return res.status(201).json({ status: 'ok', company: createdCompany });
  })
);

// GET /api/companies/:id — requireAuth + membership or platform_admin
companyRoutes.get(
  '/:id',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Invalid company ID format');
    }

    const company = await defaultCompanyStore.getById(id);

    if (!company) {
      throw new NotFoundError('Company not found');
    }

    return res.status(200).json({ status: 'ok', company });
  })
);
