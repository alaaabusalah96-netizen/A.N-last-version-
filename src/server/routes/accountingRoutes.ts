import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultAccountService } from '../accounting/accountService.js';
import { defaultMembershipStore } from '../org/membershipStore.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';

export const accountingRoutes = Router();

async function assertCompanyAccess(userId: string, userRole: string, companyId: string): Promise<void> {
  if (!isUuid(companyId)) {
    throw new ValidationError('Invalid company ID format');
  }

  const company = await defaultCompanyStore.getById(companyId);
  if (!company) {
    throw new NotFoundError('Company not found');
  }

  if (userRole === 'platform_admin') {
    return;
  }

  const membership = await defaultMembershipStore.getMembership(userId, companyId);
  if (!membership || !membership.isActive) {
    throw new ForbiddenError('Access denied: You do not hold an active membership for this company');
  }
}

// GET /api/accounting/accounts?companyId=...
accountingRoutes.get(
  '/accounts',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    if (!companyId) {
      throw new ValidationError('Query parameter companyId is required');
    }

    await assertCompanyAccess(user.id, user.role, companyId);

    const accounts = await defaultAccountService.listAccounts(companyId);
    return res.status(200).json({ status: 'ok', accounts });
  })
);

// POST /api/accounting/accounts — Create account
accountingRoutes.post(
  '/accounts',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { companyId, code, nameAr, nameEn, accountType, parentId, isPostable } = req.body || {};

    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    await assertCompanyAccess(user.id, user.role, companyId);

    const account = await defaultAccountService.createAccount(
      companyId,
      { code, nameAr, nameEn, accountType, parentId, isPostable },
      user.id
    );

    return res.status(201).json({ status: 'ok', account });
  })
);

// POST /api/accounting/accounts/seed-default — Seed standard COA
accountingRoutes.post(
  '/accounts/seed-default',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { companyId } = req.body || {};

    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    await assertCompanyAccess(user.id, user.role, companyId);

    const result = await defaultAccountService.seedDefaultCoa(companyId);
    return res.status(200).json({
      status: 'ok',
      createdCount: result.createdCount,
      accounts: result.accounts,
    });
  })
);
