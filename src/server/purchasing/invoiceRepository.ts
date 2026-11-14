import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import {
  SupplierInvoice,
  SupplierInvoiceLine,
  CreateSupplierInvoiceInput,
  OutstandingGrnLineRow,
  SupplierInvoiceStatus,
} from './purchasingTypes.js';
import { toMoney } from '../lib/numeric.js';

function toIsoDate(val: unknown): string {
  if (!val) return '';
  if (typeof val === 'string') return val.slice(0, 10);
  return new Date(val as Date).toISOString().slice(0, 10);
}

function toIsoTimestamp(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'string') return val;
  return new Date(val as Date).toISOString();
}

function mapInvoiceHeader(row: any, lines: SupplierInvoiceLine[] = []): SupplierInvoice {
  return {
    id: row.id,
    companyId: row.companyId,
    supplierId: row.supplierId,
    supplierCode: row.supplierCode ?? undefined,
    supplierNameAr: row.supplierNameAr ?? undefined,
    status: row.status as SupplierInvoiceStatus,
    invoiceNo: row.invoiceNo ?? null,
    supplierInvoiceNo: row.supplierInvoiceNo,
    invoiceDate: toIsoDate(row.invoiceDate),
    dueDate: toIsoDate(row.dueDate) || null,
    memo: row.memo ?? null,
    journalEntryId: row.journalEntryId ?? null,
    journalEntryNo: row.journalEntryNo ?? null,
    postedAt: toIsoTimestamp(row.postedAt),
    postedBy: row.postedBy ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: toIsoTimestamp(row.createdAt) || new Date().toISOString(),
    updatedAt: toIsoTimestamp(row.updatedAt) || new Date().toISOString(),
    lines,
  };
}

function mapInvoiceLine(row: any): SupplierInvoiceLine {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    companyId: row.companyId,
    grnLineId: row.grnLineId,
    itemId: row.itemId,
    itemCode: row.itemCode ?? undefined,
    itemNameAr: row.itemNameAr ?? undefined,
    itemUom: row.itemUom ?? undefined,
    qty: toMoney(row.qty),
    unitCost: toMoney(row.unitCost),
    lineNo: Number(row.lineNo || 1),
  };
}

export class InvoiceRepository {
  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<SupplierInvoice[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          si.id,
          si.company_id as "companyId",
          si.supplier_id as "supplierId",
          s.code as "supplierCode",
          s.name_ar as "supplierNameAr",
          si.status,
          si.invoice_no as "invoiceNo",
          si.supplier_invoice_no as "supplierInvoiceNo",
          si.invoice_date as "invoiceDate",
          si.due_date as "dueDate",
          si.memo,
          si.journal_entry_id as "journalEntryId",
          je.entry_no as "journalEntryNo",
          si.posted_at as "postedAt",
          si.posted_by as "postedBy",
          si.created_by as "createdBy",
          si.created_at as "createdAt",
          si.updated_at as "updatedAt"
        FROM purch_supplier_invoices si
        INNER JOIN purch_suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
        LEFT JOIN journal_entries je ON je.id = si.journal_entry_id AND je.company_id = si.company_id
        WHERE si.company_id = $1
        ORDER BY si.created_at DESC;
      `;
      const res = await executor.query(sql, [companyId]);
      if (res.rows.length === 0) return [];

      const invoiceIds = res.rows.map((r: any) => r.id);
      const linesSql = `
        SELECT
          sil.id,
          sil.invoice_id as "invoiceId",
          sil.company_id as "companyId",
          sil.grn_line_id as "grnLineId",
          sil.item_id as "itemId",
          i.code as "itemCode",
          i.name_ar as "itemNameAr",
          i.uom as "itemUom",
          sil.qty,
          sil.unit_cost as "unitCost",
          sil.line_no as "lineNo"
        FROM purch_supplier_invoice_lines sil
        INNER JOIN inv_items i ON i.id = sil.item_id AND i.company_id = sil.company_id
        WHERE sil.company_id = $1 AND sil.invoice_id = ANY($2::uuid[])
        ORDER BY sil.line_no ASC;
      `;
      const linesRes = await executor.query<any>(linesSql, [companyId, invoiceIds]);
      const linesByInvoice = new Map<string, SupplierInvoiceLine[]>();
      for (const lr of linesRes.rows) {
        const invId = lr.invoiceId;
        if (!linesByInvoice.has(invId)) {
          linesByInvoice.set(invId, []);
        }
        linesByInvoice.get(invId)!.push(mapInvoiceLine(lr));
      }

      return res.rows.map((r: any) => mapInvoiceHeader(r, linesByInvoice.get(r.id) || []));
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, id: string, customExecutor?: DbExecutor): Promise<SupplierInvoice | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          si.id,
          si.company_id as "companyId",
          si.supplier_id as "supplierId",
          s.code as "supplierCode",
          s.name_ar as "supplierNameAr",
          si.status,
          si.invoice_no as "invoiceNo",
          si.supplier_invoice_no as "supplierInvoiceNo",
          si.invoice_date as "invoiceDate",
          si.due_date as "dueDate",
          si.memo,
          si.journal_entry_id as "journalEntryId",
          je.entry_no as "journalEntryNo",
          si.posted_at as "postedAt",
          si.posted_by as "postedBy",
          si.created_by as "createdBy",
          si.created_at as "createdAt",
          si.updated_at as "updatedAt"
        FROM purch_supplier_invoices si
        INNER JOIN purch_suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
        LEFT JOIN journal_entries je ON je.id = si.journal_entry_id AND je.company_id = si.company_id
        WHERE si.company_id = $1 AND si.id = $2;
      `;
      const res = await executor.query(sql, [companyId, id]);
      if (res.rows.length === 0) return null;

      const linesSql = `
        SELECT
          sil.id,
          sil.invoice_id as "invoiceId",
          sil.company_id as "companyId",
          sil.grn_line_id as "grnLineId",
          sil.item_id as "itemId",
          i.code as "itemCode",
          i.name_ar as "itemNameAr",
          i.uom as "itemUom",
          sil.qty,
          sil.unit_cost as "unitCost",
          sil.line_no as "lineNo"
        FROM purch_supplier_invoice_lines sil
        INNER JOIN inv_items i ON i.id = sil.item_id AND i.company_id = sil.company_id
        WHERE sil.company_id = $1 AND sil.invoice_id = $2
        ORDER BY sil.line_no ASC;
      `;
      const linesRes = await executor.query(linesSql, [companyId, id]);
      const lines = linesRes.rows.map((lr: any) => mapInvoiceLine(lr));

      return mapInvoiceHeader(res.rows[0], lines);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByIdForUpdate(companyId: string, id: string, tx: DbExecutor): Promise<SupplierInvoice | null> {
    const sql = `
      SELECT
        id,
        company_id as "companyId",
        supplier_id as "supplierId",
        status,
        invoice_no as "invoiceNo",
        supplier_invoice_no as "supplierInvoiceNo",
        invoice_date as "invoiceDate",
        due_date as "dueDate",
        memo,
        journal_entry_id as "journalEntryId",
        posted_at as "postedAt",
        posted_by as "postedBy",
        created_by as "createdBy",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM purch_supplier_invoices
      WHERE company_id = $1 AND id = $2
      FOR UPDATE;
    `;
    const res = await tx.query(sql, [companyId, id]);
    if (res.rows.length === 0) return null;
    return mapInvoiceHeader(res.rows[0]);
  }

  async listOutstandingLines(
    companyId: string,
    supplierId: string,
    customExecutor?: DbExecutor
  ): Promise<OutstandingGrnLineRow[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          gl.id as "grnLineId",
          g.id as "grnId",
          g.grn_no as "grnNo",
          g.supplier_id as "supplierId",
          gl.item_id as "itemId",
          i.code as "itemCode",
          i.name_ar as "itemNameAr",
          i.uom as "itemUom",
          gl.qty as "grnQty",
          gl.unit_cost as "unitCost",
          COALESCE(inv.invoiced_qty, 0) as "invoicedQty",
          (gl.qty - COALESCE(inv.invoiced_qty, 0)) as "remainingQty"
        FROM purch_grn_lines gl
        INNER JOIN purch_grn g ON g.id = gl.grn_id AND g.company_id = gl.company_id
        INNER JOIN inv_items i ON i.id = gl.item_id AND i.company_id = gl.company_id
        LEFT JOIN (
          SELECT grn_line_id, SUM(qty) as invoiced_qty
          FROM purch_supplier_invoice_lines sil
          INNER JOIN purch_supplier_invoices si ON si.id = sil.invoice_id AND si.company_id = sil.company_id
          WHERE si.company_id = $1 AND si.status = 'posted'
          GROUP BY grn_line_id
        ) inv ON inv.grn_line_id = gl.id
        WHERE g.company_id = $1 AND g.supplier_id = $2 AND g.status = 'posted'
          AND (gl.qty - COALESCE(inv.invoiced_qty, 0)) > 0
        ORDER BY g.created_at ASC, gl.line_no ASC;
      `;
      const res = await executor.query(sql, [companyId, supplierId]);
      return res.rows.map((r: any) => ({
        grnLineId: r.grnLineId,
        grnId: r.grnId,
        grnNo: r.grnNo || null,
        supplierId: r.supplierId,
        itemId: r.itemId,
        itemCode: r.itemCode,
        itemNameAr: r.itemNameAr,
        itemUom: r.itemUom,
        grnQty: toMoney(r.grnQty),
        unitCost: toMoney(r.unitCost),
        invoicedQty: toMoney(r.invoicedQty),
        remainingQty: toMoney(r.remainingQty),
      }));
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async createDraft(
    companyId: string,
    input: CreateSupplierInvoiceInput,
    actorId?: string,
    customExecutor?: DbExecutor
  ): Promise<SupplierInvoice> {
    const run = async (executor: DbExecutor) => {
      const headerSql = `
        INSERT INTO purch_supplier_invoices (
          company_id,
          supplier_id,
          status,
          supplier_invoice_no,
          invoice_date,
          due_date,
          memo,
          created_by
        )
        VALUES ($1, $2, 'draft', $3, COALESCE($4::date, CURRENT_DATE), $5::date, $6, $7)
        RETURNING
          id,
          company_id as "companyId",
          supplier_id as "supplierId",
          status,
          invoice_no as "invoiceNo",
          supplier_invoice_no as "supplierInvoiceNo",
          invoice_date as "invoiceDate",
          due_date as "dueDate",
          memo,
          journal_entry_id as "journalEntryId",
          posted_at as "postedAt",
          posted_by as "postedBy",
          created_by as "createdBy",
          created_at as "createdAt",
          updated_at as "updatedAt";
      `;
      const headerRes = await executor.query<any>(headerSql, [
        companyId,
        input.supplierId,
        input.supplierInvoiceNo.trim(),
        input.invoiceDate || null,
        input.dueDate || null,
        input.memo?.trim() || null,
        actorId || null,
      ]);
      const headerRow = headerRes.rows[0];
      const invoiceId = headerRow.id;

      const lines: SupplierInvoiceLine[] = [];
      for (let i = 0; i < input.lines.length; i++) {
        const l = input.lines[i];
        // We need itemId from grn_line
        const grnLineRes = await executor.query<{ itemId: string }>(
          `SELECT item_id as "itemId" FROM purch_grn_lines WHERE id = $1 AND company_id = $2`,
          [l.grnLineId, companyId]
        );
        const itemId = grnLineRes.rows[0]?.itemId;

        const lineSql = `
          INSERT INTO purch_supplier_invoice_lines (
            invoice_id,
            company_id,
            grn_line_id,
            item_id,
            qty,
            unit_cost,
            line_no
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING
            id,
            invoice_id as "invoiceId",
            company_id as "companyId",
            grn_line_id as "grnLineId",
            item_id as "itemId",
            qty,
            unit_cost as "unitCost",
            line_no as "lineNo";
        `;
        const lineRes = await executor.query(lineSql, [
          invoiceId,
          companyId,
          l.grnLineId,
          itemId,
          toMoney(l.qty),
          toMoney(l.unitCost),
          i + 1,
        ]);
        lines.push(mapInvoiceLine(lineRes.rows[0]));
      }

      return mapInvoiceHeader(headerRow, lines);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async markPosted(
    companyId: string,
    id: string,
    invoiceNo: string,
    journalEntryId: string,
    actorId: string,
    tx: DbExecutor
  ): Promise<void> {
    const sql = `
      UPDATE purch_supplier_invoices
      SET
        status = 'posted',
        invoice_no = COALESCE(invoice_no, $3),
        journal_entry_id = $4,
        posted_by = $5,
        posted_at = NOW(),
        updated_at = NOW()
      WHERE company_id = $1 AND id = $2;
    `;
    await tx.query(sql, [companyId, id, invoiceNo, journalEntryId, actorId]);
  }

  async deleteDraft(companyId: string, id: string, customExecutor?: DbExecutor): Promise<void> {
    const run = async (executor: DbExecutor) => {
      await executor.query(
        `DELETE FROM purch_supplier_invoice_lines WHERE company_id = $1 AND invoice_id = $2`,
        [companyId, id]
      );
      await executor.query(
        `DELETE FROM purch_supplier_invoices WHERE company_id = $1 AND id = $2 AND status = 'draft'`,
        [companyId, id]
      );
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultInvoiceRepository = new InvoiceRepository();
