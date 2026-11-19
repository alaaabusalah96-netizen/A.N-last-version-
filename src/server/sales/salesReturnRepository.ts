import { DbExecutor } from '../db/index.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { SalesReturn, SalesReturnLine, SalesReturnStatus } from './salesTypes.js';
import { MONEY_SCALE, fromMinorUnits, toDecimal, toMinorUnits, toMoney } from '../lib/numeric.js';

export interface PersistSalesReturnLineData {
  invoiceLineId: string;
  deliveryLineId: string | null;
  itemId: string;
  qty: string;
  unitPrice: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
  lineNo: number;
}

export interface PersistSalesReturnDraftData {
  customerId: string;
  invoiceId: string;
  warehouseId: string;
  returnDate?: string;
  reason?: string;
  memo?: string;
  subtotal: string;
  taxAmount: string;
  totalAmount: string;
  lines: PersistSalesReturnLineData[];
}

function mapHeaderRow(row: any): SalesReturn {
  return {
    id: row.id,
    companyId: row.company_id,
    customerId: row.customer_id,
    customerCode: row.customer_code || undefined,
    customerNameAr: row.customer_name_ar || undefined,
    invoiceId: row.invoice_id,
    invoiceNo: row.invoice_no || null,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code || undefined,
    warehouseNameAr: row.warehouse_name_ar || undefined,
    returnNo: row.return_no || null,
    returnDate:
      row.return_date instanceof Date
        ? row.return_date.toISOString().slice(0, 10)
        : String(row.return_date).slice(0, 10),
    status: row.status as SalesReturnStatus,
    subtotal: toMoney(row.subtotal ?? 0),
    taxAmount: toMoney(row.tax_amount ?? 0),
    totalAmount: toMoney(row.total_amount ?? 0),
    cogsAmount: toMoney(row.cogs_amount ?? 0),
    reason: row.reason || null,
    memo: row.memo || null,
    journalEntryId: row.journal_entry_id || null,
    journalEntryNo: row.journal_entry_no || null,
    postedAt: row.posted_at
      ? row.posted_at instanceof Date
        ? row.posted_at.toISOString()
        : String(row.posted_at)
      : null,
    postedBy: row.posted_by || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function mapLineRow(row: any): SalesReturnLine {
  const taxUnits = toMinorUnits(row.tax_amount ?? 0, MONEY_SCALE);
  const totalUnits = toMinorUnits(row.line_total ?? 0, MONEY_SCALE);
  const netUnits = totalUnits - taxUnits;

  return {
    id: row.id,
    returnId: row.return_id,
    companyId: row.company_id,
    invoiceLineId: row.invoice_line_id,
    deliveryLineId: row.delivery_line_id || null,
    itemId: row.item_id,
    itemCode: row.item_code || undefined,
    itemNameAr: row.item_name_ar || undefined,
    itemUom: row.item_uom || undefined,
    qty: toDecimal(row.qty ?? 0, 4),
    unitPrice: toDecimal(row.unit_price ?? 0, 4),
    taxRate: toDecimal(row.tax_rate ?? 0, 2),
    taxAmount: toMoney(fromMinorUnits(taxUnits, MONEY_SCALE)),
    lineTotal: toMoney(fromMinorUnits(totalUnits, MONEY_SCALE)),
    netAmount: toMoney(fromMinorUnits(netUnits, MONEY_SCALE)),
    cogsCost: toMoney(row.cogs_cost ?? 0),
    valuationMovementId: row.valuation_movement_id || null,
    lineNo: parseInt(row.line_no, 10) || 1,
  };
}

export class SalesReturnRepository {
  async list(companyId: string, customExecutor?: DbExecutor): Promise<SalesReturn[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          sr.id, sr.company_id, sr.customer_id, sr.invoice_id, sr.warehouse_id,
          sr.return_no, sr.return_date, sr.status, sr.subtotal, sr.tax_amount, sr.total_amount, sr.cogs_amount,
          sr.reason, sr.memo, sr.journal_entry_id, sr.posted_at, sr.posted_by, sr.created_by, sr.created_at, sr.updated_at,
          c.code as customer_code, c.name_ar as customer_name_ar,
          inv.invoice_no as invoice_no,
          w.code as warehouse_code, w.name_ar as warehouse_name_ar,
          je.entry_no as journal_entry_no
        FROM sales_returns sr
        INNER JOIN sales_customers c ON c.id = sr.customer_id AND c.company_id = sr.company_id
        INNER JOIN sales_invoices inv ON inv.id = sr.invoice_id AND inv.company_id = sr.company_id
        INNER JOIN inv_warehouses w ON w.id = sr.warehouse_id AND w.company_id = sr.company_id
        LEFT JOIN journal_entries je ON je.id = sr.journal_entry_id AND je.company_id = sr.company_id
        WHERE sr.company_id = $1
        ORDER BY sr.created_at DESC
      `;
      const res = await executor.query<any>(sql, [companyId]);
      return res.rows.map(mapHeaderRow);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, id: string, customExecutor?: DbExecutor): Promise<SalesReturn | null> {
    const run = async (executor: DbExecutor) => {
      const headerSql = `
        SELECT
          sr.id, sr.company_id, sr.customer_id, sr.invoice_id, sr.warehouse_id,
          sr.return_no, sr.return_date, sr.status, sr.subtotal, sr.tax_amount, sr.total_amount, sr.cogs_amount,
          sr.reason, sr.memo, sr.journal_entry_id, sr.posted_at, sr.posted_by, sr.created_by, sr.created_at, sr.updated_at,
          c.code as customer_code, c.name_ar as customer_name_ar,
          inv.invoice_no as invoice_no,
          w.code as warehouse_code, w.name_ar as warehouse_name_ar,
          je.entry_no as journal_entry_no
        FROM sales_returns sr
        INNER JOIN sales_customers c ON c.id = sr.customer_id AND c.company_id = sr.company_id
        INNER JOIN sales_invoices inv ON inv.id = sr.invoice_id AND inv.company_id = sr.company_id
        INNER JOIN inv_warehouses w ON w.id = sr.warehouse_id AND w.company_id = sr.company_id
        LEFT JOIN journal_entries je ON je.id = sr.journal_entry_id AND je.company_id = sr.company_id
        WHERE sr.company_id = $1 AND sr.id = $2
      `;
      const res = await executor.query<any>(headerSql, [companyId, id]);
      if (res.rows.length === 0) return null;

      const header = mapHeaderRow(res.rows[0]);

      const linesSql = `
        SELECT
          l.id, l.return_id, l.company_id, l.invoice_line_id, l.delivery_line_id, l.item_id,
          l.qty, l.unit_price, l.tax_rate, l.tax_amount, l.line_total, l.cogs_cost, l.valuation_movement_id, l.line_no,
          i.code as item_code, i.name_ar as item_name_ar, i.uom as item_uom
        FROM sales_return_lines l
        INNER JOIN inv_items i ON i.id = l.item_id AND i.company_id = l.company_id
        WHERE l.company_id = $1 AND l.return_id = $2
        ORDER BY l.line_no ASC
      `;
      const linesRes = await executor.query<any>(linesSql, [companyId, id]);
      header.lines = linesRes.rows.map(mapLineRow);
      return header;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByIdForUpdate(
    companyId: string,
    id: string,
    executor: DbExecutor
  ): Promise<{
    id: string;
    status: SalesReturnStatus;
    customerId: string;
    invoiceId: string;
    warehouseId: string;
    subtotal: number;
    taxAmount: number;
    totalAmount: number;
  } | null> {
    const sql = `
      SELECT id, status, customer_id as "customerId", invoice_id as "invoiceId", warehouse_id as "warehouseId",
             subtotal, tax_amount as "taxAmount", total_amount as "totalAmount"
      FROM sales_returns
      WHERE company_id = $1 AND id = $2
      FOR UPDATE
    `;
    const res = await executor.query<any>(sql, [companyId, id]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      status: row.status as SalesReturnStatus,
      customerId: row.customerId,
      invoiceId: row.invoiceId,
      warehouseId: row.warehouseId,
      subtotal: toMoney(row.subtotal ?? 0),
      taxAmount: toMoney(row.taxAmount ?? 0),
      totalAmount: toMoney(row.totalAmount ?? 0),
    };
  }

  async createDraft(
    companyId: string,
    data: PersistSalesReturnDraftData,
    actorUserId?: string,
    customExecutor?: DbExecutor
  ): Promise<SalesReturn> {
    const run = async (executor: DbExecutor) => {
      const headerSql = `
        INSERT INTO sales_returns (
          company_id, customer_id, invoice_id, warehouse_id,
          return_date, reason, memo, subtotal, tax_amount, total_amount, status, created_by
        )
        VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7, $8, $9, $10, 'draft', $11)
        RETURNING id
      `;
      const headerRes = await executor.query<any>(headerSql, [
        companyId,
        data.customerId,
        data.invoiceId,
        data.warehouseId,
        data.returnDate || null,
        data.reason?.trim() || null,
        data.memo?.trim() || null,
        data.subtotal,
        data.taxAmount,
        data.totalAmount,
        actorUserId || null,
      ]);
      const returnId = headerRes.rows[0].id;

      for (const line of data.lines) {
        await executor.query(
          `INSERT INTO sales_return_lines (
             company_id, return_id, invoice_line_id, delivery_line_id, item_id,
             qty, unit_price, tax_rate, tax_amount, line_total, line_no
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            companyId,
            returnId,
            line.invoiceLineId,
            line.deliveryLineId || null,
            line.itemId,
            line.qty,
            line.unitPrice,
            line.taxRate,
            line.taxAmount,
            line.lineTotal,
            line.lineNo,
          ]
        );
      }

      const created = await this.findById(companyId, returnId, executor);
      return created!;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async updateLineComputedValues(
    companyId: string,
    lineId: string,
    taxAmount: string,
    lineTotal: string,
    cogsCost: string,
    valuationMovementId: string | null,
    executor: DbExecutor
  ): Promise<void> {
    await executor.query(
      `UPDATE sales_return_lines
       SET tax_amount = $3, line_total = $4, cogs_cost = $5, valuation_movement_id = $6
       WHERE company_id = $1 AND id = $2`,
      [companyId, lineId, taxAmount, lineTotal, cogsCost, valuationMovementId]
    );
  }

  async markPosted(
    companyId: string,
    id: string,
    returnNo: string,
    journalEntryId: string,
    subtotal: string,
    taxAmount: string,
    totalAmount: string,
    cogsAmount: string,
    postedBy?: string,
    customExecutor?: DbExecutor
  ): Promise<void> {
    const run = async (executor: DbExecutor) => {
      await executor.query(
        `UPDATE sales_returns
         SET
           status = 'posted',
           return_no = $3,
           journal_entry_id = $4,
           subtotal = $5,
           tax_amount = $6,
           total_amount = $7,
           cogs_amount = $8,
           posted_at = NOW(),
           posted_by = $9,
           updated_at = NOW()
         WHERE company_id = $1 AND id = $2`,
        [
          companyId,
          id,
          returnNo,
          journalEntryId,
          subtotal,
          taxAmount,
          totalAmount,
          cogsAmount,
          postedBy || null,
        ]
      );
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async delete(companyId: string, id: string, customExecutor?: DbExecutor): Promise<boolean> {
    const run = async (executor: DbExecutor) => {
      const sql = `DELETE FROM sales_returns WHERE company_id = $1 AND id = $2 AND status = 'draft' RETURNING id`;
      const res = await executor.query<any>(sql, [companyId, id]);
      return res.rows.length > 0;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultSalesReturnRepository = new SalesReturnRepository();
