import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { ValidationError } from '../http/errors.js';
import crypto from 'crypto';

export interface PriceVarianceExceptionRow {
  id: string;
  companyId: string;
  invoiceId: string;
  supplierId: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  requestedBy: string | null;
  requestedByUsername?: string | null;
  approvedBy: string | null;
  approvedByUsername?: string | null;
  rejectedBy: string | null;
  rejectedByUsername?: string | null;
  supersededBy?: string | null;
  supersededByUsername?: string | null;
  reason: string;
  decisionReason: string | null;
  supersedeReason?: string | null;
  fingerprint: string;
  snapshot: any;
  maxVariancePc: number;
  decidedAt?: string | null;
  supersededAt?: string | null;
  createdAt: string;
  updatedAt: string;
  isFingerprintValid?: boolean;
  isExpired?: boolean;
}

export class PriceVarianceExceptionRepository {
  computeFingerprint(companyId: string, invoiceId: string, supplierId: string, lines: Array<{ invoiceLineId?: string; itemId: string; grnLineId: string; qty: number | string; unitCost: number | string; refUnitCost?: number | string }>): string {
    const sortedLines = [...lines].sort((a, b) => (a.grnLineId || '').localeCompare(b.grnLineId || ''));
    const payload = {
      companyId,
      invoiceId,
      supplierId,
      lines: sortedLines.map((l) => ({
        invoiceLineId: l.invoiceLineId || '',
        itemId: l.itemId,
        grnLineId: l.grnLineId,
        qty: String(l.qty),
        unitCost: String(l.unitCost),
        refUnitCost: l.refUnitCost !== undefined ? String(l.refUnitCost) : '',
      })),
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  async create(
    companyId: string,
    data: {
      invoiceId: string;
      supplierId: string;
      reason: string;
      fingerprint: string;
      snapshot: any;
      requestedBy: string | null;
      maxVariancePct?: number;
    },
    tx?: DbExecutor
  ): Promise<PriceVarianceExceptionRow> {
    if (!data.requestedBy || typeof data.requestedBy !== 'string' || data.requestedBy.trim() === '') {
      throw new ValidationError('معرف مقدم الطلب (requestedBy) مطلوب لتسجيل طلب الاستثناء');
    }
    if (!data.reason || typeof data.reason !== 'string' || data.reason.trim() === '') {
      throw new ValidationError('سبب طلب الاستثناء مطلوب');
    }
    const normalizedRequestedBy = data.requestedBy.trim();
    const normalizedReason = data.reason.trim();

    const run = async (executor: DbExecutor) => {
      // Supersede any existing pending or approved exceptions for this invoice
      // IMPORTANT (R04 WP-2): Record supersede metadata in supersede_reason only; preserve original decision_reason intact.
      await executor.query(
        `UPDATE purch_price_variance_exceptions
         SET status = 'superseded',
             superseded_by = $3,
             superseded_at = NOW(),
             supersede_reason = 'تم استبدال الطلب بطلب استثناء جديد',
             updated_at = NOW()
         WHERE company_id = $1 AND invoice_id = $2 AND status IN ('pending', 'approved')`,
        [companyId, data.invoiceId, normalizedRequestedBy]
      );

      const res = await executor.query<any>(
        `INSERT INTO purch_price_variance_exceptions
           (company_id, invoice_id, supplier_id, status, requested_by, reason, fingerprint, snapshot, max_variance_pct)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8)
         RETURNING
           id,
           company_id as "companyId",
           invoice_id as "invoiceId",
           supplier_id as "supplierId",
           status,
           requested_by as "requestedBy",
           approved_by as "approvedBy",
           rejected_by as "rejectedBy",
           superseded_by as "supersededBy",
           reason,
           decision_reason as "decisionReason",
           supersede_reason as "supersedeReason",
           fingerprint,
           snapshot,
           max_variance_pct as "maxVariancePc",
           decided_at as "decidedAt",
           superseded_at as "supersededAt",
           created_at as "createdAt",
           updated_at as "updatedAt";`,
        [
          companyId,
          data.invoiceId,
          data.supplierId,
          normalizedRequestedBy,
          normalizedReason,
          data.fingerprint,
          JSON.stringify(data.snapshot),
          data.maxVariancePct ?? 5.0,
        ]
      );
      return res.rows[0];
    };

    if (tx) return await run(tx);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, exceptionId: string, tx?: DbExecutor): Promise<PriceVarianceExceptionRow | null> {
    const run = async (executor: DbExecutor) => {
      const res = await executor.query<any>(
        `SELECT
           id,
           company_id as "companyId",
           invoice_id as "invoiceId",
           supplier_id as "supplierId",
           status,
           requested_by as "requestedBy",
           approved_by as "approvedBy",
           rejected_by as "rejectedBy",
           superseded_by as "supersededBy",
           reason,
           decision_reason as "decisionReason",
           supersede_reason as "supersedeReason",
           fingerprint,
           snapshot,
           max_variance_pct as "maxVariancePc",
           decided_at as "decidedAt",
           superseded_at as "supersededAt",
           created_at as "createdAt",
           updated_at as "updatedAt"
         FROM purch_price_variance_exceptions
         WHERE company_id = $1 AND id = $2;`,
        [companyId, exceptionId]
      );
      return res.rows[0] || null;
    };
    if (tx) return await run(tx);
    return await withTenantTransaction(companyId, run);
  }

  async findByIdForUpdate(companyId: string, exceptionId: string, tx: DbExecutor): Promise<PriceVarianceExceptionRow | null> {
    const res = await tx.query<any>(
      `SELECT
         id,
         company_id as "companyId",
         invoice_id as "invoiceId",
         supplier_id as "supplierId",
         status,
         requested_by as "requestedBy",
         approved_by as "approvedBy",
         rejected_by as "rejectedBy",
         superseded_by as "supersededBy",
         reason,
         decision_reason as "decisionReason",
         supersede_reason as "supersedeReason",
         fingerprint,
         snapshot,
         max_variance_pct as "maxVariancePc",
         decided_at as "decidedAt",
         superseded_at as "supersededAt",
         created_at as "createdAt",
         updated_at as "updatedAt"
       FROM purch_price_variance_exceptions
       WHERE company_id = $1 AND id = $2
       FOR UPDATE;`,
      [companyId, exceptionId]
    );
    return res.rows[0] || null;
  }

  async findActiveApprovedByInvoice(companyId: string, invoiceId: string, tx?: DbExecutor): Promise<PriceVarianceExceptionRow | null> {
    const run = async (executor: DbExecutor) => {
      const res = await executor.query<any>(
        `SELECT
           id,
           company_id as "companyId",
           invoice_id as "invoiceId",
           supplier_id as "supplierId",
           status,
           requested_by as "requestedBy",
           approved_by as "approvedBy",
           rejected_by as "rejectedBy",
           superseded_by as "supersededBy",
           reason,
           decision_reason as "decisionReason",
           supersede_reason as "supersedeReason",
           fingerprint,
           snapshot,
           max_variance_pct as "maxVariancePc",
           decided_at as "decidedAt",
           superseded_at as "supersededAt",
           created_at as "createdAt",
           updated_at as "updatedAt"
         FROM purch_price_variance_exceptions
         WHERE company_id = $1 AND invoice_id = $2 AND status = 'approved'
         LIMIT 1;`,
        [companyId, invoiceId]
      );
      return res.rows[0] || null;
    };
    if (tx) return await run(tx);
    return await withTenantTransaction(companyId, run);
  }

  async hasAnyForInvoice(companyId: string, invoiceId: string, tx?: DbExecutor): Promise<boolean> {
    const run = async (executor: DbExecutor) => {
      const res = await executor.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM purch_price_variance_exceptions
           WHERE company_id = $1 AND invoice_id = $2
         ) as exists;`,
        [companyId, invoiceId]
      );
      return Boolean(res.rows[0]?.exists);
    };
    if (tx) return await run(tx);
    return await withTenantTransaction(companyId, run);
  }

  async listByInvoice(companyId: string, invoiceId: string, tx?: DbExecutor): Promise<PriceVarianceExceptionRow[]> {
    const run = async (executor: DbExecutor) => {
      const res = await executor.query<any>(
        `SELECT
           e.id,
           e.company_id as "companyId",
           e.invoice_id as "invoiceId",
           e.supplier_id as "supplierId",
           e.status,
           e.requested_by as "requestedBy",
           req_u.username as "requestedByUsername",
           e.approved_by as "approvedBy",
           app_u.username as "approvedByUsername",
           e.rejected_by as "rejectedBy",
           rej_u.username as "rejectedByUsername",
           e.superseded_by as "supersededBy",
           sup_u.username as "supersededByUsername",
           e.reason,
           e.decision_reason as "decisionReason",
           e.supersede_reason as "supersedeReason",
           e.fingerprint,
           e.snapshot,
           e.max_variance_pct as "maxVariancePc",
           e.decided_at as "decidedAt",
           e.superseded_at as "supersededAt",
           e.created_at as "createdAt",
           e.updated_at as "updatedAt"
         FROM purch_price_variance_exceptions e
         LEFT JOIN platform_users req_u ON req_u.id = e.requested_by
         LEFT JOIN platform_users app_u ON app_u.id = e.approved_by
         LEFT JOIN platform_users rej_u ON rej_u.id = e.rejected_by
         LEFT JOIN platform_users sup_u ON sup_u.id = e.superseded_by
         WHERE e.company_id = $1 AND e.invoice_id = $2
         ORDER BY e.created_at DESC;`,
        [companyId, invoiceId]
      );
      return res.rows;
    };
    if (tx) return await run(tx);
    return await withTenantTransaction(companyId, run);
  }

  async updateStatus(
    companyId: string,
    exceptionId: string,
    status: 'approved' | 'rejected' | 'superseded',
    actorId: string | null,
    reasonText: string | null,
    tx: DbExecutor
  ): Promise<PriceVarianceExceptionRow> {
    if (!actorId || typeof actorId !== 'string' || actorId.trim() === '') {
      throw new ValidationError('معرف المستخدم (actorId) مطلوب لتحديث حالة طلب الاستثناء');
    }
    const normalizedActorId = actorId.trim();
    const normalizedReasonText = reasonText && reasonText.trim() !== '' ? reasonText.trim() : null;

    if (status === 'superseded' && !normalizedReasonText) {
      throw new ValidationError('سبب الاستبدال (supersede_reason) مطلوب عند استبدال طلب الاستثناء');
    }

    const res = await tx.query<any>(
      `UPDATE purch_price_variance_exceptions
       SET status = $3::varchar,
           approved_by = CASE WHEN $3::text = 'approved' THEN $4::uuid ELSE approved_by END,
           rejected_by = CASE WHEN $3::text = 'rejected' THEN $4::uuid ELSE rejected_by END,
           superseded_by = CASE WHEN $3::text = 'superseded' THEN $4::uuid ELSE superseded_by END,
           decided_at = CASE WHEN $3::text IN ('approved', 'rejected') THEN NOW() ELSE decided_at END,
           superseded_at = CASE WHEN $3::text = 'superseded' THEN NOW() ELSE superseded_at END,
           decision_reason = CASE
             WHEN $3::text IN ('approved', 'rejected') THEN COALESCE($5::text, decision_reason)
             ELSE decision_reason
           END,
           supersede_reason = CASE
             WHEN $3::text = 'superseded' THEN COALESCE($5::text, supersede_reason)
             ELSE supersede_reason
           END,
           updated_at = NOW()
       WHERE company_id = $1::uuid AND id = $2::uuid
       RETURNING
         id,
         company_id as "companyId",
         invoice_id as "invoiceId",
         supplier_id as "supplierId",
         status,
         requested_by as "requestedBy",
         approved_by as "approvedBy",
         rejected_by as "rejectedBy",
         superseded_by as "supersededBy",
         reason,
         decision_reason as "decisionReason",
         supersede_reason as "supersedeReason",
         fingerprint,
         snapshot,
         max_variance_pct as "maxVariancePc",
         decided_at as "decidedAt",
         superseded_at as "supersededAt",
         created_at as "createdAt",
         updated_at as "updatedAt";`,
      [companyId, exceptionId, status, normalizedActorId, normalizedReasonText]
    );
    return res.rows[0];
  }
}

export const defaultPriceVarianceExceptionRepository = new PriceVarianceExceptionRepository();
