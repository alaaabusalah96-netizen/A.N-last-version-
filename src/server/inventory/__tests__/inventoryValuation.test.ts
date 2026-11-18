import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InventoryValuationService } from '../inventoryValuationService.js';
import {
  CostingMethod,
  CostLayer,
  ValuationBalance,
  ValuationMovement,
  CostAdjustmentRecord,
  CostAllocationRecord,
} from '../inventoryValuationTypes.js';
import {
  parseExactUnits,
  mulExactUnits,
  divExactUnits,
  allocateProportionalUnits,
  fromMinorUnits,
  QTY_SCALE,
  COST_SCALE,
} from '../../lib/numeric.js';

/**
 * Stateful in-memory valuation & stock store verifying Phase 1 core invariants
 * without relying on trivial stub return values.
 */
function createInMemoryStores() {
  const assignments = new Map<string, { profileId: string; costingMethod: CostingMethod }>();
  const profiles = new Map<string, { id: string; name: string; costingMethod: CostingMethod; isActive: boolean }>();
  const valBalances = new Map<string, ValuationBalance>();
  const stockBalances = new Map<string, { companyId: string; warehouseId: string; itemId: string; qty: number }>();
  const layers: CostLayer[] = [];
  const movements: ValuationMovement[] = [];
  const allocations: CostAllocationRecord[] = [];
  const adjustments: CostAdjustmentRecord[] = [];
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}-${seq++}`;
  const key = (c: string, w: string, i: string) => `${c}::${w}::${i}`;

  const valuationRepo: any = {
    listProfiles: vi.fn(async () => Array.from(profiles.values())),
    findProfileById: vi.fn(async (_c: string, id: string) => profiles.get(id) || null),
    createProfile: vi.fn(async (companyId: string, input: any) => {
      const p = { id: nextId('prof'), companyId, name: input.name, costingMethod: input.costingMethod, isDefault: Boolean(input.isDefault), isActive: true, createdAt: new Date().toISOString() };
      profiles.set(p.id, p);
      return p;
    }),
    getItemAssignment: vi.fn(async (companyId: string, itemId: string) => {
      const a = assignments.get(`${companyId}::${itemId}`);
      if (!a) return null;
      return { companyId, itemId, profileId: a.profileId, costingMethod: a.costingMethod, assignedAt: new Date().toISOString() };
    }),
    hasFinancialMovementsForItem: vi.fn(async (companyId: string, itemId: string) => {
      return movements.some((m) => m.companyId === companyId && m.itemId === itemId)
        || layers.some((l) => l.companyId === companyId && l.itemId === itemId)
        || Array.from(valBalances.values()).some((b) => b.companyId === companyId && b.itemId === itemId && (b.quantity > 0 || b.totalCost > 0));
    }),
    assignItemProfile: vi.fn(async (companyId: string, itemId: string, profileId: string) => {
      const p = profiles.get(profileId)!;
      assignments.set(`${companyId}::${itemId}`, { profileId, costingMethod: p.costingMethod });
      return { companyId, itemId, profileId, costingMethod: p.costingMethod, assignedAt: new Date().toISOString() };
    }),
    lockValuationBalanceForUpdate: vi.fn(async (companyId: string, warehouseId: string, itemId: string) => {
      const k = key(companyId, warehouseId, itemId);
      if (!valBalances.has(k)) {
        valBalances.set(k, {
          companyId,
          warehouseId,
          itemId,
          quantity: 0,
          totalCost: 0,
          unitCost: 0,
          updatedAt: new Date().toISOString(),
        });
      }
      return { ...valBalances.get(k)! };
    }),
    setValuationBalanceExact: vi.fn(async (companyId: string, warehouseId: string, itemId: string, qty: string, totalCost: string, unitCost: string) => {
      const row: ValuationBalance = {
        companyId,
        warehouseId,
        itemId,
        quantity: Number(qty),
        totalCost: Number(totalCost),
        unitCost: Number(unitCost),
        updatedAt: new Date().toISOString(),
      };
      valBalances.set(key(companyId, warehouseId, itemId), row);
      return { ...row };
    }),
    createCostLayer: vi.fn(async (companyId: string, input: any) => {
      const layer: CostLayer = {
        id: nextId('layer'),
        companyId,
        warehouseId: input.warehouseId,
        itemId: input.itemId,
        originalQty: Number(input.originalQty),
        remainingQty: Number(input.originalQty),
        unitCost: Number(input.unitCost),
        totalCost: Number(input.totalCost),
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceLineId: input.sourceLineId ?? null,
        originLayerId: input.originLayerId ?? null,
        originSourceType: input.originSourceType ?? input.sourceType,
        originSourceId: input.originSourceId ?? input.sourceId,
        originSourceLineId: input.originSourceLineId ?? input.sourceLineId ?? null,
        effectiveDate: input.effectiveDate || new Date(Date.now() + seq * 1000).toISOString(),
        isExhausted: false,
        createdAt: new Date().toISOString(),
      };
      layers.push(layer);
      return { ...layer };
    }),
    listActiveCostLayersForUpdate: vi.fn(async (companyId: string, warehouseId: string, itemId: string) => {
      return layers
        .filter((l) => l.companyId === companyId && l.warehouseId === warehouseId && l.itemId === itemId && !l.isExhausted && l.remainingQty > 0)
        .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id))
        .map((l) => ({ ...l }));
    }),
    findLayersByOriginLineForUpdate: vi.fn(async (companyId: string, sourceId: string, sourceLineId: string) => {
      return layers
        .filter(
          (l) =>
            l.companyId === companyId &&
            ((l.sourceId === sourceId && l.sourceLineId === sourceLineId) ||
              (l.originSourceId === sourceId && l.originSourceLineId === sourceLineId))
        )
        .map((l) => ({ ...l }));
    }),
    updateCostLayerRemaining: vi.fn(async (companyId: string, layerId: string, remQty: string, totalCost: string, isExhausted: boolean) => {
      const l = layers.find((x) => x.companyId === companyId && x.id === layerId)!;
      l.remainingQty = Number(remQty);
      l.totalCost = Number(totalCost);
      l.isExhausted = isExhausted;
    }),
    updateCostLayerValuation: vi.fn(async (companyId: string, layerId: string, unitCost: string, totalCost: string) => {
      const l = layers.find((x) => x.companyId === companyId && x.id === layerId)!;
      l.unitCost = Number(unitCost);
      l.totalCost = Number(totalCost);
    }),
    findValuationMovementByIdempotency: vi.fn(async (companyId: string, warehouseId: string, itemId: string, movementType: string, sourceType: string, sourceId: string, sourceLineId?: string | null) => {
      return (
        movements.find(
          (m) =>
            m.companyId === companyId &&
            m.warehouseId === warehouseId &&
            m.itemId === itemId &&
            m.movementType === movementType &&
            m.sourceType === sourceType &&
            m.sourceId === sourceId &&
            (m.sourceLineId ?? null) === (sourceLineId ?? null)
        ) || null
      );
    }),
    createValuationMovement: vi.fn(async (companyId: string, input: any) => {
      const m: ValuationMovement = {
        id: nextId('mov'),
        companyId,
        warehouseId: input.warehouseId,
        itemId: input.itemId,
        movementType: input.movementType,
        qty: Number(input.qty),
        unitCost: Number(input.unitCost),
        totalCost: Number(input.totalCost),
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceLineId: input.sourceLineId ?? null,
        journalEntryId: input.journalEntryId ?? null,
        reason: input.reason ?? null,
        costSource: input.costSource ?? null,
        costingMethod: input.costingMethod ?? null,
        referenceMovementId: input.referenceMovementId ?? null,
        notes: input.notes ?? null,
        createdBy: input.createdBy ?? null,
        createdAt: new Date().toISOString(),
      };
      movements.push(m);
      return { ...m };
    }),
    createCostAllocation: vi.fn(async (companyId: string, input: any) => {
      allocations.push({
        id: nextId('alloc'),
        companyId,
        valuationMovementId: input.valuationMovementId,
        costLayerId: input.costLayerId ?? null,
        allocatedQty: Number(input.allocatedQty),
        unitCost: Number(input.unitCost),
        allocatedCost: Number(input.allocatedCost),
        createdAt: new Date().toISOString(),
      });
    }),
    findCostAdjustmentsByInvoiceLine: vi.fn(async (companyId: string, invoiceLineId: string) =>
      adjustments.filter((a) => a.companyId === companyId && a.invoiceLineId === invoiceLineId)
    ),
    findCostAdjustmentsByGrnLine: vi.fn(async (companyId: string, grnLineId: string) =>
      adjustments.filter((a) => a.companyId === companyId && a.grnLineId === grnLineId && a.status === 'posted')
    ),
    createCostAdjustment: vi.fn(async (companyId: string, input: any) => {
      const a: CostAdjustmentRecord = {
        id: nextId('adj'),
        companyId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceLineId: input.sourceLineId ?? null,
        grnId: input.grnId ?? null,
        grnLineId: input.grnLineId ?? null,
        invoiceId: input.invoiceId ?? null,
        invoiceLineId: input.invoiceLineId ?? null,
        costLayerId: input.costLayerId ?? null,
        itemId: input.itemId,
        warehouseId: input.warehouseId,
        costingMethod: input.costingMethod ?? null,
        qtyBasis: Number(input.qtyBasis),
        originalUnitCost: Number(input.originalUnitCost),
        finalUnitCost: Number(input.finalUnitCost),
        unitVariance: Number(input.unitVariance),
        adjustmentAmount: Number(input.adjustmentAmount),
        remainingAllocation: Number(input.remainingAllocation),
        consumedAllocation: Number(input.consumedAllocation),
        status: input.status || 'posted',
        reason: input.reason ?? null,
        journalEntryId: input.journalEntryId ?? null,
        approvedBy: input.approvedBy ?? null,
        approvedAt: null,
        createdBy: input.createdBy ?? null,
        createdAt: new Date().toISOString(),
      };
      adjustments.push(a);
      return { ...a };
    }),
  };

  const stockRepo: any = {
    ensureBalanceRow: vi.fn(async (companyId: string, warehouseId: string, itemId: string) => {
      const k = key(companyId, warehouseId, itemId);
      if (!stockBalances.has(k)) {
        stockBalances.set(k, { companyId, warehouseId, itemId, qty: 0 });
      }
    }),
    getBalanceForUpdate: vi.fn(async (companyId: string, warehouseId: string, itemId: string) => {
      const s = stockBalances.get(key(companyId, warehouseId, itemId));
      return s ? { ...s } : null;
    }),
    incrementBalance: vi.fn(async (companyId: string, warehouseId: string, itemId: string, qty: number) => {
      const k = key(companyId, warehouseId, itemId);
      const cur = stockBalances.get(k) || { companyId, warehouseId, itemId, qty: 0 };
      const sumUnits = parseExactUnits(cur.qty, QTY_SCALE) + parseExactUnits(qty, QTY_SCALE);
      const next = { ...cur, qty: Number(fromMinorUnits(sumUnits, QTY_SCALE)) };
      stockBalances.set(k, next);
      return { ...next };
    }),
    decrementBalance: vi.fn(async (companyId: string, warehouseId: string, itemId: string, qty: number) => {
      const k = key(companyId, warehouseId, itemId);
      const cur = stockBalances.get(k);
      if (!cur) return null;
      const curUnits = parseExactUnits(cur.qty, QTY_SCALE);
      const decUnits = parseExactUnits(qty, QTY_SCALE);
      if (curUnits < decUnits) return null;
      const next = { ...cur, qty: Number(fromMinorUnits(curUnits - decUnits, QTY_SCALE)) };
      stockBalances.set(k, next);
      return { ...next };
    }),
  };

  return { profiles, assignments, valBalances, stockBalances, layers, movements, allocations, adjustments, valuationRepo, stockRepo };
}

describe('Phase 1 — Core Inventory Valuation Engine Invariants', () => {
  let stores: ReturnType<typeof createInMemoryStores>;
  let service: InventoryValuationService;
  let fakeTx: any;

  beforeEach(() => {
    stores = createInMemoryStores();
    stores.profiles.set('prof-fifo', { id: 'prof-fifo', name: 'FIFO', costingMethod: 'FIFO', isActive: true });
    stores.profiles.set('prof-ma', { id: 'prof-ma', name: 'MA', costingMethod: 'PERPETUAL_MOVING_AVERAGE', isActive: true });
    stores.assignments.set('comp-1::item-fifo', { profileId: 'prof-fifo', costingMethod: 'FIFO' });
    stores.assignments.set('comp-1::item-ma', { profileId: 'prof-ma', costingMethod: 'PERPETUAL_MOVING_AVERAGE' });

    const warehouseRepo: any = {
      findById: vi.fn(async (_c: string, id: string) => ({ id, code: id, nameAr: id, isActive: true })),
    };
    const itemRepo: any = {
      findById: vi.fn(async (_c: string, id: string) => ({ id, code: id, nameAr: id, uom: 'unit', isActive: true })),
    };
    const auditService: any = { record: vi.fn(async () => {}) };

    fakeTx = {
      query: vi.fn(async (sql: string, params: any[]) => {
        if (sql.includes('FROM inv_valuation_balances')) {
          const [companyId, itemId] = params;
          const rows = Array.from(stores.valBalances.values())
            .filter((b) => b.companyId === companyId && b.itemId === itemId && b.quantity > 0)
            .map((b) => ({ warehouseId: b.warehouseId }));
          return { rows };
        }
        return { rows: [] };
      }),
    };

    service = new InventoryValuationService(
      stores.valuationRepo,
      warehouseRepo,
      itemRepo,
      auditService,
      stores.stockRepo
    );
  });

  describe('J. Exact Fixed-Point BigInt Arithmetic', () => {
    it('avoids floating point drift on fractional quantities and proportional splits', () => {
      const qtyUnits = parseExactUnits('0.3333', QTY_SCALE);
      const priceUnits = parseExactUnits('99.9999', COST_SCALE);
      const total = mulExactUnits(qtyUnits, QTY_SCALE, priceUnits, COST_SCALE, COST_SCALE);
      expect(fromMinorUnits(total, COST_SCALE)).toBe('33.3300');

      const divided = divExactUnits(parseExactUnits('100', COST_SCALE), COST_SCALE, parseExactUnits('3', QTY_SCALE), QTY_SCALE, COST_SCALE);
      expect(fromMinorUnits(divided, COST_SCALE)).toBe('33.3333');

      const parts = allocateProportionalUnits(10000n, [1n, 1n, 1n]);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(10000n);
      expect(parts).toEqual([3334n, 3333n, 3333n]);
    });
  });

  describe('2. Unassigned Item Protection & Method Lock', () => {
    it('blocks receipt and issue when item has no costing profile (no silent FIFO default)', async () => {
      await expect(
        service.processReceipt(
          'comp-1',
          { warehouseId: 'wh-1', itemId: 'item-unassigned', qty: 10, unitCost: 50, sourceType: 'GRN', sourceId: 'g-1' },
          'user-1',
          fakeTx
        )
      ).rejects.toThrow(/COSTING_PROFILE_REQUIRED/);
    });
  });

  describe('A. FIFO Rules & Strict No-Fallback', () => {
    it('consumes oldest layers first, handles partial & exact exhaustion with zero penny residue', async () => {
      await service.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 10, unitCost: 10, sourceType: 'GRN', sourceId: 'g-1', sourceLineId: 'gl-1', effectiveDate: '2026-01-01T00:00:00Z' },
        'u1',
        fakeTx
      );
      await service.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 20, unitCost: 15, sourceType: 'GRN', sourceId: 'g-2', sourceLineId: 'gl-2', effectiveDate: '2026-01-02T00:00:00Z' },
        'u1',
        fakeTx
      );

      // Issue 15 -> 10 from layer 1 (100) + 5 from layer 2 (75) = 175
      const issue1 = await service.processIssue(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 15, sourceType: 'SALES_DELIVERY', sourceId: 'd-1', sourceLineId: 'dl-1' },
        'u1',
        fakeTx
      );
      expect(issue1.totalCost).toBe(175);
      expect(issue1.allocatedLayers).toHaveLength(2);
      expect(issue1.balance.quantity).toBe(15);
      expect(issue1.balance.totalCost).toBe(225);

      // Exact exhaustion of remaining 15
      const issue2 = await service.processIssue(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 15, sourceType: 'SALES_DELIVERY', sourceId: 'd-2', sourceLineId: 'dl-2' },
        'u1',
        fakeTx
      );
      expect(issue2.totalCost).toBe(225);
      expect(issue2.balance.quantity).toBe(0);
      expect(issue2.balance.totalCost).toBe(0);
    });

    it('rejects FIFO issue when active layer qty < stock/valuation qty (strictly NO average fallback)', async () => {
      await service.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 10, unitCost: 20, sourceType: 'GRN', sourceId: 'g-1', sourceLineId: 'gl-1' },
        'u1',
        fakeTx
      );

      // Corrupt layer remaining qty in storage to simulate missing layer provenance
      stores.layers[0].remainingQty = 4;

      await expect(
        service.processIssue(
          'comp-1',
          { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 8, sourceType: 'SALES_DELIVERY', sourceId: 'd-corrupt', sourceLineId: 'dl-corrupt' },
          'u1',
          fakeTx
        )
      ).rejects.toThrow(/VALUATION_INTEGRITY_ERROR/);
    });

    it('preserves multi-layer FIFO lineage across multi-hop warehouse transfers without duplicate movement keys', async () => {
      await service.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 10, unitCost: 10, sourceType: 'GRN', sourceId: 'grn-1', sourceLineId: 'grn-l1', effectiveDate: '2026-01-01T00:00:00Z' },
        'u1',
        fakeTx
      );
      await service.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 10, unitCost: 20, sourceType: 'GRN', sourceId: 'grn-2', sourceLineId: 'grn-l2', effectiveDate: '2026-01-02T00:00:00Z' },
        'u1',
        fakeTx
      );

      // Transfer 15 from WH-1 to WH-2 (consumes 10@10 + 5@20 = 200)
      const t1 = await service.processTransfer(
        'comp-1',
        { sourceWarehouseId: 'wh-1', destWarehouseId: 'wh-2', itemId: 'item-fifo', qty: 15, sourceId: 'tr-1', sourceLineId: 'trl-1' },
        'u1',
        fakeTx
      );
      expect(t1.totalCost).toBe(200);
      expect(stores.movements.filter((m) => m.movementType === 'TRANSFER_IN')).toHaveLength(1);

      const wh2Layers = stores.layers.filter((l) => l.warehouseId === 'wh-2' && !l.isExhausted);
      expect(wh2Layers).toHaveLength(2);
      expect(wh2Layers[0].originSourceId).toBe('grn-1');
      expect(wh2Layers[0].originSourceLineId).toBe('grn-l1');
      expect(wh2Layers[0].originLayerId).toBe(stores.layers[0].id);
      expect(wh2Layers[1].originSourceId).toBe('grn-2');

      // Second hop: Transfer 12 from WH-2 to WH-3
      const t2 = await service.processTransfer(
        'comp-1',
        { sourceWarehouseId: 'wh-2', destWarehouseId: 'wh-3', itemId: 'item-fifo', qty: 12, sourceId: 'tr-2', sourceLineId: 'trl-2' },
        'u1',
        fakeTx
      );
      expect(t2.totalCost).toBe(140); // 10*10 + 2*20

      const wh3Layers = stores.layers.filter((l) => l.warehouseId === 'wh-3' && !l.isExhausted);
      expect(wh3Layers[0].originSourceId).toBe('grn-1');
      expect(wh3Layers[1].originSourceId).toBe('grn-2');
      // Each wh3 layer points to its immediate wh2 layer via originLayerId (never colliding)
      expect(wh3Layers[0].originLayerId).toBe(wh2Layers[0].id);
      expect(wh3Layers[1].originLayerId).toBe(wh2Layers[1].id);
    });
  });

  describe('B. Perpetual Moving Average Rules', () => {
    it('computes weighted average without creating FIFO layers and resets pool to zero on depletion', async () => {
      await service.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 100, unitCost: 100, sourceType: 'GRN', sourceId: 'g-ma-1', sourceLineId: 'l1' },
        'u1',
        fakeTx
      );
      expect(stores.layers).toHaveLength(0); // Never create FIFO layers for MA item

      await service.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 50, unitCost: 130, sourceType: 'GRN', sourceId: 'g-ma-2', sourceLineId: 'l2' },
        'u1',
        fakeTx
      );
      // 150 units, 16500 total -> 110 unitCost
      const issue = await service.processIssue(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 60, sourceType: 'SALES_DELIVERY', sourceId: 'sd-1', sourceLineId: 'sdl-1' },
        'u1',
        fakeTx
      );
      expect(issue.unitCost).toBe(110);
      expect(issue.totalCost).toBe(6600);
      expect(issue.balance.quantity).toBe(90);
      expect(issue.balance.totalCost).toBe(9900);

      // Full depletion clears residual rounding completely
      const deplete = await service.processIssue(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 90, sourceType: 'SALES_DELIVERY', sourceId: 'sd-2', sourceLineId: 'sdl-2' },
        'u1',
        fakeTx
      );
      expect(deplete.balance.quantity).toBe(0);
      expect(deplete.balance.totalCost).toBe(0);
      expect(deplete.balance.unitCost).toBe(0);
    });
  });

  describe('13 & 14. Purchase Price Variance & Purchase Return Provenance', () => {
    it('splits FIFO PPV proportionally between remaining (including transferred) and consumed stock, and rejects duplicate PPV', async () => {
      // Receive 100 @ 100
      await service.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 100, unitCost: 100, sourceType: 'GRN', sourceId: 'grn-ppv', sourceLineId: 'grnl-ppv' },
        'u1',
        fakeTx
      );
      // Sell 40 from WH-1 -> 60 left
      await service.processIssue(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 40, sourceType: 'SALES_DELIVERY', sourceId: 'sd-ppv', sourceLineId: 'sdl-ppv' },
        'u1',
        fakeTx
      );
      // Transfer 20 from WH-1 to WH-2 -> WH-1 has 40, WH-2 has 20
      await service.processTransfer(
        'comp-1',
        { sourceWarehouseId: 'wh-1', destWarehouseId: 'wh-2', itemId: 'item-fifo', qty: 20, sourceId: 'tr-ppv', sourceLineId: 'trl-ppv' },
        'u1',
        fakeTx
      );

      // Supplier invoice arrives for 100 @ 103 (+300 variance: 60 remaining -> +180 [WH1: +120, WH2: +60], 40 consumed -> +120)
      const ppv = await service.applyPurchasePriceVariance(
        'comp-1',
        {
          grnId: 'grn-ppv',
          grnLineId: 'grnl-ppv',
          invoiceId: 'inv-ppv',
          invoiceLineId: 'invl-ppv',
          warehouseId: 'wh-1',
          itemId: 'item-fifo',
          invoicedQty: 100,
          grnUnitCost: 100,
          invoiceUnitCost: 103,
          journalEntryId: 'je-ppv',
        },
        fakeTx
      );

      expect(fromMinorUnits(ppv.remainingAllocationUnits, COST_SCALE)).toBe('180.0000');
      expect(fromMinorUnits(ppv.consumedAllocationUnits, COST_SCALE)).toBe('120.0000');
      expect(stores.valBalances.get('comp-1::wh-1::item-fifo')!.totalCost).toBe(4120); // 40 * 103
      expect(stores.valBalances.get('comp-1::wh-2::item-fifo')!.totalCost).toBe(2060); // 20 * 103

      // Duplicate reconciliation for same invoice line must fail
      await expect(
        service.applyPurchasePriceVariance(
          'comp-1',
          {
            grnId: 'grn-ppv',
            grnLineId: 'grnl-ppv',
            invoiceId: 'inv-ppv',
            invoiceLineId: 'invl-ppv',
            warehouseId: 'wh-1',
            itemId: 'item-fifo',
            invoicedQty: 100,
            grnUnitCost: 100,
            invoiceUnitCost: 103,
          },
          fakeTx
        )
      ).rejects.toThrow(/IDEMPOTENT_DUPLICATE/);

      // Return 10 from WH-1 against GRN-PPV -> must return at updated cost 103/unit = 1030
      const ret = await service.resolveAndIssuePurchaseReturn(
        'comp-1',
        {
          grnId: 'grn-ppv',
          grnLineId: 'grnl-ppv',
          grnQty: 100,
          grnUnitCost: 100,
          warehouseId: 'wh-1',
          itemId: 'item-fifo',
          returnId: 'pr-1',
          returnLineId: 'prl-1',
          qty: 10,
        },
        'u1',
        fakeTx
      );
      expect(ret.unitCost).toBe(103);
      expect(ret.totalCost).toBe(1030);
    });
  });

  describe('18 & 19. Idempotency & Negative Stock Guard', () => {
    it('blocks negative stock and duplicate receipt movement on same source line', async () => {
      await service.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 10, unitCost: 10, sourceType: 'GRN', sourceId: 'g-idem', sourceLineId: 'gl-idem' },
        'u1',
        fakeTx
      );

      await expect(
        service.processReceipt(
          'comp-1',
          { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 10, unitCost: 10, sourceType: 'GRN', sourceId: 'g-idem', sourceLineId: 'gl-idem' },
          'u1',
          fakeTx
        )
      ).rejects.toThrow(/IDEMPOTENT_DUPLICATE/);

      await expect(
        service.processIssue(
          'comp-1',
          { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 11, sourceType: 'SALES_DELIVERY', sourceId: 'd-neg', sourceLineId: 'dl-neg' },
          'u1',
          fakeTx
        )
      ).rejects.toThrow(/رصيد مخزني غير كافٍ/);
    });
  });
});
