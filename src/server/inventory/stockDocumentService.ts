import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { ValidationError } from '../http/errors.js';
import { defaultStockService, StockService } from './stockService.js';
import { defaultAuditService } from '../audit/auditService.js';
import type { StockAdjustmentKind, StockAdjustmentDirection } from './inventoryTypes.js';

export type StockDocumentType = 'receipt' | 'issue' | 'adjustment' | 'transfer';

export const MAX_STOCK_DOCUMENT_LINES = 500;

export interface StockDocumentLineInput {
  itemId: string;
  qty: number;
  unitCost?: number;
  costSource?: string;
  reason?: string;
  memo?: string;
  warehouseId?: string;
  direction?: StockAdjustmentDirection;
  adjustmentType?: StockAdjustmentKind;
  expenseAccountId?: string;
}

export interface StockDocumentInput {
  docType: StockDocumentType;
  warehouseId?: string;
  sourceWarehouseId?: string;
  destWarehouseId?: string;
  reason?: string;
  memo?: string;
  costSource?: string;
  entryDate?: string;
  expenseAccountId?: string;
  adjustmentType?: StockAdjustmentKind;
  lines: StockDocumentLineInput[];
}

export interface StockDocumentResult {
  documentId: string;
  docNo: string;
  docType: StockDocumentType;
  lineCount: number;
  lines: Array<{ lineNo: number; itemId: string; movementIds: string[]; journalEntryId: string | null }>;
}


export const ASYNC_STOCK_DOCUMENT_MIN_LINES = 50;

export interface StockDocumentJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  docType: StockDocumentType;
  lineCount: number;
  result: StockDocumentResult | null;
  errorMessage: string | null;
  createdAt: string;
}

const JOB_STALE_MS = 15 * 60 * 1000;

function mapJob(r: any): StockDocumentJob {
  return {
    id: r.id, status: r.status, docType: r.doc_type, lineCount: r.line_count,
    result: r.result ?? null, errorMessage: r.error_message ?? null, createdAt: new Date(r.created_at).toISOString(),
  };
}

const PREFIX: Record<StockDocumentType, string> = { receipt: 'SR', issue: 'SI', adjustment: 'SA', transfer: 'ST' };

export class StockDocumentService {
  constructor(private stock: StockService = defaultStockService) {}

  private validate(companyId: string, input: StockDocumentInput): void {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!input || !(input.docType in PREFIX)) throw new ValidationError('نوع المستند غير صالح');
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new ValidationError('المستند يجب أن يحتوي على سطر واحد على الأقل');
    }
    if (input.lines.length > MAX_STOCK_DOCUMENT_LINES) {
      throw new ValidationError(`عدد الأسطر يتجاوز الحد الأقصى (${MAX_STOCK_DOCUMENT_LINES})`);
    }
    if (input.docType === 'transfer') {
      if (!input.sourceWarehouseId || !input.destWarehouseId) {
        throw new ValidationError('مستودع المصدر ومستودع الوجهة مطلوبان لمستند التحويل');
      }
    } else if (!input.warehouseId && input.lines.some((l) => !l?.warehouseId)) {
      throw new ValidationError('المستودع مطلوب (في رأس المستند أو في كل سطر)');
    }
    input.lines.forEach((l, i) => {
      if (!l || typeof l.itemId !== 'string' || !l.itemId) throw new ValidationError(`السطر ${i + 1}: الصنف مطلوب`);
      if (!(Number(l.qty) > 0)) throw new ValidationError(`السطر ${i + 1}: الكمية يجب أن تكون أكبر من الصفر`);
      const n = i + 1;
      const reason = (l.reason || input.reason || input.memo || l.memo || '').trim();
      const costSource = (l.costSource || input.costSource || '').trim();
      const hasCost = l.unitCost !== undefined && l.unitCost !== null && Number(l.unitCost) > 0;
      if (input.docType === 'receipt') {
        if (!reason) throw new ValidationError(`السطر ${n}: السبب (reason) مطلوب، في رأس المستند أو في السطر`);
        if (!costSource) throw new ValidationError(`السطر ${n}: مصدر التكلفة (costSource) مطلوب للاستلام، في رأس المستند أو في السطر`);
        if (!hasCost) throw new ValidationError(`السطر ${n}: تكلفة الوحدة (unitCost) مطلوبة وأكبر من الصفر للاستلام`);
      } else if (input.docType === 'adjustment') {
        if (l.direction !== 'increase' && l.direction !== 'decrease') {
          throw new ValidationError(`السطر ${n}: الاتجاه (direction) مطلوب في كل سطر تسوية: increase أو decrease`);
        }
        if (!reason) throw new ValidationError(`السطر ${n}: السبب (reason) مطلوب للتسوية، في رأس المستند أو في السطر`);
        if (l.direction === 'increase') {
          if (!costSource) throw new ValidationError(`السطر ${n}: مصدر التكلفة (costSource) مطلوب للتسوية بالزيادة`);
          if (!hasCost) throw new ValidationError(`السطر ${n}: تكلفة الوحدة (unitCost) مطلوبة وأكبر من الصفر للتسوية بالزيادة`);
        }
      } else if (input.docType === 'issue') {
        if (!reason) throw new ValidationError(`السطر ${n}: السبب (reason) مطلوب للصرف، في رأس المستند أو في السطر`);
      }
    });
  }

  /**
   * Post a multi-line stock document. Every line goes through the same single-line engine
   * (balance check, costing, journal) inside ONE transaction, so the document is all or nothing and
   * the balance check is cumulative (lines are applied in order and later lines see earlier ones).
   */
  async postDocument(companyId: string, input: StockDocumentInput, actorId?: string): Promise<StockDocumentResult> {
    this.validate(companyId, input);

    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`stockdoc:${companyId}`]);
      const cnt = await tx.query<any>('SELECT count(*)::int AS n FROM inv_stock_documents WHERE company_id = $1', [companyId]);
      const docNo = `${PREFIX[input.docType]}-${String((cnt.rows[0]?.n ?? 0) + 1).padStart(6, '0')}`;
      const ins = await tx.query<any>(
        `INSERT INTO inv_stock_documents
           (company_id, doc_no, doc_type, entry_date, warehouse_id, dest_warehouse_id, reason, memo, line_count, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          companyId,
          docNo,
          input.docType,
          input.entryDate || null,
          input.docType === 'transfer' ? input.sourceWarehouseId : input.warehouseId || null,
          input.docType === 'transfer' ? input.destWarehouseId : null,
          input.reason || null,
          input.memo || null,
          input.lines.length,
          actorId || null,
        ]
      );
      const documentId: string = ins.rows[0].id;
      const out: StockDocumentResult['lines'] = [];

      for (let i = 0; i < input.lines.length; i++) {
        const l = input.lines[i];
        const lineNo = i + 1;
        const tag = `${docNo}#${lineNo}`;
        try {
          const memo = [input.memo, l.memo].filter(Boolean).join(' — ') || undefined;
          const reason = l.reason || input.reason;
          const warehouseId = l.warehouseId || input.warehouseId || '';
          let movementIds: string[] = [];
          let journalEntryId: string | null = null;
          if (input.docType === 'receipt') {
            const r = await this.stock.receiveStock(companyId, {
              warehouseId, itemId: l.itemId, qty: Number(l.qty), unitCost: l.unitCost,
              costSource: l.costSource || input.costSource, reason, memo: memo ? `${memo} [${tag}]` : tag,
              entryDate: input.entryDate, expenseAccountId: l.expenseAccountId || input.expenseAccountId,
            }, actorId);
            movementIds = [r.movement.id]; journalEntryId = r.journalEntryId;
          } else if (input.docType === 'issue') {
            const r = await this.stock.issueStock(companyId, {
              warehouseId, itemId: l.itemId, qty: Number(l.qty), reason,
              memo: memo ? `${memo} [${tag}]` : tag, entryDate: input.entryDate,
              expenseAccountId: l.expenseAccountId || input.expenseAccountId,
            }, actorId);
            movementIds = [r.movement.id]; journalEntryId = r.journalEntryId;
          } else if (input.docType === 'adjustment') {
            const adjustmentType = l.adjustmentType || input.adjustmentType || 'adjustment';
            if (l.direction !== 'increase' && l.direction !== 'decrease') {
              throw new ValidationError('اتجاه التسوية (زيادة/نقص) مطلوب');
            }
            const r = await this.stock.adjustStock(companyId, {
              warehouseId, itemId: l.itemId, adjustmentType, direction: l.direction, qty: Number(l.qty),
              unitCost: l.unitCost, costSource: l.costSource || input.costSource, reason: reason || '',
              memo: memo ? `${memo} [${tag}]` : tag, entryDate: input.entryDate,
              expenseAccountId: l.expenseAccountId || input.expenseAccountId,
            }, actorId);
            movementIds = [r.movement.id]; journalEntryId = r.journalEntryId;
          } else {
            const r = await this.stock.transfer(companyId, {
              itemId: l.itemId, sourceWarehouseId: input.sourceWarehouseId!, destWarehouseId: input.destWarehouseId!,
              qty: Number(l.qty), memo: memo ? `${memo} [${tag}]` : tag,
            }, actorId);
            movementIds = [r.movementOut.id, r.movementIn.id];
          }
          await tx.query(
            'UPDATE inv_stock_movements SET document_id = $1, line_no = $2 WHERE company_id = $3 AND id = ANY($4::uuid[])',
            [documentId, lineNo, companyId, movementIds]
          );
          out.push({ lineNo, itemId: l.itemId, movementIds, journalEntryId });
        } catch (err: any) {
          if (err && typeof err.message === 'string' && !err.message.startsWith('السطر ')) {
            err.message = `السطر ${lineNo}: ${err.message}`;
          }
          throw err;
        }
      }

      await defaultAuditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'STOCK_DOCUMENT_POST',
          entityType: 'inv_stock_document',
          entityId: documentId,
          metadata: { docNo, docType: input.docType, lineCount: input.lines.length },
        },
        { executor: tx }
      );

      return { documentId, docNo, docType: input.docType, lineCount: input.lines.length, lines: out };
    });
  }

  /** Queue a large document. The document is validated first so obvious input errors fail immediately. */
  async createJob(companyId: string, input: StockDocumentInput, actorId?: string): Promise<StockDocumentJob> {
    this.validate(companyId, input);
    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const r = await tx.query<any>(
        `INSERT INTO inv_stock_document_jobs (company_id, doc_type, payload, line_count, created_by)
         VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING *`,
        [companyId, input.docType, JSON.stringify(input), input.lines.length, actorId || null]
      );
      return mapJob(r.rows[0]);
    });
  }

  /** Claim a queued job (only one caller wins) and post it. Never throws: the outcome is stored on the job. */
  async runJob(companyId: string, jobId: string): Promise<void> {
    const claim = await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const r = await tx.query<any>(
        `UPDATE inv_stock_document_jobs SET status = 'running', started_at = now()
          WHERE company_id = $1 AND id = $2 AND status = 'queued' RETURNING payload, created_by`,
        [companyId, jobId]
      );
      return r.rows[0] || null;
    });
    if (!claim) return;
    let result: StockDocumentResult | null = null;
    let errMsg: string | null = null;
    try {
      result = await this.postDocument(companyId, claim.payload as StockDocumentInput, claim.created_by || undefined);
    } catch (err: any) {
      errMsg = String(err?.message || err || 'فشل ترحيل المستند').slice(0, 1000);
    }
    await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      await tx.query(
        `UPDATE inv_stock_document_jobs SET status = $3, result = $4::jsonb, error_message = $5, finished_at = now()
          WHERE company_id = $1 AND id = $2`,
        [companyId, jobId, errMsg ? 'failed' : 'done', result ? JSON.stringify(result) : null, errMsg]
      );
    });
  }

  /** Read a job. A queued job nobody started (CPU paused after the response) is started by the poll itself. */
  async getJob(companyId: string, jobId: string): Promise<StockDocumentJob | null> {
    const row = await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const r = await tx.query<any>('SELECT * FROM inv_stock_document_jobs WHERE company_id = $1 AND id = $2', [companyId, jobId]);
      return r.rows[0] || null;
    });
    if (!row) return null;
    if (row.status === 'queued') {
      void this.runJob(companyId, jobId).catch(() => undefined);
      return { ...mapJob(row), status: 'running' };
    }
    if (row.status === 'running' && row.started_at && Date.now() - new Date(row.started_at).getTime() > JOB_STALE_MS) {
      // The posting transaction is atomic: a process that died mid-way left nothing behind.
      await withTenantTransaction(companyId, async (tx: DbExecutor) => {
        await tx.query(
          `UPDATE inv_stock_document_jobs SET status = 'failed', error_message = $3, finished_at = now()
            WHERE company_id = $1 AND id = $2 AND status = 'running'`,
          [companyId, jobId, 'انقطعت المعالجة قبل الاكتمال ولم يُرحَّل شيء، أعد إرسال المستند']
        );
      });
      return { ...mapJob(row), status: 'failed', errorMessage: 'انقطعت المعالجة قبل الاكتمال ولم يُرحَّل شيء، أعد إرسال المستند' };
    }
    return mapJob(row);
  }
}

export const defaultStockDocumentService = new StockDocumentService();
