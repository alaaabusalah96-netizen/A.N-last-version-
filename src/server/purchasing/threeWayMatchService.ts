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

export interface EvaluateLineMatchInput {
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
}

export function evaluateThreeWayLineMatch(
  input: EvaluateLineMatchInput,
  policy: ThreeWayMatchPolicy = DEFAULT_THREE_WAY_POLICY
): LineMatchResult {
  const grnQty = toDecimal(input.grnQty, 4);
  const grnUnitCost = toDecimal(input.grnUnitCost, 4);
  const invoiceQty = toDecimal(input.invoiceQty, 4);
  const invoiceUnitCost = toDecimal(input.invoiceUnitCost, 4);
  const poLineId = input.poLineId || null;
  const poQty = input.poQty !== null && input.poQty !== undefined ? toDecimal(input.poQty, 4) : null;
  const poUnitCost = input.poUnitCost !== null && input.poUnitCost !== undefined ? toDecimal(input.poUnitCost, 4) : null;

  const qtyVariance = toDecimal(grnQty - invoiceQty, 4);
  const exceedsGrnOver =
    policy.qtyTolerancePct > 0
      ? invoiceQty > grnQty * (1 + policy.qtyTolerancePct / 100)
      : invoiceQty > grnQty;
  const exceedsPoQty = poQty !== null && invoiceQty > poQty;
  const qtyExceeded = exceedsGrnOver || exceedsPoQty;

  const hasPoRef = Boolean(poLineId && poUnitCost !== null);
  const refUnitCost = hasPoRef ? (poUnitCost as number) : grnUnitCost;
  const priceDiff = Math.abs(invoiceUnitCost - refUnitCost);
  const priceVariancePct =
    refUnitCost > 0
      ? (priceDiff / refUnitCost) * 100
      : (priceDiff > policy.priceRoundingAbs ? 100 : 0);

  const priceWithinRounding = priceDiff <= policy.priceRoundingAbs;
  const priceWithinTolerance = !priceWithinRounding && priceVariancePct <= policy.priceTolerancePct;
  const priceExceeded = !priceWithinRounding && !priceWithinTolerance;

  let status: MatchStatus;
  let messageAr: string;

  if (qtyExceeded && priceExceeded) {
    status = 'variance_exceeded';
    messageAr = exceedsPoQty && exceedsGrnOver
      ? `تجاوزت الكمية المفوترة (${invoiceQty}) كمية الاستلام (${grnQty}) وكمية أمر الشراء (${poQty}) وفارق السعر (${priceVariancePct.toFixed(2)}%)`
      : exceedsPoQty
      ? `تجاوزت الكمية المفوترة (${invoiceQty}) كمية أمر الشراء (${poQty}) وفارق السعر (${priceVariancePct.toFixed(2)}%)`
      : `تجاوزت الكمية المفوترة (${invoiceQty}) كمية الاستلام (${grnQty}) وفارق السعر (${priceVariancePct.toFixed(2)}%) حدود التسامح المسموح بها`;
  } else if (qtyExceeded) {
    status = 'variance_exceeded';
    messageAr = exceedsPoQty && exceedsGrnOver
      ? `تجاوزت الكمية المفوترة (${invoiceQty}) كمية الاستلام (${grnQty}) وكمية أمر الشراء (${poQty})`
      : exceedsPoQty
      ? `تجاوزت الكمية المفوترة (${invoiceQty}) كمية أمر الشراء المعتمدة (${poQty})`
      : `تجاوزت الكمية المفوترة (${invoiceQty}) كمية الاستلام المسموح بها (${grnQty})`;
  } else if (priceExceeded) {
    status = 'variance_exceeded';
    messageAr = hasPoRef
      ? `تجاوز فارق السعر (${priceVariancePct.toFixed(2)}%) الحد الأقصى للتسامح (${policy.priceTolerancePct}%)`
      : `تجاوز فارق السعر عن الاستلام (${priceVariancePct.toFixed(2)}%) الحد المسموح (${policy.priceTolerancePct}%)`;
  } else if (priceWithinTolerance) {
    status = 'within_tolerance';
    messageAr = hasPoRef
      ? `فارق السعر (${priceVariancePct.toFixed(2)}%) ضمن نسبة التسامح المسموح بها (${policy.priceTolerancePct}%)`
      : `فارق السعر عن الاستلام (${priceVariancePct.toFixed(2)}%) ضمن حد التسامح (${policy.priceTolerancePct}%)`;
  } else if (!poLineId) {
    status = 'grn_only';
    messageAr = 'مطابقة ثنائية (بدون أمر شراء مرتبط)';
  } else {
    status = 'matched';
    messageAr = 'مطابق لأمر الشراء وسند الاستلام';
  }

  return {
    grnLineId: input.grnLineId,
    itemId: input.itemId,
    itemCode: input.itemCode,
    itemNameAr: input.itemNameAr,
    poLineId,
    poQty,
    poUnitCost,
    grnQty,
    grnUnitCost,
    invoiceQty,
    invoiceUnitCost,
    qtyVariance,
    priceVariancePct: Number(priceVariancePct.toFixed(2)),
    status,
    messageAr,
  };
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
         INNER JOIN purch_grn_lines gl ON gl.id = sil.grn_line_id AND gl.company_id = sil.company_id
         LEFT JOIN purch_po_lines po_l ON po_l.id = gl.po_line_id AND po_l.company_id = sil.company_id
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
        const lineResult = evaluateThreeWayLineMatch(
          {
            grnLineId: r.grnLineId,
            itemId: r.itemId,
            itemCode: r.itemCode,
            itemNameAr: r.itemNameAr,
            poLineId: r.poLineId || null,
            poQty: r.poQty !== null && r.poQty !== undefined ? toDecimal(r.poQty, 4) : null,
            poUnitCost: r.poUnitCost !== null && r.poUnitCost !== undefined ? toDecimal(r.poUnitCost, 4) : null,
            grnQty: toDecimal(r.grnQty, 4),
            grnUnitCost: toDecimal(r.grnUnitCost, 4),
            invoiceQty: toDecimal(r.invoiceQty, 4),
            invoiceUnitCost: toDecimal(r.invoiceUnitCost, 4),
          },
          DEFAULT_THREE_WAY_POLICY
        );

        if (statusPriority[lineResult.status] > statusPriority[worstStatus]) {
          worstStatus = lineResult.status;
        }

        results.push(lineResult);
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
