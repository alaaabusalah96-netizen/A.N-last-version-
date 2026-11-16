import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { defaultCompanyStore } from '../org/companyStore.js';
import { defaultBankAccountService } from '../banking/bankAccountService.js';
import { defaultBankReconcileService } from '../banking/bankReconcileService.js';
import { wrap } from '../http/asyncHandler.js';
import { isUuid } from '../http/validators.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../http/errors.js';

export const bankingRoutes = Router();

async function assertBankingPermission(
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

// ============================================================================
// Bank Accounts (الحسابات البنكية)
// ============================================================================

bankingRoutes.get(
  '/accounts',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = (req.query.companyId as string) || '';
    await assertBankingPermission(user, PERMISSIONS.BANKING_READ, companyId);
    const accounts = await defaultBankAccountService.listAccounts(companyId);
    res.json({ status: 'ok', accounts });
  })
);

bankingRoutes.post(
  '/accounts',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertBankingPermission(user, PERMISSIONS.BANKING_WRITE, companyId);
    const account = await defaultBankAccountService.createAccount(companyId, req.body || {}, user.id);
    res.status(201).json({ status: 'ok', account });
  })
);

bankingRoutes.get(
  '/accounts/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف الحساب البنكي غير صالح');
    }
    const companyId = (req.query.companyId as string) || '';
    await assertBankingPermission(user, PERMISSIONS.BANKING_READ, companyId);
    const account = await defaultBankAccountService.getAccount(companyId, id);
    res.json({ status: 'ok', account });
  })
);

bankingRoutes.patch(
  '/accounts/:id',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف الحساب البنكي غير صالح');
    }
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertBankingPermission(user, PERMISSIONS.BANKING_WRITE, companyId);
    const account = await defaultBankAccountService.updateAccount(companyId, id, req.body || {}, user.id);
    res.json({ status: 'ok', account });
  })
);

// ============================================================================
// Simplified Bank Reconciliation (التسوية البنكية المبسطة: كشف مقابل حركات)
// ============================================================================

bankingRoutes.get(
  '/accounts/:id/reconciliation',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف الحساب البنكي غير صالح');
    }
    const companyId = (req.query.companyId as string) || '';
    await assertBankingPermission(user, PERMISSIONS.BANKING_READ, companyId);
    const asOfDate = typeof req.query.asOfDate === 'string' && req.query.asOfDate ? req.query.asOfDate : undefined;
    const workspace = await defaultBankReconcileService.getWorkspace(companyId, id, asOfDate);
    res.json({ status: 'ok', workspace });
  })
);

bankingRoutes.post(
  '/accounts/:id/statement-lines',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف الحساب البنكي غير صالح');
    }
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertBankingPermission(user, PERMISSIONS.BANKING_WRITE, companyId);
    const lines = Array.isArray(req.body?.lines)
      ? req.body.lines
      : req.body?.statementDate
      ? [req.body]
      : [];
    const created = await defaultBankReconcileService.addStatementLines(companyId, id, lines, user.id);
    res.status(201).json({ status: 'ok', lines: created });
  })
);

bankingRoutes.post(
  '/accounts/:id/statement-lines/:lineId/match',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id, lineId } = req.params;
    if (!id || !isUuid(id) || !lineId || !isUuid(lineId)) {
      throw new ValidationError('المعرفات المرسلة غير صالحة');
    }
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertBankingPermission(user, PERMISSIONS.BANKING_RECONCILE, companyId);
    const line = await defaultBankReconcileService.matchStatementLine(
      companyId,
      id,
      lineId,
      req.body?.journalLineId,
      user.id
    );
    res.json({ status: 'ok', line });
  })
);

bankingRoutes.post(
  '/accounts/:id/statement-lines/:lineId/unmatch',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id, lineId } = req.params;
    if (!id || !isUuid(id) || !lineId || !isUuid(lineId)) {
      throw new ValidationError('المعرفات المرسلة غير صالحة');
    }
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertBankingPermission(user, PERMISSIONS.BANKING_RECONCILE, companyId);
    const line = await defaultBankReconcileService.unmatchStatementLine(companyId, id, lineId, user.id);
    res.json({ status: 'ok', line });
  })
);

bankingRoutes.post(
  '/accounts/:id/reconciliations/complete',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const { id } = req.params;
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف الحساب البنكي غير صالح');
    }
    const companyId = req.body?.companyId || (req.query.companyId as string) || '';
    await assertBankingPermission(user, PERMISSIONS.BANKING_RECONCILE, companyId);
    const reconciliation = await defaultBankReconcileService.completeReconciliation(
      companyId,
      id,
      req.body || {},
      user.id
    );
    res.status(201).json({ status: 'ok', reconciliation });
  })
);
