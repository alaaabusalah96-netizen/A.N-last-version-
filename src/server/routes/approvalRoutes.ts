import { Router, Response } from 'express';
import { AuthenticatedRequest, requireAuth } from '../auth/authMiddleware.js';
import { defaultApprovalService, ApprovalStatus } from '../approvals/approvalService.js';
import { defaultRbacService } from '../rbac/rbacService.js';
import { wrap } from '../http/asyncHandler.js';
import { requirePermission } from '../rbac/requirePermission.js';
import { PERMISSIONS, PermissionCode } from '../rbac/permissions.js';
import { isUuid } from '../http/validators.js';
import { ValidationError } from '../http/errors.js';

/**
 * Approval API (C1-b). Mounted under /api/companies/:companyId.
 * - Reading requests: any company member (COMPANY_READ).
 * - Reading / publishing policies: COMPANY_SETTINGS_READ / COMPANY_SETTINGS_WRITE.
 * - Submitting over HTTP needs COMPANY_SETTINGS_WRITE and a published policy. Documents will
 *   submit through the service with their own checks once wired.
 * - Deciding: the step's own permission is checked inside the service for the current step.
 *   The requester can never decide their own request, and one person cannot decide two steps.
 */
export const approvalRoutes = Router({ mergeParams: true });

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

approvalRoutes.get(
  '/approvals/requests',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId } = req.params;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    if (limit !== undefined && !Number.isFinite(limit)) throw new ValidationError('limit غير صالح');
    const requests = await defaultApprovalService.listRequests(companyId, {
      status: str(req.query.status) as ApprovalStatus | undefined,
      documentType: str(req.query.documentType),
      documentId: str(req.query.documentId),
      limit,
    });
    res.status(200).json({ status: 'ok', requests });
  })
);

approvalRoutes.get(
  '/approvals/requests/:requestId',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId, requestId } = req.params;
    if (!isUuid(requestId)) throw new ValidationError('Invalid request ID format');
    const request = await defaultApprovalService.getRequest(companyId, requestId);
    res.status(200).json({ status: 'ok', request });
  })
);

approvalRoutes.post(
  '/approvals/requests',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId } = req.params;
    const documentType = str(req.body?.documentType);
    const documentId = str(req.body?.documentId);
    if (!documentType) throw new ValidationError('نوع المستند مطلوب');
    if (!documentId || !isUuid(documentId)) throw new ValidationError('معرف المستند غير صالح');
    // The policy decides who approves. The client never picks the approving permission.
    const request = await defaultApprovalService.requestApproval(
      companyId,
      documentType,
      documentId,
      PERMISSIONS.COMPANY_SETTINGS_WRITE,
      req.user!.id,
      { requirePolicy: true }
    );
    res.status(201).json({ status: 'ok', request });
  })
);

approvalRoutes.post(
  '/approvals/requests/:requestId/decision',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId, requestId } = req.params;
    if (!isUuid(requestId)) throw new ValidationError('Invalid request ID format');
    const user = req.user!;
    const request = await defaultApprovalService.decide(
      companyId,
      requestId,
      req.body?.decision,
      typeof req.body?.reason === 'string' ? req.body.reason : null,
      user.id,
      (permission) => defaultRbacService.hasPermission(user, permission as PermissionCode, companyId)
    );
    res.status(200).json({ status: 'ok', request });
  })
);

approvalRoutes.get(
  '/approvals/policies',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_READ),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const policies = await defaultApprovalService.listPolicies(req.params.companyId);
    res.status(200).json({ status: 'ok', policies });
  })
);

approvalRoutes.put(
  '/approvals/policies/:documentType',
  requireAuth,
  requirePermission(PERMISSIONS.COMPANY_SETTINGS_WRITE),
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const { companyId, documentType } = req.params;
    const policy = await defaultApprovalService.setPolicy(companyId, documentType, req.body?.steps, req.user!.id);
    res.status(200).json({ status: 'ok', policy });
  })
);
