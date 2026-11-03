import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultMembershipStore } from '../org/membershipStore.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { requirePlatformAdmin } from '../rbac/requirePlatformAdmin.js';

export const companyRoutes = Router();

// GET /api/companies — requireAuth + company:read (platform_admin sees all; others see their memberships)
companyRoutes.get(
  '/',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_READ),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to retrieve companies';
      return res.status(500).json({ error: 'Internal Error', message });
    }
  }
);

// POST /api/companies — requireAuth + platform_admin ONLY (Strict platform governance)
companyRoutes.post(
  '/',
  requireAuth,
  requirePlatformAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user!;
      const { code, nameAr, nameEn } = req.body || {};

      if (!code || !nameAr) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Both code and nameAr are required to create a company',
        });
      }

      const company = await defaultCompanyStore.create({
        code,
        nameAr,
        nameEn,
        createdBy: user.id,
      });

      // Automatically grant the creator company_admin membership in the newly created company
      await defaultMembershipStore.addMember(user.id, company.id, 'company_admin', true);

      return res.status(201).json({ status: 'ok', company });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create company';
      return res.status(400).json({ error: 'Bad Request', message });
    }
  }
);

// GET /api/companies/:id — requireAuth + membership or platform_admin
companyRoutes.get(
  '/:id',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_READ),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const company = await defaultCompanyStore.getById(id);

      if (!company) {
        return res.status(404).json({ error: 'Not Found', message: 'Company not found' });
      }

      return res.status(200).json({ status: 'ok', company });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to retrieve company';
      return res.status(500).json({ error: 'Internal Error', message });
    }
  }
);
