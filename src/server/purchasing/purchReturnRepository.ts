import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { toDecimal } from '../lib/numeric.js';
import { toCalendarDate } from '../lib/calendarDate.js';

export interface PurchReturnLine {
  id: string;
  returnId: string;
  companyId: string;
  grnLineId: string;
  invoiceLineId?: string | null;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  itemUom?: string;
  qty: number;
  unitCost: number;
  lineNo: number;
}

export interface PurchReturnHeader {
  id: string;
  companyId: string;
  supplierId: string;
  supplierCode?: string;
  supplierNameAr?: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  grnId: string;
  grnNo?: string | null;
  invoiceId?: string | null;
  returnNo?: string | null;
  returnDate: string;
  status: 'draft' | 'posted' | 'cancelled';
  reason?: string | null;
  memo?: string | null;
  journalEntryId?: string | null;
  journalEntryNo?: string | null;
  postedAt?: string | null;
  postedBy?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: PurchReturnLine[];
}

export interface CreatePurchReturnLineInput {
  grnLineId: string;
  qty: number;
  unitCost: number;
}

export interface CreatePurchReturnInput {
  supplierId: string;
  warehouseId: string;
  grnId: string;
  invoiceId?: string;
  returnDate?: string;
  reason?: string;
  memo?: string;
  lines: CreatePurchReturnLineInput[];
}

export interface ReturnableGrnLineRow {
  grnLineId: string;
  grnId: string;
  grnNo: string | null;
  supplierId: string;
  warehouseId: string;
  itemId: string;
  itemCode: string;
  itemNameAr: string;
  itemUom: string;
  grnQty: number;
  unitCost: number;
  alreadyReturnedQty: number;
  returnableQty: number;
}

function toIsoDate(val: unknown): string {
  return toCalendarDate(val);
}

function toIsoTimestamp(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'string') return val;
  return new Date(val as Date).toISOString();
}

function mapReturnHeader(row: any, lines: PurchReturnLine[] = []): PurchReturnHeader {
  return {
    id: row.id,
    companyId: row.companyId,
    supplierId: row.supplierId,
    supplierCode: row.supplierCode ?? undefined,
    supplierNameAr: row.supplierNameAr ?? undefined,
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouseCode ?? undefined,
    warehouseNameAr: row.warehouseNameAr ?? undefined,
    grnId: row.grnId,
    grnNo: row.grnNo ?? null,
    invoiceId: row.invoiceId ?? null,
    returnNo: row.returnNo ?? null,
    returnDate: toIsoDate(row.returnDate),
    status: row.status as 'draft' | 'posted' | 'cancelled',
    reason: row.reason ?? null,
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

function mapReturnLine(row: any): PurchReturnLine {
  return {
    id: row.id,
    returnId: row.returnId,
    companyId: row.companyId,
    grnLineId: row.grnLineId,
    itemId: row.itemId,
    itemCode: row.itemCode ?? undefined,
    itemNameAr: row.itemNameAr ?? undefined,
    itemUom: row.itemUom ?? undefined,
    qty: toDecimal(row.qty, 4),
    unitCost: toDecimal(row.unitCost, 4),
    lineNo: Number(row.lineNo || 1),
  };
}

export class PurchReturnRepository {
  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<PurchReturnHeader[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          pr.id,
          pr.company_id as "companyId",
          pr.supplier_id as "supplierId",
          s.code as "supplierCode",
          s.name_ar as "supplierNameAr",
          pr.warehouse_id as "warehouseId",
          w.code as "warehouseCode",
          w.name_ar as "warehouseNameAr",
          pr.grn_id as "grnId",
          g.grn_no as "grnNo",
          pr.invoice_id as "invoiceId",
          pr.return_no as "returnNo",
          pr.return_date::text as "returnDate",
          pr.status,
          pr.reason,
          pr.memo,
          pr.journal_entry_id as "journalEntryId",
          je.entry_no as "journalEntryNo",
          pr.posted_at as "postedAt",
          pr.posted_by as "postedBy",
          pr.created_by as "createdBy",
          pr.created_at as "createdAt",
          pr.updated_at as "updatedAt"
        FROM purch_returns pr
        INNER JOIN purch_suppliers s ON s.id = pr.supplier_id AND s.company_id = pr.company_id
        INNER JOIN inv_warehouses w ON w.id = pr.warehouse_id AND w.company_id = pr.company_id
        INNER JOIN purch_grn g ON g.id = pr.grn_id AND g.company_id = pr.company_id
        LEFT JOIN journal_entries je ON je.id = pr.journal_entry_id AND je.company_id = pr.company_id
        WHERE pr.company_id = $1
        ORDER BY pr.created_at DESC;
      `;
      const res = await executor.query<any>(sql, [companyId]);
      if (res.rows.length === 0) return [];

      const returnIds = res.rows.map((r: any) => r.id);
      const linesSql = `
        SELECT
          prl.id,
          prl.return_id as "returnId",
          prl.company_id as "companyId",
          prl.grn_line_id as "grnLineId",
          prl.item_id as "itemId",
          i.code as "itemCode",
          i.name_ar as "itemNameAr",
          i.uom as "itemUom",
          prl.qty,
          prl.unit_cost as "unitCost",
          prl.line_no as "lineNo"
        FROM purch_return_lines prl
        INNER JOIN inv_items i ON i.id = prl.item_id AND i.company_id = prl.company_id
        WHERE prl.company_id = $1 AND prl.return_id = ANY($2::uuid[])
        ORDER BY prl.line_no ASC;
      `;
      const linesRes = await executor.query<any>(linesSql, [companyId, returnIds]);
      const linesByReturn = new Map<string, PurchReturnLine[]>();
      for (const lr of linesRes.rows) {
        const retId = lr.returnId;
        if (!linesByReturn.has(retId)) {
          linesByReturn.set(retId, []);
        }
        linesByReturn.get(retId)!.push(mapReturnLine(lr));
      }

      return res.rows.map((r: any) => mapReturnHeader(r, linesByReturn.get(r.id) || []));
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, id: string, customExecutor?: DbExecutor): Promise<PurchReturnHeader | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          pr.id,
          pr.company_id as "companyId",
          pr.supplier_id as "supplierId",
          s.code as "supplierCode",
          s.name_ar as "supplierNameAr",
          pr.warehouse_id as "warehouseId",
          w.code as "warehouseCode",
          w.name_ar as "warehouseNameAr",
          pr.grn_id as "grnId",
          g.grn_no as "grnNo",
          pr.invoice_id as "invoiceId",
          pr.return_no as "returnNo",
          pr.return_date::text as "returnDate",
          pr.status,
          pr.reason,
          pr.memo,
          pr.journal_entry_id as "journalEntryId",
          je.entry_no as "journalEntryNo",
          pr.posted_at as "postedAt",
          pr.posted_by as "postedBy",
          pr.created_by as "createdBy",
          pr.created_at as "createdAt",
          pr.updated_at as "updatedAt"
        FROM purch_returns pr
        INNER JOIN purch_suppliers s ON s.id = pr.supplier_id AND s.company_id = pr.company_id
        INNER JOIN inv_warehouses w ON w.id = pr.warehouse_id AND w.company_id = pr.company_id
        INNER JOIN purch_grn g ON g.id = pr.grn_id AND g.company_id = pr.company_id
        LEFT JOIN journal_entries je ON je.id = pr.journal_entry_id AND je.company_id = pr.company_id
        WHERE pr.company_id = $1 AND pr.id = $2;
      `;
      const res = await executor.query<any>(sql, [companyId, id]);
      if (res.rows.length === 0) return null;

      const linesSql = `
        SELECT
          prl.id,
          prl.return_id as "returnId",
          prl.company_id as "companyId",
          prl.grn_line_id as "grnLineId",
          prl.item_id as "itemId",
          i.code as "itemCode",
          i.name_ar as "itemNameAr",
          i.uom as "itemUom",
          prl.qty,
          prl.unit_cost as "unitCost",
          prl.line_no as "lineNo"
        FROM purch_return_lines prl
        INNER JOIN inv_items i ON i.id = prl.item_id AND i.company_id = prl.company_id
        WHERE prl.company_id = $1 AND prl.return_id = $2
        ORDER BY prl.line_no ASC;
      `;
      const linesRes = await executor.query<any>(linesSql, [companyId, id]);
      const lines = linesRes.rows.map((lr: any) => mapReturnLine(lr));

      return mapReturnHeader(res.rows[0], lines);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByIdForUpdate(companyId: string, id: string, tx: DbExecutor): Promise<PurchReturnHeader | null> {
    const sql = `
      SELECT
        id,
        company_id as "companyId",
        supplier_id as "supplierId",
        warehouse_id as "warehouseId",
        grn_id as "grnId",
        invoice_id as "invoiceId",
        status,
        return_date::text as "returnDate",
        return_no as "returnNo"
      FROM purch_returns
      WHERE company_id = $1 AND id = $2
      FOR UPDATE;
    `;
    const res = await tx.query<any>(sql, [companyId, id]);
    if (res.rows.length === 0) return null;
    return mapReturnHeader(res.rows[0]);
  }

  async listReturnableGrnLines(
    companyId: string,
    supplierId?: string,
    customExecutor?: DbExecutor
  ): Promise<ReturnableGrnLineRow[]> {
    const run = async (executor: DbExecutor) => {
      const params: any[] = [companyId];
      let supplierFilter = '';
      if (supplierId) {
        params.push(supplierId);
        supplierFilter = `AND g.supplier_id = $2`;
      }

      const sql = `
        SELECT
          gl.id as "grnLineId",
          g.id as "grnId",
          g.grn_no as "grnNo",
          g.supplier_id as "supplierId",
          g.warehouse_id as "warehouseId",
          gl.item_id as "itemId",
          i.code as "itemCode",
          i.name_ar as "itemNameAr",
          i.uom as "itemUom",
          gl.qty as "grnQty",
          COALESCE(gl.unit_cost, 0) as "unitCost",
          COALESCE(ret.returned_qty, 0) as "alreadyReturnedQty",
          LEAST(gl.qty - COALESCE(ret.returned_qty, 0), COALESCE(sb.qty, 0)) as "returnableQty"
        FROM purch_grn_lines gl
        INNER JOIN purch_grn g ON g.id = gl.grn_id AND g.company_id = gl.company_id
        INNER JOIN inv_items i ON i.id = gl.item_id AND i.company_id = gl.company_id
        LEFT JOIN (
          SELECT prl.grn_line_id, SUM(prl.qty) as returned_qty
          FROM purch_return_lines prl
          INNER JOIN purch_returns pr ON pr.id = prl.return_id AND pr.company_id = prl.company_id
          WHERE pr.company_id = $1 AND pr.status = 'posted'
          GROUP BY prl.grn_line_id
        ) ret ON ret.grn_line_id = gl.id
        LEFT JOIN inv_stock_balances sb
          ON sb.company_id = g.company_id AND sb.warehouse_id = g.warehouse_id AND sb.item_id = gl.item_id
        WHERE g.company_id = $1 AND g.status = 'posted' ${supplierFilter}
          AND LEAST(gl.qty - COALESCE(ret.returned_qty, 0), COALESCE(sb.qty, 0)) > 0
        ORDER BY g.created_at ASC, gl.line_no ASC;
      `;
      const res = await executor.query<any>(sql, params);
      return res.rows.map((r: any) => ({
        grnLineId: r.grnLineId,
        grnId: r.grnId,
        grnNo: r.grnNo || null,
        supplierId: r.supplierId,
        warehouseId: r.warehouseId,
        itemId: r.itemId,
        itemCode: r.itemCode,
        itemNameAr: r.itemNameAr,
        itemUom: r.itemUom,
        grnQty: toDecimal(r.grnQty, 4),
        unitCost: toDecimal(r.unitCost, 4),
        alreadyReturnedQty: toDecimal(r.alreadyReturnedQty, 4),
        returnableQty: toDecimal(r.returnableQty, 4),
      }));
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async createDraft(
    companyId: string,
    input: CreatePurchReturnInput,
    actorId?: string,
    customExecutor?: DbExecutor
  ): Promise<PurchReturnHeader> {
    const run = async (executor: DbExecutor) => {
      const headerSql = `
        INSERT INTO purch_returns (
          company_id,
          supplier_id,
          warehouse_id,
          grn_id,
          invoice_id,
          status,
          return_date,
          reason,
          memo,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, 'draft', COALESCE($6::date, CURRENT_DATE), $7, $8, $9)
        RETURNING
          id,
          company_id as "companyId",
          supplier_id as "supplierId",
          warehouse_id as "warehouseId",
          grn_id as "grnId",
          invoice_id as "invoiceId",
          status,
          return_no as "returnNo",
          return_date::text as "returnDate",
          reason,
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
        input.warehouseId,
        input.grnId,
        input.invoiceId || null,
        input.returnDate || null,
        input.reason?.trim() || null,
        input.memo?.trim() || null,
        actorId || null,
      ]);
      const headerRow = headerRes.rows[0];
      const returnId = headerRow.id;

      const lines: PurchReturnLine[] = [];
      for (let i = 0; i < input.lines.length; i++) {
        const l = input.lines[i];
        const grnLineRes = await executor.query<any>(
          `SELECT item_id as "itemId" FROM purch_grn_lines WHERE id = $1 AND company_id = $2 AND grn_id = $3`,
          [l.grnLineId.trim(), companyId, input.grnId]
        );
        const itemId = grnLineRes.rows[0]?.itemId;
        if (!itemId) {
          throw new Error(`GRN line '${l.grnLineId}' does not belong to GRN '${input.grnId}'`);
        }

        const lineSql = `
          INSERT INTO purch_return_lines (
            return_id,
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
            return_id as "returnId",
            company_id as "companyId",
            grn_line_id as "grnLineId",
            item_id as "itemId",
            qty,
            unit_cost as "unitCost",
            line_no as "lineNo";
        `;
        const lineRes = await executor.query<any>(lineSql, [
          returnId,
          companyId,
          l.grnLineId.trim(),
          itemId,
          toDecimal(l.qty, 4),
          toDecimal(l.unitCost, 4),
          i + 1,
        ]);
        lines.push(mapReturnLine(lineRes.rows[0]));
      }

      return mapReturnHeader(headerRow, lines);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async markPosted(
    companyId: string,
    id: string,
    returnNo: string,
    journalEntryId: string,
    actorId: string,
    tx: DbExecutor
  ): Promise<void> {
    await tx.query(
      `UPDATE purch_returns
       SET
         status = 'posted',
         return_no = COALESCE(return_no, $3),
         journal_entry_id = $4,
         posted_by = $5,
         posted_at = NOW(),
         updated_at = NOW()
       WHERE company_id = $1 AND id = $2;`,
      [companyId, id, returnNo, journalEntryId, actorId]
    );
  }

  async deleteDraft(companyId: string, id: string, customExecutor?: DbExecutor): Promise<void> {
    const run = async (executor: DbExecutor) => {
      await executor.query(
        `DELETE FROM purch_return_lines WHERE company_id = $1 AND return_id = $2`,
        [companyId, id]
      );
      await executor.query(
        `DELETE FROM purch_returns WHERE company_id = $1 AND id = $2 AND status = 'draft'`,
        [companyId, id]
      );
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultPurchReturnRepository = new PurchReturnRepository();
