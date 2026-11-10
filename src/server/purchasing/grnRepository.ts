import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { GrnHeader, GrnLine, CreateGrnInput } from './purchasingTypes.js';

export class GrnRepository {
  async listByCompany(companyId: string, customExecutor?: DbExecutor): Promise<GrnHeader[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          g.id, 
          g.company_id as "companyId", 
          g.supplier_id as "supplierId", 
          s.code as "supplierCode",
          s.name_ar as "supplierNameAr",
          g.warehouse_id as "warehouseId", 
          w.code as "warehouseCode",
          w.name_ar as "warehouseNameAr",
          g.status, 
          g.grn_no as "grnNo", 
          g.posted_at as "postedAt", 
          g.posted_by as "postedBy", 
          g.memo, 
          g.created_by as "createdBy", 
          g.created_at as "createdAt"
        FROM purch_grn g
        INNER JOIN purch_suppliers s ON s.id = g.supplier_id AND s.company_id = g.company_id
        INNER JOIN inv_warehouses w ON w.id = g.warehouse_id AND w.company_id = g.company_id
        WHERE g.company_id = $1
        ORDER BY g.created_at DESC
        LIMIT 100
      `;
      const res = await executor.query<GrnHeader>(sql, [companyId]);
      return res.rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findById(
    companyId: string,
    grnId: string,
    customExecutor?: DbExecutor
  ): Promise<GrnHeader | null> {
    const run = async (executor: DbExecutor) => {
      const headerSql = `
        SELECT 
          g.id, 
          g.company_id as "companyId", 
          g.supplier_id as "supplierId", 
          s.code as "supplierCode",
          s.name_ar as "supplierNameAr",
          g.warehouse_id as "warehouseId", 
          w.code as "warehouseCode",
          w.name_ar as "warehouseNameAr",
          g.status, 
          g.grn_no as "grnNo", 
          g.posted_at as "postedAt", 
          g.posted_by as "postedBy", 
          g.memo, 
          g.created_by as "createdBy", 
          g.created_at as "createdAt"
        FROM purch_grn g
        INNER JOIN purch_suppliers s ON s.id = g.supplier_id AND s.company_id = g.company_id
        INNER JOIN inv_warehouses w ON w.id = g.warehouse_id AND w.company_id = g.company_id
        WHERE g.id = $1 AND g.company_id = $2
      `;
      const headerRes = await executor.query<GrnHeader>(headerSql, [grnId, companyId]);
      const header = headerRes.rows[0];
      if (!header) return null;

      const linesSql = `
        SELECT 
          l.id, 
          l.grn_id as "grnId", 
          l.company_id as "companyId", 
          l.item_id as "itemId", 
          i.code as "itemCode",
          i.name_ar as "itemNameAr",
          i.uom as "itemUom",
          l.qty::float as "qty", 
          l.unit_cost::float as "unitCost", 
          l.line_no as "lineNo"
        FROM purch_grn_lines l
        INNER JOIN inv_items i ON i.id = l.item_id AND i.company_id = l.company_id
        WHERE l.grn_id = $1 AND l.company_id = $2
        ORDER BY l.line_no ASC
      `;
      const linesRes = await executor.query<GrnLine>(linesSql, [grnId, companyId]);
      header.lines = linesRes.rows;

      return header;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findByIdForUpdate(
    companyId: string,
    grnId: string,
    executor: DbExecutor
  ): Promise<GrnHeader | null> {
    const sql = `
      SELECT 
        id, 
        company_id as "companyId", 
        supplier_id as "supplierId", 
        warehouse_id as "warehouseId", 
        status, 
        grn_no as "grnNo", 
        posted_at as "postedAt", 
        posted_by as "postedBy", 
        memo, 
        created_by as "createdBy", 
        created_at as "createdAt"
      FROM purch_grn
      WHERE id = $1 AND company_id = $2
      FOR UPDATE
    `;
    const res = await executor.query<GrnHeader>(sql, [grnId, companyId]);
    return res.rows[0] || null;
  }

  async createDraft(
    companyId: string,
    input: CreateGrnInput,
    createdBy?: string,
    customExecutor?: DbExecutor
  ): Promise<GrnHeader> {
    const run = async (executor: DbExecutor) => {
      const grnSql = `
        INSERT INTO purch_grn (company_id, supplier_id, warehouse_id, status, memo, created_by)
        VALUES ($1, $2, $3, 'draft', $4, $5)
        RETURNING 
          id, 
          company_id as "companyId", 
          supplier_id as "supplierId", 
          warehouse_id as "warehouseId", 
          status, 
          memo, 
          created_by as "createdBy", 
          created_at as "createdAt"
      `;
      const grnRes = await executor.query<GrnHeader>(grnSql, [
        companyId,
        input.supplierId,
        input.warehouseId,
        input.memo || null,
        createdBy || null,
      ]);
      const header = grnRes.rows[0];

      const lines: GrnLine[] = [];
      for (let i = 0; i < input.lines.length; i++) {
        const lineInput = input.lines[i];
        const lineSql = `
          INSERT INTO purch_grn_lines (grn_id, company_id, item_id, qty, unit_cost, line_no)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING 
            id, 
            grn_id as "grnId", 
            company_id as "companyId", 
            item_id as "itemId", 
            qty::float as "qty", 
            unit_cost::float as "unitCost", 
            line_no as "lineNo"
        `;
        const lineRes = await executor.query<GrnLine>(lineSql, [
          header.id,
          companyId,
          lineInput.itemId,
          lineInput.qty,
          lineInput.unitCost ?? null,
          i + 1,
        ]);
        lines.push(lineRes.rows[0]);
      }

      header.lines = lines;
      return header;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async markPosted(
    companyId: string,
    grnId: string,
    grnNo: string,
    postedBy: string,
    executor: DbExecutor
  ): Promise<void> {
    const sql = `
      UPDATE purch_grn
      SET status = 'posted', grn_no = $3, posted_at = NOW(), posted_by = $4
      WHERE id = $1 AND company_id = $2
    `;
    await executor.query(sql, [grnId, companyId, grnNo, postedBy]);
  }
}

export const defaultGrnRepository = new GrnRepository();
