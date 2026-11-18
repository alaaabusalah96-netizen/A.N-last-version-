import { DbExecutor } from '../db/types.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import {
  CostingProfile,
  ItemCostingAssignment,
  ValuationBalance,
  CostLayer,
  ValuationMovement,
  ValuationMovementType,
  CostAllocationRecord,
  CostAdjustmentRecord,
  OpeningValuationRecord,
  ValuationReconciliationRecord,
  CostingMethod,
} from './inventoryValuationTypes.js';
import { toDecimal } from '../lib/numeric.js';

function mapProfile(r: any): CostingProfile {
  return {
    id: r.id,
    companyId: r.companyId,
    name: r.name,
    costingMethod: r.costingMethod,
    isDefault: Boolean(r.isDefault),
    isActive: Boolean(r.isActive),
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  };
}

function mapBalance(r: any): ValuationBalance {
  return {
    companyId: r.companyId,
    warehouseId: r.warehouseId,
    warehouseCode: r.warehouseCode ?? undefined,
    warehouseNameAr: r.warehouseNameAr ?? undefined,
    itemId: r.itemId,
    itemCode: r.itemCode ?? undefined,
    itemNameAr: r.itemNameAr ?? undefined,
    itemUom: r.itemUom ?? undefined,
    costingMethod: r.costingMethod ?? null,
    quantity: toDecimal(r.quantity, 4),
    totalCost: toDecimal(r.totalCost, 4),
    unitCost: toDecimal(r.unitCost, 4),
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
  };
}

function mapLayer(r: any): CostLayer {
  return {
    id: r.id,
    companyId: r.companyId,
    warehouseId: r.warehouseId,
    warehouseCode: r.warehouseCode ?? undefined,
    warehouseNameAr: r.warehouseNameAr ?? undefined,
    itemId: r.itemId,
    itemCode: r.itemCode ?? undefined,
    itemNameAr: r.itemNameAr ?? undefined,
    originalQty: toDecimal(r.originalQty, 4),
    remainingQty: toDecimal(r.remainingQty, 4),
    unitCost: toDecimal(r.unitCost, 4),
    totalCost: toDecimal(r.totalCost, 4),
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    sourceLineId: r.sourceLineId ?? null,
    originLayerId: r.originLayerId ?? null,
    originSourceType: r.originSourceType ?? null,
    originSourceId: r.originSourceId ?? null,
    originSourceLineId: r.originSourceLineId ?? null,
    effectiveDate: r.effectiveDate instanceof Date ? r.effectiveDate.toISOString() : String(r.effectiveDate),
    isExhausted: Boolean(r.isExhausted),
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  };
}

function mapMovement(r: any): ValuationMovement {
  return {
    id: r.id,
    companyId: r.companyId,
    warehouseId: r.warehouseId,
    warehouseCode: r.warehouseCode ?? undefined,
    warehouseNameAr: r.warehouseNameAr ?? undefined,
    itemId: r.itemId,
    itemCode: r.itemCode ?? undefined,
    itemNameAr: r.itemNameAr ?? undefined,
    movementType: r.movementType,
    qty: toDecimal(r.qty, 4),
    unitCost: toDecimal(r.unitCost, 4),
    totalCost: toDecimal(r.totalCost, 4),
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    sourceLineId: r.sourceLineId ?? null,
    journalEntryId: r.journalEntryId ?? null,
    reason: r.reason ?? null,
    costSource: r.costSource ?? null,
    costingMethod: r.costingMethod ?? null,
    referenceMovementId: r.referenceMovementId ?? null,
    notes: r.notes ?? null,
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  };
}

function mapAdjustment(r: any): CostAdjustmentRecord {
  return {
    id: r.id,
    companyId: r.companyId,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    sourceLineId: r.sourceLineId ?? null,
    grnId: r.grnId ?? null,
    grnLineId: r.grnLineId ?? null,
    invoiceId: r.invoiceId ?? null,
    invoiceLineId: r.invoiceLineId ?? null,
    costLayerId: r.costLayerId ?? null,
    itemId: r.itemId,
    itemCode: r.itemCode ?? undefined,
    itemNameAr: r.itemNameAr ?? undefined,
    warehouseId: r.warehouseId,
    warehouseCode: r.warehouseCode ?? undefined,
    warehouseNameAr: r.warehouseNameAr ?? undefined,
    costingMethod: r.costingMethod ?? null,
    qtyBasis: toDecimal(r.qtyBasis, 4),
    originalUnitCost: toDecimal(r.originalUnitCost, 4),
    finalUnitCost: toDecimal(r.finalUnitCost, 4),
    unitVariance: toDecimal(r.unitVariance, 4),
    adjustmentAmount: toDecimal(r.adjustmentAmount, 4),
    remainingAllocation: toDecimal(r.remainingAllocation, 4),
    consumedAllocation: toDecimal(r.consumedAllocation, 4),
    status: r.status,
    reason: r.reason ?? null,
    journalEntryId: r.journalEntryId ?? null,
    approvedBy: r.approvedBy ?? null,
    approvedAt: r.approvedAt ? (r.approvedAt instanceof Date ? r.approvedAt.toISOString() : String(r.approvedAt)) : null,
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  };
}

function mapOpening(r: any): OpeningValuationRecord {
  return {
    id: r.id,
    companyId: r.companyId,
    warehouseId: r.warehouseId,
    warehouseCode: r.warehouseCode ?? undefined,
    warehouseNameAr: r.warehouseNameAr ?? undefined,
    itemId: r.itemId,
    itemCode: r.itemCode ?? undefined,
    itemNameAr: r.itemNameAr ?? undefined,
    costingMethod: r.costingMethod ?? null,
    quantity: toDecimal(r.quantity, 4),
    totalCost: toDecimal(r.totalCost, 4),
    unitCost: toDecimal(r.unitCost, 4),
    status: r.status,
    reason: r.reason ?? null,
    evidenceRef: r.evidenceRef ?? null,
    approvedAt: r.approvedAt ? (r.approvedAt instanceof Date ? r.approvedAt.toISOString() : String(r.approvedAt)) : null,
    approvedBy: r.approvedBy ?? null,
    rejectedAt: r.rejectedAt ? (r.rejectedAt instanceof Date ? r.rejectedAt.toISOString() : String(r.rejectedAt)) : null,
    rejectedBy: r.rejectedBy ?? null,
    rejectionReason: r.rejectionReason ?? null,
    journalEntryId: r.journalEntryId ?? null,
    valuationMovementId: r.valuationMovementId ?? null,
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  };
}

function mapReconciliation(r: any): ValuationReconciliationRecord {
  return {
    id: r.id,
    companyId: r.companyId,
    warehouseId: r.warehouseId ?? null,
    warehouseNameAr: r.warehouseNameAr ?? null,
    itemId: r.itemId ?? null,
    itemNameAr: r.itemNameAr ?? null,
    costingMethod: r.costingMethod ?? null,
    periodId: r.periodId ?? null,
    periodCode: r.periodCode ?? null,
    accountId: r.accountId ?? null,
    subledgerTotal: toDecimal(r.subledgerTotal, 4),
    glControlTotal: toDecimal(r.glControlTotal, 4),
    variance: toDecimal(r.variance, 4),
    status: r.status,
    unmatchedMovementsCount: Number(r.unmatchedMovementsCount || 0),
    unbalancedAdjustmentsCount: Number(r.unbalancedAdjustmentsCount || 0),
    duplicateJournalLinksCount: Number(r.duplicateJournalLinksCount || 0),
    qtyValuationMismatchesCount: Number(r.qtyValuationMismatchesCount || 0),
    openingDiff: toDecimal(r.openingDiff || 0, 4),
    details: r.details ?? null,
    notes: r.notes ?? null,
    reconciledAt: r.reconciledAt instanceof Date ? r.reconciledAt.toISOString() : String(r.reconciledAt),
    reconciledBy: r.reconciledBy ?? null,
  };
}

export class InventoryValuationRepository {
  async listProfiles(companyId: string, customExecutor?: DbExecutor): Promise<CostingProfile[]> {
    const run = async (executor: DbExecutor): Promise<CostingProfile[]> => {
      const res = await executor.query<any>(
        `SELECT id, company_id as "companyId", name, costing_method as "costingMethod",
                is_default as "isDefault", is_active as "isActive", created_at as "createdAt"
         FROM inv_costing_profiles
         WHERE company_id = $1
         ORDER BY created_at ASC;`,
        [companyId]
      );
      return res.rows.map(mapProfile);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findProfileById(companyId: string, profileId: string, customExecutor?: DbExecutor): Promise<CostingProfile | null> {
    const run = async (executor: DbExecutor): Promise<CostingProfile | null> => {
      const res = await executor.query<any>(
        `SELECT id, company_id as "companyId", name, costing_method as "costingMethod",
                is_default as "isDefault", is_active as "isActive", created_at as "createdAt"
         FROM inv_costing_profiles
         WHERE company_id = $1 AND id = $2;`,
        [companyId, profileId]
      );
      return res.rows[0] ? mapProfile(res.rows[0]) : null;
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
      const res = await executor.query<any>(
        `INSERT INTO inv_costing_profiles (company_id, name, costing_method, is_default)
         VALUES ($1, $2, $3, $4)
         RETURNING id, company_id as "companyId", name, costing_method as "costingMethod",
                   is_default as "isDefault", is_active as "isActive", created_at as "createdAt";`,
        [companyId, input.name, input.costingMethod, Boolean(input.isDefault)]
      );
      return mapProfile(res.rows[0]);
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
         WHERE icp.company_id = $1 AND icp.item_id = $2 AND cp.is_active = true;`,
        [companyId, itemId]
      );
      return res.rows[0] || null;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async listItemAssignments(companyId: string, customExecutor?: DbExecutor): Promise<ItemCostingAssignment[]> {
    const run = async (executor: DbExecutor): Promise<ItemCostingAssignment[]> => {
      const res = await executor.query<ItemCostingAssignment>(
        `SELECT icp.company_id as "companyId", icp.item_id as "itemId", i.code as "itemCode", i.name_ar as "itemNameAr",
                icp.profile_id as "profileId", cp.name as "profileName", cp.costing_method as "costingMethod",
                icp.assigned_at as "assignedAt", icp.assigned_by as "assignedBy"
         FROM inv_item_costing_profiles icp
         JOIN inv_items i ON icp.company_id = i.company_id AND icp.item_id = i.id
         JOIN inv_costing_profiles cp ON icp.company_id = cp.company_id AND icp.profile_id = cp.id
         WHERE icp.company_id = $1
         ORDER BY i.code ASC;`,
        [companyId]
      );
      return res.rows;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async listUnassignedItems(
    companyId: string,
    customExecutor?: DbExecutor
  ): Promise<Array<{ itemId: string; itemCode: string; itemNameAr: string; hasStock: boolean }>> {
    const run = async (executor: DbExecutor) => {
      const res = await executor.query<any>(
        `SELECT
           i.id as "itemId",
           i.code as "itemCode",
           i.name_ar as "itemNameAr",
           EXISTS (
             SELECT 1 FROM inv_stock_balances sb
             WHERE sb.company_id = i.company_id AND sb.item_id = i.id AND sb.qty > 0
           ) as "hasStock"
         FROM inv_items i
         LEFT JOIN inv_item_costing_profiles icp
           ON icp.company_id = i.company_id AND icp.item_id = i.id
         WHERE i.company_id = $1 AND i.is_active = true AND icp.item_id IS NULL
         ORDER BY i.code ASC;`,
        [companyId]
      );
      return res.rows.map((r: any) => ({
        itemId: r.itemId,
        itemCode: r.itemCode,
        itemNameAr: r.itemNameAr,
        hasStock: Boolean(r.hasStock),
      }));
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async hasFinancialMovementsForItem(companyId: string, itemId: string, executor: DbExecutor): Promise<boolean> {
    const res = await executor.query<{ exists: boolean }>(
      `SELECT (
         EXISTS (SELECT 1 FROM inv_valuation_movements WHERE company_id = $1 AND item_id = $2)
         OR EXISTS (SELECT 1 FROM inv_cost_layers WHERE company_id = $1 AND item_id = $2)
         OR EXISTS (SELECT 1 FROM inv_valuation_balances WHERE company_id = $1 AND item_id = $2 AND (quantity > 0 OR total_cost > 0))
       ) as "exists";`,
      [companyId, itemId]
    );
    return Boolean(res.rows[0]?.exists);
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
      const res = await executor.query<any>(
        `SELECT vb.company_id as "companyId", vb.warehouse_id as "warehouseId", w.code as "warehouseCode", w.name_ar as "warehouseNameAr",
                vb.item_id as "itemId", i.code as "itemCode", i.name_ar as "itemNameAr", i.uom as "itemUom",
                cp.costing_method as "costingMethod",
                vb.quantity::text as "quantity", vb.total_cost::text as "totalCost", vb.unit_cost::text as "unitCost", vb.updated_at as "updatedAt"
         FROM inv_valuation_balances vb
         JOIN inv_warehouses w ON vb.company_id = w.company_id AND vb.warehouse_id = w.id
         JOIN inv_items i ON vb.company_id = i.company_id AND vb.item_id = i.id
         LEFT JOIN inv_item_costing_profiles icp ON icp.company_id = vb.company_id AND icp.item_id = vb.item_id
         LEFT JOIN inv_costing_profiles cp ON cp.company_id = icp.company_id AND cp.id = icp.profile_id
         WHERE vb.company_id = $1 AND vb.warehouse_id = $2 AND vb.item_id = $3;`,
        [companyId, warehouseId, itemId]
      );
      return res.rows[0] ? mapBalance(res.rows[0]) : null;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async listValuationBalances(companyId: string, customExecutor?: DbExecutor): Promise<ValuationBalance[]> {
    const run = async (executor: DbExecutor): Promise<ValuationBalance[]> => {
      const res = await executor.query<any>(
        `SELECT vb.company_id as "companyId", vb.warehouse_id as "warehouseId", w.code as "warehouseCode", w.name_ar as "warehouseNameAr",
                vb.item_id as "itemId", i.code as "itemCode", i.name_ar as "itemNameAr", i.uom as "itemUom",
                cp.costing_method as "costingMethod",
                vb.quantity::text as "quantity", vb.total_cost::text as "totalCost", vb.unit_cost::text as "unitCost", vb.updated_at as "updatedAt"
         FROM inv_valuation_balances vb
         JOIN inv_warehouses w ON vb.company_id = w.company_id AND vb.warehouse_id = w.id
         JOIN inv_items i ON vb.company_id = i.company_id AND vb.item_id = i.id
         LEFT JOIN inv_item_costing_profiles icp ON icp.company_id = vb.company_id AND icp.item_id = vb.item_id
         LEFT JOIN inv_costing_profiles cp ON cp.company_id = icp.company_id AND cp.id = icp.profile_id
         WHERE vb.company_id = $1
         ORDER BY w.code ASC, i.code ASC;`,
        [companyId]
      );
      return res.rows.map(mapBalance);
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
    const res = await executor.query<any>(
      `SELECT vb.company_id as "companyId", vb.warehouse_id as "warehouseId", vb.item_id as "itemId",
              vb.quantity::text as "quantity", vb.total_cost::text as "totalCost", vb.unit_cost::text as "unitCost", vb.updated_at as "updatedAt"
       FROM inv_valuation_balances vb
       WHERE vb.company_id = $1 AND vb.warehouse_id = $2 AND vb.item_id = $3
       FOR UPDATE;`,
      [companyId, warehouseId, itemId]
    );
    return res.rows[0] ? mapBalance(res.rows[0]) : null;
  }

  /**
   * Persists exact BigInt-computed valuation balance fields directly (zero SQL floating division).
   */
  async setValuationBalanceExact(
    companyId: string,
    warehouseId: string,
    itemId: string,
    quantity: string,
    totalCost: string,
    unitCost: string,
    executor: DbExecutor
  ): Promise<ValuationBalance> {
    await this.ensureValuationBalanceRow(companyId, warehouseId, itemId, executor);
    const res = await executor.query<any>(
      `UPDATE inv_valuation_balances
       SET quantity = $4::numeric,
           total_cost = $5::numeric,
           unit_cost = $6::numeric,
           updated_at = now()
       WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3
       RETURNING company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
                 quantity::text as "quantity", total_cost::text as "totalCost", unit_cost::text as "unitCost", updated_at as "updatedAt";`,
      [companyId, warehouseId, itemId, quantity, totalCost, unitCost]
    );
    return mapBalance(res.rows[0]);
  }

  async createCostLayer(
    companyId: string,
    input: {
      warehouseId: string;
      itemId: string;
      originalQty: string;
      unitCost: string;
      totalCost: string;
      sourceType: string;
      sourceId: string;
      sourceLineId?: string | null;
      originLayerId?: string | null;
      originSourceType?: string | null;
      originSourceId?: string | null;
      originSourceLineId?: string | null;
      effectiveDate?: string | null;
    },
    executor: DbExecutor
  ): Promise<CostLayer> {
    const res = await executor.query<any>(
      `INSERT INTO inv_cost_layers (
         company_id, warehouse_id, item_id, original_qty, remaining_qty,
         unit_cost, total_cost, source_type, source_id, source_line_id,
         origin_layer_id, origin_source_type, origin_source_id, origin_source_line_id,
         effective_date
       )
       VALUES ($1, $2, $3, $4::numeric, $4::numeric, $5::numeric, $6::numeric, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::timestamptz, now()))
       RETURNING id, company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
                 original_qty::text as "originalQty", remaining_qty::text as "remainingQty",
                 unit_cost::text as "unitCost", total_cost::text as "totalCost",
                 source_type as "sourceType", source_id as "sourceId", source_line_id as "sourceLineId",
                 origin_layer_id as "originLayerId", origin_source_type as "originSourceType",
                 origin_source_id as "originSourceId", origin_source_line_id as "originSourceLineId",
                 effective_date as "effectiveDate", is_exhausted as "isExhausted", created_at as "createdAt";`,
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
        input.originLayerId || null,
        input.originSourceType || input.sourceType,
        input.originSourceId || input.sourceId,
        input.originSourceLineId ?? input.sourceLineId ?? null,
        input.effectiveDate || null,
      ]
    );
    return mapLayer(res.rows[0]);
  }

  async listActiveCostLayersForUpdate(companyId: string, warehouseId: string, itemId: string, executor: DbExecutor): Promise<CostLayer[]> {
    const res = await executor.query<any>(
      `SELECT id, company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
              original_qty::text as "originalQty", remaining_qty::text as "remainingQty",
              unit_cost::text as "unitCost", total_cost::text as "totalCost",
              source_type as "sourceType", source_id as "sourceId", source_line_id as "sourceLineId",
              origin_layer_id as "originLayerId", origin_source_type as "originSourceType",
              origin_source_id as "originSourceId", origin_source_line_id as "originSourceLineId",
              effective_date as "effectiveDate", is_exhausted as "isExhausted", created_at as "createdAt"
       FROM inv_cost_layers
       WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 AND remaining_qty > 0 AND is_exhausted = false
       ORDER BY effective_date ASC, created_at ASC, id ASC
       FOR UPDATE;`,
      [companyId, warehouseId, itemId]
    );
    return res.rows.map(mapLayer);
  }

  async listCostLayers(
    companyId: string,
    filters?: { warehouseId?: string; itemId?: string; includeExhausted?: boolean },
    customExecutor?: DbExecutor
  ): Promise<CostLayer[]> {
    const run = async (executor: DbExecutor): Promise<CostLayer[]> => {
      const clauses = ['cl.company_id = $1'];
      const params: any[] = [companyId];
      if (filters?.warehouseId) {
        params.push(filters.warehouseId);
        clauses.push(`cl.warehouse_id = $${params.length}`);
      }
      if (filters?.itemId) {
        params.push(filters.itemId);
        clauses.push(`cl.item_id = $${params.length}`);
      }
      if (!filters?.includeExhausted) {
        clauses.push('cl.remaining_qty > 0 AND cl.is_exhausted = false');
      }
      const res = await executor.query<any>(
        `SELECT cl.id, cl.company_id as "companyId", cl.warehouse_id as "warehouseId",
                w.code as "warehouseCode", w.name_ar as "warehouseNameAr",
                cl.item_id as "itemId", i.code as "itemCode", i.name_ar as "itemNameAr",
                cl.original_qty::text as "originalQty", cl.remaining_qty::text as "remainingQty",
                cl.unit_cost::text as "unitCost", cl.total_cost::text as "totalCost",
                cl.source_type as "sourceType", cl.source_id as "sourceId", cl.source_line_id as "sourceLineId",
                cl.origin_layer_id as "originLayerId", cl.origin_source_type as "originSourceType",
                cl.origin_source_id as "originSourceId", cl.origin_source_line_id as "originSourceLineId",
                cl.effective_date as "effectiveDate", cl.is_exhausted as "isExhausted", cl.created_at as "createdAt"
         FROM inv_cost_layers cl
         JOIN inv_warehouses w ON w.company_id = cl.company_id AND w.id = cl.warehouse_id
         JOIN inv_items i ON i.company_id = cl.company_id AND i.id = cl.item_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY cl.effective_date ASC, cl.created_at ASC, cl.id ASC;`,
        params
      );
      return res.rows.map(mapLayer);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findLayersByOriginLineForUpdate(
    companyId: string,
    sourceId: string,
    sourceLineId: string,
    executor: DbExecutor
  ): Promise<CostLayer[]> {
    const res = await executor.query<any>(
      `SELECT id, company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
              original_qty::text as "originalQty", remaining_qty::text as "remainingQty",
              unit_cost::text as "unitCost", total_cost::text as "totalCost",
              source_type as "sourceType", source_id as "sourceId", source_line_id as "sourceLineId",
              origin_layer_id as "originLayerId", origin_source_type as "originSourceType",
              origin_source_id as "originSourceId", origin_source_line_id as "originSourceLineId",
              effective_date as "effectiveDate", is_exhausted as "isExhausted", created_at as "createdAt"
       FROM inv_cost_layers
       WHERE company_id = $1
         AND (
           (source_id = $2 AND source_line_id = $3)
           OR (origin_source_id = $2 AND origin_source_line_id = $3)
         )
       ORDER BY warehouse_id ASC, created_at ASC, id ASC
       FOR UPDATE;`,
      [companyId, sourceId, sourceLineId]
    );
    return res.rows.map(mapLayer);
  }

  async updateCostLayerRemaining(
    companyId: string,
    layerId: string,
    remainingQty: string,
    totalCost: string,
    isExhausted: boolean,
    executor: DbExecutor
  ): Promise<void> {
    await executor.query(
      `UPDATE inv_cost_layers
       SET remaining_qty = $3::numeric, total_cost = $4::numeric, is_exhausted = $5
       WHERE company_id = $1 AND id = $2;`,
      [companyId, layerId, remainingQty, totalCost, isExhausted]
    );
  }

  async updateCostLayerValuation(
    companyId: string,
    layerId: string,
    unitCost: string,
    totalCost: string,
    executor: DbExecutor
  ): Promise<void> {
    await executor.query(
      `UPDATE inv_cost_layers
       SET unit_cost = $3::numeric, total_cost = $4::numeric
       WHERE company_id = $1 AND id = $2;`,
      [companyId, layerId, unitCost, totalCost]
    );
  }

  async findValuationMovementByIdempotency(
    companyId: string,
    warehouseId: string,
    itemId: string,
    movementType: ValuationMovementType,
    sourceType: string,
    sourceId: string,
    sourceLineId: string | null | undefined,
    executor: DbExecutor
  ): Promise<ValuationMovement | null> {
    const res = await executor.query<any>(
      `SELECT id, company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
              movement_type as "movementType", qty::text as "qty", unit_cost::text as "unitCost",
              total_cost::text as "totalCost", source_type as "sourceType", source_id as "sourceId",
              source_line_id as "sourceLineId", journal_entry_id as "journalEntryId",
              reason, cost_source as "costSource", costing_method as "costingMethod",
              reference_movement_id as "referenceMovementId", notes,
              created_by as "createdBy", created_at as "createdAt"
       FROM inv_valuation_movements
       WHERE company_id = $1
         AND warehouse_id = $2
         AND item_id = $3
         AND movement_type = $4
         AND source_type = $5
         AND source_id = $6
         AND COALESCE(source_line_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($7::uuid, '00000000-0000-0000-0000-000000000000'::uuid);`,
      [companyId, warehouseId, itemId, movementType, sourceType, sourceId, sourceLineId || null]
    );
    return res.rows[0] ? mapMovement(res.rows[0]) : null;
  }

  async createValuationMovement(
    companyId: string,
    input: {
      warehouseId: string;
      itemId: string;
      movementType: ValuationMovementType;
      qty: string;
      unitCost: string;
      totalCost: string;
      sourceType: string;
      sourceId: string;
      sourceLineId?: string | null;
      journalEntryId?: string | null;
      reason?: string | null;
      costSource?: string | null;
      costingMethod?: CostingMethod | null;
      referenceMovementId?: string | null;
      notes?: string | null;
      createdBy?: string | null;
    },
    executor: DbExecutor
  ): Promise<ValuationMovement> {
    const res = await executor.query<any>(
      `INSERT INTO inv_valuation_movements (
         company_id, warehouse_id, item_id, movement_type, qty, unit_cost, total_cost,
         source_type, source_id, source_line_id, journal_entry_id,
         reason, cost_source, costing_method, reference_movement_id, notes, created_by
       )
       VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id, company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
                 movement_type as "movementType", qty::text as "qty", unit_cost::text as "unitCost",
                 total_cost::text as "totalCost", source_type as "sourceType", source_id as "sourceId",
                 source_line_id as "sourceLineId", journal_entry_id as "journalEntryId",
                 reason, cost_source as "costSource", costing_method as "costingMethod",
                 reference_movement_id as "referenceMovementId", notes,
                 created_by as "createdBy", created_at as "createdAt";`,
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
        input.reason || null,
        input.costSource || null,
        input.costingMethod || null,
        input.referenceMovementId || null,
        input.notes || null,
        input.createdBy || null,
      ]
    );
    return mapMovement(res.rows[0]);
  }

  async linkValuationMovementJournal(
    companyId: string,
    valuationMovementId: string,
    journalEntryId: string,
    executor: DbExecutor
  ): Promise<void> {
    await executor.query(
      `UPDATE inv_valuation_movements
       SET journal_entry_id = $3
       WHERE company_id = $1 AND id = $2;`,
      [companyId, valuationMovementId, journalEntryId]
    );
  }

  async linkCostAdjustmentsJournal(
    companyId: string,
    adjustmentIds: string[],
    journalEntryId: string,
    executor: DbExecutor
  ): Promise<void> {
    if (!adjustmentIds || adjustmentIds.length === 0) return;
    await executor.query(
      `UPDATE inv_cost_adjustments
       SET journal_entry_id = $3
       WHERE company_id = $1 AND id = ANY($2::uuid[]);`,
      [companyId, adjustmentIds, journalEntryId]
    );
  }

  async listValuationMovements(
    companyId: string,
    filters?: { warehouseId?: string; itemId?: string; limit?: number },
    customExecutor?: DbExecutor
  ): Promise<ValuationMovement[]> {
    const run = async (executor: DbExecutor): Promise<ValuationMovement[]> => {
      const clauses = ['vm.company_id = $1'];
      const params: any[] = [companyId];
      if (filters?.warehouseId) {
        params.push(filters.warehouseId);
        clauses.push(`vm.warehouse_id = $${params.length}`);
      }
      if (filters?.itemId) {
        params.push(filters.itemId);
        clauses.push(`vm.item_id = $${params.length}`);
      }
      const limit = Math.min(Math.max(filters?.limit || 100, 1), 500);
      params.push(limit);

      const res = await executor.query<any>(
        `SELECT vm.id, vm.company_id as "companyId", vm.warehouse_id as "warehouseId",
                w.code as "warehouseCode", w.name_ar as "warehouseNameAr",
                vm.item_id as "itemId", i.code as "itemCode", i.name_ar as "itemNameAr",
                vm.movement_type as "movementType", vm.qty::text as "qty", vm.unit_cost::text as "unitCost",
                vm.total_cost::text as "totalCost", vm.source_type as "sourceType", vm.source_id as "sourceId",
                vm.source_line_id as "sourceLineId", vm.journal_entry_id as "journalEntryId",
                vm.reason, vm.cost_source as "costSource", vm.costing_method as "costingMethod",
                vm.reference_movement_id as "referenceMovementId", vm.notes,
                vm.created_by as "createdBy", vm.created_at as "createdAt"
         FROM inv_valuation_movements vm
         JOIN inv_warehouses w ON w.company_id = vm.company_id AND w.id = vm.warehouse_id
         JOIN inv_items i ON i.company_id = vm.company_id AND i.id = vm.item_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY vm.created_at DESC
         LIMIT $${params.length};`,
        params
      );
      return res.rows.map(mapMovement);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async createCostAllocation(
    companyId: string,
    input: {
      valuationMovementId: string;
      costLayerId?: string | null;
      allocatedQty: string;
      unitCost: string;
      allocatedCost: string;
    },
    executor: DbExecutor
  ): Promise<void> {
    await executor.query(
      `INSERT INTO inv_cost_allocations (company_id, valuation_movement_id, cost_layer_id, allocated_qty, unit_cost, allocated_cost)
       VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric);`,
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

  async listAllocationsForMovement(
    companyId: string,
    valuationMovementId: string,
    customExecutor?: DbExecutor
  ): Promise<CostAllocationRecord[]> {
    const run = async (executor: DbExecutor) => {
      const res = await executor.query<any>(
        `SELECT id, company_id as "companyId", valuation_movement_id as "valuationMovementId",
                cost_layer_id as "costLayerId", allocated_qty::text as "allocatedQty",
                unit_cost::text as "unitCost", allocated_cost::text as "allocatedCost", created_at as "createdAt"
         FROM inv_cost_allocations
         WHERE company_id = $1 AND valuation_movement_id = $2
         ORDER BY created_at ASC;`,
        [companyId, valuationMovementId]
      );
      return res.rows.map((r: any) => ({
        ...r,
        allocatedQty: toDecimal(r.allocatedQty, 4),
        unitCost: toDecimal(r.unitCost, 4),
        allocatedCost: toDecimal(r.allocatedCost, 4),
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      }));
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async findCostAdjustmentsByInvoiceLine(
    companyId: string,
    invoiceLineId: string,
    executor: DbExecutor
  ): Promise<CostAdjustmentRecord[]> {
    const res = await executor.query<any>(
      `SELECT id, company_id as "companyId", source_type as "sourceType", source_id as "sourceId",
              source_line_id as "sourceLineId", grn_id as "grnId", grn_line_id as "grnLineId",
              invoice_id as "invoiceId", invoice_line_id as "invoiceLineId", cost_layer_id as "costLayerId",
              item_id as "itemId", warehouse_id as "warehouseId", costing_method as "costingMethod",
              qty_basis::text as "qtyBasis", original_unit_cost::text as "originalUnitCost",
              final_unit_cost::text as "finalUnitCost", unit_variance::text as "unitVariance",
              adjustment_amount::text as "adjustmentAmount", remaining_allocation::text as "remainingAllocation",
              consumed_allocation::text as "consumedAllocation", status, reason,
              journal_entry_id as "journalEntryId", approved_by as "approvedBy", approved_at as "approvedAt",
              created_by as "createdBy", created_at as "createdAt"
       FROM inv_cost_adjustments
       WHERE company_id = $1 AND invoice_line_id = $2;`,
      [companyId, invoiceLineId]
    );
    return res.rows.map(mapAdjustment);
  }

  async findCostAdjustmentsByGrnLine(
    companyId: string,
    grnLineId: string,
    executor: DbExecutor
  ): Promise<CostAdjustmentRecord[]> {
    const res = await executor.query<any>(
      `SELECT id, company_id as "companyId", source_type as "sourceType", source_id as "sourceId",
              source_line_id as "sourceLineId", grn_id as "grnId", grn_line_id as "grnLineId",
              invoice_id as "invoiceId", invoice_line_id as "invoiceLineId", cost_layer_id as "costLayerId",
              item_id as "itemId", warehouse_id as "warehouseId", costing_method as "costingMethod",
              qty_basis::text as "qtyBasis", original_unit_cost::text as "originalUnitCost",
              final_unit_cost::text as "finalUnitCost", unit_variance::text as "unitVariance",
              adjustment_amount::text as "adjustmentAmount", remaining_allocation::text as "remainingAllocation",
              consumed_allocation::text as "consumedAllocation", status, reason,
              journal_entry_id as "journalEntryId", approved_by as "approvedBy", approved_at as "approvedAt",
              created_by as "createdBy", created_at as "createdAt"
       FROM inv_cost_adjustments
       WHERE company_id = $1 AND grn_line_id = $2 AND status = 'posted'
       ORDER BY created_at ASC;`,
      [companyId, grnLineId]
    );
    return res.rows.map(mapAdjustment);
  }

  async createCostAdjustment(
    companyId: string,
    input: {
      sourceType: string;
      sourceId: string;
      sourceLineId?: string | null;
      grnId?: string | null;
      grnLineId?: string | null;
      invoiceId?: string | null;
      invoiceLineId?: string | null;
      costLayerId?: string | null;
      itemId: string;
      warehouseId: string;
      costingMethod?: CostingMethod | null;
      qtyBasis: string;
      originalUnitCost: string;
      finalUnitCost: string;
      unitVariance: string;
      adjustmentAmount: string;
      remainingAllocation: string;
      consumedAllocation: string;
      status?: string;
      reason?: string | null;
      journalEntryId?: string | null;
      approvedBy?: string | null;
      createdBy?: string | null;
    },
    executor: DbExecutor
  ): Promise<CostAdjustmentRecord> {
    const res = await executor.query<any>(
      `INSERT INTO inv_cost_adjustments (
         company_id, source_type, source_id, source_line_id,
         grn_id, grn_line_id, invoice_id, invoice_line_id, cost_layer_id,
         item_id, warehouse_id, costing_method,
         qty_basis, original_unit_cost, final_unit_cost, unit_variance,
         adjustment_amount, remaining_allocation, consumed_allocation,
         status, reason, journal_entry_id, approved_by, approved_at, created_by
       )
       VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8, $9,
         $10, $11, $12,
         $13::numeric, $14::numeric, $15::numeric, $16::numeric,
         $17::numeric, $18::numeric, $19::numeric,
         $20, $21, $22, $23, CASE WHEN $23 IS NOT NULL THEN now() ELSE NULL END, $24
       )
       RETURNING id, company_id as "companyId", source_type as "sourceType", source_id as "sourceId",
                 source_line_id as "sourceLineId", grn_id as "grnId", grn_line_id as "grnLineId",
                 invoice_id as "invoiceId", invoice_line_id as "invoiceLineId", cost_layer_id as "costLayerId",
                 item_id as "itemId", warehouse_id as "warehouseId", costing_method as "costingMethod",
                 qty_basis::text as "qtyBasis", original_unit_cost::text as "originalUnitCost",
                 final_unit_cost::text as "finalUnitCost", unit_variance::text as "unitVariance",
                 adjustment_amount::text as "adjustmentAmount", remaining_allocation::text as "remainingAllocation",
                 consumed_allocation::text as "consumedAllocation", status, reason,
                 journal_entry_id as "journalEntryId", approved_by as "approvedBy", approved_at as "approvedAt",
                 created_by as "createdBy", created_at as "createdAt";`,
      [
        companyId,
        input.sourceType,
        input.sourceId,
        input.sourceLineId || null,
        input.grnId || null,
        input.grnLineId || null,
        input.invoiceId || null,
        input.invoiceLineId || null,
        input.costLayerId || null,
        input.itemId,
        input.warehouseId,
        input.costingMethod || null,
        input.qtyBasis,
        input.originalUnitCost,
        input.finalUnitCost,
        input.unitVariance,
        input.adjustmentAmount,
        input.remainingAllocation,
        input.consumedAllocation,
        input.status || 'posted',
        input.reason || null,
        input.journalEntryId || null,
        input.approvedBy || null,
        input.createdBy || null,
      ]
    );
    return mapAdjustment(res.rows[0]);
  }

  async listCostAdjustments(
    companyId: string,
    customExecutor?: DbExecutor
  ): Promise<CostAdjustmentRecord[]> {
    const run = async (executor: DbExecutor) => {
      const res = await executor.query<any>(
        `SELECT ca.id, ca.company_id as "companyId", ca.source_type as "sourceType", ca.source_id as "sourceId",
                ca.source_line_id as "sourceLineId", ca.grn_id as "grnId", ca.grn_line_id as "grnLineId",
                ca.invoice_id as "invoiceId", ca.invoice_line_id as "invoiceLineId", ca.cost_layer_id as "costLayerId",
                ca.item_id as "itemId", i.code as "itemCode", i.name_ar as "itemNameAr",
                ca.warehouse_id as "warehouseId", w.code as "warehouseCode", w.name_ar as "warehouseNameAr",
                ca.costing_method as "costingMethod",
                ca.qty_basis::text as "qtyBasis", ca.original_unit_cost::text as "originalUnitCost",
                ca.final_unit_cost::text as "finalUnitCost", ca.unit_variance::text as "unitVariance",
                ca.adjustment_amount::text as "adjustmentAmount", ca.remaining_allocation::text as "remainingAllocation",
                ca.consumed_allocation::text as "consumedAllocation", ca.status, ca.reason,
                ca.journal_entry_id as "journalEntryId", ca.approved_by as "approvedBy", ca.approved_at as "approvedAt",
                ca.created_by as "createdBy", ca.created_at as "createdAt"
         FROM inv_cost_adjustments ca
         JOIN inv_warehouses w ON w.company_id = ca.company_id AND w.id = ca.warehouse_id
         JOIN inv_items i ON i.company_id = ca.company_id AND i.id = ca.item_id
         WHERE ca.company_id = $1
         ORDER BY ca.created_at DESC;`,
        [companyId]
      );
      return res.rows.map(mapAdjustment);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async createOpeningValuation(
    companyId: string,
    input: {
      warehouseId: string;
      itemId: string;
      costingMethod: CostingMethod;
      quantity: string;
      totalCost: string;
      unitCost: string;
      reason?: string | null;
      evidenceRef?: string | null;
      createdBy?: string | null;
    },
    executor: DbExecutor
  ): Promise<OpeningValuationRecord> {
    const res = await executor.query<any>(
      `INSERT INTO inv_opening_valuations (
         company_id, warehouse_id, item_id, costing_method, quantity, total_cost, unit_cost,
         status, reason, evidence_ref, created_by
       )
       VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric, 'pending_setup', $8, $9, $10)
       RETURNING id, company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
                 costing_method as "costingMethod", quantity::text as "quantity",
                 total_cost::text as "totalCost", unit_cost::text as "unitCost",
                 status, reason, evidence_ref as "evidenceRef",
                 approved_at as "approvedAt", approved_by as "approvedBy",
                 rejected_at as "rejectedAt", rejected_by as "rejectedBy", rejection_reason as "rejectionReason",
                 journal_entry_id as "journalEntryId", valuation_movement_id as "valuationMovementId",
                 created_by as "createdBy", created_at as "createdAt";`,
      [
        companyId,
        input.warehouseId,
        input.itemId,
        input.costingMethod,
        input.quantity,
        input.totalCost,
        input.unitCost,
        input.reason || null,
        input.evidenceRef || null,
        input.createdBy || null,
      ]
    );
    return mapOpening(res.rows[0]);
  }

  async findOpeningByIdForUpdate(companyId: string, openingId: string, executor: DbExecutor): Promise<OpeningValuationRecord | null> {
    const res = await executor.query<any>(
      `SELECT id, company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
              costing_method as "costingMethod", quantity::text as "quantity",
              total_cost::text as "totalCost", unit_cost::text as "unitCost",
              status, reason, evidence_ref as "evidenceRef",
              approved_at as "approvedAt", approved_by as "approvedBy",
              rejected_at as "rejectedAt", rejected_by as "rejectedBy", rejection_reason as "rejectionReason",
              journal_entry_id as "journalEntryId", valuation_movement_id as "valuationMovementId",
              created_by as "createdBy", created_at as "createdAt"
       FROM inv_opening_valuations
       WHERE company_id = $1 AND id = $2
       FOR UPDATE;`,
      [companyId, openingId]
    );
    return res.rows[0] ? mapOpening(res.rows[0]) : null;
  }

  async markOpeningApproved(
    companyId: string,
    openingId: string,
    approvedBy: string,
    journalEntryId: string | null,
    valuationMovementId: string,
    executor: DbExecutor
  ): Promise<OpeningValuationRecord> {
    const res = await executor.query<any>(
      `UPDATE inv_opening_valuations
       SET status = 'approved',
           approved_at = now(),
           approved_by = $3,
           journal_entry_id = $4,
           valuation_movement_id = $5
       WHERE company_id = $1 AND id = $2 AND status = 'pending_setup'
       RETURNING id, company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
                 costing_method as "costingMethod", quantity::text as "quantity",
                 total_cost::text as "totalCost", unit_cost::text as "unitCost",
                 status, reason, evidence_ref as "evidenceRef",
                 approved_at as "approvedAt", approved_by as "approvedBy",
                 rejected_at as "rejectedAt", rejected_by as "rejectedBy", rejection_reason as "rejectionReason",
                 journal_entry_id as "journalEntryId", valuation_movement_id as "valuationMovementId",
                 created_by as "createdBy", created_at as "createdAt";`,
      [companyId, openingId, approvedBy, journalEntryId, valuationMovementId]
    );
    return mapOpening(res.rows[0]);
  }

  async markOpeningRejected(
    companyId: string,
    openingId: string,
    rejectedBy: string,
    rejectionReason: string,
    executor: DbExecutor
  ): Promise<OpeningValuationRecord> {
    const res = await executor.query<any>(
      `UPDATE inv_opening_valuations
       SET status = 'rejected',
           rejected_at = now(),
           rejected_by = $3,
           rejection_reason = $4
       WHERE company_id = $1 AND id = $2 AND status = 'pending_setup'
       RETURNING id, company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
                 costing_method as "costingMethod", quantity::text as "quantity",
                 total_cost::text as "totalCost", unit_cost::text as "unitCost",
                 status, reason, evidence_ref as "evidenceRef",
                 approved_at as "approvedAt", approved_by as "approvedBy",
                 rejected_at as "rejectedAt", rejected_by as "rejectedBy", rejection_reason as "rejectionReason",
                 journal_entry_id as "journalEntryId", valuation_movement_id as "valuationMovementId",
                 created_by as "createdBy", created_at as "createdAt";`,
      [companyId, openingId, rejectedBy, rejectionReason]
    );
    return mapOpening(res.rows[0]);
  }

  async listOpeningValuations(companyId: string, customExecutor?: DbExecutor): Promise<OpeningValuationRecord[]> {
    const run = async (executor: DbExecutor) => {
      const res = await executor.query<any>(
        `SELECT ov.id, ov.company_id as "companyId", ov.warehouse_id as "warehouseId",
                w.code as "warehouseCode", w.name_ar as "warehouseNameAr",
                ov.item_id as "itemId", i.code as "itemCode", i.name_ar as "itemNameAr",
                ov.costing_method as "costingMethod", ov.quantity::text as "quantity",
                ov.total_cost::text as "totalCost", ov.unit_cost::text as "unitCost",
                ov.status, ov.reason, ov.evidence_ref as "evidenceRef",
                ov.approved_at as "approvedAt", ov.approved_by as "approvedBy",
                ov.rejected_at as "rejectedAt", ov.rejected_by as "rejectedBy", ov.rejection_reason as "rejectionReason",
                ov.journal_entry_id as "journalEntryId", ov.valuation_movement_id as "valuationMovementId",
                ov.created_by as "createdBy", ov.created_at as "createdAt"
         FROM inv_opening_valuations ov
         JOIN inv_warehouses w ON w.company_id = ov.company_id AND w.id = ov.warehouse_id
         JOIN inv_items i ON i.company_id = ov.company_id AND i.id = ov.item_id
         WHERE ov.company_id = $1
         ORDER BY ov.created_at DESC;`,
        [companyId]
      );
      return res.rows.map(mapOpening);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async saveReconciliation(
    companyId: string,
    input: {
      warehouseId?: string | null;
      itemId?: string | null;
      costingMethod?: CostingMethod | null;
      periodId?: string | null;
      accountId?: string | null;
      subledgerTotal: string;
      glControlTotal: string;
      variance: string;
      status: 'reconciled' | 'discrepancy_detected';
      unmatchedMovementsCount: number;
      unbalancedAdjustmentsCount: number;
      duplicateJournalLinksCount: number;
      qtyValuationMismatchesCount: number;
      openingDiff: string;
      details?: Record<string, unknown> | null;
      notes?: string | null;
      reconciledBy?: string | null;
    },
    executor: DbExecutor
  ): Promise<ValuationReconciliationRecord> {
    const res = await executor.query<any>(
      `INSERT INTO inv_valuation_reconciliations (
         company_id, warehouse_id, item_id, costing_method, period_id, account_id,
         subledger_total, gl_control_total, variance, status,
         unmatched_movements_count, unbalanced_adjustments_count, duplicate_journal_links_count,
         qty_valuation_mismatches_count, opening_diff, details, notes, reconciled_by
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::numeric, $8::numeric, $9::numeric, $10,
         $11, $12, $13, $14, $15::numeric, $16::jsonb, $17, $18
       )
       RETURNING id, company_id as "companyId", warehouse_id as "warehouseId", item_id as "itemId",
                 costing_method as "costingMethod", period_id as "periodId", account_id as "accountId",
                 subledger_total::text as "subledgerTotal", gl_control_total::text as "glControlTotal",
                 variance::text as "variance", status,
                 unmatched_movements_count as "unmatchedMovementsCount",
                 unbalanced_adjustments_count as "unbalancedAdjustmentsCount",
                 duplicate_journal_links_count as "duplicateJournalLinksCount",
                 qty_valuation_mismatches_count as "qtyValuationMismatchesCount",
                 opening_diff::text as "openingDiff",
                 details, notes, reconciled_at as "reconciledAt", reconciled_by as "reconciledBy";`,
      [
        companyId,
        input.warehouseId || null,
        input.itemId || null,
        input.costingMethod || null,
        input.periodId || null,
        input.accountId || null,
        input.subledgerTotal,
        input.glControlTotal,
        input.variance,
        input.status,
        input.unmatchedMovementsCount,
        input.unbalancedAdjustmentsCount,
        input.duplicateJournalLinksCount,
        input.qtyValuationMismatchesCount,
        input.openingDiff,
        input.details ? JSON.stringify(input.details) : null,
        input.notes || null,
        input.reconciledBy || null,
      ]
    );
    return mapReconciliation(res.rows[0]);
  }

  async listReconciliations(companyId: string, customExecutor?: DbExecutor): Promise<ValuationReconciliationRecord[]> {
    const run = async (executor: DbExecutor) => {
      const res = await executor.query<any>(
        `SELECT vr.id, vr.company_id as "companyId",
                vr.warehouse_id as "warehouseId", w.name_ar as "warehouseNameAr",
                vr.item_id as "itemId", i.name_ar as "itemNameAr",
                vr.costing_method as "costingMethod",
                vr.period_id as "periodId", ap.code as "periodCode",
                vr.account_id as "accountId",
                vr.subledger_total::text as "subledgerTotal",
                vr.gl_control_total::text as "glControlTotal",
                vr.variance::text as "variance",
                vr.status,
                vr.unmatched_movements_count as "unmatchedMovementsCount",
                vr.unbalanced_adjustments_count as "unbalancedAdjustmentsCount",
                vr.duplicate_journal_links_count as "duplicateJournalLinksCount",
                vr.qty_valuation_mismatches_count as "qtyValuationMismatchesCount",
                vr.opening_diff::text as "openingDiff",
                vr.details, vr.notes,
                vr.reconciled_at as "reconciledAt", vr.reconciled_by as "reconciledBy"
         FROM inv_valuation_reconciliations vr
         LEFT JOIN inv_warehouses w ON w.company_id = vr.company_id AND w.id = vr.warehouse_id
         LEFT JOIN inv_items i ON i.company_id = vr.company_id AND i.id = vr.item_id
         LEFT JOIN accounting_periods ap ON ap.company_id = vr.company_id AND ap.id = vr.period_id
         WHERE vr.company_id = $1
         ORDER BY vr.reconciled_at DESC
         LIMIT 100;`,
        [companyId]
      );
      return res.rows.map(mapReconciliation);
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultInventoryValuationRepository = new InventoryValuationRepository();
