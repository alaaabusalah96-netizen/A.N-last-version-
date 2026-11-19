import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import crypto from 'crypto';

export interface PriceVarianceExceptionRow {
  id: string;
  companyId: string;
  invoiceId: string;
  supplierId: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  requestedBy: string | null;
  approvedBy: string | null;
  rejectedBy: string | null;
  reason: string;
  decisionReason: string | null;
  fingerprint: string;
  snapshot: any;
  maxVariancePc: number;
  createdAt: string;
  updatedAt: string;
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
    const run = async (executor: DbExecutor) => {
      // Supersede any existing pending or approved exceptions for this invoice
      await executor.query(
        `UPDATE purch_price_variance_exceptions
         SET status = 'superseded', updated_at = NOW()
         WHERE company_id = $1 AND invoice_id = $2 AND status IN ('pending', 'approved')`,
        [companyId, data.invoiceId]
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
           reason,
           decision_reason as "decisionReason",
           fingerprint,
           snapshot,
           max_variance_pct as "maxVariancePc",
           created_at as "createdAt",
           updated_at as "updatedAt";`,
        [
          companyId,
          data.invoiceId,
          data.supplierId,
          data.requestedBy,
          data.reason,
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
           reason,
           decision_reason as "decisionReason",
           fingerprint,
           snapshot,
           max_variance_pct as "maxVariancePc",
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
         reason,
         decision_reason as "decisionReason",
         fingerprint,
         snapshot,
         max_variance_pct as "maxVariancePc",
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
           reason,
           decision_reason as "decisionReason",
           fingerprint,
           snapshot,
           max_variance_pct as "maxVariancePc",
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

  async listByInvoice(companyId: string, invoiceId: string, tx?: DbExecutor): Promise<PriceVarianceExceptionRow[]> {
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
           reason,
           decision_reason as "decisionReason",
           fingerprint,
           snapshot,
           max_variance_pct as "maxVariancePc",
           created_at as "createdAt",
           updated_at as "updatedAt"
         FROM purch_price_variance_exceptions
         WHERE company_id = $1 AND invoice_id = $2
         ORDER BY created_at DESC;`,
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
    decisionReason: string | null,
    tx: DbExecutor
  ): Promise<PriceVarianceExceptionRow> {
    const col = status === 'approved' ? 'approved_by' : status === 'rejected' ? 'rejected_by' : 'approved_by';
    const res = await tx.query<any>(
      `UPDATE purch_price_variance_exceptions
       SET status = $3,
           approved_by = CASE WHEN $3 = 'approved' THEN $4 ELSE approved_by END,
           rejected_by = CASE WHEN $3 = 'rejected' THEN $4 ELSE rejected_by END,
           decision_reason = COALESCE($5, decision_reason),
           updated_at = NOW()
       WHERE company_id = $1 AND id = $2
       RETURNING
         id,
         company_id as "companyId",
         invoice_id as "invoiceId",
         supplier_id as "supplierId",
         status,
         requested_by as "requestedBy",
         approved_by as "approvedBy",
         rejected_by as "rejectedBy",
         reason,
         decision_reason as "decisionReason",
         fingerprint,
         snapshot,
         max_variance_pct as "maxVariancePc",
         created_at as "createdAt",
         updated_at as "updatedAt";`,
      [companyId, exceptionId, status, actorId, decisionReason]
    );
    return res.rows[0];
  }
}

export const defaultPriceVarianceExceptionRepository = new PriceVarianceExceptionRepository();
