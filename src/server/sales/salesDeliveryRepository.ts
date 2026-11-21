import { DbExecutor } from '../db/index.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { SalesDeliveryNote, SalesDeliveryLine, CreateDeliveryInput } from './salesTypes.js';

import { toDecimal } from '../lib/numeric.js';
import { toCalendarDate } from '../lib/calendarDate.js';

function mapHeaderRow(row: any): SalesDeliveryNote {
  return {
    id: row.id,
    companyId: row.company_id,
    customerId: row.customer_id,
    customerCode: row.customer_code,
    customerNameAr: row.customer_name_ar,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    warehouseNameAr: row.warehouse_name_ar,
    deliveryNo: row.delivery_no || null,
    deliveryDate: toCalendarDate(row.delivery_date),
    status: row.status,
    memo: row.memo || null,
    postedAt: row.posted_at ? (row.posted_at instanceof Date ? row.posted_at.toISOString() : String(row.posted_at)) : null,
    postedBy: row.posted_by || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function mapLineRow(row: any): SalesDeliveryLine {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    companyId: row.company_id,
    itemId: row.item_id,
    itemCode: row.item_code,
    itemNameAr: row.item_name_ar,
    itemUom: row.item_uom,
    qty: toDecimal(row.qty ?? 0, 4),
    unitPrice: toDecimal(row.unit_price ?? 0, 4),
    unitCost: toDecimal(row.unit_cost ?? 0, 4),
    frozenTotalCost: toDecimal(row.frozen_total_cost ?? 0, 4),
    valuationMovementId: row.valuation_movement_id || null,
    lineNo: parseInt(row.line_no, 10) || 1,
  };
}

export class SalesDeliveryRepository {
  async list(companyId: string, customExecutor?: DbExecutor): Promise<SalesDeliveryNote[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          d.id, d.company_id, d.customer_id, d.warehouse_id, d.delivery_no, d.delivery_date::text as delivery_date,
          d.status, d.memo, d.posted_at, d.posted_by, d.created_by, d.created_at, d.updated_at,
          c.code as customer_code, c.name_ar as customer_name_ar,
          w.code as warehouse_code, w.name_ar as warehouse_name_ar
        FROM sales_delivery_notes d
        INNER JOIN sales_customers c ON c.id = d.customer_id AND c.company_id = d.company_id
        INNER JOIN inv_warehouses w ON w.id = d.warehouse_id AND w.company_id = d.company_id
        WHERE d.company_id = $1
        ORDER BY d.created_at DESC
      `;
      const res = await executor.query<any>(sql, [companyId]);
      return res.rows.map(mapHeaderRow);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(companyId: string, id: string, customExecutor?: DbExecutor): Promise<SalesDeliveryNote | null> {
    const run = async (executor: DbExecutor) => {
      const headerSql = `
        SELECT 
          d.id, d.company_id, d.customer_id, d.warehouse_id, d.delivery_no, d.delivery_date::text as delivery_date,
          d.status, d.memo, d.posted_at, d.posted_by, d.created_by, d.created_at, d.updated_at,
          c.code as customer_code, c.name_ar as customer_name_ar,
          w.code as warehouse_code, w.name_ar as warehouse_name_ar
        FROM sales_delivery_notes d
        INNER JOIN sales_customers c ON c.id = d.customer_id AND c.company_id = d.company_id
        INNER JOIN inv_warehouses w ON w.id = d.warehouse_id AND w.company_id = d.company_id
        WHERE d.company_id = $1 AND d.id = $2
      `;
      const res = await executor.query<any>(headerSql, [companyId, id]);
      if (res.rows.length === 0) return null;

      const header = mapHeaderRow(res.rows[0]);

      const linesSql = `
        SELECT 
          l.id, l.delivery_id, l.company_id, l.item_id, l.qty, l.unit_price, l.unit_cost,
          l.frozen_total_cost, l.valuation_movement_id, l.line_no,
          i.code as item_code, i.name_ar as item_name_ar, i.uom as item_uom
        FROM sales_delivery_lines l
        INNER JOIN inv_items i ON i.id = l.item_id AND i.company_id = l.company_id
        WHERE l.company_id = $1 AND l.delivery_id = $2
        ORDER BY l.line_no ASC
      `;
      const linesRes = await executor.query<any>(linesSql, [companyId, id]);
      header.lines = linesRes.rows.map(mapLineRow);
      return header;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByIdForUpdate(companyId: string, id: string, executor: DbExecutor): Promise<{ id: string; status: string; warehouseId: string } | null> {
    const sql = `
      SELECT id, status, warehouse_id as "warehouseId"
      FROM sales_delivery_notes
      WHERE company_id = $1 AND id = $2
      FOR UPDATE
    `;
    const res = await executor.query<any>(sql, [companyId, id]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async createDraft(companyId: string, input: CreateDeliveryInput, actorUserId?: string, customExecutor?: DbExecutor): Promise<SalesDeliveryNote> {
    const run = async (executor: DbExecutor) => {
      const headerSql = `
        INSERT INTO sales_delivery_notes (
          company_id, customer_id, warehouse_id, delivery_date, memo, status, created_by
        )
        VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, 'draft', $6)
        RETURNING id
      `;
      const headerRes = await executor.query<any>(headerSql, [
        companyId,
        input.customerId,
        input.warehouseId,
        input.deliveryDate || null,
        input.memo?.trim() || null,
        actorUserId || null,
      ]);
      const deliveryId = headerRes.rows[0].id;

      for (let i = 0; i < input.lines.length; i++) {
        const line = input.lines[i];
        const lineSql = `
          INSERT INTO sales_delivery_lines (
            company_id, delivery_id, item_id, qty, unit_price, unit_cost, line_no
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;
        await executor.query(lineSql, [
          companyId,
          deliveryId,
          line.itemId,
          line.qty,
          line.unitPrice ?? 0,
          // Never trust client-supplied unitCost; server valuation freezes cost upon posting
          0,
          i + 1,
        ]);
      }

      const created = await this.findById(companyId, deliveryId, executor);
      return created!;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async markPosted(
    companyId: string,
    id: string,
    deliveryNo: string,
    postedBy?: string,
    customExecutor?: DbExecutor
  ): Promise<void> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        UPDATE sales_delivery_notes
        SET
          status = 'posted',
          delivery_no = $3,
          posted_at = NOW(),
          posted_by = $4,
          updated_at = NOW()
        WHERE company_id = $1 AND id = $2
      `;
      await executor.query(sql, [companyId, id, deliveryNo, postedBy || null]);
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async delete(companyId: string, id: string, customExecutor?: DbExecutor): Promise<boolean> {
    const run = async (executor: DbExecutor) => {
      const sql = `DELETE FROM sales_delivery_notes WHERE company_id = $1 AND id = $2 AND status = 'draft' RETURNING id`;
      const res = await executor.query<any>(sql, [companyId, id]);
      return res.rows.length > 0;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultSalesDeliveryRepository = new SalesDeliveryRepository();
