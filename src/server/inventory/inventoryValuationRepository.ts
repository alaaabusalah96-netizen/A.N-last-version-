import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { CostingProfile, ItemCostingAssignment, ValuationBalance, CostLayer, ValuationMovement, CostingMethod } from './inventoryValuationTypes.js';

export class InventoryValuationRepository {
  async listProfiles(companyId: string, customExecutor?: DbExecutor): Promise<CostingProfile[]> {
    const run = async (executor: DbExecutor): Promise<CostingProfile[]> => {
      const res = await executor.query<CostingProfile>(
        `SELECT id, company_id as "companyId", name, costing_method as "costingMethod", is_default as "isDefault", is_active as "isActive", created_at as "createdAt"
         FROM inv_costing_profiles WHERE company_id = $1 ORDER BY created_at ASC;`,
        [companyId]
      );
      return res.rows;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findProfileById(companyId: string, profileId: string, customExecutor?: DbExecutor): Promise<CostingProfile | null> {
    const run = async (executor: DbExecutor): Promise<CostingProfile | null> => {
      const res = await executor.query<CostingProfile>(
        `SELECT id, company_id as "companyId", name, costing_method as "costingMethod", is_default as "isDefault", is_active as "isActive", created_at as "createdAt"
         FROM inv_costing_profiles WHERE company_id = $1 AND id = $2;`,
        [companyId, profileId]
      );
      return res.rows[0] || null;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async createProfile(
    companyId: string,
    input: { name: string; costingMethod: CostingMethod; isDefault?: boolean },
    customExecutor?: DbExecutor
  ): Promise<CostingProfile> {
    const run = async (executor: DbExecutor): Promise<CostingProfile> => {
      if (input.isDefault) {
        await executor.query(
          `UPDATE inv_costing_profiles SET is_default = false WHERE company_id = $1;`,
          [companyId]
        );
      }
      const res = await executor.query<CostingProfile>(
        `INSERT INTO inv_costing_profiles (company_id, name, costing_method, is_default)
         VALUES ($1, $2, $3, $4)
         RETURNING id, company_id as "companyId", name, costing_method as "costingMethod", is_default as "isDefault", is_active as "isActive", created_at as "createdAt";`,
        [companyId, input.name, input.costingMethod, input.isDefault || false]
      );
      return res.rows[0];
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async getItemAssignment(companyId: string, itemId: string, customExecutor?: DbExecutor): Promise<ItemCostingAssignment | null> {
    const run = async (executor: DbExecutor): Promise<ItemCostingAssignment | null> => {
      const res = await executor.query<ItemCostingAssignment>(
        `SELECT icp.company_id as "companyId", icp.item_id as "itemId", i.code as "itemCode", i.name_ar as "itemNameAr",
                icp.profile_id as "profileId", cp.name as "profileName", cp.costing_method as "costingMethod",
                icp.assigned_at as "assignedAt", icp.assigned_by as "assignedBy"
         FROM inv_item_costing_profiles icp
         JOIN inv_items i ON icp.company_id = i.company_id AND icp.item_id = i.id
         JOIN inv_costing_profiles cp ON icp.company_id = cp.company_id AND icp.profile_id = cp.id
         WHERE icp.company_id = $1 AND icp.item_id = $2;`,
        [companyId, itemId]
      );
      return res.rows[0] || null;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async assignItemProfile(
    companyId: string,
    itemId: string,
    profileId: string,
    userId?: string,
    customExecutor?: DbExecutor
  ): Promise<ItemCostingAssignment> {
    const run = async (executor: DbExecutor): Promise<ItemCostingAssignment> => {
      await executor.query(
        `INSERT INTO inv_item_costing_profiles (company_id, item_id, profile_id, assigned_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, item_id)
         DO UPDATE SET profile_id = EXCLUDED.profile_id, assigned_at = now(), assigned_by = EXCLUDED.assigned_by;`,
        [companyId, itemId, profileId, userId || null]
      );
      const assignment = await this.getItemAssignment(companyId, itemId, executor);
      if (!assignment) {
        throw new Error('Failed to retrieve item costing assignment after save');
      }
      return assignment;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async getValuationBalance(companyId: string, warehouseId: string, itemId: string, customExecutor?: DbExecutor): Promise<ValuationBalance | null> {
    const run = async (executor: DbExecutor): Promise<ValuationBalance | null> => {
      const res = await executor.query<ValuationBalance>(
        `SELECT vb.company_id as "companyId", vb.warehouse_id as "warehouseId", w.code as "warehouseCode", w.name_ar as "warehouseNameAr",
                vb.item_id as "itemId", i.code as "itemCode", i.name_ar as "itemNameAr", i.uom as "itemUom",
                vb.quantity, vb.total_cost as "totalCost", vb.unit_cost as "unitCost", vb.updated_at as "updatedAt"
         FROM inv_valuation_balances vb
         JOIN inv_warehouses w ON vb.company_id = w.company_id AND vb.warehouse_id = w.id
         JOIN inv_items i ON vb.company_id = i.company_id AND vb.item_id = i.id
         WHERE vb.company_id = $1 AND vb.warehouse_id = $2 AND vb.item_id = $3;`,
        [companyId, warehouseId, itemId]
      );
      return res.rows[0] || null;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async listValuationBalances(companyId: string, customExecutor?: DbExecutor): Promise<ValuationBalance[]> {
    const run = async (executor: DbExecutor): Promise<ValuationBalance[]> => {
      const res = await executor.query<ValuationBalance>(
        `SELECT vb.company_id as "companyId", vb.warehouse_id as "warehouseId", w.code as "warehouseCode", w.name_ar as "warehouseNameAr",
                vb.item_id as "itemId", i.code as "itemCode", i.name_ar as "itemNameAr", i.uom as "itemUom",
                vb.quantity, vb.total_cost as "totalCost", vb.unit_cost as "unitCost", vb.updated_at as "updatedAt"
         FROM inv_valuation_balances vb
         JOIN inv_warehouses w ON vb.company_id = w.company_id AND vb.warehouse_id = w.id
         JOIN inv_items i ON vb.company_id = i.company_id AND vb.item_id = i.id
         WHERE vb.company_id = $1 ORDER BY w.code ASC, i.code ASC;`,
        [companyId]
      );
      return res.rows;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async ensureValuationBalanceRow(companyId: string, warehouseId: string, itemId: string, executor: DbExecutor): Promise<void> {
    await executor.query(
      `INSERT INTO inv_valuation_balances (company_id, warehouse_id, item_id, quantity, total_cost, unit_cost)
       VALUES ($1, $2, $3, 0, 0, 0)
       ON CONFLICT (company_id, warehouse_id, item_id) DO NOTHING;`,
      [companyId, warehouseId, itemId]
    );
  }

  async lockValuationBalanceForUpdate(companyId: string, warehouseId: string, itemId: string, executor: DbExecutor): Promise<ValuationBalance | null> {
    await this.ensureValuationBalanceRow(companyId, warehouseId, itemId, executor);
    const res = await executor.query<ValuationBalance>(
      `SELECT vb.company_id as "companyId", vb.warehouse_id as "warehouseId", vb.item_id as "itemId",
              vb.quantity, vb.total_cost as "totalCost", vb.unit_cost as "unitCost", vb.updated_at as "updatedAt"
       FROM inv_valuation_balances vb
       WHERE vb.company_id = $1 AND vb.warehouse_id = $2 AND vb.item_id = $3
       FOR UPDATE;`,
      [companyId, warehouseId, itemId]
    );
    return res.rows[0] || null;
  }

  async updateValuationBalance(
    companyId: string,
    warehouseId: string,
    itemId: string,
    qtyDelta: number,
    costDelta: number,
    executor: DbExecutor
  ): Promise<ValuationBalance> {
    await this.ensureValuationBalanceRow(companyId, warehouseId, itemId, executor);
    const res = await executor.query<ValuationBalance>(
      `UPDATE inv_valuation_balances
       SET quantity = quantity + $4,
           total_cost = GREATEST(0, total_cost + $5),
           unit_cost = CASE WHEN (quantity + $4) > 0 THEN GREATEST(0, total_cost + $5) / (quantity + $4) ELSE 0 END,
           updated_at = now()
       WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3
       RETURNING company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
                 quantity, total_cost as "totalCost", unit_cost as "unitCost", updated_at as "updatedAt";`,
      [companyId, warehouseId, itemId, qtyDelta, costDelta]
    );
    return res.rows[0];
  }

  async createCostLayer(
    companyId: string,
    input: {
      warehouseId: string;
      itemId: string;
      originalQty: number;
      unitCost: number;
      totalCost: number;
      sourceType: string;
      sourceId: string;
      sourceLineId?: string | null;
    },
    executor: DbExecutor
  ): Promise<CostLayer> {
    const res = await executor.query<CostLayer>(
      `INSERT INTO inv_cost_layers (company_id, warehouse_id, item_id, original_qty, remaining_qty, unit_cost, total_cost, source_type, source_id, source_line_id)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9)
       RETURNING id, company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
                 original_qty as "originalQty", remaining_qty as "remainingQty", unit_cost as "unitCost",
                 total_cost as "totalCost", source_type as "sourceType", source_id as "sourceId",
                 source_line_id as "sourceLineId", effective_date as "effectiveDate", is_exhausted as "isExhausted", created_at as "createdAt";`,
      [
        companyId,
        input.warehouseId,
        input.itemId,
        input.originalQty,
        input.unitCost,
        input.totalCost,
        input.sourceType,
        input.sourceId,
        input.sourceLineId || null,
      ]
    );
    return res.rows[0];
  }

  async listActiveCostLayersForUpdate(companyId: string, warehouseId: string, itemId: string, executor: DbExecutor): Promise<CostLayer[]> {
    const res = await executor.query<CostLayer>(
      `SELECT id, company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
              original_qty as "originalQty", remaining_qty as "remainingQty", unit_cost as "unitCost",
              total_cost as "totalCost", source_type as "sourceType", source_id as "sourceId",
              source_line_id as "sourceLineId", effective_date as "effectiveDate", is_exhausted as "isExhausted", created_at as "createdAt"
       FROM inv_cost_layers
       WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 AND remaining_qty > 0 AND is_exhausted = false
       ORDER BY effective_date ASC, created_at ASC
       FOR UPDATE;`,
      [companyId, warehouseId, itemId]
    );
    return res.rows;
  }

  async updateCostLayerRemaining(companyId: string, layerId: string, remainingQty: number, totalCost: number, isExhausted: boolean, executor: DbExecutor): Promise<void> {
    await executor.query(
      `UPDATE inv_cost_layers
       SET remaining_qty = $3, total_cost = $4, is_exhausted = $5
       WHERE company_id = $1 AND id = $2;`,
      [companyId, layerId, remainingQty, totalCost, isExhausted]
    );
  }

  async createValuationMovement(
    companyId: string,
    input: {
      warehouseId: string;
      itemId: string;
      movementType: 'RECEIVE' | 'ISSUE' | 'ADJUSTMENT' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'OPENING' | 'RETURN';
      qty: number;
      unitCost: number;
      totalCost: number;
      sourceType: string;
      sourceId: string;
      sourceLineId?: string | null;
      journalEntryId?: string | null;
      createdBy?: string | null;
    },
    executor: DbExecutor
  ): Promise<ValuationMovement> {
    const res = await executor.query<ValuationMovement>(
      `INSERT INTO inv_valuation_movements (company_id, warehouse_id, item_id, movement_type, qty, unit_cost, total_cost, source_type, source_id, source_line_id, journal_entry_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
                 movement_type as "movementType", qty, unit_cost as "unitCost", total_cost as "totalCost",
                 source_type as "sourceType", source_id as "sourceId", source_line_id as "sourceLineId",
                 journal_entry_id as "journalEntryId", created_by as "createdBy", created_at as "createdAt";`,
      [
        companyId,
        input.warehouseId,
        input.itemId,
        input.movementType,
        input.qty,
        input.unitCost,
        input.totalCost,
        input.sourceType,
        input.sourceId,
        input.sourceLineId || null,
        input.journalEntryId || null,
        input.createdBy || null,
      ]
    );
    return res.rows[0];
  }

  async createCostAllocation(
    companyId: string,
    input: {
      valuationMovementId: string;
      costLayerId?: string | null;
      allocatedQty: number;
      unitCost: number;
      allocatedCost: number;
    },
    executor: DbExecutor
  ): Promise<void> {
    await executor.query(
      `INSERT INTO inv_cost_allocations (company_id, valuation_movement_id, cost_layer_id, allocated_qty, unit_cost, allocated_cost)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [
        companyId,
        input.valuationMovementId,
        input.costLayerId || null,
        input.allocatedQty,
        input.unitCost,
        input.allocatedCost,
      ]
    );
  }
}

export const defaultInventoryValuationRepository = new InventoryValuationRepository();
