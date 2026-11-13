import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { CreatePoInput, PoLine, PoStatus, PurchaseOrder } from './purchasingTypes.js';
import { toDecimal } from '../lib/numeric.js';

export class PurchaseOrderRepository {
  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<PurchaseOrder[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT
          p.id,
          p.company_id as "companyId",
          p.supplier_id as "supplierId",
          s.code as "supplierCode",
          s.name_ar as "supplierNameAr",
          p.status,
          p.po_no as "poNo",
          p.order_date::text as "orderDate",
          p.expected_date::text as "expectedDate",
          p.memo,
          p.approved_at as "approvedAt",
          p.approved_by as "approvedBy",
          p.closed_at as "closedAt",
          p.closed_by as "closedBy",
          p.created_by as "createdBy",
          p.created_at as "createdAt"
        FROM purch_purchase_orders p
        INNER JOIN purch_suppliers s ON s.id = p.supplier_id AND s.company_id = p.company_id
        WHERE p.company_id = $1
        ORDER BY p.created_at DESC
        LIMIT 100
      `;
      const res = await executor.query<PurchaseOrder>(sql, [companyId]);
      return res.rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(
    companyId: string,
    poId: string,
    customExecutor?: DbExecutor
  ): Promise<PurchaseOrder | null> {
    const run = async (executor: DbExecutor) => {
      const headerSql = `
        SELECT
          p.id,
          p.company_id as "companyId",
          p.supplier_id as "supplierId",
          s.code as "supplierCode",
          s.name_ar as "supplierNameAr",
          p.status,
          p.po_no as "poNo",
          p.order_date::text as "orderDate",
          p.expected_date::text as "expectedDate",
          p.memo,
          p.approved_at as "approvedAt",
          p.approved_by as "approvedBy",
          p.closed_at as "closedAt",
          p.closed_by as "closedBy",
          p.created_by as "createdBy",
          p.created_at as "createdAt"
        FROM purch_purchase_orders p
        INNER JOIN purch_suppliers s ON s.id = p.supplier_id AND s.company_id = p.company_id
        WHERE p.id = $1 AND p.company_id = $2
      `;
      const headerRes = await executor.query<PurchaseOrder>(headerSql, [poId, companyId]);
      const header = headerRes.rows[0];
      if (!header) return null;

      const linesSql = `
        SELECT
          l.id,
          l.po_id as "poId",
          l.company_id as "companyId",
          l.item_id as "itemId",
          i.code as "itemCode",
          i.name_ar as "itemNameAr",
          i.uom as "itemUom",
          l.qty as "qty",
          l.unit_cost as "unitCost",
          l.received_qty as "receivedQty",
          l.line_no as "lineNo"
        FROM purch_po_lines l
        INNER JOIN inv_items i ON i.id = l.item_id AND i.company_id = l.company_id
        WHERE l.po_id = $1 AND l.company_id = $2
        ORDER BY l.line_no ASC
      `;
      const linesRes = await executor.query<any>(linesSql, [poId, companyId]);
      header.lines = linesRes.rows.map((r) => ({
        ...r,
        qty: toDecimal(r.qty, 4),
        unitCost: r.unitCost === null || r.unitCost === undefined ? null : toDecimal(r.unitCost, 4),
        receivedQty: toDecimal(r.receivedQty, 4),
      }));

      return header;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByIdForUpdate(
    companyId: string,
    poId: string,
    executor: DbExecutor
  ): Promise<PurchaseOrder | null> {
    const sql = `
      SELECT
        id,
        company_id as "companyId",
        supplier_id as "supplierId",
        status,
        po_no as "poNo",
        order_date::text as "orderDate",
        expected_date::text as "expectedDate",
        memo,
        approved_at as "approvedAt",
        approved_by as "approvedBy",
        closed_at as "closedAt",
        closed_by as "closedBy",
        created_by as "createdBy",
        created_at as "createdAt"
      FROM purch_purchase_orders
      WHERE id = $1 AND company_id = $2
      FOR UPDATE
    `;
    const res = await executor.query<PurchaseOrder>(sql, [poId, companyId]);
    return res.rows[0] || null;
  }

  async create(
    companyId: string,
    input: CreatePoInput,
    createdBy?: string,
    customExecutor?: DbExecutor
  ): Promise<PurchaseOrder> {
    const run = async (executor: DbExecutor) => {
      const headerSql = `
        INSERT INTO purch_purchase_orders (
          company_id,
          supplier_id,
          status,
          expected_date,
          memo,
          created_by
        )
        VALUES ($1, $2, 'draft', $3, $4, $5)
        RETURNING
          id,
          company_id as "companyId",
          supplier_id as "supplierId",
          status,
          po_no as "poNo",
          order_date::text as "orderDate",
          expected_date::text as "expectedDate",
          memo,
          approved_at as "approvedAt",
          approved_by as "approvedBy",
          closed_at as "closedAt",
          closed_by as "closedBy",
          created_by as "createdBy",
          created_at as "createdAt"
      `;
      const headerRes = await executor.query<PurchaseOrder>(headerSql, [
        companyId,
        input.supplierId,
        input.expectedDate ? input.expectedDate.trim() : null,
        input.memo ? input.memo.trim() : null,
        createdBy || null,
      ]);
      const header = headerRes.rows[0];

      const lines: PoLine[] = [];
      for (let i = 0; i < input.lines.length; i++) {
        const lineInput = input.lines[i];
        const lineSql = `
          INSERT INTO purch_po_lines (po_id, company_id, item_id, qty, unit_cost, received_qty, line_no)
          VALUES ($1, $2, $3, $4, $5, 0, $6)
          RETURNING
            id,
            po_id as "poId",
            company_id as "companyId",
            item_id as "itemId",
            qty as "qty",
            unit_cost as "unitCost",
            received_qty as "receivedQty",
            line_no as "lineNo"
        `;
        const lineRes = await executor.query<any>(lineSql, [
          header.id,
          companyId,
          lineInput.itemId,
          lineInput.qty,
          lineInput.unitCost ?? null,
          i + 1,
        ]);
        const row = lineRes.rows[0];
        lines.push({
          ...row,
          qty: toDecimal(row.qty, 4),
          unitCost: row.unitCost === null || row.unitCost === undefined ? null : toDecimal(row.unitCost, 4),
          receivedQty: toDecimal(row.receivedQty, 4),
        });
      }

      header.lines = lines;
      return header;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async updateStatus(
    companyId: string,
    poId: string,
    params: {
      status: PoStatus;
      poNo?: string | null;
      approvedBy?: string | null;
      closedBy?: string | null;
    },
    executor: DbExecutor
  ): Promise<boolean> {
    if (params.status === 'approved') {
      const sql = `
        UPDATE purch_purchase_orders
        SET
          status = 'approved',
          po_no = COALESCE($3, po_no),
          approved_at = NOW(),
          approved_by = $4
        WHERE id = $1 AND company_id = $2
      `;
      const res = await executor.query(sql, [
        poId,
        companyId,
        params.poNo ?? null,
        params.approvedBy || null,
      ]);
      return (res.rowCount ?? 0) === 1;
    }

    if (params.status === 'closed') {
      const sql = `
        UPDATE purch_purchase_orders
        SET
          status = 'closed',
          closed_at = NOW(),
          closed_by = $3
        WHERE id = $1 AND company_id = $2
      `;
      const res = await executor.query(sql, [
        poId,
        companyId,
        params.closedBy || null,
      ]);
      return (res.rowCount ?? 0) === 1;
    }

    const sql = `
      UPDATE purch_purchase_orders
      SET status = $3
      WHERE id = $1 AND company_id = $2
    `;
    const res = await executor.query(sql, [poId, companyId, params.status]);
    return (res.rowCount ?? 0) === 1;
  }

  async updateReceivedQty(
    companyId: string,
    poLineId: string,
    receivedQty: number,
    executor: DbExecutor
  ): Promise<PoLine | null> {
    const sql = `
      UPDATE purch_po_lines
      SET received_qty = $3
      WHERE id = $1 AND company_id = $2
      RETURNING
        id,
        po_id as "poId",
        company_id as "companyId",
        item_id as "itemId",
        qty as "qty",
        unit_cost as "unitCost",
        received_qty as "receivedQty",
        line_no as "lineNo"
    `;
    const res = await executor.query<any>(sql, [poLineId, companyId, receivedQty]);
    const row = res.rows[0];
    if (!row) return null;
    return {
      ...row,
      qty: toDecimal(row.qty, 4),
      unitCost: row.unitCost === null || row.unitCost === undefined ? null : toDecimal(row.unitCost, 4),
      receivedQty: toDecimal(row.receivedQty, 4),
    };
  }
}

export const defaultPurchaseOrderRepository = new PurchaseOrderRepository();
