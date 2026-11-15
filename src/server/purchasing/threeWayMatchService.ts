import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { ValidationError } from '../http/errors.js';
import { toDecimal } from '../lib/numeric.js';

export interface ThreeWayMatchPolicy {
  qtyTolerancePct: number;
  priceTolerancePct: number;
  priceRoundingAbs: number;
}

export const DEFAULT_THREE_WAY_POLICY: ThreeWayMatchPolicy = {
  qtyTolerancePct: 0,
  priceTolerancePct: 5, // 5% price tolerance limit
  priceRoundingAbs: 0.01,
};

export type MatchStatus = 'matched' | 'within_tolerance' | 'variance_exceeded' | 'grn_only';

export interface LineMatchResult {
  grnLineId: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  poLineId?: string | null;
  poQty?: number | null;
  poUnitCost?: number | null;
  grnQty: number;
  grnUnitCost: number;
  invoiceQty: number;
  invoiceUnitCost: number;
  qtyVariance: number;
  priceVariancePct: number;
  status: MatchStatus;
  messageAr: string;
}

export interface InvoiceThreeWayMatchReport {
  invoiceId: string;
  supplierInvoiceNo: string;
  overallStatus: MatchStatus;
  lines: LineMatchResult[];
  policy: ThreeWayMatchPolicy;
}

export class ThreeWayMatchService {
  getPolicy(): ThreeWayMatchPolicy {
    return { ...DEFAULT_THREE_WAY_POLICY };
  }

  async evaluateInvoice(
    companyId: string,
    invoiceId: string,
    customExecutor?: DbExecutor
  ): Promise<InvoiceThreeWayMatchReport> {
    const run = async (executor: DbExecutor) => {
      const invRes = await executor.query<any>(
        `SELECT id, supplier_invoice_no FROM purch_supplier_invoices WHERE company_id = $1 AND id = $2`,
        [companyId, invoiceId]
      );
      if (invRes.rows.length === 0) {
        throw new ValidationError('فاتورة المورد غير موجودة');
      }
      const invRow = invRes.rows[0];

      const linesRes = await executor.query<any>(
        `SELECT
           sil.id as "invoiceLineId",
           sil.grn_line_id as "grnLineId",
           sil.item_id as "itemId",
           i.code as "itemCode",
           i.name_ar as "itemNameAr",
           sil.qty as "invoiceQty",
           sil.unit_cost as "invoiceUnitCost",
           gl.qty as "grnQty",
           gl.unit_cost as "grnUnitCost",
           gl.po_line_id as "poLineId",
           po_l.qty as "poQty",
           po_l.unit_cost as "poUnitCost"
         FROM purch_supplier_invoice_lines sil
         INNER JOIN inv_items i ON i.id = sil.item_id AND i.company_id = sil.company_id
         INNER JOIN purch_grn_lines gl ON gl.id = sil.grn_line_id AND gl.company_id = gl.company_id
         LEFT JOIN purch_po_lines po_l ON po_l.id = gl.po_line_id AND po_l.company_id = gl.company_id
         WHERE sil.company_id = $1 AND sil.invoice_id = $2
         ORDER BY sil.line_no ASC;`,
        [companyId, invoiceId]
      );

      const results: LineMatchResult[] = [];
      let worstStatus: MatchStatus = 'matched';
      const statusPriority: Record<MatchStatus, number> = {
        matched: 1,
        grn_only: 2,
        within_tolerance: 3,
        variance_exceeded: 4,
      };

      for (const r of linesRes.rows) {
        const grnQty = toDecimal(r.grnQty, 4);
        const grnUnitCost = toDecimal(r.grnUnitCost, 4);
        const invoiceQty = toDecimal(r.invoiceQty, 4);
        const invoiceUnitCost = toDecimal(r.invoiceUnitCost, 4);
        const poLineId = r.poLineId || null;
        const poUnitCost = r.poUnitCost !== null && r.poUnitCost !== undefined ? toDecimal(r.poUnitCost, 4) : null;

        let status: MatchStatus = 'matched';
        let messageAr = 'مطابق تماماً (3-Way Match)';
        let priceVariancePct = 0;

        if (!poLineId) {
          status = 'grn_only';
          messageAr = 'مطابقة ثنائية (بدون أمر شراء مرتبط)';
        } else if (poUnitCost !== null && poUnitCost > 0) {
          const diff = Math.abs(invoiceUnitCost - poUnitCost);
          priceVariancePct = (diff / poUnitCost) * 100;
          if (diff <= DEFAULT_THREE_WAY_POLICY.priceRoundingAbs) {
            status = 'matched';
            messageAr = 'مطابق لأمر الشراء';
          } else if (priceVariancePct <= DEFAULT_THREE_WAY_POLICY.priceTolerancePct) {
            status = 'within_tolerance';
            messageAr = `فارق السعر (${priceVariancePct.toFixed(2)}%) ضمن نسبة التسامح المسموح بها (${DEFAULT_THREE_WAY_POLICY.priceTolerancePct}%)`;
          } else {
            status = 'variance_exceeded';
            messageAr = `تجاوز فارق السعر (${priceVariancePct.toFixed(2)}%) الحد الأقصى للتسامح (${DEFAULT_THREE_WAY_POLICY.priceTolerancePct}%)`;
          }
        } else {
          const diff = Math.abs(invoiceUnitCost - grnUnitCost);
          priceVariancePct = grnUnitCost > 0 ? (diff / grnUnitCost) * 100 : 0;
          if (diff <= DEFAULT_THREE_WAY_POLICY.priceRoundingAbs) {
            status = 'matched';
            messageAr = 'مطابق لسند الاستلام';
          } else if (priceVariancePct <= DEFAULT_THREE_WAY_POLICY.priceTolerancePct) {
            status = 'within_tolerance';
            messageAr = `فارق السعر عن الاستلام (${priceVariancePct.toFixed(2)}%) ضمن حد التسامح`;
          } else {
            status = 'variance_exceeded';
            messageAr = `تجاوز فارق السعر عن الاستلام (${priceVariancePct.toFixed(2)}%) الحد المسموح`;
          }
        }

        if (statusPriority[status] > statusPriority[worstStatus]) {
          worstStatus = status;
        }

        results.push({
          grnLineId: r.grnLineId,
          itemId: r.itemId,
          itemCode: r.itemCode,
          itemNameAr: r.itemNameAr,
          poLineId,
          poQty: r.poQty !== null ? toDecimal(r.poQty, 4) : null,
          poUnitCost,
          grnQty,
          grnUnitCost,
          invoiceQty,
          invoiceUnitCost,
          qtyVariance: toDecimal(grnQty - invoiceQty, 4),
          priceVariancePct: Number(priceVariancePct.toFixed(2)),
          status,
          messageAr,
        });
      }

      if (results.length === 0) {
        worstStatus = 'matched';
      }

      return {
        invoiceId,
        supplierInvoiceNo: invRow.supplier_invoice_no,
        overallStatus: worstStatus,
        lines: results,
        policy: DEFAULT_THREE_WAY_POLICY,
      };
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultThreeWayMatchService = new ThreeWayMatchService();
