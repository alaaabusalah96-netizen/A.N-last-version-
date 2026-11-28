import { withTenantTransaction } from '../db/transactionManager.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';

export type StocktakeStatus = 'counting' | 'closed' | 'cancelled';

export interface StocktakeHeader {
  id: string;
  companyId: string;
  stocktakeNo: number;
  warehouseId: string;
  warehouseCode: string;
  warehouseNameAr: string;
  status: StocktakeStatus;
  countDate: string;
  memo: string | null;
  createdAt: string;
  closedAt: string | null;
  lineCount: number;
  countedCount: number;
}

export interface StocktakeLine {
  itemId: string;
  itemCode: string;
  itemNameAr: string;
  uom: string;
  systemQty: string;
  countedQty: string | null;
  /** counted - system, null while not counted. Reported only: counting never posts. */
  varianceQty: string | null;
}

export interface StocktakeDetail extends StocktakeHeader {
  lines: StocktakeLine[];
  summary: { uncounted: number; shortage: number; surplus: number; matched: number };
}

const HEADER_SELECT = `
  s.id, s.company_id as "companyId", s.stocktake_no as "stocktakeNo", s.warehouse_id as "warehouseId",
  w.code as "warehouseCode", w.name_ar as "warehouseNameAr", s.status, s.count_date::text as "countDate",
  s.memo, s.created_at as "createdAt", s.closed_at as "closedAt",
  (SELECT COUNT(*) FROM inv_stocktake_lines l WHERE l.company_id = s.company_id AND l.stocktake_id = s.id)::int as "lineCount",
  (SELECT COUNT(*) FROM inv_stocktake_lines l WHERE l.company_id = s.company_id AND l.stocktake_id = s.id AND l.counted_qty IS NOT NULL)::int as "countedCount"
`;

function toIso(v: any): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapHeader(r: any): StocktakeHeader {
  return { ...r, createdAt: toIso(r.createdAt) as string, closedAt: toIso(r.closedAt) };
}

export class StocktakeService {
  constructor(private auditService: AuditService = defaultAuditService) {}

  async list(companyId: string): Promise<StocktakeHeader[]> {
    this.requireCompany(companyId);
    return await withTenantTransaction(companyId, async (tx) => {
      const res = await tx.query<any>(
        `SELECT ${HEADER_SELECT}
         FROM inv_stocktakes s
         INNER JOIN inv_warehouses w ON w.id = s.warehouse_id AND w.company_id = s.company_id
         WHERE s.company_id = $1
         ORDER BY s.stocktake_no DESC
         LIMIT 200`,
        [companyId]
      );
      return res.rows.map(mapHeader);
    });
  }

  async get(companyId: string, id: string): Promise<StocktakeDetail> {
    this.requireCompany(companyId);
    this.requireId(id);
    return await withTenantTransaction(companyId, async (tx) => {
      const head = await tx.query<any>(
        `SELECT ${HEADER_SELECT}
         FROM inv_stocktakes s
         INNER JOIN inv_warehouses w ON w.id = s.warehouse_id AND w.company_id = s.company_id
         WHERE s.company_id = $1 AND s.id = $2`,
        [companyId, id]
      );
      if (head.rows.length === 0) throw new NotFoundError('كشف الجرد غير موجود');
      const lines = await tx.query<any>(
        `SELECT l.item_id as "itemId", i.code as "itemCode", i.name_ar as "itemNameAr", i.uom,
                l.system_qty::text as "systemQty", l.counted_qty::text as "countedQty",
                (l.counted_qty - l.system_qty)::text as "varianceQty"
         FROM inv_stocktake_lines l
         INNER JOIN inv_items i ON i.id = l.item_id AND i.company_id = l.company_id
         WHERE l.company_id = $1 AND l.stocktake_id = $2
         ORDER BY i.code ASC`,
        [companyId, id]
      );
      const rows = lines.rows as StocktakeLine[];
      const summary = { uncounted: 0, shortage: 0, surplus: 0, matched: 0 };
      for (const l of rows) {
        if (l.varianceQty === null) summary.uncounted++;
        else if (Number(l.varianceQty) < 0) summary.shortage++;
        else if (Number(l.varianceQty) > 0) summary.surplus++;
        else summary.matched++;
      }
      return { ...mapHeader(head.rows[0]), lines: rows, summary };
    });
  }

  /** Snapshot every active item of the warehouse with its current system quantity (0 when no balance row). */
  async create(
    companyId: string,
    input: { warehouseId: string; memo?: string; countDate?: string },
    actorId?: string
  ): Promise<StocktakeDetail> {
    this.requireCompany(companyId);
    if (!input?.warehouseId || !isUuid(input.warehouseId)) throw new ValidationError('المستودع مطلوب');
    if (input.countDate !== undefined && input.countDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(input.countDate)) {
      throw new ValidationError('تاريخ الجرد غير صالح');
    }
    const id = await withTenantTransaction(companyId, async (tx) => {
      const wh = await tx.query<any>(
        `SELECT id, is_active as "isActive" FROM inv_warehouses WHERE company_id = $1 AND id = $2`,
        [companyId, input.warehouseId]
      );
      if (wh.rows.length === 0) throw new NotFoundError('المستودع المحدد غير موجود');
      if (!wh.rows[0].isActive) throw new ValidationError('المستودع المحدد غير نشط');

      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`stocktake:${companyId}`]);
      const open = await tx.query<any>(
        `SELECT stocktake_no as "no" FROM inv_stocktakes WHERE company_id = $1 AND warehouse_id = $2 AND status = 'counting' LIMIT 1`,
        [companyId, input.warehouseId]
      );
      if (open.rows.length > 0) {
        throw new ValidationError(`يوجد كشف جرد مفتوح لهذا المستودع (رقم ${open.rows[0].no})؛ أغلقه أو ألغِه أولاً`);
      }
      const next = await tx.query<any>(
        `SELECT COALESCE(MAX(stocktake_no), 0) + 1 as "no" FROM inv_stocktakes WHERE company_id = $1`,
        [companyId]
      );
      const head = await tx.query<any>(
        `INSERT INTO inv_stocktakes (company_id, stocktake_no, warehouse_id, count_date, memo, created_by)
         VALUES ($1, $2, $3, COALESCE(NULLIF($4, '')::date, CURRENT_DATE), $5, $6)
         RETURNING id`,
        [companyId, next.rows[0].no, input.warehouseId, input.countDate || '', input.memo?.trim() || null, actorId || null]
      );
      const stocktakeId = head.rows[0].id as string;
      await tx.query(
        `INSERT INTO inv_stocktake_lines (company_id, stocktake_id, item_id, system_qty)
         SELECT $1, $2, i.id, COALESCE(b.qty, 0)
         FROM inv_items i
         LEFT JOIN inv_stock_balances b
           ON b.company_id = i.company_id AND b.item_id = i.id AND b.warehouse_id = $3
         WHERE i.company_id = $1 AND i.is_active = true`,
        [companyId, stocktakeId, input.warehouseId]
      );
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'STOCKTAKE_CREATE',
          entityType: 'inv_stocktakes',
          entityId: stocktakeId,
          metadata: { warehouseId: input.warehouseId, stocktakeNo: next.rows[0].no },
        },
        { executor: tx }
      );
      return stocktakeId;
    });
    return await this.get(companyId, id);
  }

  /** Save counted quantities (null clears a count). Only while the sheet is open. Posts nothing. */
  async saveCounts(
    companyId: string,
    id: string,
    counts: Array<{ itemId: string; countedQty: number | null }>,
    actorId?: string
  ): Promise<StocktakeDetail> {
    this.requireCompany(companyId);
    this.requireId(id);
    if (!Array.isArray(counts) || counts.length === 0) throw new ValidationError('لا توجد كميات للحفظ');
    if (counts.length > 5000) throw new ValidationError('عدد الأصناف في الحفظ الواحد كبير جداً (الحد 5000)');
    const seen = new Set<string>();
    for (const c of counts) {
      if (!c || !isUuid(c.itemId)) throw new ValidationError('معرّف صنف غير صالح');
      if (seen.has(c.itemId)) throw new ValidationError('صنف مكرر في الكميات المحفوظة');
      seen.add(c.itemId);
      if (c.countedQty !== null && (typeof c.countedQty !== 'number' || !Number.isFinite(c.countedQty) || c.countedQty < 0)) {
        throw new ValidationError('الكمية المعدودة يجب أن تكون رقماً غير سالب');
      }
    }
    await withTenantTransaction(companyId, async (tx) => {
      const head = await tx.query<any>(
        `SELECT status FROM inv_stocktakes WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        [companyId, id]
      );
      if (head.rows.length === 0) throw new NotFoundError('كشف الجرد غير موجود');
      if (head.rows[0].status !== 'counting') throw new ValidationError('لا يمكن تعديل الكميات: كشف الجرد ليس في حالة عدّ');
      const upd = await tx.query<any>(
        `UPDATE inv_stocktake_lines l
         SET counted_qty = t.qty,
             counted_by = CASE WHEN t.qty IS NULL THEN NULL ELSE $3::uuid END,
             counted_at = CASE WHEN t.qty IS NULL THEN NULL ELSE now() END
         FROM unnest($4::uuid[], $5::numeric[]) AS t(item_id, qty)
         WHERE l.company_id = $1 AND l.stocktake_id = $2 AND l.item_id = t.item_id
         RETURNING l.item_id`,
        [companyId, id, actorId || null, counts.map((c) => c.itemId), counts.map((c) => c.countedQty)]
      );
      if (upd.rows.length !== counts.length) throw new ValidationError('أحد الأصناف ليس ضمن كشف الجرد');
    });
    return await this.get(companyId, id);
  }

  async close(companyId: string, id: string, actorId?: string): Promise<StocktakeDetail> {
    return await this.setStatus(companyId, id, 'closed', 'STOCKTAKE_CLOSE', actorId);
  }

  async cancel(companyId: string, id: string, actorId?: string): Promise<StocktakeDetail> {
    return await this.setStatus(companyId, id, 'cancelled', 'STOCKTAKE_CANCEL', actorId);
  }

  private async setStatus(
    companyId: string,
    id: string,
    status: 'closed' | 'cancelled',
    action: string,
    actorId?: string
  ): Promise<StocktakeDetail> {
    this.requireCompany(companyId);
    this.requireId(id);
    await withTenantTransaction(companyId, async (tx) => {
      const head = await tx.query<any>(
        `SELECT status FROM inv_stocktakes WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        [companyId, id]
      );
      if (head.rows.length === 0) throw new NotFoundError('كشف الجرد غير موجود');
      if (head.rows[0].status !== 'counting') throw new ValidationError('كشف الجرد ليس في حالة عدّ');
      await tx.query(
        `UPDATE inv_stocktakes SET status = $3, closed_by = $4, closed_at = now() WHERE company_id = $1 AND id = $2`,
        [companyId, id, status, actorId || null]
      );
      await this.auditService.record(
        { actorUserId: actorId || null, companyId, action, entityType: 'inv_stocktakes', entityId: id, metadata: {} },
        { executor: tx }
      );
    });
    return await this.get(companyId, id);
  }

  private requireCompany(companyId: string) {
    if (!companyId || typeof companyId !== 'string') throw new ValidationError('companyId is required');
  }
  private requireId(id: string) {
    if (!id || !isUuid(id)) throw new ValidationError('Invalid ID format');
  }
}

export const defaultStocktakeService = new StocktakeService();
