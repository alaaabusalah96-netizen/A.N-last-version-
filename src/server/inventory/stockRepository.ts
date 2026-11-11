import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { StockBalance, StockMovement, MovementType } from './inventoryTypes.js';

export class StockRepository {
  async listBalancesByCompany(companyId: string, customExecutor?: DbExecutor): Promise<StockBalance[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          b.company_id as "companyId", 
          b.warehouse_id as "warehouseId", 
          w.code as "warehouseCode",
          w.name_ar as "warehouseNameAr",
          b.item_id as "itemId", 
          i.code as "itemCode",
          i.name_ar as "itemNameAr",
          i.uom as "itemUom",
          b.qty::float as "qty", 
          b.updated_at as "updatedAt"
        FROM inv_stock_balances b
        INNER JOIN inv_warehouses w ON w.id = b.warehouse_id AND w.company_id = b.company_id
        INNER JOIN inv_items i ON i.id = b.item_id AND i.company_id = b.company_id
        WHERE b.company_id = $1
        ORDER BY w.code ASC, i.code ASC
      `;
      const res = await executor.query<StockBalance>(sql, [companyId]);
      return res.rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async getBalanceForUpdate(
    companyId: string,
    warehouseId: string,
    itemId: string,
    executor: DbExecutor
  ): Promise<StockBalance | null> {
    const sql = `
      SELECT 
        company_id as "companyId", 
        warehouse_id as "warehouseId", 
        item_id as "itemId", 
        qty::float as "qty", 
        updated_at as "updatedAt"
      FROM inv_stock_balances
      WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3
      FOR UPDATE
    `;
    const res = await executor.query<StockBalance>(sql, [companyId, warehouseId, itemId]);
    return res.rows[0] || null;
  }

  async ensureBalanceRow(
    companyId: string,
    warehouseId: string,
    itemId: string,
    executor: DbExecutor
  ): Promise<void> {
    const sql = `
      INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
      VALUES ($1, $2, $3, 0, NOW())
      ON CONFLICT (company_id, warehouse_id, item_id) DO NOTHING
    `;
    await executor.query(sql, [companyId, warehouseId, itemId]);
  }

  async incrementBalance(
    companyId: string,
    warehouseId: string,
    itemId: string,
    qty: number,
    executor: DbExecutor
  ): Promise<StockBalance> {
    const sql = `
      INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (company_id, warehouse_id, item_id)
      DO UPDATE SET qty = inv_stock_balances.qty + EXCLUDED.qty, updated_at = NOW()
      RETURNING 
        company_id as "companyId", 
        warehouse_id as "warehouseId", 
        item_id as "itemId", 
        qty::float as "qty", 
        updated_at as "updatedAt"
    `;
    const res = await executor.query<StockBalance>(sql, [companyId, warehouseId, itemId, qty]);
    return res.rows[0];
  }

  async decrementBalance(
    companyId: string,
    warehouseId: string,
    itemId: string,
    qty: number,
    executor: DbExecutor
  ): Promise<StockBalance | null> {
    const sql = `
      UPDATE inv_stock_balances
      SET qty = qty - $4, updated_at = NOW()
      WHERE company_id = $1
        AND warehouse_id = $2
        AND item_id = $3
        AND qty >= $4
      RETURNING 
        company_id as "companyId", 
        warehouse_id as "warehouseId", 
        item_id as "itemId", 
        qty::float as "qty", 
        updated_at as "updatedAt"
    `;
    const res = await executor.query<StockBalance>(sql, [companyId, warehouseId, itemId, qty]);
    return res.rows[0] || null;
  }

  async upsertBalance(
    companyId: string,
    warehouseId: string,
    itemId: string,
    newQty: number,
    executor: DbExecutor
  ): Promise<StockBalance> {
    const sql = `
      INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (company_id, warehouse_id, item_id)
      DO UPDATE SET qty = EXCLUDED.qty, updated_at = NOW()
      RETURNING 
        company_id as "companyId", 
        warehouse_id as "warehouseId", 
        item_id as "itemId", 
        qty::float as "qty", 
        updated_at as "updatedAt"
    `;
    const res = await executor.query<StockBalance>(sql, [companyId, warehouseId, itemId, newQty]);
    return res.rows[0];
  }

  async createMovement(
    companyId: string,
    warehouseId: string,
    itemId: string,
    movementType: MovementType,
    qty: number,
    memo?: string,
    createdBy?: string,
    transferId?: string,
    customExecutor?: DbExecutor
  ): Promise<StockMovement> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        INSERT INTO inv_stock_movements (company_id, warehouse_id, item_id, movement_type, qty, memo, created_by, transfer_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING 
          id, 
          company_id as "companyId", 
          warehouse_id as "warehouseId", 
          item_id as "itemId", 
          movement_type as "movementType", 
          qty::float as "qty", 
          memo, 
          transfer_id as "transferId",
          created_by as "createdBy", 
          created_at as "createdAt"
      `;
      const res = await executor.query<StockMovement>(sql, [
        companyId,
        warehouseId,
        itemId,
        movementType,
        qty,
        memo || null,
        createdBy || null,
        transferId || null,
      ]);
      return res.rows[0];
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async listMovementsByCompany(companyId: string, customExecutor?: DbExecutor): Promise<StockMovement[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          m.id, 
          m.company_id as "companyId", 
          m.warehouse_id as "warehouseId", 
          w.code as "warehouseCode",
          w.name_ar as "warehouseNameAr",
          m.item_id as "itemId", 
          i.code as "itemCode",
          i.name_ar as "itemNameAr",
          m.movement_type as "movementType", 
          m.qty::float as "qty", 
          m.memo, 
          m.transfer_id as "transferId",
          m.created_by as "createdBy", 
          m.created_at as "createdAt"
        FROM inv_stock_movements m
        INNER JOIN inv_warehouses w ON w.id = m.warehouse_id AND w.company_id = m.company_id
        INNER JOIN inv_items i ON i.id = m.item_id AND i.company_id = m.company_id
        WHERE m.company_id = $1
        ORDER BY m.created_at DESC
        LIMIT 100
      `;
      const res = await executor.query<StockMovement>(sql, [companyId]);
      return res.rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async listBalancesByItem(
    companyId: string,
    itemId: string,
    customExecutor?: DbExecutor
  ): Promise<StockBalance[]> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          b.company_id as "companyId", 
          b.warehouse_id as "warehouseId", 
          w.code as "warehouseCode",
          w.name_ar as "warehouseNameAr",
          b.item_id as "itemId", 
          i.code as "itemCode",
          i.name_ar as "itemNameAr",
          i.uom as "itemUom",
          b.qty::float as "qty", 
          b.updated_at as "updatedAt"
        FROM inv_stock_balances b
        INNER JOIN inv_warehouses w ON w.id = b.warehouse_id AND w.company_id = b.company_id
        INNER JOIN inv_items i ON i.id = b.item_id AND i.company_id = b.company_id
        WHERE b.company_id = $1 AND b.item_id = $2
        ORDER BY w.code ASC
      `;
      const res = await executor.query<StockBalance>(sql, [companyId, itemId]);
      return res.rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async listMovementsByItem(
    companyId: string,
    itemId: string,
    filters?: {
      warehouseId?: string;
      fromDate?: string;
      toDate?: string;
      movementType?: string;
    },
    customExecutor?: DbExecutor
  ): Promise<StockMovement[]> {
    const run = async (executor: DbExecutor) => {
      const params: any[] = [companyId, itemId];
      let whereClause = 'WHERE m.company_id = $1 AND m.item_id = $2';

      if (filters?.warehouseId) {
        params.push(filters.warehouseId);
        whereClause += ` AND m.warehouse_id = $${params.length}`;
      }
      if (filters?.fromDate) {
        params.push(filters.fromDate);
        whereClause += ` AND m.created_at >= $${params.length}`;
      }
      if (filters?.toDate) {
        params.push(filters.toDate);
        whereClause += ` AND m.created_at <= $${params.length}`;
      }
      if (filters?.movementType) {
        params.push(filters.movementType);
        whereClause += ` AND m.movement_type = $${params.length}`;
      }

      const sql = `
        SELECT 
          m.id, 
          m.company_id as "companyId", 
          m.warehouse_id as "warehouseId", 
          w.code as "warehouseCode",
          w.name_ar as "warehouseNameAr",
          m.item_id as "itemId", 
          i.code as "itemCode",
          i.name_ar as "itemNameAr",
          m.movement_type as "movementType", 
          m.qty::float as "qty", 
          m.memo, 
          m.transfer_id as "transferId",
          m.created_by as "createdBy", 
          m.created_at as "createdAt"
        FROM inv_stock_movements m
        INNER JOIN inv_warehouses w ON w.id = m.warehouse_id AND w.company_id = m.company_id
        INNER JOIN inv_items i ON i.id = m.item_id AND i.company_id = m.company_id
        ${whereClause}
        ORDER BY m.created_at DESC
        LIMIT 200
      `;
      const res = await executor.query<StockMovement>(sql, params);
      return res.rows;
    };

    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultStockRepository = new StockRepository();

