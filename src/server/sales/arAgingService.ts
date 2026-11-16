import { DbExecutor } from '../db/index.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { ArAgingReport, ArAgingItem, ArCustomerAgingSummary } from './salesTypes.js';
import { ValidationError } from '../http/errors.js';

export class ArAgingService {
  async getAgingReport(companyId: string, customExecutor?: DbExecutor): Promise<ArAgingReport> {
    if (!companyId) throw new ValidationError('companyId is required');

    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          i.id as "invoiceId",
          i.invoice_no as "invoiceNo",
          i.invoice_date as "invoiceDate",
          i.due_date as "dueDate",
          i.customer_id as "customerId",
          c.code as "customerCode",
          c.name_ar as "customerNameAr",
          i.total_amount as "invoiceTotal",
          COALESCE(col.total, 0) as "collectedAmount",
          ROUND((i.total_amount - COALESCE(col.total, 0))::numeric, 2) as "remainingOpenAmount",
          GREATEST(0, (CURRENT_DATE - COALESCE(i.due_date, i.invoice_date)))::int as "agingDays"
        FROM sales_invoices i
        INNER JOIN sales_customers c ON c.id = i.customer_id AND c.company_id = i.company_id
        LEFT JOIN (
          SELECT invoice_id, SUM(amount) as total
          FROM sales_collections
          WHERE company_id = $1 AND status = 'posted'
          GROUP BY invoice_id
        ) col ON col.invoice_id = i.id
        WHERE i.company_id = $1 AND i.status = 'posted'
          AND ROUND((i.total_amount - COALESCE(col.total, 0))::numeric, 2) > 0
        ORDER BY "agingDays" DESC, i.invoice_date ASC
      `;

      const res = await executor.query<any>(sql, [companyId]);

      const items: ArAgingItem[] = [];
      const customerMap = new Map<string, ArCustomerAgingSummary>();

      let grandTotalOpen = 0;
      let grandTotal0To30 = 0;
      let grandTotal31To60 = 0;
      let grandTotal61Plus = 0;

      for (const row of res.rows) {
        const remainingOpen = parseFloat(row.remainingOpenAmount || '0');
        const agingDays = parseInt(row.agingDays, 10) || 0;

        let bucket: '0-30' | '31-60' | '61+' = '0-30';
        if (agingDays > 60) {
          bucket = '61+';
          grandTotal61Plus += remainingOpen;
        } else if (agingDays > 30) {
          bucket = '31-60';
          grandTotal31To60 += remainingOpen;
        } else {
          bucket = '0-30';
          grandTotal0To30 += remainingOpen;
        }

        grandTotalOpen += remainingOpen;

        const item: ArAgingItem = {
          invoiceId: row.invoiceId,
          invoiceNo: row.invoiceNo || row.invoiceId.slice(0, 8),
          invoiceDate: row.invoiceDate instanceof Date ? row.invoiceDate.toISOString().slice(0, 10) : String(row.invoiceDate).slice(0, 10),
          dueDate: row.dueDate ? (row.dueDate instanceof Date ? row.dueDate.toISOString().slice(0, 10) : String(row.dueDate).slice(0, 10)) : null,
          customerId: row.customerId,
          customerCode: row.customerCode,
          customerNameAr: row.customerNameAr,
          invoiceTotal: parseFloat(row.invoiceTotal || '0'),
          collectedAmount: parseFloat(row.collectedAmount || '0'),
          remainingOpenAmount: remainingOpen,
          agingDays,
          bucket,
        };
        items.push(item);

        let summary = customerMap.get(row.customerId);
        if (!summary) {
          summary = {
            customerId: row.customerId,
            customerCode: row.customerCode,
            customerNameAr: row.customerNameAr,
            totalOpenAmount: 0,
            bucket0To30: 0,
            bucket31To60: 0,
            bucket61Plus: 0,
            invoiceCount: 0,
          };
          customerMap.set(row.customerId, summary);
        }

        summary.totalOpenAmount += remainingOpen;
        summary.invoiceCount += 1;
        if (bucket === '0-30') summary.bucket0To30 += remainingOpen;
        else if (bucket === '31-60') summary.bucket31To60 += remainingOpen;
        else summary.bucket61Plus += remainingOpen;
      }

      return {
        items,
        customerSummaries: Array.from(customerMap.values()),
        grandTotalOpen: Math.round(grandTotalOpen * 100) / 100,
        grandTotal0To30: Math.round(grandTotal0To30 * 100) / 100,
        grandTotal31To60: Math.round(grandTotal31To60 * 100) / 100,
        grandTotal61Plus: Math.round(grandTotal61Plus * 100) / 100,
      };
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultArAgingService = new ArAgingService();
