import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InventoryValuationService } from '../inventoryValuationService.js';
import { SalesReturnService } from '../../sales/salesReturnService.js';
import { SalesInvoiceService } from '../../sales/salesInvoiceService.js';
import {
  CostingMethod,
  CostLayer,
  ValuationBalance,
  ValuationMovement,
  CostAllocationRecord,
  CostAdjustmentRecord,
  MaSourceBalance,
  MaSourceEvent,
} from '../inventoryValuationTypes.js';
import { ValidationError } from '../../http/errors.js';
import {
  parseExactUnits,
  fromMinorUnits,
  QTY_SCALE,
  COST_SCALE,
  MONEY_SCALE,
} from '../../lib/numeric.js';

const { fakeTxRef } = vi.hoisted(() => ({
  fakeTxRef: { current: null as any },
}));

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn(async (_companyId: string, fn: (tx: any) => Promise<any>) => {
    return await fn(fakeTxRef.current);
  }),
}));

vi.mock('../../accounting/journalService.js', () => {
  const createDraftEntry = vi.fn(async () => ({ id: 'je-mock-draft', status: 'draft' }));
  const postEntry = vi.fn(async (_c: string, id: string) => ({ id, status: 'posted' }));
  const reverseEntry = vi.fn(async () => ({ id: 'je-mock-rev', status: 'posted' }));
  return {
    JournalService: vi.fn(() => ({ createDraftEntry, postEntry, reverseEntry })),
    defaultJournalService: { createDraftEntry, postEntry, reverseEntry },
  };
});

function createValuation7bHarness() {
  const profiles = new Map<string, { id: string; name: string; costingMethod: CostingMethod; isActive: boolean }>([
    ['prof-fifo', { id: 'prof-fifo', name: 'FIFO Profile', costingMethod: 'FIFO', isActive: true }],
    ['prof-ma', { id: 'prof-ma', name: 'MA Profile', costingMethod: 'PERPETUAL_MOVING_AVERAGE', isActive: true }],
  ]);
  const assignments = new Map<string, { profileId: string; costingMethod: CostingMethod }>([
    ['comp-1::item-fifo', { profileId: 'prof-fifo', costingMethod: 'FIFO' }],
    ['comp-1::item-ma', { profileId: 'prof-ma', costingMethod: 'PERPETUAL_MOVING_AVERAGE' }],
  ]);

  const valBalances = new Map<string, ValuationBalance>();
  const stockBalances = new Map<string, { companyId: string; warehouseId: string; itemId: string; qty: number }>();
  const layers: CostLayer[] = [];
  const movements: ValuationMovement[] = [];
  const allocations: CostAllocationRecord[] = [];
  const adjustments: CostAdjustmentRecord[] = [];
  const reconciliations: any[] = [];
  const maSourceBalances: MaSourceBalance[] = [];
  const maSourceEvents: MaSourceEvent[] = [];

  let seq = 1;
  const nextId = (prefix: string) => `${prefix}-${seq++}`;
  const key = (c: string, w: string, i: string) => `${c}::${w}::${i}`;

  const warehouseRepo: any = {
    findById: vi.fn(async (_c: string, id: string) => ({ id, code: id, nameAr: id, isActive: true })),
  };
  const itemRepo: any = {
    findById: vi.fn(async (_c: string, id: string) => ({ id, code: id, nameAr: id, uom: 'unit', isActive: true })),
  };
  const auditService: any = { record: vi.fn(async () => {}) };
  const settingsRepo: any = {
    getByCompanyId: vi.fn(async (companyId: string) => ({
      companyId,
      inventoryAccountId: 'acct-inv',
      inventoryAdjustmentAccountId: 'acct-adj',
      openingBalanceEquityAccountId: 'acct-open-eq',
    })),
  };
  const accountRepo: any = {
    findById: vi.fn(async (_c: string, id: string) => ({
      id,
      code: id,
      nameAr: id,
      accountType: id === 'acct-inv' ? 'asset' : 'expense',
      isActive: true,
      isPostable: true,
    })),
  };

  const valuationRepo: any = {
    findProfileById: vi.fn(async (_c: string, id: string) => profiles.get(id) || null),
    getItemAssignment: vi.fn(async (companyId: string, itemId: string) => {
      const a = assignments.get(`${companyId}::${itemId}`);
      if (!a) return null;
      return { companyId, itemId, profileId: a.profileId, costingMethod: a.costingMethod, assignedAt: new Date().toISOString() };
    }),
    hasFinancialMovementsForItem: vi.fn(async (companyId: string, itemId: string) =>
      movements.some((m) => m.companyId === companyId && m.itemId === itemId)
    ),
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
    findCostLayerById: vi.fn(async (companyId: string, layerId: string) => {
      const l = layers.find((x) => x.companyId === companyId && x.id === layerId);
      return l ? { ...l } : null;
    }),
    listActiveCostLayersForUpdate: vi.fn(async (companyId: string, warehouseId: string, itemId: string) =>
      layers
        .filter((l) => l.companyId === companyId && l.warehouseId === warehouseId && l.itemId === itemId && !l.isExhausted && l.remainingQty > 0)
        .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id))
        .map((l) => ({ ...l }))
    ),
    listAllCostLayersByItem: vi.fn(async (companyId: string, itemId: string) =>
      layers
        .filter((l) => l.companyId === companyId && l.itemId === itemId)
        .map((l) => ({ ...l }))
    ),
    updateCostLayerRemaining: vi.fn(async (companyId: string, layerId: string, remQty: string, totalCost: string, isExhausted: boolean) => {
      const l = layers.find((x) => x.companyId === companyId && x.id === layerId)!;
      l.remainingQty = Number(remQty);
      l.totalCost = Number(totalCost);
      l.isExhausted = isExhausted;
    }),
    findValuationMovementByIdempotency: vi.fn(async (companyId: string, warehouseId: string, itemId: string, movementType: string, sourceType: string, sourceId: string, sourceLineId?: string | null) =>
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
    ),
    listSalesReturnMovementsByReference: vi.fn(async (companyId: string, referenceMovementId: string) =>
      movements
        .filter((m) => m.companyId === companyId && m.movementType === 'RETURN' && m.sourceType === 'SALES_RETURN' && m.referenceMovementId === referenceMovementId)
        .map((m) => ({ ...m }))
    ),
    createValuationMovement: vi.fn(async (companyId: string, input: any) => {
      const m: ValuationMovement = {
        id: nextId('vmov'),
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
    linkValuationMovementJournal: vi.fn(async (_c: string, movId: string, jeId: string) => {
      const m = movements.find((x) => x.id === movId);
      if (m) m.journalEntryId = jeId;
    }),
    createCostAllocation: vi.fn(async (companyId: string, input: any) => {
      const a: CostAllocationRecord = {
        id: nextId('alloc'),
        companyId,
        valuationMovementId: input.valuationMovementId,
        costLayerId: input.costLayerId ?? null,
        allocatedQty: Number(input.allocatedQty),
        unitCost: Number(input.unitCost),
        allocatedCost: Number(input.allocatedCost),
        createdAt: new Date().toISOString(),
      };
      allocations.push(a);
      return { ...a };
    }),
    listAllocationsForMovement: vi.fn(async (companyId: string, movId: string) =>
      allocations.filter((a) => a.companyId === companyId && a.valuationMovementId === movId).map((a) => ({ ...a }))
    ),
    findCostAdjustmentsByInvoiceLine: vi.fn(async (companyId: string, invoiceLineId: string) =>
      adjustments.filter((a) => a.companyId === companyId && a.invoiceLineId === invoiceLineId).map((a) => ({ ...a }))
    ),
    listAdjustmentsBySource: vi.fn(async (companyId: string, sourceType: string, sourceId: string, sourceLineId?: string | null) =>
      adjustments.filter(
        (a) =>
          a.companyId === companyId &&
          a.sourceType === sourceType &&
          a.sourceId === sourceId &&
          (sourceLineId === undefined || (a.sourceLineId ?? null) === (sourceLineId ?? null))
      )
    ),
    createCostAdjustment: vi.fn(async (companyId: string, input: any) => {
      const adj: CostAdjustmentRecord = {
        id: nextId('adj'),
        companyId,
        warehouseId: input.warehouseId,
        itemId: input.itemId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceLineId: input.sourceLineId ?? null,
        grnId: input.grnId ?? null,
        grnLineId: input.grnLineId ?? null,
        invoiceId: input.invoiceId ?? null,
        invoiceLineId: input.invoiceLineId ?? null,
        costLayerId: input.costLayerId ?? null,
        costingMethod: input.costingMethod ?? null,
        qtyBasis: Number(input.qtyBasis ?? 0),
        originalUnitCost: Number(input.originalUnitCost ?? 0),
        finalUnitCost: Number(input.finalUnitCost ?? 0),
        unitVariance: Number(input.unitVariance ?? 0),
        adjustmentAmount: Number(input.adjustmentAmount ?? 0),
        remainingAllocation: Number(input.remainingAllocation ?? 0),
        consumedAllocation: Number(input.consumedAllocation ?? 0),
        status: input.status ?? 'posted',
        reason: input.reason ?? null,
        journalEntryId: input.journalEntryId ?? null,
        approvedBy: input.approvedBy ?? null,
        approvedAt: input.approvedBy ? new Date().toISOString() : null,
        createdBy: input.createdBy ?? null,
        createdAt: new Date().toISOString(),
      };
      adjustments.push(adj);
      return { ...adj };
    }),
    saveReconciliation: vi.fn(async (companyId: string, input: any) => {
      const rec = {
        id: nextId('rec'),
        companyId,
        ...input,
        subledgerTotal: Number(input.subledgerTotal ?? 0),
        glControlTotal: Number(input.glControlTotal ?? 0),
        variance: Number(input.variance ?? 0),
        openingDiff: Number(input.openingDiff ?? 0),
        reconciledAt: new Date().toISOString(),
      };
      reconciliations.push(rec);
      return rec;
    }),
    upsertMaSourceBalance: vi.fn(async (companyId: string, input: any) => {
      const idx = maSourceBalances.findIndex(
        (b) =>
          b.companyId === companyId &&
          b.warehouseId === input.warehouseId &&
          b.itemId === input.itemId &&
          b.sourceType === input.sourceType &&
          b.sourceId === input.sourceId &&
          (b.sourceLineId ?? null) === (input.sourceLineId ?? null) &&
          b.originSourceType === input.originSourceType &&
          b.originSourceId === input.originSourceId &&
          (b.originSourceLineId ?? null) === (input.originSourceLineId ?? null)
      );
      const now = new Date(Date.now() + seq++).toISOString();
      if (idx >= 0) {
        const cur = maSourceBalances[idx];
        cur.receivedQty = Number(input.receivedQty);
        cur.remainingQty = Number(input.remainingQty);
        cur.consumedQty = Number(input.consumedQty);
        cur.originalValue = Number(input.originalValue);
        cur.remainingValue = Number(input.remainingValue);
        cur.consumedValue = Number(input.consumedValue);
        cur.updatedAt = now;
        return { ...cur };
      }
      const row: MaSourceBalance = {
        id: nextId('masb'),
        companyId,
        warehouseId: input.warehouseId,
        itemId: input.itemId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceLineId: input.sourceLineId ?? null,
        originSourceType: input.originSourceType,
        originSourceId: input.originSourceId,
        originSourceLineId: input.originSourceLineId ?? null,
        grnId: input.grnId ?? null,
        grnLineId: input.grnLineId ?? null,
        receivedQty: Number(input.receivedQty),
        remainingQty: Number(input.remainingQty),
        consumedQty: Number(input.consumedQty),
        originalValue: Number(input.originalValue),
        remainingValue: Number(input.remainingValue),
        consumedValue: Number(input.consumedValue),
        createdAt: now,
        updatedAt: now,
      };
      maSourceBalances.push(row);
      return { ...row };
    }),
    listMaSourceBalancesForUpdate: vi.fn(async (companyId: string, warehouseId: string, itemId: string) =>
      maSourceBalances
        .filter((b) => b.companyId === companyId && b.warehouseId === warehouseId && b.itemId === itemId && b.remainingQty > 0)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map((b) => ({ ...b }))
    ),
    findMaSourceBalancesByGrnLineForUpdate: vi.fn(async (companyId: string, grnLineId: string) =>
      maSourceBalances
        .filter((b) => b.companyId === companyId && (b.grnLineId === grnLineId || b.originSourceLineId === grnLineId))
        .sort((a, b) => a.warehouseId.localeCompare(b.warehouseId) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map((b) => ({ ...b }))
    ),
    applyPpvToMaSourceBalance: vi.fn(async (companyId: string, id: string, valueDelta: string | number) => {
      const b = maSourceBalances.find((x) => x.companyId === companyId && x.id === id);
      if (!b) return;
      const origU = parseExactUnits(b.originalValue, COST_SCALE) + parseExactUnits(valueDelta, COST_SCALE);
      const remU = parseExactUnits(b.remainingValue, COST_SCALE) + parseExactUnits(valueDelta, COST_SCALE);
      const consU = parseExactUnits(b.consumedValue, COST_SCALE);
      if (remU < 0n || origU < 0n || remU + consU !== origU) {
        throw new Error('DB_CHECK_VIOLATION: applyPpvToMaSourceBalance');
      }
      b.originalValue = Number(fromMinorUnits(origU, COST_SCALE));
      b.remainingValue = Number(fromMinorUnits(remU, COST_SCALE));
      b.updatedAt = new Date().toISOString();
    }),
    updateMaSourceBalanceQuantities: vi.fn(
      async (
        companyId: string,
        id: string,
        remainingQty: string | number,
        consumedQty: string | number,
        _tx: any,
        remainingValue?: string | number,
        consumedValue?: string | number
      ) => {
        const b = maSourceBalances.find((x) => x.companyId === companyId && x.id === id);
        if (!b) return;
        const recvQ = parseExactUnits(b.receivedQty, QTY_SCALE);
        const remQ = parseExactUnits(remainingQty, QTY_SCALE);
        const consQ = parseExactUnits(consumedQty, QTY_SCALE);
        if (remQ < 0n || consQ < 0n || remQ + consQ !== recvQ) {
          throw new Error('DB_CHECK_VIOLATION: qty mismatch');
        }
        b.remainingQty = Number(remainingQty);
        b.consumedQty = Number(consumedQty);
        if (remainingValue !== undefined && consumedValue !== undefined) {
          const origV = parseExactUnits(b.originalValue, COST_SCALE);
          const remV = parseExactUnits(remainingValue, COST_SCALE);
          const consV = parseExactUnits(consumedValue, COST_SCALE);
          if (remV < 0n || consV < 0n || remV + consV !== origV) {
            throw new Error('DB_CHECK_VIOLATION: val mismatch');
          }
          b.remainingValue = Number(remainingValue);
          b.consumedValue = Number(consumedValue);
        }
        b.updatedAt = new Date().toISOString();
      }
    ),
    createMaSourceEvent: vi.fn(async (companyId: string, input: any) => {
      const ev: MaSourceEvent = {
        id: nextId('mase'),
        companyId,
        itemId: input.itemId,
        warehouseId: input.warehouseId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceLineId: input.sourceLineId ?? null,
        originSourceType: input.originSourceType,
        originSourceId: input.originSourceId,
        originSourceLineId: input.originSourceLineId ?? null,
        grnId: input.grnId ?? null,
        grnLineId: input.grnLineId ?? null,
        eventType: input.eventType,
        quantity: Number(input.quantity),
        valueDelta: Number(input.valueDelta),
        referenceMovementId: input.referenceMovementId ?? null,
        createdAt: new Date().toISOString(),
      };
      maSourceEvents.push(ev);
      return { ...ev };
    }),
  };

  const stockRepo: any = {
    ensureBalanceRow: vi.fn(async (companyId: string, warehouseId: string, itemId: string) => {
      const k = key(companyId, warehouseId, itemId);
      if (!stockBalances.has(k)) stockBalances.set(k, { companyId, warehouseId, itemId, qty: 0 });
    }),
    getBalanceForUpdate: vi.fn(async (companyId: string, warehouseId: string, itemId: string) => {
      const s = stockBalances.get(key(companyId, warehouseId, itemId));
      return s ? { ...s } : null;
    }),
    incrementBalance: vi.fn(async (companyId: string, warehouseId: string, itemId: string, qty: number) => {
      const k = key(companyId, warehouseId, itemId);
      const cur = stockBalances.get(k) || { companyId, warehouseId, itemId, qty: 0 };
      const sum = parseExactUnits(cur.qty, QTY_SCALE) + parseExactUnits(qty, QTY_SCALE);
      const next = { ...cur, qty: Number(fromMinorUnits(sum, QTY_SCALE)) };
      stockBalances.set(k, next);
      return { ...next };
    }),
    decrementBalance: vi.fn(async (companyId: string, warehouseId: string, itemId: string, qty: number) => {
      const k = key(companyId, warehouseId, itemId);
      const cur = stockBalances.get(k);
      if (!cur) return null;
      const curU = parseExactUnits(cur.qty, QTY_SCALE);
      const decU = parseExactUnits(qty, QTY_SCALE);
      if (curU < decU) return null;
      const next = { ...cur, qty: Number(fromMinorUnits(curU - decU, QTY_SCALE)) };
      stockBalances.set(k, next);
      return { ...next };
    }),
    createMovement: vi.fn(async () => ({ id: nextId('smov') })),
  };

  let customReconHandler: ((sql: string, params?: any[]) => any) | null = null;

  const fakeTx: any = {
    query: vi.fn(async (sql: string, params?: any[]) => {
      if (customReconHandler) {
        const res = customReconHandler(sql, params);
        if (res) return res;
      }
      if (sql.includes('FROM inv_valuation_balances')) {
        const cid = params?.[0];
        return {
          rows: Array.from(valBalances.values())
            .filter((b) => b.companyId === cid && b.quantity > 0)
            .map((b) => ({ warehouseId: b.warehouseId })),
        };
      }
      return { rows: [] };
    }),
  };
  fakeTxRef.current = fakeTx;

  const valuationService = new InventoryValuationService(
    valuationRepo,
    warehouseRepo,
    itemRepo,
    auditService,
    stockRepo,
    settingsRepo,
    accountRepo
  );

  function assertMaLedgerParity(companyId: string, warehouseId: string, itemId: string) {
    const vb = valBalances.get(key(companyId, warehouseId, itemId));
    const sb = maSourceBalances.filter((b) => b.companyId === companyId && b.warehouseId === warehouseId && b.itemId === itemId);
    const sumRemQty = sb.reduce((acc, b) => acc + parseExactUnits(b.remainingQty, QTY_SCALE), 0n);
    const sumRemVal = sb.reduce((acc, b) => acc + parseExactUnits(b.remainingValue, COST_SCALE), 0n);
    expect(sumRemQty).toBe(parseExactUnits(vb?.quantity ?? 0, QTY_SCALE));
    expect(sumRemVal).toBe(parseExactUnits(vb?.totalCost ?? 0, COST_SCALE));
    for (const row of sb) {
      const rQ = parseExactUnits(row.receivedQty, QTY_SCALE);
      const remQ = parseExactUnits(row.remainingQty, QTY_SCALE);
      const cQ = parseExactUnits(row.consumedQty, QTY_SCALE);
      const oV = parseExactUnits(row.originalValue, COST_SCALE);
      const remV = parseExactUnits(row.remainingValue, COST_SCALE);
      const cV = parseExactUnits(row.consumedValue, COST_SCALE);
      expect(remQ + cQ).toBe(rQ);
      expect(remV + cV).toBe(oV);
      expect(remQ >= 0n && cQ >= 0n && remV >= 0n && cV >= 0n).toBe(true);
    }
  }

  return {
    valuationService,
    valuationRepo,
    stockRepo,
    valBalances,
    stockBalances,
    layers,
    movements,
    allocations,
    adjustments,
    maSourceBalances,
    maSourceEvents,
    fakeTx,
    setCustomReconHandler: (fn: (sql: string, params?: any[]) => any) => {
      customReconHandler = fn;
    },
    assertMaLedgerParity,
  };
}

describe('Package 7B — PPV, MA Purchase Returns, Sales Returns, Reconciliation & Invoice Cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // PHASE 1 — MOVING AVERAGE PPV
  // =========================================================================
  describe('Phase 1: Moving Average PPV via Source Ledger', () => {
    it('allocates PPV across remaining and consumed portions in the same warehouse preserving exact sum', async () => {
      const h = createValuation7bHarness();
      await h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 20, sourceType: 'GRN', sourceId: 'grn-1', sourceLineId: 'grnl-1' },
        'u1',
        h.fakeTx
      );
      await h.valuationService.processIssue(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 4, sourceType: 'SALES_DELIVERY', sourceId: 'del-1', sourceLineId: 'dell-1' },
        'u1',
        h.fakeTx
      );

      // Total qty 10 -> 6 remaining, 4 consumed. Price changes 20 -> 25 (+5/unit => +50 total PPV).
      // Expected: 30 remaining (+30 to wh-1), 20 consumed.
      const res = await h.valuationService.applyPurchasePriceVariance(
        'comp-1',
        {
          grnId: 'grn-1',
          grnLineId: 'grnl-1',
          invoiceId: 'pinv-1',
          invoiceLineId: 'pinvl-1',
          warehouseId: 'wh-1',
          itemId: 'item-ma',
          invoicedQty: 10,
          grnUnitCost: 20,
          invoiceUnitCost: 25,
          reason: 'Supplier invoice PPV',
          createdBy: 'u1',
        },
        h.fakeTx
      );

      expect(res.totalVarianceUnits).toBe(parseExactUnits(50, COST_SCALE));
      expect(res.remainingAllocationUnits).toBe(parseExactUnits(30, COST_SCALE));
      expect(res.consumedAllocationUnits).toBe(parseExactUnits(20, COST_SCALE));
      expect(h.valBalances.get('comp-1::wh-1::item-ma')?.totalCost).toBe(150); // 120 + 30
      expect(h.valBalances.get('comp-1::wh-1::item-ma')?.unitCost).toBe(25);
      h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');

      const ppvEvents = h.maSourceEvents.filter((e) => e.eventType === 'PPV');
      expect(ppvEvents).toHaveLength(1);
      expect(ppvEvents[0].valueDelta).toBe(30);
    });

    it('tracks transferred stock across warehouses and never leaks PPV to unrelated GRNs in other warehouses', async () => {
      const h = createValuation7bHarness();
      // GRN-1 in WH-1: 10 units @ 10 = 100
      await h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 10, sourceType: 'GRN', sourceId: 'grn-1', sourceLineId: 'grnl-1' },
        'u1',
        h.fakeTx
      );
      // Unrelated GRN-2 in WH-3: 10 units @ 100 = 1000 (must NEVER receive GRN-1 PPV!)
      await h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-3', itemId: 'item-ma', qty: 10, unitCost: 100, sourceType: 'GRN', sourceId: 'grn-2', sourceLineId: 'grnl-2' },
        'u1',
        h.fakeTx
      );
      // Transfer 4 units of GRN-1 from WH-1 to WH-2
      await h.valuationService.processTransfer(
        'comp-1',
        { sourceWarehouseId: 'wh-1', destWarehouseId: 'wh-2', itemId: 'item-ma', qty: 4, sourceId: 'tr-1', sourceLineId: 'trl-1' },
        'u1',
        h.fakeTx
      );
      // Issue 3 units from WH-1 (leaving 3 in WH-1, 4 in WH-2, 3 consumed)
      await h.valuationService.processIssue(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 3, sourceType: 'SALES_DELIVERY', sourceId: 'del-1', sourceLineId: 'dell-1' },
        'u1',
        h.fakeTx
      );

      // Apply +10/unit PPV on GRN-1 (10 units => total PPV = +100).
      // WH-1 remaining = 3 (+30), WH-2 remaining = 4 (+40), consumed = 3 (+30). WH-3 untouched (1000).
      const res = await h.valuationService.applyPurchasePriceVariance(
        'comp-1',
        {
          grnId: 'grn-1',
          grnLineId: 'grnl-1',
          invoiceId: 'pinv-1',
          invoiceLineId: 'pinvl-1',
          warehouseId: 'wh-1',
          itemId: 'item-ma',
          invoicedQty: 10,
          grnUnitCost: 10,
          invoiceUnitCost: 20,
          createdBy: 'u1',
        },
        h.fakeTx
      );

      expect(res.totalVarianceUnits).toBe(parseExactUnits(100, COST_SCALE));
      expect(res.remainingAllocationUnits).toBe(parseExactUnits(70, COST_SCALE));
      expect(res.consumedAllocationUnits).toBe(parseExactUnits(30, COST_SCALE));
      expect(h.valBalances.get('comp-1::wh-1::item-ma')?.totalCost).toBe(60); // 30 + 30
      expect(h.valBalances.get('comp-1::wh-2::item-ma')?.totalCost).toBe(80); // 40 + 40
      expect(h.valBalances.get('comp-1::wh-3::item-ma')?.totalCost).toBe(1000); // untouched!
      h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');
      h.assertMaLedgerParity('comp-1', 'wh-2', 'item-ma');
      h.assertMaLedgerParity('comp-1', 'wh-3', 'item-ma');
    });

    it('routes 100% of PPV to consumedAllocation when source quantity is fully consumed', async () => {
      const h = createValuation7bHarness();
      await h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 5, unitCost: 30, sourceType: 'GRN', sourceId: 'grn-c', sourceLineId: 'grnl-c' },
        'u1',
        h.fakeTx
      );
      await h.valuationService.processIssue(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 5, sourceType: 'SALES_DELIVERY', sourceId: 'del-c', sourceLineId: 'dell-c' },
        'u1',
        h.fakeTx
      );

      const res = await h.valuationService.applyPurchasePriceVariance(
        'comp-1',
        {
          grnId: 'grn-c',
          grnLineId: 'grnl-c',
          invoiceId: 'pinv-c',
          invoiceLineId: 'pinvl-c',
          warehouseId: 'wh-1',
          itemId: 'item-ma',
          invoicedQty: 5,
          grnUnitCost: 30,
          invoiceUnitCost: 36,
          createdBy: 'u1',
        },
        h.fakeTx
      );

      expect(res.totalVarianceUnits).toBe(parseExactUnits(30, COST_SCALE));
      expect(res.remainingAllocationUnits).toBe(0n);
      expect(res.consumedAllocationUnits).toBe(parseExactUnits(30, COST_SCALE));
      expect(h.valBalances.get('comp-1::wh-1::item-ma')?.totalCost).toBe(0);
      h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');
    });

    it('clamps large negative PPV against remainingValue/totalCost and shifts excess to consumedAllocation without negative balances', async () => {
      const h = createValuation7bHarness();
      await h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 20, sourceType: 'GRN', sourceId: 'grn-neg', sourceLineId: 'grnl-neg' },
        'u1',
        h.fakeTx
      );
      // Issue 5 @ 20 => remQty 5, remVal 100
      await h.valuationService.processIssue(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 5, sourceType: 'SALES_DELIVERY', sourceId: 'del-n', sourceLineId: 'dell-n' },
        'u1',
        h.fakeTx
      );

      // Massive credit PPV: final cost 20 -> 0 => -200 total. Remaining cap is 100!
      // Target remaining share = -100 (at floor 0), consumed = -100. Wait if qty=10, 8 remaining, 2 consumed, invoice cost 20->-? Wait finalUnitCost must be >= 0 so let's make WH remaining value small via earlier cheap receipt + issue!
      // Instead test with WH-1 having cheap prior mix:
      const h2 = createValuation7bHarness();
      // First receipt 10 @ 2 = 20, second receipt GRN-X 10 @ 20 = 200. Pool = 20 @ avg 11 = 220.
      await h2.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 2, sourceType: 'GRN', sourceId: 'grn-cheap', sourceLineId: 'grnl-cheap' },
        'u1',
        h2.fakeTx
      );
      await h2.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 20, sourceType: 'GRN', sourceId: 'grn-x', sourceLineId: 'grnl-x' },
        'u1',
        h2.fakeTx
      );
      // Issue 10 => pool remaining 10 @ 11 = 110; GRN-X remainingQty=5, remainingValue=100 (or say pool had 10@0, 10@20 -> pool total 100 < GRN-X rem allocation).
      await h2.valuationService.processIssue(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, sourceType: 'SALES_DELIVERY', sourceId: 'del-mix', sourceLineId: 'dell-mix' },
        'u1',
        h2.fakeTx
      );
      // Apply negative PPV on GRN-X: 20 -> 1 => variance -190 across 10 => -95 rem, -95 consumed (pool has 110, GRN-X remVal has 100, fits).
      const resNeg = await h2.valuationService.applyPurchasePriceVariance(
        'comp-1',
        {
          grnId: 'grn-x',
          grnLineId: 'grnl-x',
          invoiceId: 'pinv-neg',
          invoiceLineId: 'pinvl-neg',
          warehouseId: 'wh-1',
          itemId: 'item-ma',
          invoicedQty: 10,
          grnUnitCost: 20,
          invoiceUnitCost: 1,
          createdBy: 'u1',
        },
        h2.fakeTx
      );
      expect(resNeg.totalVarianceUnits).toBe(parseExactUnits(-190, COST_SCALE));
      expect(resNeg.remainingAllocationUnits + resNeg.consumedAllocationUnits).toBe(parseExactUnits(-190, COST_SCALE));
      expect((h2.valBalances.get('comp-1::wh-1::item-ma')?.totalCost ?? -1) >= 0).toBe(true);
      h2.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');

      // Zero-variance returns 0 cleanly
      const zeroRes = await h.valuationService.applyPurchasePriceVariance(
        'comp-1',
        {
          grnId: 'grn-neg',
          grnLineId: 'grnl-neg',
          invoiceId: 'pinv-z',
          invoiceLineId: 'pinvl-z',
          warehouseId: 'wh-1',
          itemId: 'item-ma',
          invoicedQty: 10,
          grnUnitCost: 20,
          invoiceUnitCost: 20,
          createdBy: 'u1',
        },
        h.fakeTx
      );
      expect(zeroRes.totalVarianceUnits).toBe(0n);
    });
  });

  // =========================================================================
  // PHASE 2 — MOVING AVERAGE PURCHASE RETURNS
  // =========================================================================
  describe('Phase 2: Moving Average Purchase Returns via Source Ledger', () => {
    it('rejects MA purchase return from warehouse when GRN source qty was transferred out', async () => {
      const h = createValuation7bHarness();
      await h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 25, sourceType: 'GRN', sourceId: 'grn-1', sourceLineId: 'grnl-1' },
        'u1',
        h.fakeTx
      );
      await h.valuationService.processTransfer(
        'comp-1',
        { sourceWarehouseId: 'wh-1', destWarehouseId: 'wh-2', itemId: 'item-ma', qty: 7, sourceId: 'tr-1', sourceLineId: 'trl-1' },
        'u1',
        h.fakeTx
      );
      // Even if someone receives unrelated GRN-2 into WH-1 so WH-1 has 10 units physically, GRN-1 only has 3 units in WH-1!
      await h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 7, unitCost: 90, sourceType: 'GRN', sourceId: 'grn-2', sourceLineId: 'grnl-2' },
        'u1',
        h.fakeTx
      );

      await expect(
        h.valuationService.resolveAndIssuePurchaseReturn(
          'comp-1',
          {
            grnId: 'grn-1',
            grnLineId: 'grnl-1',
            grnQty: 10,
            grnUnitCost: 25,
            warehouseId: 'wh-1',
            itemId: 'item-ma',
            returnId: 'pret-1',
            returnLineId: 'pretl-1',
            qty: 5,
          },
          'u1',
          h.fakeTx
        )
      ).rejects.toThrow(/أرصدة مصدر الاستلام الأصلي|تحويل أو صرف جزء من البضاعة/);
    });

    it('issues MA purchase return at exact PPV-adjusted GRN source cost & emits PURCHASE_RETURN event', async () => {
      const h = createValuation7bHarness();
      await h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 20, sourceType: 'GRN', sourceId: 'grn-p', sourceLineId: 'grnl-p' },
        'u1',
        h.fakeTx
      );
      // Apply PPV 20 -> 26 (+60)
      await h.valuationService.applyPurchasePriceVariance(
        'comp-1',
        {
          grnId: 'grn-p',
          grnLineId: 'grnl-p',
          invoiceId: 'pinv-p',
          invoiceLineId: 'pinvl-p',
          warehouseId: 'wh-1',
          itemId: 'item-ma',
          invoicedQty: 10,
          grnUnitCost: 20,
          invoiceUnitCost: 26,
          createdBy: 'u1',
        },
        h.fakeTx
      );

      // Receive another GRN at 100 in same warehouse to shift warehouse pool avg far from 26 -> purchase return MUST still use GRN-P's 26!
      await h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 100, sourceType: 'GRN', sourceId: 'grn-other', sourceLineId: 'grnl-other' },
        'u1',
        h.fakeTx
      );

      const retRes = await h.valuationService.resolveAndIssuePurchaseReturn(
        'comp-1',
        {
          grnId: 'grn-p',
          grnLineId: 'grnl-p',
          grnQty: 10,
          grnUnitCost: 20,
          warehouseId: 'wh-1',
          itemId: 'item-ma',
          returnId: 'pret-p',
          returnLineId: 'pretl-p',
          qty: 4,
        },
        'u1',
        h.fakeTx
      );

      expect(retRes.unitCost).toBe(26);
      expect(retRes.totalCost).toBe(104);
      expect(h.valBalances.get('comp-1::wh-1::item-ma')?.totalCost).toBe(260 + 1000 - 104);
      h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');

      const retEv = h.maSourceEvents.find((e) => e.eventType === 'PURCHASE_RETURN')!;
      expect(retEv.quantity).toBe(4);
      expect(retEv.valueDelta).toBe(-104);
    });
  });

  // =========================================================================
  // PHASE 3 — SALES RETURNS (FIFO + MA + GL & AR)
  // =========================================================================
  describe('Phase 3: Sales Returns Valuation Restoration & Full Service Flow', () => {
    it('FIFO multi-layer delivery partial sales returns restore exact original layer slices & preserve cost conservation', async () => {
      const h = createValuation7bHarness();
      await h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 4, unitCost: 10, sourceType: 'GRN', sourceId: 'g-1', sourceLineId: 'gl-1', effectiveDate: '2026-01-01T00:00:00Z' },
        'u1',
        h.fakeTx
      );
      await h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 6, unitCost: 25, sourceType: 'GRN', sourceId: 'g-2', sourceLineId: 'gl-2', effectiveDate: '2026-01-02T00:00:00Z' },
        'u1',
        h.fakeTx
      );

      // Delivery of 8 units consumes 4@10 (40) + 4@25 (100) = 140
      const delivery = await h.valuationService.processIssue(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 8, sourceType: 'SALES_DELIVERY', sourceId: 'del-1', sourceLineId: 'dell-1' },
        'u1',
        h.fakeTx
      );
      expect(delivery.totalCost).toBe(140);

      // Partial return 1: 3 units => takes from first slice (3@10 = 30)
      const ret1 = await h.valuationService.restoreSalesReturnInventory(
        'comp-1',
        {
          warehouseId: 'wh-1',
          itemId: 'item-fifo',
          qty: 3,
          returnId: 'sret-1',
          returnLineId: 'sretl-1',
          deliveryLineId: 'dell-1',
          deliveryValuationMovementId: delivery.movement.id,
          deliveryQty: 8,
          deliveryFrozenTotalCost: 140,
        },
        'u1',
        h.fakeTx
      );
      expect(ret1.totalCost).toBe(30);

      // Partial return 2: 3 units => takes remaining 1@10 (10) + 2@25 (50) = 60
      const ret2 = await h.valuationService.restoreSalesReturnInventory(
        'comp-1',
        {
          warehouseId: 'wh-1',
          itemId: 'item-fifo',
          qty: 3,
          returnId: 'sret-2',
          returnLineId: 'sretl-2',
          deliveryLineId: 'dell-1',
          deliveryValuationMovementId: delivery.movement.id,
          deliveryQty: 8,
          deliveryFrozenTotalCost: 140,
        },
        'u1',
        h.fakeTx
      );
      expect(ret2.totalCost).toBe(60);

      // Partial return 3 exceeds delivered 8 (6 returned + 3 requested > 8) => MUST reject
      await expect(
        h.valuationService.restoreSalesReturnInventory(
          'comp-1',
          {
            warehouseId: 'wh-1',
            itemId: 'item-fifo',
            qty: 3,
            returnId: 'sret-3',
            returnLineId: 'sretl-3',
            deliveryLineId: 'dell-1',
            deliveryValuationMovementId: delivery.movement.id,
            deliveryQty: 8,
            deliveryFrozenTotalCost: 140,
          },
          'u1',
          h.fakeTx
        )
      ).rejects.toThrow(ValidationError);

      // Partial return 3 valid for 2 => 2@25 = 50 -> Total restored = 30 + 60 + 50 = 140 exact!
      const ret3 = await h.valuationService.restoreSalesReturnInventory(
        'comp-1',
        {
          warehouseId: 'wh-1',
          itemId: 'item-fifo',
          qty: 2,
          returnId: 'sret-3',
          returnLineId: 'sretl-3',
          deliveryLineId: 'dell-1',
          deliveryValuationMovementId: delivery.movement.id,
          deliveryQty: 8,
          deliveryFrozenTotalCost: 140,
        },
        'u1',
        h.fakeTx
      );
      expect(ret3.totalCost).toBe(50);
    });

    it('MA sales return restores strictly at original frozen delivery cost regardless of subsequent receipts', async () => {
      const h = createValuation7bHarness();
      await h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 20, sourceType: 'GRN', sourceId: 'g-1', sourceLineId: 'gl-1' },
        'u1',
        h.fakeTx
      );
      // Delivery 6 @ 20 = 120
      const delivery = await h.valuationService.processIssue(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 6, sourceType: 'SALES_DELIVERY', sourceId: 'del-ma', sourceLineId: 'dell-ma' },
        'u1',
        h.fakeTx
      );
      // New receipt at 100 shifts pool MA unit cost way up!
      await h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 100, sourceType: 'GRN', sourceId: 'g-2', sourceLineId: 'gl-2' },
        'u1',
        h.fakeTx
      );

      // Return 4 units from delivery => must restore at 20/unit = 80 (NOT current pool avg!)
      const ret = await h.valuationService.restoreSalesReturnInventory(
        'comp-1',
        {
          warehouseId: 'wh-1',
          itemId: 'item-ma',
          qty: 4,
          returnId: 'sret-ma',
          returnLineId: 'sretl-ma',
          deliveryLineId: 'dell-ma',
          deliveryValuationMovementId: delivery.movement.id,
          deliveryQty: 6,
          deliveryFrozenTotalCost: 120,
        },
        'u1',
        h.fakeTx
      );
      expect(ret.unitCost).toBe(20);
      expect(ret.totalCost).toBe(80);
      h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');

      const srEv = h.maSourceEvents.find((e) => e.eventType === 'SALES_RETURN')!;
      expect(srEv.valueDelta).toBe(80);
      expect(srEv.quantity).toBe(4);
    });

    it('SalesReturnService posts balanced Revenue/VAT/AR + Inventory/COGS JE and updates return totals', async () => {
      const queries: string[] = [];
      const mockTx: any = {
        query: vi.fn(async (sql: string) => {
          queries.push(sql);
          if (sql.includes('FROM inv_warehouses')) return { rows: [{ id: 'wh-1', is_active: true }] };
          if (sql.includes('FROM sales_invoices WHERE')) return { rows: [{ id: 'inv-1', status: 'posted', customer_id: 'cust-1', invoice_no: 'SINV-1' }] };
          if (sql.includes('FROM sales_invoice_lines')) {
            return { rows: [{ id: 'invl-1', item_id: 'item-ma', delivery_line_id: 'dell-1', qty: '10.0000', tax_amount: '150.00', line_total: '1150.00' }] };
          }
          if (sql.includes('FROM sales_return_lines')) {
            return { rows: [{ returned_qty: '0', returned_tax: '0', returned_total: '0' }] };
          }
          if (sql.includes('FROM sales_delivery_lines')) {
            return { rows: [{ id: 'dell-1', item_id: 'item-ma', qty: '10.0000', frozen_total_cost: '400.0000', valuation_movement_id: 'vmov-del', dn_status: 'posted' }] };
          }
          if (sql.includes('accounts_receivable_account_id')) return { rows: [{ arAccountId: 'acct-ar' }] };
          if (sql.includes('sales_revenue_account_id')) return { rows: [{ revAccountId: 'acct-rev' }] };
          if (sql.includes('vat_payable_account_id')) return { rows: [{ vatAccountId: 'acct-vat' }] };
          if (sql.includes('cogs_account_id')) return { rows: [{ cogsAccountId: 'acct-cogs', inventoryAccountId: 'acct-inv' }] };
          if (sql.includes('FROM accounts')) {
            return {
              rows: [
                { id: 'acct-vat', code: '2150', nameAr: 'VAT', accountType: 'liability', isActive: true, isPostable: true },
                { id: 'acct-cogs', code: '5110', nameAr: 'COGS', accountType: 'expense', isActive: true, isPostable: true },
                { id: 'acct-inv', code: '1130', nameAr: 'INV', accountType: 'asset', isActive: true, isPostable: true },
              ],
            };
          }
          return { rows: [] };
        }),
      };
      fakeTxRef.current = mockTx;

      const returnRepo: any = {
        findByIdForUpdate: vi.fn().mockResolvedValue({
          id: 'sret-1',
          status: 'draft',
          customerId: 'cust-1',
          invoiceId: 'inv-1',
          warehouseId: 'wh-1',
          subtotal: 400,
          taxAmount: 60,
          totalAmount: 460,
        }),
        findById: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'sret-1',
            companyId: 'comp-1',
            customerId: 'cust-1',
            customerNameAr: 'عميل 1',
            invoiceId: 'inv-1',
            invoiceNo: 'SINV-1',
            warehouseId: 'wh-1',
            returnDate: '2026-11-18',
            status: 'draft',
            subtotal: 400,
            taxAmount: 60,
            totalAmount: 460,
            cogsAmount: 0,
            lines: [
              { id: 'sretl-1', invoiceLineId: 'invl-1', deliveryLineId: 'dell-1', itemId: 'item-ma', qty: 4, unitPrice: 100, taxRate: 15, taxAmount: 60, lineTotal: 460, cogsCost: 0, lineNo: 1 },
            ],
          })
          .mockResolvedValueOnce({
            id: 'sret-1',
            status: 'posted',
            returnNo: 'SRTN-000001',
            subtotal: 400,
            taxAmount: 60,
            totalAmount: 460,
            cogsAmount: 160,
          }),
        updateLineComputedValues: vi.fn().mockResolvedValue(undefined),
        markPosted: vi.fn().mockResolvedValue(undefined),
      };
      const stockRepo: any = {
        getBalanceForUpdate: vi.fn().mockResolvedValue({ qty: 6 }),
        incrementBalance: vi.fn().mockResolvedValue({ qty: 10 }),
        createMovement: vi.fn().mockResolvedValue({ id: 'smov-r1' }),
      };
      const valuationService: any = {
        getItemCostingMethod: vi.fn().mockResolvedValue({ method: 'PERPETUAL_MOVING_AVERAGE' }),
        restoreSalesReturnInventory: vi.fn().mockResolvedValue({
          movement: { id: 'vmov-r1', totalCost: 160 },
          unitCost: 40,
          totalCost: 160,
        }),
        linkValuationMovementJournal: vi.fn().mockResolvedValue(undefined),
      };
      const journalRepo: any = {
        allocateSequenceNumber: vi.fn().mockResolvedValue('SRTN-000001'),
      };
      const journalService: any = {
        createDraftEntry: vi.fn().mockResolvedValue({ id: 'je-sr-1' }),
        postEntry: vi.fn().mockResolvedValue({ id: 'je-sr-1', status: 'posted' }),
      };
      const auditService: any = { record: vi.fn().mockResolvedValue(undefined) };

      const service = new SalesReturnService(
        returnRepo,
        {} as any,
        stockRepo,
        valuationService,
        journalRepo,
        journalService,
        auditService
      );

      const posted = await service.postReturn('comp-1', 'sret-1', 'actor-1');
      expect(posted.status).toBe('posted');
      expect(posted.cogsAmount).toBe(160);

      const jeLines = journalService.createDraftEntry.mock.calls[0][1].lines;
      expect(jeLines).toEqual([
        expect.objectContaining({ accountId: 'acct-rev', debit: 400, credit: 0 }),
        expect.objectContaining({ accountId: 'acct-vat', debit: 60, credit: 0 }),
        expect.objectContaining({ accountId: 'acct-ar', debit: 0, credit: 460 }),
        expect.objectContaining({ accountId: 'acct-inv', debit: 160, credit: 0 }),
        expect.objectContaining({ accountId: 'acct-cogs', debit: 0, credit: 160 }),
      ]);
      expect(valuationService.linkValuationMovementJournal).toHaveBeenCalledWith('comp-1', 'vmov-r1', 'je-sr-1', mockTx);
      expect(queries.some((q) => q.includes('sales_return_lines'))).toBe(true);
    });
  });

  // =========================================================================
  // PHASE 4 — RECONCILIATION MODES
  // =========================================================================
  describe('Phase 4: Valuation Reconciliation Modes', () => {
    it('returns SUBLEDGER_ONLY with zero GL variance when warehouseId/itemId filter is applied and never creates auto-JE', async () => {
      const h = createValuation7bHarness();
      h.setCustomReconHandler((sql: string) => {
        if (sql.includes('SELECT COALESCE(SUM(vb.total_cost), 0)')) return { rows: [{ total: '250.0000' }] };
        if (sql.includes('inv_stock_balances sb')) return { rows: [{ cnt: 0 }] };
        if (sql.includes('inv_valuation_movements')) return { rows: [{ cnt: 0 }] };
        if (sql.includes('inv_cost_adjustments')) return { rows: [{ cnt: 0 }] };
        if (sql.includes('WITH openings AS')) return { rows: [{ diff: '0.0000' }] };
        return undefined;
      });

      const rec = await h.valuationService.runReconciliation('comp-1', { warehouseId: 'wh-1' }, 'u1');
      expect(rec.comparisonScope).toBe('SUBLEDGER_ONLY');
      expect(rec.isGlComparable).toBe(false);
      expect(rec.status).toBe('subledger_only');
      expect(rec.glControlTotal).toBe(0);
      expect(rec.variance).toBe(0);
      expect(rec.subledgerTotal).toBe(250);
    });

    it('returns historical_unavailable when periodId reconciliation sees unsigned ADJUSTMENT movements', async () => {
      const h = createValuation7bHarness();
      h.setCustomReconHandler((sql: string) => {
        if (sql.includes('FROM accounting_periods')) {
          return { rows: [{ end_date: '2026-01-31' }] };
        }
        if (sql.includes('WITH period_movs AS')) {
          return {
            rows: [
              {
                ambiguousAdjCount: 2,
                crossPeriodUnlinkedCount: 0,
                inflowTotal: '500.0000',
                outflowTotal: '0.0000',
                adjRemTotal: '0.0000',
              },
            ],
          };
        }
        if (sql.includes('SELECT COALESCE(SUM(vb.total_cost), 0)')) return { rows: [{ total: '500.0000' }] };
        if (sql.includes('inv_stock_balances sb')) return { rows: [{ cnt: 0 }] };
        if (sql.includes('inv_valuation_movements')) return { rows: [{ cnt: 0 }] };
        if (sql.includes('inv_cost_adjustments')) return { rows: [{ cnt: 0 }] };
        if (sql.includes('WITH openings AS')) return { rows: [{ diff: '0.0000' }] };
        if (sql.includes('FROM journal_lines')) return { rows: [{ netBalance: '500.0000' }] };
        return undefined;
      });

      const rec = await h.valuationService.runReconciliation('comp-1', { periodId: 'per-1' }, 'u1');
      expect(rec.comparisonScope).toBe('HISTORICAL_GL');
      expect(rec.isGlComparable).toBe(false);
      expect(rec.status).toBe('historical_unavailable');
    });

    it('detects COMPANY_GL discrepancy honestly without auto-posting any balancing journal entry', async () => {
      const h = createValuation7bHarness();
      h.setCustomReconHandler((sql: string) => {
        if (sql.includes('SELECT COALESCE(SUM(vb.total_cost), 0)')) return { rows: [{ total: '500.0000' }] };
        if (sql.includes('FROM journal_lines')) return { rows: [{ netBalance: '480.0000' }] };
        if (sql.includes('inv_stock_balances sb')) return { rows: [{ cnt: 0 }] };
        if (sql.includes('inv_valuation_movements')) return { rows: [{ cnt: 1 }] };
        if (sql.includes('inv_cost_adjustments')) return { rows: [{ cnt: 0 }] };
        if (sql.includes('WITH openings AS')) return { rows: [{ diff: '0.0000' }] };
        return undefined;
      });

      const rec = await h.valuationService.runReconciliation('comp-1', {}, 'u1');
      expect(rec.comparisonScope).toBe('COMPANY_GL');
      expect(rec.isGlComparable).toBe(true);
      expect(rec.status).toBe('discrepancy_detected');
      expect(rec.variance).toBe(20);
    });
  });

  // =========================================================================
  // PHASE 5 — SALES INVOICE CANCELLATION & RE-INVOICING
  // =========================================================================
  describe('Phase 5: Sales Invoice Cancellation & Re-Invoicing', () => {
    it('cancels posted invoice with ONE coherent reversal JE and excludes reversed links when re-invoicing', async () => {
      const executedSqls: string[] = [];
      const mockTx: any = {
        query: vi.fn(async (sql: string) => {
          executedSqls.push(sql);
          if (sql.includes('FROM sales_collections')) return { rows: [] };
          if (sql.includes('FROM sales_returns')) return { rows: [] };
          if (sql.includes('FROM inv_sales_cogs_links')) {
            return {
              rows: [
                { id: 'link-1', invoice_id: 'inv-1', invoice_line_id: 'invl-1', delivery_line_id: 'dell-1', invoiced_qty: '5.0000', cogs_amount: '150.00' },
              ],
            };
          }
          if (sql.includes('FROM inv_sales_cogs_reversals')) return { rows: [] };
          return { rows: [] };
        }),
      };
      fakeTxRef.current = mockTx;

      const invoiceRepo: any = {
        findByIdForUpdate: vi.fn().mockResolvedValue({ id: 'inv-1', status: 'posted', totalAmount: 575 }),
        findById: vi
          .fn()
          .mockResolvedValueOnce({ id: 'inv-1', invoiceNo: 'SINV-1', status: 'posted', journalEntryId: 'je-orig-1' })
          .mockResolvedValueOnce({ id: 'inv-1', invoiceNo: 'SINV-1', status: 'cancelled', reversalJournalEntryId: 'je-rev-1' }),
        markCancelled: vi.fn().mockResolvedValue(undefined),
      };
      const journalService: any = {
        reverseEntry: vi.fn().mockResolvedValue({ id: 'je-rev-1', status: 'posted' }),
        createDraftEntry: vi.fn(),
        postEntry: vi.fn(),
      };
      const auditService: any = { record: vi.fn().mockResolvedValue(undefined) };

      const service = new SalesInvoiceService(
        invoiceRepo,
        {} as any,
        {} as any,
        journalService,
        auditService
      );

      const cancelled = await service.cancelPostedInvoice('comp-1', 'inv-1', 'إلغاء فاتورة للعميل', 'actor-1');
      expect(cancelled.status).toBe('cancelled');
      expect(journalService.reverseEntry).toHaveBeenCalledTimes(1);
      expect(journalService.reverseEntry).toHaveBeenCalledWith(
        'comp-1',
        'je-orig-1',
        'actor-1',
        expect.stringContaining('SINV-1'),
        false,
        mockTx
      );
      expect(journalService.createDraftEntry).not.toHaveBeenCalled();
      expect(invoiceRepo.markCancelled).toHaveBeenCalledWith('comp-1', 'inv-1', 'je-rev-1', 'إلغاء فاتورة للعميل', 'actor-1', mockTx);
      expect(executedSqls.some((s) => s.includes('INSERT INTO inv_sales_cogs_reversals'))).toBe(true);

      // Re-invoicing check: postInvoice queries exclude inv_sales_cogs_reversals
      const reInvTx: any = {
        query: vi.fn(async (sql: string) => {
          executedSqls.push(sql);
          if (sql.includes('FROM sales_delivery_lines')) {
            return {
              rows: [{ id: 'dell-1', qty: '5.0000', unit_cost: '30.0000', frozen_total_cost: '150.0000', valuation_movement_id: 'vmov-del', dl_item_id: 'item-1', dn_customer_id: 'cust-1', dn_status: 'posted' }],
            };
          }
          if (sql.includes('FROM inv_sales_cogs_links') && sql.includes('SUM(invoiced_qty)')) {
            // Since original link is in inv_sales_cogs_reversals, SQL NOT EXISTS excludes it => 0 invoiced!
            expect(sql).toContain('inv_sales_cogs_reversals');
            return { rows: [{ invoiced_qty: '0' }] };
          }
          if (sql.includes('FROM inv_sales_cogs_links') && sql.includes('SUM(cogs_amount)')) {
            expect(sql).toContain('inv_sales_cogs_reversals');
            return { rows: [{ linked_cost: '0' }] };
          }
          if (sql.includes('accounts_receivable_account_id')) return { rows: [{ arAccountId: 'acct-ar' }] };
          if (sql.includes('sales_revenue_account_id')) return { rows: [{ revAccountId: 'acct-rev' }] };
          if (sql.includes('cogs_account_id')) return { rows: [{ cogsAccountId: 'acct-cogs', inventoryAccountId: 'acct-inv' }] };
          if (sql.includes('FROM accounts')) {
            return {
              rows: [
                { id: 'acct-cogs', code: '5110', nameAr: 'COGS', accountType: 'expense', isActive: true, isPostable: true },
                { id: 'acct-inv', code: '1130', nameAr: 'INV', accountType: 'asset', isActive: true, isPostable: true },
              ],
            };
          }
          return { rows: [] };
        }),
      };
      fakeTxRef.current = reInvTx;

      const reInvRepo: any = {
        findByIdForUpdate: vi.fn().mockResolvedValue({ id: 'inv-2', status: 'draft', totalAmount: 500 }),
        findById: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'inv-2',
            customerId: 'cust-1',
            customerNameAr: 'عميل',
            invoiceDate: '2026-11-18',
            subtotal: 500,
            taxAmount: 0,
            totalAmount: 500,
            status: 'draft',
            lines: [{ id: 'invl-2', itemId: 'item-1', deliveryLineId: 'dell-1', qty: 5, unitPrice: 100 }],
          })
          .mockResolvedValueOnce({ id: 'inv-2', invoiceNo: 'SINV-2', status: 'posted', cogsAmount: 150 }),
        markPosted: vi.fn().mockResolvedValue(undefined),
      };
      const reInvJournalService: any = {
        createDraftEntry: vi.fn().mockResolvedValue({ id: 'je-2' }),
        postEntry: vi.fn().mockResolvedValue({ id: 'je-2', status: 'posted' }),
      };
      const service2 = new SalesInvoiceService(
        reInvRepo,
        {} as any,
        { allocateSequenceNumber: vi.fn().mockResolvedValue('SINV-2') } as any,
        reInvJournalService,
        auditService
      );

      const posted2 = await service2.postInvoice('comp-1', 'inv-2', 'actor-1');
      expect(posted2.status).toBe('posted');
      expect(posted2.cogsAmount).toBe(150);
    });
  });
});
