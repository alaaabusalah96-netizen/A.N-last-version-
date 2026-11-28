import { withTenantTransaction } from '../db/transactionManager.js';
import { ValidationError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';

export interface CostCenterIssueFilter {
  from?: string;
  to?: string;
  costCenterId?: string;
  itemId?: string;
}

export interface CostCenterIssueRow {
  costCenterId: string;
  costCenterCode: string;
  costCenterNameAr: string;
  itemId: string;
  itemCode: string;
  itemNameAr: string;
  uom: string;
  issueCount: number;
  totalQty: string;
  totalCost: string;
}

export interface CostCenterIssueReport {
  from: string | null;
  to: string | null;
  rows: CostCenterIssueRow[];
  totals: { totalQty: string; totalCost: string };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CostCenterIssueReportService {
  /**
   * Quantity and cost issued per cost center and item for a from/to date range (inclusive).
   * Cost comes from the valuation movement written with each issue (server FIFO / moving average).
   */
  async report(companyId: string, f: CostCenterIssueFilter): Promise<CostCenterIssueReport> {
    if (!companyId || typeof companyId !== 'string') throw new ValidationError('companyId is required');
    if (f.from && !DATE_RE.test(f.from)) throw new ValidationError('تاريخ البداية غير صالح');
    if (f.to && !DATE_RE.test(f.to)) throw new ValidationError('تاريخ النهاية غير صالح');
    if (f.from && f.to && f.from > f.to) throw new ValidationError('تاريخ البداية بعد تاريخ النهاية');
    if (f.costCenterId && !isUuid(f.costCenterId)) throw new ValidationError('مركز التكلفة غير صالح');
    if (f.itemId && !isUuid(f.itemId)) throw new ValidationError('الصنف غير صالح');

    return await withTenantTransaction(companyId, async (tx) => {
      const res = await tx.query<any>(
        `SELECT m.cost_center_id as "costCenterId", o.code as "costCenterCode", o.name_ar as "costCenterNameAr",
                m.item_id as "itemId", i.code as "itemCode", i.name_ar as "itemNameAr", i.uom,
                COUNT(*)::int as "issueCount",
                SUM(m.qty)::text as "totalQty",
                COALESCE(SUM(v.total_cost), 0)::text as "totalCost"
         FROM inv_stock_movements m
         INNER JOIN org_units o ON o.company_id = m.company_id AND o.id = m.cost_center_id
         INNER JOIN inv_items i ON i.company_id = m.company_id AND i.id = m.item_id
         LEFT JOIN inv_valuation_movements v
           ON v.company_id = m.company_id AND v.source_id = m.id AND v.movement_type = 'ISSUE'
         WHERE m.company_id = $1
           AND m.movement_type = 'issue'
           AND m.cost_center_id IS NOT NULL
           AND ($2::date IS NULL OR m.created_at >= $2::date)
           AND ($3::date IS NULL OR m.created_at < ($3::date + 1))
           AND ($4::uuid IS NULL OR m.cost_center_id = $4::uuid)
           AND ($5::uuid IS NULL OR m.item_id = $5::uuid)
         GROUP BY m.cost_center_id, o.code, o.name_ar, m.item_id, i.code, i.name_ar, i.uom
         ORDER BY o.code, i.code`,
        [companyId, f.from || null, f.to || null, f.costCenterId || null, f.itemId || null]
      );
      const rows = res.rows as CostCenterIssueRow[];
      const qty = rows.reduce((a, r) => a + Number(r.totalQty), 0);
      const cost = rows.reduce((a, r) => a + Number(r.totalCost), 0);
      return {
        from: f.from || null,
        to: f.to || null,
        rows,
        totals: { totalQty: String(qty), totalCost: cost.toFixed(4) },
      };
    });
  }
}

export const defaultCostCenterIssueReportService = new CostCenterIssueReportService();
