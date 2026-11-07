import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultAccountService } from '../accounting/accountService.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';

export const accountingRoutes = Router();

async function assertPermissionForCompanyQueryOrBody(
  user: AuthenticatedRequest['user'],
  permission: string,
  companyId: string
): Promise<void> {
  if (!companyId || !isUuid(companyId)) {
    throw new ValidationError('Invalid or missing company ID format');
  }

  const company = await defaultCompanyStore.getById(companyId);
  if (!company) {
    throw new NotFoundError('Company not found');
  }

  const allowed = await defaultRbacService.hasPermission(user!, permission, companyId);
  if (!allowed) {
    throw new ForbiddenError(`Access denied: Missing required permission '${permission}' for this company`);
  }
}

// GET /api/accounting/accounts?companyId=...
accountingRoutes.get(
  '/accounts',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_ACCOUNTS_READ, companyId);

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

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_ACCOUNTS_CREATE, companyId);

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

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_ACCOUNTS_SEED, companyId);

    const result = await defaultAccountService.seedDefaultCoa(companyId);
    return res.status(200).json({
      status: 'ok',
      createdCount: result.createdCount,
      accounts: result.accounts,
    });
  })
);
