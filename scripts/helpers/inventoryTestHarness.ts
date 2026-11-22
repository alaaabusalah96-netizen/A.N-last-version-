import crypto from 'node:crypto';
import pg from 'pg';
import { DbExecutor, QueryResult } from '../../src/server/db/types.js';
import { defaultInventoryValuationService } from '../../src/server/inventory/inventoryValuationService.js';

/**
 * Adapts an active pg.Client (e.g. an_app connection already inside BEGIN + SET LOCAL app.current_tenant_id)
 * to the DbExecutor interface without creating a separate pool or altering RLS state.
 */
export function createPgClientExecutor(client: pg.Client): DbExecutor {
  return {
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const res = await client.query(sql, params);
      return {
        rows: res.rows as T[],
        rowCount: res.rowCount ?? res.rows.length ?? 0,
      };
    },
    async withTransaction<T>(fn: (ex: DbExecutor) => Promise<T>): Promise<T> {
      const spName = `sp_test_${crypto.randomBytes(4).toString('hex')}`;
      await client.query(`SAVEPOINT ${spName};`);
      try {
        const result = await fn(this);
        await client.query(`RELEASE SAVEPOINT ${spName};`);
        return result;
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${spName};`).catch(() => {});
        throw err;
      }
    },
    async health(): Promise<{ ok: boolean; detail?: string }> {
      try {
        await client.query('SELECT 1');
        return { ok: true };
      } catch (err: any) {
        return { ok: false, detail: err?.message || String(err) };
      }
    },
    async close(): Promise<void> {
      // Caller owns the pg.Client lifecycle.
    },
  };
}

export interface StockValuationParityResult {
  stockQty: number;
  valuationQty: number;
  layerRemainingQty: number;
  initializedOpening: boolean;
}

/**
 * Inspects actual physical stock and valuation balances inside an existing tenant transaction
 * on `executor`, harmonizes uninitialized opening stock via official
 * `InventoryValuationService.processReceipt(..., { movementType: 'OPENING', stockSyncMode: 'external_verified' })`,
 * and verifies stock qty == valuation qty == FIFO layer remaining qty.
 */
export async function harmonizeStockAndValuationOnExecutor(params: {
  companyId: string;
  warehouseId: string;
  itemId: string;
  unitCost: number;
  actorId: string;
  executor: DbExecutor;
}): Promise<StockValuationParityResult> {
  const { companyId, warehouseId, itemId, unitCost, actorId, executor } = params;

  const stockRes = await executor.query<{ qty: string }>(
    `SELECT qty::text AS qty
     FROM inv_stock_balances
     WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3
     FOR UPDATE;`,
    [companyId, warehouseId, itemId]
  );
  const stockQty = Number(stockRes.rows[0]?.qty ?? 0);

  const valRes = await executor.query<{ qty: string }>(
    `SELECT quantity::text AS qty
     FROM inv_valuation_balances
     WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3
     FOR UPDATE;`,
    [companyId, warehouseId, itemId]
  );
  const preValQty = valRes.rows[0] ? Number(valRes.rows[0].qty) : 0;

  let initializedOpening = false;
  if (stockQty > 0 && valRes.rows.length === 0) {
    await defaultInventoryValuationService.processReceipt(
      companyId,
      {
        warehouseId,
        itemId,
        qty: stockQty,
        unitCost,
        sourceType: 'OPENING_TEST_SEED',
        sourceId: crypto.randomUUID(),
        movementType: 'OPENING',
        reason: 'Test fixture opening valuation harmonization',
        costSource: 'TEST_OPENING_HARMONIZATION',
        stockSyncMode: 'external_verified',
        expectedPreStockQty: 0,
        expectedPostStockQty: stockQty,
      },
      actorId,
      executor
    );
    initializedOpening = true;
  } else if (stockQty !== preValQty) {
    throw new Error(
      `HARMONIZATION_MISMATCH: Existing physical stock (${stockQty}) differs from valuation balance (${preValQty}) for warehouse=${warehouseId}, item=${itemId}`
    );
  }

  const verifyRes = await executor.query<{
    stock_qty: number;
    val_qty: number;
    layer_qty: number;
  }>(
    `SELECT
       s.qty::float AS stock_qty,
       COALESCE(v.quantity, 0)::float AS val_qty,
       COALESCE((
         SELECT SUM(l.remaining_qty)
         FROM inv_cost_layers l
         WHERE l.company_id = s.company_id
           AND l.warehouse_id = s.warehouse_id
           AND l.item_id = s.item_id
           AND l.is_exhausted = false
       ), 0)::float AS layer_qty
     FROM inv_stock_balances s
     LEFT JOIN inv_valuation_balances v
       ON v.company_id = s.company_id
      AND v.warehouse_id = s.warehouse_id
      AND v.item_id = s.item_id
     WHERE s.company_id = $1 AND s.warehouse_id = $2 AND s.item_id = $3;`,
    [companyId, warehouseId, itemId]
  );

  const row = verifyRes.rows[0];
  if (!row) {
    throw new Error(`HARMONIZATION_MISSING_ROW: No stock row found for warehouse=${warehouseId}, item=${itemId}`);
  }

  return {
    stockQty: row.stock_qty,
    valuationQty: row.val_qty,
    layerRemainingQty: row.layer_qty,
    initializedOpening,
  };
}

/**
 * Seeds a deliberate stock-vs-valuation mismatch fixture strictly inside the caller's active
 * tenant transaction on `executor` (so RLS-enforced tables like inv_warehouses always have
 * `app.current_tenant_id` set).
 */
export async function seedDeliberateValuationMismatchOnExecutor(params: {
  companyId: string;
  warehouseCode: string;
  warehouseNameAr: string;
  itemId: string;
  stockQty: number;
  valuationQty: number;
  unitCost: number;
  executor: DbExecutor;
}): Promise<{ warehouseId: string; stockQty: number; valuationQty: number }> {
  const { companyId, warehouseCode, warehouseNameAr, itemId, stockQty, valuationQty, unitCost, executor } = params;

  const whRes = await executor.query<{ id: string }>(
    `INSERT INTO inv_warehouses (company_id, code, name_ar)
     VALUES ($1, $2, $3)
     RETURNING id;`,
    [companyId, warehouseCode, warehouseNameAr]
  );
  const warehouseId = whRes.rows[0].id;

  await executor.query(
    `INSERT INTO inv_stock_balances (company_id, warehouse_id, item_id, qty, updated_at)
     VALUES ($1, $2, $3, $4, NOW());`,
    [companyId, warehouseId, itemId, stockQty]
  );

  const totalCost = valuationQty * unitCost;
  await executor.query(
    `INSERT INTO inv_valuation_balances (company_id, warehouse_id, item_id, quantity, total_cost, unit_cost, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW());`,
    [companyId, warehouseId, itemId, valuationQty, totalCost, unitCost]
  );

  await executor.query(
    `INSERT INTO inv_cost_layers (
       company_id, warehouse_id, item_id, original_qty, remaining_qty,
       unit_cost, total_cost, source_type, source_id, is_exhausted
     ) VALUES ($1, $2, $3, $4, $4, $5, $6, 'OPENING_TEST_MISMATCH', $7, false);`,
    [companyId, warehouseId, itemId, valuationQty, unitCost, totalCost, crypto.randomUUID()]
  );

  return { warehouseId, stockQty, valuationQty };
}

export interface InventoryTeardownCheckResult {
  remainingChildCount: number;
  breakdown: Record<string, number>;
}

/**
 * Verifies post-teardown cleanliness across all test-owned inventory and valuation child tables.
 * Intentionally excludes protected immutable tables (`companies`, `audit_logs`).
 */
export async function countRemainingTestInventoryRows(params: {
  executor: { query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }> };
  ownedCompanies: string[];
  registeredMovements: string[];
  registeredItems: string[];
  registeredWarehouses: string[];
}): Promise<InventoryTeardownCheckResult> {
  const { executor, ownedCompanies, registeredMovements, registeredItems, registeredWarehouses } = params;
  const zeroUuid = '00000000-0000-0000-0000-000000000000';
  const safeCompanies = ownedCompanies.length > 0 ? ownedCompanies : [zeroUuid];
  const safeMovements = registeredMovements.length > 0 ? registeredMovements : [zeroUuid];
  const safeItems = registeredItems.length > 0 ? registeredItems : [zeroUuid];
  const safeWarehouses = registeredWarehouses.length > 0 ? registeredWarehouses : [zeroUuid];

  const res = await executor.query<{
    stock_movements: number;
    stock_balances: number;
    valuation_balances: number;
    cost_layers: number;
    valuation_movements: number;
    cost_allocations: number;
    ma_source_events: number;
    ma_source_balances: number;
    item_costing_profiles: number;
    items: number;
    warehouses: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM inv_stock_movements WHERE id = ANY($1::uuid[]) OR company_id = ANY($2::uuid[])) AS stock_movements,
       (SELECT count(*)::int FROM inv_stock_balances WHERE company_id = ANY($2::uuid[])) AS stock_balances,
       (SELECT count(*)::int FROM inv_valuation_balances WHERE company_id = ANY($2::uuid[])) AS valuation_balances,
       (SELECT count(*)::int FROM inv_cost_layers WHERE company_id = ANY($2::uuid[])) AS cost_layers,
       (SELECT count(*)::int FROM inv_valuation_movements WHERE company_id = ANY($2::uuid[])) AS valuation_movements,
       (SELECT count(*)::int FROM inv_cost_allocations WHERE company_id = ANY($2::uuid[])) AS cost_allocations,
       (SELECT count(*)::int FROM inv_ma_source_events WHERE company_id = ANY($2::uuid[])) AS ma_source_events,
       (SELECT count(*)::int FROM inv_ma_source_balances WHERE company_id = ANY($2::uuid[])) AS ma_source_balances,
       (SELECT count(*)::int FROM inv_item_costing_profiles WHERE company_id = ANY($2::uuid[]) AND item_id = ANY($3::uuid[])) AS item_costing_profiles,
       (SELECT count(*)::int FROM inv_items WHERE id = ANY($3::uuid[])) AS items,
       (SELECT count(*)::int FROM inv_warehouses WHERE id = ANY($4::uuid[])) AS warehouses;`,
    [safeMovements, safeCompanies, safeItems, safeWarehouses]
  );

  const row = res.rows[0] || {
    stock_movements: 0,
    stock_balances: 0,
    valuation_balances: 0,
    cost_layers: 0,
    valuation_movements: 0,
    cost_allocations: 0,
    ma_source_events: 0,
    ma_source_balances: 0,
    item_costing_profiles: 0,
    items: 0,
    warehouses: 0,
  };

  const remainingChildCount =
    row.stock_movements +
    row.stock_balances +
    row.valuation_balances +
    row.cost_layers +
    row.valuation_movements +
    row.cost_allocations +
    row.ma_source_events +
    row.ma_source_balances +
    row.item_costing_profiles +
    row.items +
    row.warehouses;

  return {
    remainingChildCount,
    breakdown: { ...row },
  };
}
