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

// ==========================================
// Journal Entries Endpoints (Ledger Guarantees)
// ==========================================

// GET /api/accounting/journals?companyId=...
accountingRoutes.get(
  '/journals',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId);

    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const { defaultJournalService } = await import('../accounting/journalService.js');
    const journals = await defaultJournalService.listEntries(companyId, limit, offset);
    return res.status(200).json({ status: 'ok', journals });
  })
);

// GET /api/accounting/journals/:id?companyId=...
accountingRoutes.get(
  '/journals/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    const companyId = (req.query.companyId as string) || '';

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_READ, companyId);

    const { defaultJournalService } = await import('../accounting/journalService.js');
    const journal = await defaultJournalService.getEntry(companyId, id);
    if (!journal) {
      throw new NotFoundError('Journal entry not found');
    }
    return res.status(200).json({ status: 'ok', journal });
  })
);

// POST /api/accounting/journals — Create draft journal entry
accountingRoutes.post(
  '/journals',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { companyId, entryDate, memo, lines } = req.body || {};

    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_WRITE, companyId);

    const { defaultJournalService } = await import('../accounting/journalService.js');
    const journal = await defaultJournalService.createDraftEntry(
      companyId,
      { entryDate, memo, lines },
      user.id
    );
    return res.status(201).json({ status: 'ok', journal });
  })
);

// POST /api/accounting/journals/:id/post — Post balanced journal entry
accountingRoutes.post(
  '/journals/:id/post',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    const { companyId } = req.body || {};

    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_POST, companyId);

    const { defaultJournalService } = await import('../accounting/journalService.js');
    const journal = await defaultJournalService.postEntry(companyId, id, user.id);
    return res.status(200).json({ status: 'ok', journal });
  })
);

// POST /api/accounting/journals/:id/reverse — Reverse posted journal entry
accountingRoutes.post(
  '/journals/:id/reverse',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    const { companyId, reversalMemo } = req.body || {};

    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    await assertPermissionForCompanyQueryOrBody(user, PERMISSIONS.ACCOUNTING_JOURNALS_POST, companyId);

    const { defaultJournalService } = await import('../accounting/journalService.js');
    const reversal = await defaultJournalService.reverseEntry(companyId, id, user.id, reversalMemo);
    return res.status(200).json({ status: 'ok', reversal });
  })
);
