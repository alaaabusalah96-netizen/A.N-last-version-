import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { PERMISSIONS } from '../rbac/permissions.js';

/**
 * Generic approval engine (C1-a).
 * - A policy lists ordered steps; each step names the permission the approver must hold.
 * - With no policy for a document type, the caller's default permission is a single step
 *   (today's behaviour: one permission gate).
 * - Separation of duties: the requester never approves; one person never approves two steps of one request.
 * - Requests and decisions are append-only. Status is derived, never stored.
 */

export interface ApprovalStep {
  stepNo: number;
  permission: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalDecisionView {
  stepNo: number;
  decision: 'approve' | 'reject';
  decidedBy: string;
  reason: string | null;
  createdAt: string;
}

export interface ApprovalRequestView {
  id: string;
  companyId: string;
  documentType: string;
  documentId: string;
  policyId: string | null;
  steps: ApprovalStep[];
  requestedBy: string;
  status: ApprovalStatus;
  nextStep: ApprovalStep | null;
  decisions: ApprovalDecisionView[];
}

export type PermissionChecker = (permission: string) => Promise<boolean>;

const VALID_PERMISSIONS = new Set<string>(Object.values(PERMISSIONS));

/** Pure: derive the status and the next step from the steps and decisions. */
export function deriveApprovalState(
  steps: ApprovalStep[],
  decisions: Array<{ stepNo: number; decision: 'approve' | 'reject' }>
): { status: ApprovalStatus; nextStep: ApprovalStep | null } {
  if (decisions.some((d) => d.decision === 'reject')) return { status: 'rejected', nextStep: null };
  const approved = new Set(decisions.filter((d) => d.decision === 'approve').map((d) => d.stepNo));
  const next = steps.find((s) => !approved.has(s.stepNo)) || null;
  return next ? { status: 'pending', nextStep: next } : { status: 'approved', nextStep: null };
}

function normalizeSteps(input: unknown): ApprovalStep[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 10) {
    throw new ValidationError('يجب أن تحتوي السياسة على خطوة واحدة إلى عشر خطوات');
  }
  return input.map((s, i) => {
    const permission = typeof s === 'string' ? s : (s as { permission?: unknown })?.permission;
    if (typeof permission !== 'string' || !VALID_PERMISSIONS.has(permission)) {
      throw new ValidationError(`الخطوة رقم ${i + 1}: صلاحية غير معروفة`);
    }
    return { stepNo: i + 1, permission };
  });
}

export class ApprovalService {
  constructor(private readonly auditService: AuditService = defaultAuditService) {}

  /** Publish a new policy version for a document type. Old versions stay. */
  async setPolicy(
    companyId: string,
    documentType: string,
    steps: unknown,
    actorId: string
  ): Promise<{ id: string; version: number; steps: ApprovalStep[] }> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    const docType = (documentType || '').trim();
    if (!docType || docType.length > 80) throw new ValidationError('نوع المستند مطلوب');
    const normalized = normalizeSteps(steps);
    return await withTenantTransaction(companyId, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`approval_policy:${companyId}:${docType}`]);
      const cur = await tx.query<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0)::int AS v FROM approval_policies WHERE company_id = $1 AND document_type = $2`,
        [companyId, docType]
      );
      const version = cur.rows[0].v + 1;
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO approval_policies (company_id, document_type, version, steps, created_by)
         VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id`,
        [companyId, docType, version, JSON.stringify(normalized), actorId]
      );
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'APPROVAL_POLICY_SET',
          entityType: 'approval_policies',
          entityId: ins.rows[0].id,
          metadata: { documentType: docType, version, steps: normalized },
        },
        { executor: tx }
      );
      return { id: ins.rows[0].id, version, steps: normalized };
    });
  }

  /**
   * Start an approval for a document. Uses the latest policy; with none, a single step
   * requiring defaultPermission. Only one open request per document.
   */
  async requestApproval(
    companyId: string,
    documentType: string,
    documentId: string,
    defaultPermission: string,
    actorId: string,
    options: { requirePolicy?: boolean } = {}
  ): Promise<ApprovalRequestView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (!documentType || !documentType.trim()) throw new ValidationError('نوع المستند مطلوب');
    if (!documentId || !isUuid(documentId)) throw new ValidationError('معرف المستند غير صالح');
    if (!VALID_PERMISSIONS.has(defaultPermission)) throw new ValidationError('الصلاحية الافتراضية غير معروفة');
    return await withTenantTransaction(companyId, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`approval_req:${companyId}:${documentType}:${documentId}`]);
      const open = await this.findRequestsForDocument(companyId, documentType, documentId, tx);
      if (open.some((r) => r.status === 'pending' || r.status === 'approved')) {
        throw new ValidationError('يوجد طلب موافقة قائم لهذا المستند');
      }
      const pol = await tx.query<{ id: string; steps: ApprovalStep[] }>(
        `SELECT id, steps FROM approval_policies WHERE company_id = $1 AND document_type = $2 ORDER BY version DESC LIMIT 1`,
        [companyId, documentType]
      );
      if (options.requirePolicy && !pol.rows[0]) {
        throw new ValidationError('لا توجد سياسة موافقة منشورة لهذا النوع من المستندات');
      }
      const policyId = pol.rows[0]?.id ?? null;
      const steps: ApprovalStep[] = pol.rows[0]?.steps ?? [{ stepNo: 1, permission: defaultPermission }];
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO approval_requests (company_id, document_type, document_id, policy_id, steps, requested_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`,
        [companyId, documentType, documentId, policyId, JSON.stringify(steps), actorId]
      );
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'APPROVAL_REQUESTED',
          entityType: documentType,
          entityId: documentId,
          metadata: { requestId: ins.rows[0].id, policyId, steps },
        },
        { executor: tx }
      );
      return (await this.loadRequest(companyId, ins.rows[0].id, tx))!;
    });
  }

  /** Approve or reject the next open step. The caller proves the permission through checkPermission. */
  async decide(
    companyId: string,
    requestId: string,
    decision: 'approve' | 'reject',
    reason: string | null,
    actorId: string,
    checkPermission: PermissionChecker
  ): Promise<ApprovalRequestView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (!requestId || !isUuid(requestId)) throw new ValidationError('معرف الطلب غير صالح');
    if (decision !== 'approve' && decision !== 'reject') throw new ValidationError('القرار غير صالح');
    const why = (reason || '').trim();
    if (decision === 'reject' && !why) throw new ValidationError('سبب الرفض مطلوب');
    return await withTenantTransaction(companyId, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`approval_decide:${companyId}:${requestId}`]);
      const req = await this.loadRequest(companyId, requestId, tx);
      if (!req) throw new NotFoundError('طلب الموافقة غير موجود');
      if (req.status !== 'pending' || !req.nextStep) throw new ValidationError('طلب الموافقة مغلق ولا يقبل قرارات جديدة');
      if (req.requestedBy === actorId) throw new ForbiddenError('لا يجوز لمقدّم الطلب أن يوافق على طلبه');
      if (req.decisions.some((d) => d.decidedBy === actorId)) {
        throw new ForbiddenError('لا يجوز لنفس الشخص أن يقرر أكثر من خطوة في الطلب نفسه');
      }
      if (!(await checkPermission(req.nextStep.permission))) {
        throw new ForbiddenError(`Access denied: Missing required permission '${req.nextStep.permission}' for this approval step`);
      }
      await tx.query(
        `INSERT INTO approval_decisions (company_id, request_id, step_no, decision, decided_by, reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [companyId, requestId, req.nextStep.stepNo, decision, actorId, why || null]
      );
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: decision === 'approve' ? 'APPROVAL_STEP_APPROVED' : 'APPROVAL_REJECTED',
          entityType: req.documentType,
          entityId: req.documentId,
          metadata: { requestId, stepNo: req.nextStep.stepNo, reason: why || null },
        },
        { executor: tx }
      );
      return (await this.loadRequest(companyId, requestId, tx))!;
    });
  }

  async getRequest(companyId: string, requestId: string): Promise<ApprovalRequestView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (!requestId || !isUuid(requestId)) throw new ValidationError('معرف الطلب غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const r = await this.loadRequest(companyId, requestId, tx);
      if (!r) throw new NotFoundError('طلب الموافقة غير موجود');
      return r;
    });
  }

  /** List requests, newest first. Status is derived, so the filter runs after loading (bounded scan). */
  async listRequests(
    companyId: string,
    filter: { status?: ApprovalStatus; documentType?: string; documentId?: string; limit?: number } = {}
  ): Promise<ApprovalRequestView[]> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (filter.status && !['pending', 'approved', 'rejected'].includes(filter.status)) {
      throw new ValidationError('حالة الطلب غير صالحة');
    }
    if (filter.documentId && !isUuid(filter.documentId)) throw new ValidationError('معرف المستند غير صالح');
    const limit = Math.min(Math.max(Math.trunc(filter.limit || 50), 1), 100);
    return await withTenantTransaction(companyId, async (tx) => {
      const params: unknown[] = [companyId];
      let where = 'company_id = $1';
      if (filter.documentType) { params.push(filter.documentType); where += ` AND document_type = $${params.length}`; }
      if (filter.documentId) { params.push(filter.documentId); where += ` AND document_id = $${params.length}`; }
      const ids = await tx.query<{ id: string }>(
        `SELECT id FROM approval_requests WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT 500`,
        params
      );
      const out: ApprovalRequestView[] = [];
      for (const row of ids.rows) {
        const r = await this.loadRequest(companyId, row.id, tx);
        if (!r) continue;
        if (filter.status && r.status !== filter.status) continue;
        out.push(r);
        if (out.length >= limit) break;
      }
      return out;
    });
  }

  /** Latest policy per document type. */
  async listPolicies(companyId: string): Promise<Array<{ id: string; documentType: string; version: number; steps: ApprovalStep[] }>> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const r = await tx.query<any>(
        `SELECT DISTINCT ON (document_type) id, document_type AS "documentType", version, steps
           FROM approval_policies WHERE company_id = $1 ORDER BY document_type, version DESC`,
        [companyId]
      );
      return r.rows.map((x: any) => ({ id: x.id, documentType: x.documentType, version: Number(x.version), steps: x.steps }));
    });
  }

  /** True only when the document has an approved request. Callers gate their action on this. */
  async isApproved(companyId: string, documentType: string, documentId: string): Promise<boolean> {
    return await withTenantTransaction(companyId, async (tx) => {
      const all = await this.findRequestsForDocument(companyId, documentType, documentId, tx);
      return all.some((r) => r.status === 'approved');
    });
  }

  private async findRequestsForDocument(
    companyId: string,
    documentType: string,
    documentId: string,
    tx: DbExecutor
  ): Promise<ApprovalRequestView[]> {
    const ids = await tx.query<{ id: string }>(
      `SELECT id FROM approval_requests WHERE company_id = $1 AND document_type = $2 AND document_id = $3 ORDER BY created_at`,
      [companyId, documentType, documentId]
    );
    const out: ApprovalRequestView[] = [];
    for (const row of ids.rows) {
      const r = await this.loadRequest(companyId, row.id, tx);
      if (r) out.push(r);
    }
    return out;
  }

  private async loadRequest(companyId: string, requestId: string, tx: DbExecutor): Promise<ApprovalRequestView | null> {
    const r = await tx.query<any>(
      `SELECT id, company_id AS "companyId", document_type AS "documentType", document_id AS "documentId",
              policy_id AS "policyId", steps, requested_by AS "requestedBy"
         FROM approval_requests WHERE company_id = $1 AND id = $2`,
      [companyId, requestId]
    );
    if (!r.rows[0]) return null;
    const d = await tx.query<any>(
      `SELECT step_no AS "stepNo", decision, decided_by AS "decidedBy", reason, created_at AS "createdAt"
         FROM approval_decisions WHERE company_id = $1 AND request_id = $2 ORDER BY step_no`,
      [companyId, requestId]
    );
    const decisions: ApprovalDecisionView[] = d.rows.map((x: any) => ({
      stepNo: Number(x.stepNo),
      decision: x.decision,
      decidedBy: x.decidedBy,
      reason: x.reason,
      createdAt: x.createdAt instanceof Date ? x.createdAt.toISOString() : x.createdAt,
    }));
    const steps: ApprovalStep[] = r.rows[0].steps;
    const state = deriveApprovalState(steps, decisions);
    return { ...r.rows[0], steps, decisions, status: state.status, nextStep: state.nextStep };
  }
}

export const defaultApprovalService = new ApprovalService();
