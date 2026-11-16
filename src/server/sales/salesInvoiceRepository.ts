import { DbExecutor } from '../db/index.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { SalesInvoice, SalesInvoiceLine, CreateSalesInvoiceInput } from './salesTypes.js';

function mapHeaderRow(row: any): SalesInvoice {
  return {
    id: row.id,
    companyId: row.company_id,
    customerId: row.customer_id,
    customerCode: row.customer_code,
    customerNameAr: row.customer_name_ar,
    deliveryId: row.delivery_id || null,
    deliveryNo: row.delivery_no || null,
    invoiceNo: row.invoice_no || null,
    invoiceDate: row.invoice_date instanceof Date ? row.invoice_date.toISOString().slice(0, 10) : String(row.invoice_date).slice(0, 10),
    dueDate: row.due_date ? (row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : String(row.due_date).slice(0, 10)) : null,
    status: row.status,
    subtotal: parseFloat(row.subtotal || '0'),
    taxAmount: parseFloat(row.tax_amount || '0'),
    totalAmount: parseFloat(row.total_amount || '0'),
    memo: row.memo || null,
    journalEntryId: row.journal_entry_id || null,
    journalEntryNo: row.journal_entry_no || null,
    postedAt: row.posted_at ? (row.posted_at instanceof Date ? row.posted_at.toISOString() : String(row.posted_at)) : null,
    postedBy: row.posted_by || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function mapLineRow(row: any): SalesInvoiceLine {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    companyId: row.company_id,
    itemId: row.item_id,
    itemCode: row.item_code,
    itemNameAr: row.item_name_ar,
    itemUom: row.item_uom,
    deliveryLineId: row.delivery_line_id || null,
    qty: parseFloat(row.qty || '0'),
    unitPrice: parseFloat(row.unit_price || '0'),
    taxRate: parseFloat(row.tax_rate || '0'),
    taxAmount: parseFloat(row.tax_amount || '0'),
    lineTotal: parseFloat(row.line_total || '0'),
    lineNo: parseInt(row.line_no, 10) || 1,
  };
}

export class SalesInvoiceRepository {
  async list(companyId: string, customExecutor?: DbExecutor): Promise<SalesInvoice[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          i.id, i.company_id, i.customer_id, i.delivery_id, i.invoice_no, i.invoice_date, i.due_date,
          i.status, i.subtotal, i.tax_amount, i.total_amount, i.memo, i.journal_entry_id,
          i.posted_at, i.posted_by, i.created_by, i.created_at, i.updated_at,
          c.code as customer_code, c.name_ar as customer_name_ar,
          d.delivery_no as delivery_no,
          je.entry_no as journal_entry_no
        FROM sales_invoices i
        INNER JOIN sales_customers c ON c.id = i.customer_id AND c.company_id = i.company_id
        LEFT JOIN sales_delivery_notes d ON d.id = i.delivery_id AND d.company_id = i.company_id
        LEFT JOIN journal_entries je ON je.id = i.journal_entry_id AND je.company_id = i.company_id
        WHERE i.company_id = $1
        ORDER BY i.created_at DESC
      `;
      const res = await executor.query<any>(sql, [companyId]);
      return res.rows.map(mapHeaderRow);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, id: string, customExecutor?: DbExecutor): Promise<SalesInvoice | null> {
    const run = async (executor: DbExecutor) => {
      const headerSql = `
        SELECT 
          i.id, i.company_id, i.customer_id, i.delivery_id, i.invoice_no, i.invoice_date, i.due_date,
          i.status, i.subtotal, i.tax_amount, i.total_amount, i.memo, i.journal_entry_id,
          i.posted_at, i.posted_by, i.created_by, i.created_at, i.updated_at,
          c.code as customer_code, c.name_ar as customer_name_ar,
          d.delivery_no as delivery_no,
          je.entry_no as journal_entry_no
        FROM sales_invoices i
        INNER JOIN sales_customers c ON c.id = i.customer_id AND c.company_id = i.company_id
        LEFT JOIN sales_delivery_notes d ON d.id = i.delivery_id AND d.company_id = i.company_id
        LEFT JOIN journal_entries je ON je.id = i.journal_entry_id AND je.company_id = i.company_id
        WHERE i.company_id = $1 AND i.id = $2
      `;
      const res = await executor.query<any>(headerSql, [companyId, id]);
      if (res.rows.length === 0) return null;

      const header = mapHeaderRow(res.rows[0]);

      const linesSql = `
        SELECT 
          l.id, l.invoice_id, l.company_id, l.item_id, l.delivery_line_id, l.qty, l.unit_price,
          l.tax_rate, l.tax_amount, l.line_total, l.line_no,
          i.code as item_code, i.name_ar as item_name_ar, i.uom as item_uom
        FROM sales_invoice_lines l
        INNER JOIN inv_items i ON i.id = l.item_id AND i.company_id = l.company_id
        WHERE l.company_id = $1 AND l.invoice_id = $2
        ORDER BY l.line_no ASC
      `;
      const linesRes = await executor.query<any>(linesSql, [companyId, id]);
      header.lines = linesRes.rows.map(mapLineRow);
      return header;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByIdForUpdate(companyId: string, id: string, executor: DbExecutor): Promise<{ id: string; status: string; totalAmount: number } | null> {
    const sql = `
      SELECT id, status, total_amount as "totalAmount"
      FROM sales_invoices
      WHERE company_id = $1 AND id = $2
      FOR UPDATE
    `;
    const res = await executor.query<any>(sql, [companyId, id]);
    if (res.rows.length === 0) return null;
    return {
      id: res.rows[0].id,
      status: res.rows[0].status,
      totalAmount: parseFloat(res.rows[0].totalAmount || '0'),
    };
  }

  async createDraft(companyId: string, input: CreateSalesInvoiceInput, actorUserId?: string, customExecutor?: DbExecutor): Promise<SalesInvoice> {
    const run = async (executor: DbExecutor) => {
      let subtotal = 0;
      let taxAmount = 0;

      const computedLines = input.lines.map((l, idx) => {
        const qty = l.qty;
        const unitPrice = l.unitPrice;
        const lineSubtotal = qty * unitPrice;
        const taxRate = l.taxRate ?? 0;
        const lineTax = (lineSubtotal * taxRate) / 100;
        const lineTotal = lineSubtotal + lineTax;

        subtotal += lineSubtotal;
        taxAmount += lineTax;

        return {
          ...l,
          taxRate,
          taxAmount: lineTax,
          lineTotal,
          lineNo: idx + 1,
        };
      });

      const totalAmount = subtotal + taxAmount;

      const headerSql = `
        INSERT INTO sales_invoices (
          company_id, customer_id, delivery_id, invoice_date, due_date, memo,
          subtotal, tax_amount, total_amount, status, created_by
        )
        VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7, $8, $9, 'draft', $10)
        RETURNING id
      `;
      const headerRes = await executor.query<any>(headerSql, [
        companyId,
        input.customerId,
        input.deliveryId || null,
        input.invoiceDate || null,
        input.dueDate || null,
        input.memo?.trim() || null,
        subtotal,
        taxAmount,
        totalAmount,
        actorUserId || null,
      ]);
      const invoiceId = headerRes.rows[0].id;

      for (const line of computedLines) {
        const lineSql = `
          INSERT INTO sales_invoice_lines (
            company_id, invoice_id, item_id, delivery_line_id, qty, unit_price,
            tax_rate, tax_amount, line_total, line_no
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `;
        await executor.query(lineSql, [
          companyId,
          invoiceId,
          line.itemId,
          line.deliveryLineId || null,
          line.qty,
          line.unitPrice,
          line.taxRate,
          line.taxAmount,
          line.lineTotal,
          line.lineNo,
        ]);
      }

      const created = await this.findById(companyId, invoiceId, executor);
      return created!;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async markPosted(
    companyId: string,
    id: string,
    invoiceNo: string,
    journalEntryId: string,
    postedBy?: string,
    customExecutor?: DbExecutor
  ): Promise<void> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        UPDATE sales_invoices
        SET
          status = 'posted',
          invoice_no = $3,
          journal_entry_id = $4,
          posted_at = NOW(),
          posted_by = $5,
          updated_at = NOW()
        WHERE company_id = $1 AND id = $2
      `;
      await executor.query(sql, [companyId, id, invoiceNo, journalEntryId, postedBy || null]);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async delete(companyId: string, id: string, customExecutor?: DbExecutor): Promise<boolean> {
    const run = async (executor: DbExecutor) => {
      const sql = `DELETE FROM sales_invoices WHERE company_id = $1 AND id = $2 AND status = 'draft' RETURNING id`;
      const res = await executor.query<any>(sql, [companyId, id]);
      return res.rows.length > 0;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async listOutstandingInvoices(companyId: string, customerId?: string, customExecutor?: DbExecutor): Promise<any[]> {
    const run = async (executor: DbExecutor) => {
      const params: any[] = [companyId];
      let customerFilter = '';
      if (customerId) {
        params.push(customerId);
        customerFilter = 'AND i.customer_id = $2';
      }

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
          ROUND((i.total_amount - COALESCE(col.total, 0))::numeric, 2) as "remainingOpenAmount"
        FROM sales_invoices i
        INNER JOIN sales_customers c ON c.id = i.customer_id AND c.company_id = i.company_id
        LEFT JOIN (
          SELECT invoice_id, SUM(amount) as total
          FROM sales_collections
          WHERE company_id = $1 AND status = 'posted'
          GROUP BY invoice_id
        ) col ON col.invoice_id = i.id
        WHERE i.company_id = $1 AND i.status = 'posted' ${customerFilter}
          AND ROUND((i.total_amount - COALESCE(col.total, 0))::numeric, 2) > 0
        ORDER BY i.invoice_date ASC
      `;
      const res = await executor.query<any>(sql, params);
      return res.rows.map((r) => ({
        ...r,
        invoiceTotal: parseFloat(r.invoiceTotal || '0'),
        collectedAmount: parseFloat(r.collectedAmount || '0'),
        remainingOpenAmount: parseFloat(r.remainingOpenAmount || '0'),
      }));
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultSalesInvoiceRepository = new SalesInvoiceRepository();
