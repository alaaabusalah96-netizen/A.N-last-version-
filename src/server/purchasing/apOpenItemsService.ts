import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { MONEY_SCALE, fromMinorUnits, toMinorUnits } from '../lib/numeric.js';

export interface ApOpenItemRow {
  invoiceId: string;
  companyId: string;
  supplierId: string;
  supplierCode: string;
  supplierNameAr: string;
  supplierInvoiceNo: string;
  invoiceNo: string | null;
  invoiceDate: string;
  dueDate: string | null;
  invoiceTotal: number;
  creditedReturnTotal: number;
  paidPaymentTotal: number;
  remainingOpenAmount: number;
  paymentStatus: 'open' | 'partial' | 'paid';
  agingDays: number;
}

export function computeApOpenAmounts(
  invoiceTotalRaw: unknown,
  creditedReturnTotalRaw: unknown,
  paidPaymentTotalRaw: unknown
): {
  invoiceTotal: number;
  creditedReturnTotal: number;
  paidPaymentTotal: number;
  remainingOpenAmount: number;
  paymentStatus: 'open' | 'partial' | 'paid';
} {
  const invUnits = toMinorUnits(invoiceTotalRaw, MONEY_SCALE);
  const retUnits = toMinorUnits(creditedReturnTotalRaw, MONEY_SCALE);
  const payUnits = toMinorUnits(paidPaymentTotalRaw, MONEY_SCALE);
  const openUnits = invUnits - retUnits - payUnits;

  const invoiceTotal = Number(fromMinorUnits(invUnits, MONEY_SCALE));
  const creditedReturnTotal = Number(fromMinorUnits(retUnits, MONEY_SCALE));
  const paidPaymentTotal = Number(fromMinorUnits(payUnits, MONEY_SCALE));
  const remainingOpenAmount =
    openUnits > BigInt(0) ? Number(fromMinorUnits(openUnits, MONEY_SCALE)) : 0;

  let paymentStatus: 'open' | 'partial' | 'paid' = 'open';
  if (remainingOpenAmount <= 0) {
    paymentStatus = 'paid';
  } else if (paidPaymentTotal > 0 || creditedReturnTotal > 0) {
    paymentStatus = 'partial';
  }

  return {
    invoiceTotal,
    creditedReturnTotal,
    paidPaymentTotal,
    remainingOpenAmount,
    paymentStatus,
  };
}

export class ApOpenItemsService {
  async listOpenItems(companyId: string, supplierId?: string, customExecutor?: DbExecutor): Promise<ApOpenItemRow[]> {
    const run = async (executor: DbExecutor) => {
      const params: any[] = [companyId];
      let supplierClause = '';
      if (supplierId) {
        params.push(supplierId);
        supplierClause = `AND si.supplier_id = $2`;
      }

      const sql = `
        SELECT
          si.id as "invoiceId",
          si.company_id as "companyId",
          si.supplier_id as "supplierId",
          s.code as "supplierCode",
          s.name_ar as "supplierNameAr",
          si.supplier_invoice_no as "supplierInvoiceNo",
          si.invoice_no as "invoiceNo",
          si.invoice_date as "invoiceDate",
          si.due_date as "dueDate",
          COALESCE(inv_totals.invoice_total, 0)::text as "invoiceTotal",
          COALESCE(ret_totals.credited_total, 0)::text as "creditedReturnTotal",
          COALESCE(pay_totals.paid_total, 0)::text as "paidPaymentTotal",
          GREATEST(
            0,
            COALESCE(inv_totals.invoice_total, 0) - COALESCE(ret_totals.credited_total, 0) - COALESCE(pay_totals.paid_total, 0)
          )::text as "remainingOpenAmount",
          COALESCE(invoice_date, CURRENT_DATE) as "invDateRaw"
        FROM purch_supplier_invoices si
        INNER JOIN purch_suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
        LEFT JOIN (
          SELECT invoice_id, SUM(qty * unit_cost) as invoice_total
          FROM purch_supplier_invoice_lines
          WHERE company_id = $1
          GROUP BY invoice_id
        ) inv_totals ON inv_totals.invoice_id = si.id
        LEFT JOIN (
          SELECT pr.invoice_id, SUM(prl.qty * prl.unit_cost) as credited_total
          FROM purch_return_lines prl
          INNER JOIN purch_returns pr ON pr.id = prl.return_id AND pr.company_id = prl.company_id
          WHERE pr.company_id = $1 AND pr.status = 'posted' AND pr.invoice_id IS NOT NULL
          GROUP BY pr.invoice_id
        ) ret_totals ON ret_totals.invoice_id = si.id
        LEFT JOIN (
          SELECT invoice_id, SUM(amount) as paid_total
          FROM purch_supplier_payments
          WHERE company_id = $1 AND status = 'posted'
          GROUP BY invoice_id
        ) pay_totals ON pay_totals.invoice_id = si.id
        WHERE si.company_id = $1 AND si.status = 'posted' ${supplierClause}
        ORDER BY si.invoice_date ASC, si.created_at ASC;
      `;
      const res = await executor.query<any>(sql, params);
      const rows: ApOpenItemRow[] = [];
      const today = new Date();

      for (const r of res.rows) {
        const amounts = computeApOpenAmounts(
          r.invoiceTotal,
          r.creditedReturnTotal,
          r.paidPaymentTotal
        );

        const invDate = new Date(r.invDateRaw);
        const agingDays = Math.max(0, Math.floor((today.getTime() - invDate.getTime()) / (1000 * 60 * 60 * 24)));

        rows.push({
          invoiceId: r.invoiceId,
          companyId: r.companyId,
          supplierId: r.supplierId,
          supplierCode: r.supplierCode,
          supplierNameAr: r.supplierNameAr,
          supplierInvoiceNo: r.supplierInvoiceNo,
          invoiceNo: r.invoiceNo || null,
          invoiceDate: String(r.invoiceDate).slice(0, 10),
          dueDate: r.dueDate ? String(r.dueDate).slice(0, 10) : null,
          invoiceTotal: amounts.invoiceTotal,
          creditedReturnTotal: amounts.creditedReturnTotal,
          paidPaymentTotal: amounts.paidPaymentTotal,
          remainingOpenAmount: amounts.remainingOpenAmount,
          paymentStatus: amounts.paymentStatus,
          agingDays,
        });
      }

      return rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultApOpenItemsService = new ApOpenItemsService();
