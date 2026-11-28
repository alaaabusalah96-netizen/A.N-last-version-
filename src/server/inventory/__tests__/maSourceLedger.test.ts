import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InventoryValuationService } from '../inventoryValuationService.js';
import { StockService } from '../stockService.js';
import {
  CostingMethod,
  CostLayer,
  ValuationBalance,
  ValuationMovement,
  OpeningValuationRecord,
  MaSourceBalance,
  MaSourceEvent,
} from '../inventoryValuationTypes.js';
import {
  parseExactUnits,
  fromMinorUnits,
  QTY_SCALE,
  COST_SCALE,
} from '../../lib/numeric.js';

const { fakeTxRef, postedJournals } = vi.hoisted(() => ({
  fakeTxRef: { current: null as any },
  postedJournals: [] as Array<{ id: string; lines: Array<{ accountId: string; debit: number; credit: number }> }>,
}));

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn(async (_companyId: string, fn: (tx: any) => Promise<any>) => {
    return await fn(fakeTxRef.current);
  }),
}));

vi.mock('../../accounting/journalService.js', () => {
  const createDraftEntry = vi.fn(async (_companyId: string, input: any) => {
    const id = `je-${postedJournals.length + 1}`;
    postedJournals.push({ id, lines: input.lines });
    return { id, status: 'draft' };
  });
  const postEntry = vi.fn(async (_companyId: string, entryId: string) => ({ id: entryId, status: 'posted' }));
  return {
    JournalService: vi.fn(() => ({ createDraftEntry, postEntry })),
    defaultJournalService: { createDraftEntry, postEntry },
  };
});

function createMaTestHarness() {
  const profiles = new Map<string, { id: string; name: string; costingMethod: CostingMethod; isActive: boolean }>([
    ['prof-fifo', { id: 'prof-fifo', name: 'FIFO Profile', costingMethod: 'FIFO', isActive: true }],
    ['prof-ma', { id: 'prof-ma', name: 'MA Profile', costingMethod: 'PERPETUAL_MOVING_AVERAGE', isActive: true }],
  ]);
  const assignments = new Map<string, { profileId: string; costingMethod: CostingMethod }>([
    ['comp-1::item-fifo', { profileId: 'prof-fifo', costingMethod: 'FIFO' }],
    ['comp-1::item-ma', { profileId: 'prof-ma', costingMethod: 'PERPETUAL_MOVING_AVERAGE' }],
    ['comp-2::item-ma', { profileId: 'prof-ma', costingMethod: 'PERPETUAL_MOVING_AVERAGE' }],
  ]);

  const valBalances = new Map<string, ValuationBalance>();
  const stockBalances = new Map<string, { companyId: string; warehouseId: string; itemId: string; qty: number }>();
  const layers: CostLayer[] = [];
  const movements: ValuationMovement[] = [];
  const allocations: any[] = [];
  const openings: OpeningValuationRecord[] = [];
  const maSourceBalances: MaSourceBalance[] = [];
  const maSourceEvents: MaSourceEvent[] = [];
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}-${seq++}`;
  const key = (c: string, w: string, i: string) => `${c}::${w}::${i}`;

  const ACCOUNTS: Record<string, any> = {
    'acct-inv': { id: 'acct-inv', code: '1300', nameAr: 'المخزون', accountType: 'asset', isActive: true, isPostable: true },
    'acct-adj': { id: 'acct-adj', code: '5200', nameAr: 'تسويات المخزون', accountType: 'expense', isActive: true, isPostable: true },
    'acct-open-eq': { id: 'acct-open-eq', code: '3100', nameAr: 'أرصدة افتتاحية', accountType: 'equity', isActive: true, isPostable: true },
  };

  const settingsRepo: any = {
    getByCompanyId: vi.fn(async (companyId: string) => ({
      companyId,
      inventoryAccountId: 'acct-inv',
      inventoryAdjustmentAccountId: 'acct-adj',
      openingBalanceEquityAccountId: 'acct-open-eq',
    })),
  };
  const accountRepo: any = { findById: vi.fn(async (_c: string, id: string) => ACCOUNTS[id] || null) };
  const warehouseRepo: any = { findById: vi.fn(async (_c: string, id: string) => ({ id, code: id, nameAr: id, isActive: true })) };
  const itemRepo: any = { findById: vi.fn(async (_c: string, id: string) => ({ id, code: id, nameAr: id, uom: 'unit', isActive: true })) };
  const auditService: any = { record: vi.fn(async () => {}) };

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
        valBalances.set(k, { companyId, warehouseId, itemId, quantity: 0, totalCost: 0, unitCost: 0, updatedAt: new Date().toISOString() });
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
    listActiveCostLayersForUpdate: vi.fn(async (companyId: string, warehouseId: string, itemId: string) =>
      layers
        .filter((l) => l.companyId === companyId && l.warehouseId === warehouseId && l.itemId === itemId && !l.isExhausted && l.remainingQty > 0)
        .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id))
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
      allocations.push({ id: nextId('alloc'), companyId, ...input });
    }),
    createOpeningValuation: vi.fn(async (companyId: string, input: any) => {
      const rec: OpeningValuationRecord = {
        id: nextId('open'),
        companyId,
        warehouseId: input.warehouseId,
        itemId: input.itemId,
        costingMethod: input.costingMethod,
        quantity: Number(input.quantity),
        totalCost: Number(input.totalCost),
        unitCost: Number(input.unitCost),
        status: 'pending_setup',
        reason: input.reason ?? null,
        evidenceRef: input.evidenceRef ?? null,
        createdBy: input.createdBy ?? null,
        createdAt: new Date().toISOString(),
      };
      openings.push(rec);
      return { ...rec };
    }),
    findOpeningByIdForUpdate: vi.fn(async (companyId: string, id: string) =>
      openings.find((o) => o.companyId === companyId && o.id === id) || null
    ),
    markOpeningApproved: vi.fn(async (companyId: string, id: string, actorId: string, jeId: string, movId: string) => {
      const o = openings.find((x) => x.companyId === companyId && x.id === id)!;
      o.status = 'approved';
      o.approvedBy = actorId;
      o.approvedAt = new Date().toISOString();
      o.journalEntryId = jeId;
      o.valuationMovementId = movId;
      return { ...o };
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
      const recvQtyU = parseExactUnits(input.receivedQty, QTY_SCALE, 'receivedQty');
      const remQtyU = parseExactUnits(input.remainingQty, QTY_SCALE, 'remainingQty');
      const consQtyU = parseExactUnits(input.consumedQty, QTY_SCALE, 'consumedQty');
      const origValU = parseExactUnits(input.originalValue, COST_SCALE, 'originalValue');
      const remValU = parseExactUnits(input.remainingValue, COST_SCALE, 'remainingValue');
      const consValU = parseExactUnits(input.consumedValue, COST_SCALE, 'consumedValue');
      if (remQtyU < 0n || consQtyU < 0n || remQtyU + consQtyU !== recvQtyU) {
        throw new Error('DB_CHECK_VIOLATION: invalid MA qty conservation');
      }
      if (origValU < 0n || remValU < 0n || consValU < 0n || remValU + consValU !== origValU) {
        throw new Error('DB_CHECK_VIOLATION: invalid MA value conservation');
      }
      const now = new Date(Date.now() + seq++).toISOString();
      if (idx >= 0) {
        const cur = maSourceBalances[idx];
        cur.grnId = cur.grnId ?? input.grnId ?? null;
        cur.grnLineId = cur.grnLineId ?? input.grnLineId ?? null;
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
        const recvQtyU = parseExactUnits(b.receivedQty, QTY_SCALE, 'recvQty');
        const remQtyU = parseExactUnits(remainingQty, QTY_SCALE, 'remQty');
        const consQtyU = parseExactUnits(consumedQty, QTY_SCALE, 'consQty');
        if (remQtyU < 0n || consQtyU < 0n || remQtyU + consQtyU !== recvQtyU) {
          throw new Error('DB_CHECK_VIOLATION: chk_inv_ma_src_bal_qty');
        }
        b.remainingQty = Number(remainingQty);
        b.consumedQty = Number(consumedQty);
        if (remainingValue !== undefined && consumedValue !== undefined) {
          const origValU = parseExactUnits(b.originalValue, COST_SCALE, 'origVal');
          const remValU = parseExactUnits(remainingValue, COST_SCALE, 'remVal');
          const consValU = parseExactUnits(consumedValue, COST_SCALE, 'consVal');
          if (remValU < 0n || consValU < 0n || remValU + consValU !== origValU) {
            throw new Error('DB_CHECK_VIOLATION: chk_inv_ma_src_bal_val_sum');
          }
          b.remainingValue = Number(remainingValue);
          b.consumedValue = Number(consumedValue);
        }
        b.updatedAt = new Date().toISOString();
      }
    ),
    createMaSourceEvent: vi.fn(async (companyId: string, input: any) => {
      const qU = parseExactUnits(input.quantity, QTY_SCALE, 'evQty');
      if (qU <= 0n) throw new Error('DB_CHECK_VIOLATION: inv_ma_source_events.quantity <= 0');
      const existing = maSourceEvents.find(
        (e) =>
          e.companyId === companyId &&
          e.eventType === input.eventType &&
          e.warehouseId === input.warehouseId &&
          e.itemId === input.itemId &&
          e.originSourceType === input.originSourceType &&
          e.originSourceId === input.originSourceId &&
          (e.originSourceLineId ?? null) === (input.originSourceLineId ?? null) &&
          e.sourceType === input.sourceType &&
          e.sourceId === input.sourceId &&
          (e.sourceLineId ?? null) === (input.sourceLineId ?? null)
      );
      if (existing) return { ...existing };
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

  valuationRepo.updateMaSourceBalanceQuantitiesBulk = vi.fn(async (companyId: string, rows: any[], ex: any) => {
    for (const r of rows) await valuationRepo.updateMaSourceBalanceQuantities(companyId, r.id, r.remainingQty, r.consumedQty, ex, r.remainingValue, r.consumedValue);
  });
  valuationRepo.createMaSourceEventsMulti = vi.fn(async (companyId: string, common: any, rows: any[], ex: any) => {
    for (const r of rows) await valuationRepo.createMaSourceEvent(companyId, { ...common, ...r }, ex);
  });

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
    createMovement: vi.fn(async (companyId: string, warehouseId: string, itemId: string, movementType: string, qty: number) => ({
      id: nextId('smov'),
      companyId,
      warehouseId,
      itemId,
      movementType,
      qty,
    })),
  };

  const fakeTx: any = {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (sql.includes('FROM inv_opening_valuations WHERE company_id') && sql.includes("status = 'approved'")) {
        const [cid, wh, it] = params;
        return { rows: openings.filter((o) => o.companyId === cid && o.warehouseId === wh && o.itemId === it && o.status === 'approved').map((o) => ({ id: o.id })) };
      }
      if (sql.includes('FROM inv_valuation_balances')) {
        const [cid, itemId] = params;
        return {
          rows: Array.from(valBalances.values())
            .filter((b) => b.companyId === cid && (!itemId || b.itemId === itemId) && b.quantity > 0)
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

  const stockService = new StockService(
    stockRepo,
    warehouseRepo,
    itemRepo,
    auditService,
    valuationService,
    settingsRepo,
    accountRepo
  );

  function assertMaLedgerParity(companyId: string, warehouseId: string, itemId: string) {
    const vb = valBalances.get(key(companyId, warehouseId, itemId));
    const sb = maSourceBalances.filter((b) => b.companyId === companyId && b.warehouseId === warehouseId && b.itemId === itemId);
    const sumRemQty = sb.reduce((acc, b) => acc + parseExactUnits(b.remainingQty, QTY_SCALE), 0n);
    const sumRemVal = sb.reduce((acc, b) => acc + parseExactUnits(b.remainingValue, COST_SCALE), 0n);
    const vbQty = parseExactUnits(vb?.quantity ?? 0, QTY_SCALE);
    const vbVal = parseExactUnits(vb?.totalCost ?? 0, COST_SCALE);
    expect(sumRemQty).toBe(vbQty);
    expect(sumRemVal).toBe(vbVal);
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
    stockService,
    valuationRepo,
    stockRepo,
    valBalances,
    stockBalances,
    layers,
    movements,
    allocations,
    maSourceBalances,
    maSourceEvents,
    fakeTx,
    assertMaLedgerParity,
  };
}

describe('Package 7A — Moving Average Source Value Ledger & Migration 052/053 Verification (15 Scenarios)', () => {
  beforeEach(() => {
    postedJournals.length = 0;
  });

  it('1. MA GRN receipt creates inv_ma_source_balances & positive RECEIPT event with GRN origin', async () => {
    const h = createMaTestHarness();
    const res = await h.valuationService.processReceipt(
      'comp-1',
      {
        warehouseId: 'wh-1',
        itemId: 'item-ma',
        qty: '25.0000',
        unitCost: '40.0000',
        totalCost: '1000.0000',
        sourceType: 'GRN',
        sourceId: 'grn-1',
        sourceLineId: 'grnl-1',
      },
      'actor-1',
      h.fakeTx
    );

    expect(h.maSourceBalances).toHaveLength(1);
    const bal = h.maSourceBalances[0];
    expect(bal.sourceType).toBe('GRN');
    expect(bal.sourceId).toBe('grn-1');
    expect(bal.sourceLineId).toBe('grnl-1');
    expect(bal.originSourceType).toBe('GRN');
    expect(bal.originSourceId).toBe('grn-1');
    expect(bal.originSourceLineId).toBe('grnl-1');
    expect(bal.grnId).toBe('grn-1');
    expect(bal.grnLineId).toBe('grnl-1');
    expect(bal.receivedQty).toBe(25);
    expect(bal.remainingQty).toBe(25);
    expect(bal.originalValue).toBe(1000);
    expect(bal.remainingValue).toBe(1000);

    expect(h.maSourceEvents).toHaveLength(1);
    const ev = h.maSourceEvents[0];
    expect(ev.eventType).toBe('RECEIPT');
    expect(ev.quantity).toBe(25);
    expect(ev.valueDelta).toBe(1000);
    expect(ev.referenceMovementId).toBe(res.movement.id);
    h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');
  });

  it('2. MA opening balance approval writes OPENING source balance & event with NULL grn_id/grn_line_id', async () => {
    const h = createMaTestHarness();
    await h.stockRepo.incrementBalance('comp-1', 'wh-1', 'item-ma', 30);

    const open = await h.valuationService.createOpeningValuation(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', quantity: 30, unitCost: 15, reason: 'Opening balance test' },
      'u1'
    );
    const approved = await h.valuationService.approveOpeningValuation('comp-1', open.id, 'admin-1', false);
    expect(approved.status).toBe('approved');

    expect(h.maSourceBalances).toHaveLength(1);
    const bal = h.maSourceBalances[0];
    expect(bal.sourceType).toBe('OPENING_VALUATION');
    expect(bal.sourceId).toBe(open.id);
    expect(bal.originSourceType).toBe('OPENING_VALUATION');
    expect(bal.originSourceId).toBe(open.id);
    expect(bal.grnId).toBeNull();
    expect(bal.grnLineId).toBeNull();
    expect(bal.originalValue).toBe(450);

    expect(h.maSourceEvents).toHaveLength(1);
    expect(h.maSourceEvents[0].eventType).toBe('OPENING');
    expect(h.maSourceEvents[0].grnId).toBeNull();
    expect(h.maSourceEvents[0].valueDelta).toBe(450);
    h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');
  });

  it('3. MA manual receipt & positive stock adjustment create source balances & RECEIPT events without fake GRN', async () => {
    const h = createMaTestHarness();
    await h.stockService.receiveStock(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 20, costSource: 'APPROVED_VALUATION', reason: 'Manual receipt' },
      'u1'
    );
    await h.stockService.adjustStock(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', adjustmentType: 'adjustment', direction: 'increase', qty: 5, unitCost: 26, costSource: 'APPROVED_VALUATION', reason: 'Cycle count surplus' },
      'u1'
    );

    expect(h.maSourceBalances).toHaveLength(2);
    expect(h.maSourceBalances.every((b) => b.grnId === null && b.grnLineId === null)).toBe(true);
    expect(h.maSourceBalances.map((b) => b.sourceType)).toEqual(['MANUAL_RECEIPT', 'STOCK_ADJUSTMENT']);
    expect(h.maSourceEvents.every((e) => e.eventType === 'RECEIPT' && e.valueDelta > 0)).toBe(true);
    h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');
  });

  it('4. Single-source MA issue decrements remaining qty/value, increments consumed qty/value & emits negative ISSUE event', async () => {
    const h = createMaTestHarness();
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 40, unitCost: 25, sourceType: 'GRN', sourceId: 'grn-1', sourceLineId: 'grnl-1' },
      'u1',
      h.fakeTx
    );
    const issue = await h.valuationService.processIssue(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 15, sourceType: 'SALES_DELIVERY', sourceId: 'del-1', sourceLineId: 'dell-1' },
      'u1',
      h.fakeTx
    );

    expect(issue.totalCost).toBe(375);
    const bal = h.maSourceBalances[0];
    expect(bal.remainingQty).toBe(25);
    expect(bal.consumedQty).toBe(15);
    expect(bal.remainingValue).toBe(625);
    expect(bal.consumedValue).toBe(375);

    const issueEv = h.maSourceEvents.find((e) => e.eventType === 'ISSUE')!;
    expect(issueEv.quantity).toBe(15);
    expect(issueEv.valueDelta).toBe(-375);
    expect(issueEv.referenceMovementId).toBe(issue.movement.id);
    h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');
  });

  it('5. Multi-source MA issue (including extreme spread 10@10 + 10@50 and uneven decimals) keeps exact value parity with zero negative remaining_value', async () => {
    const h = createMaTestHarness();
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 10, sourceType: 'GRN', sourceId: 'grn-a', sourceLineId: 'grnl-a' },
      'u1',
      h.fakeTx
    );
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 50, sourceType: 'GRN', sourceId: 'grn-b', sourceLineId: 'grnl-b' },
      'u1',
      h.fakeTx
    );

    // Pool: 20 units, 600 total value, avg 30. Issue 5 => cost = 150.
    // Pure FIFO qty depletion from grn-a (val=100) at 150 would fail remaining_value >= 0; proportional attribution handles cleanly.
    const issue1 = await h.valuationService.processIssue(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 5, sourceType: 'SALES_DELIVERY', sourceId: 'del-1', sourceLineId: 'dell-1' },
      'u1',
      h.fakeTx
    );
    expect(issue1.totalCost).toBe(150);
    h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');

    // Also test uneven fractional 3-way split on second warehouse
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-2', itemId: 'item-ma', qty: '1.0000', unitCost: '10.0000', totalCost: '10.0000', sourceType: 'GRN', sourceId: 'g-1', sourceLineId: 'gl-1' },
      'u1',
      h.fakeTx
    );
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-2', itemId: 'item-ma', qty: '2.0000', unitCost: '20.0000', totalCost: '40.0000', sourceType: 'GRN', sourceId: 'g-2', sourceLineId: 'gl-2' },
      'u1',
      h.fakeTx
    );
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-2', itemId: 'item-ma', qty: '0.3333', unitCost: '33.3333', totalCost: '11.1100', sourceType: 'GRN', sourceId: 'g-3', sourceLineId: 'gl-3' },
      'u1',
      h.fakeTx
    );
    await h.valuationService.processIssue(
      'comp-1',
      { warehouseId: 'wh-2', itemId: 'item-ma', qty: '1.1111', sourceType: 'SALES_DELIVERY', sourceId: 'del-frac', sourceLineId: 'dell-frac' },
      'u1',
      h.fakeTx
    );
    h.assertMaLedgerParity('comp-1', 'wh-2', 'item-ma');
  });

  it('6. Full MA pool depletion zeroes all remaining qty/value and satisfies exact conservation checks', async () => {
    const h = createMaTestHarness();
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 7, unitCost: '14.2857', totalCost: '100.0000', sourceType: 'GRN', sourceId: 'g-1', sourceLineId: 'gl-1' },
      'u1',
      h.fakeTx
    );
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 3, unitCost: '10.0000', totalCost: '30.0000', sourceType: 'GRN', sourceId: 'g-2', sourceLineId: 'gl-2' },
      'u1',
      h.fakeTx
    );

    const partial = await h.valuationService.processIssue(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 4, sourceType: 'SALES_DELIVERY', sourceId: 'd-1', sourceLineId: 'dl-1' },
      'u1',
      h.fakeTx
    );
    expect(partial.balance.quantity).toBe(6);

    const deplete = await h.valuationService.processIssue(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 6, sourceType: 'SALES_DELIVERY', sourceId: 'd-2', sourceLineId: 'dl-2' },
      'u1',
      h.fakeTx
    );
    expect(deplete.balance.quantity).toBe(0);
    expect(deplete.balance.totalCost).toBe(0);
    expect(h.maSourceBalances.every((b) => b.remainingQty === 0 && b.remainingValue === 0)).toBe(true);
    h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');
  });

  it('7. Single-hop MA transfer WH1 -> WH2 records TRANSFER_OUT/IN & creates WH2 source balance preserving GRN root origin', async () => {
    const h = createMaTestHarness();
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 20, unitCost: 30, sourceType: 'GRN', sourceId: 'grn-1', sourceLineId: 'grnl-1' },
      'u1',
      h.fakeTx
    );
    await h.valuationService.processTransfer(
      'comp-1',
      { sourceWarehouseId: 'wh-1', destWarehouseId: 'wh-2', itemId: 'item-ma', qty: 8, sourceId: 'tr-1', sourceLineId: 'trl-1' },
      'u1',
      h.fakeTx
    );

    h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');
    h.assertMaLedgerParity('comp-1', 'wh-2', 'item-ma');

    const wh2Bal = h.maSourceBalances.find((b) => b.warehouseId === 'wh-2')!;
    expect(wh2Bal.sourceType).toBe('WAREHOUSE_TRANSFER');
    expect(wh2Bal.sourceId).toBe('tr-1');
    expect(wh2Bal.originSourceType).toBe('GRN');
    expect(wh2Bal.originSourceId).toBe('grn-1');
    expect(wh2Bal.originSourceLineId).toBe('grnl-1');
    expect(wh2Bal.grnId).toBe('grn-1');
    expect(wh2Bal.grnLineId).toBe('grnl-1');
    expect(wh2Bal.remainingValue).toBe(240);

    expect(h.maSourceEvents.some((e) => e.eventType === 'TRANSFER_OUT' && e.warehouseId === 'wh-1' && e.valueDelta === -240)).toBe(true);
    expect(h.maSourceEvents.some((e) => e.eventType === 'TRANSFER_IN' && e.warehouseId === 'wh-2' && e.valueDelta === 240)).toBe(true);
  });

  it('8. Multi-hop MA transfer WH1 -> WH2 -> WH3 (including converging paths) preserves root origin without unique key collisions', async () => {
    const h = createMaTestHarness();
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 30, unitCost: 20, sourceType: 'GRN', sourceId: 'grn-root', sourceLineId: 'grnl-root' },
      'u1',
      h.fakeTx
    );
    // Two separate transfers WH1 -> WH2 carrying the same root GRN origin
    await h.valuationService.processTransfer(
      'comp-1',
      { sourceWarehouseId: 'wh-1', destWarehouseId: 'wh-2', itemId: 'item-ma', qty: 10, sourceId: 'tr-1a', sourceLineId: 'trl-1a' },
      'u1',
      h.fakeTx
    );
    await h.valuationService.processTransfer(
      'comp-1',
      { sourceWarehouseId: 'wh-1', destWarehouseId: 'wh-2', itemId: 'item-ma', qty: 10, sourceId: 'tr-1b', sourceLineId: 'trl-1b' },
      'u1',
      h.fakeTx
    );
    // Transfer from WH2 -> WH3 drawing from BOTH wh-2 rows that share grn-root
    await h.valuationService.processTransfer(
      'comp-1',
      { sourceWarehouseId: 'wh-2', destWarehouseId: 'wh-3', itemId: 'item-ma', qty: 15, sourceId: 'tr-2', sourceLineId: 'trl-2' },
      'u1',
      h.fakeTx
    );

    h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');
    h.assertMaLedgerParity('comp-1', 'wh-2', 'item-ma');
    h.assertMaLedgerParity('comp-1', 'wh-3', 'item-ma');

    const wh3Rows = h.maSourceBalances.filter((b) => b.warehouseId === 'wh-3');
    expect(wh3Rows).toHaveLength(1);
    expect(wh3Rows[0].originSourceType).toBe('GRN');
    expect(wh3Rows[0].originSourceId).toBe('grn-root');
    expect(wh3Rows[0].remainingQty).toBe(15);
    expect(wh3Rows[0].remainingValue).toBe(300);
  });

  it('9. Multi-source MA transfer creates distinct destination source rows per origin without uq_inv_ma_src_bal_identity collisions', async () => {
    const h = createMaTestHarness();
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 10, sourceType: 'GRN', sourceId: 'grn-1', sourceLineId: 'grnl-1' },
      'u1',
      h.fakeTx
    );
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 30, sourceType: 'GRN', sourceId: 'grn-2', sourceLineId: 'grnl-2' },
      'u1',
      h.fakeTx
    );

    await h.valuationService.processTransfer(
      'comp-1',
      { sourceWarehouseId: 'wh-1', destWarehouseId: 'wh-2', itemId: 'item-ma', qty: 10, sourceId: 'tr-split', sourceLineId: 'trl-split' },
      'u1',
      h.fakeTx
    );

    const wh2Rows = h.maSourceBalances.filter((b) => b.warehouseId === 'wh-2');
    expect(wh2Rows).toHaveLength(2);
    expect(new Set(wh2Rows.map((r) => r.originSourceId))).toEqual(new Set(['grn-1', 'grn-2']));
    h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');
    h.assertMaLedgerParity('comp-1', 'wh-2', 'item-ma');
  });

  it('10. Non-GRN source (OPENING_VALUATION / MANUAL_RECEIPT) transferred retains NULL grn_id & non-GRN root origin', async () => {
    const h = createMaTestHarness();
    await h.valuationService.processReceipt(
      'comp-1',
      {
        warehouseId: 'wh-1',
        itemId: 'item-ma',
        qty: 12,
        unitCost: 50,
        sourceType: 'MANUAL_RECEIPT',
        sourceId: 'mr-1',
        movementType: 'RECEIVE',
        costSource: 'APPROVED_VALUATION',
      },
      'u1',
      h.fakeTx
    );

    await h.valuationService.processTransfer(
      'comp-1',
      { sourceWarehouseId: 'wh-1', destWarehouseId: 'wh-2', itemId: 'item-ma', qty: 5, sourceId: 'tr-mr', sourceLineId: 'trl-mr' },
      'u1',
      h.fakeTx
    );

    const wh2Bal = h.maSourceBalances.find((b) => b.warehouseId === 'wh-2')!;
    expect(wh2Bal.originSourceType).toBe('MANUAL_RECEIPT');
    expect(wh2Bal.originSourceId).toBe('mr-1');
    expect(wh2Bal.grnId).toBeNull();
    expect(wh2Bal.grnLineId).toBeNull();
    h.assertMaLedgerParity('comp-1', 'wh-2', 'item-ma');
  });

  it('11. Idempotent retry safety blocks duplicate receipt/issue/transfer & createMaSourceEvent DO NOTHING returns existing event', async () => {
    const h = createMaTestHarness();
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 20, unitCost: 10, sourceType: 'GRN', sourceId: 'grn-idem', sourceLineId: 'grnl-idem' },
      'u1',
      h.fakeTx
    );
    await expect(
      h.valuationService.processReceipt(
        'comp-1',
        { warehouseId: 'wh-1', itemId: 'item-ma', qty: 20, unitCost: 10, sourceType: 'GRN', sourceId: 'grn-idem', sourceLineId: 'grnl-idem' },
        'u1',
        h.fakeTx
      )
    ).rejects.toThrow(/IDEMPOTENT_DUPLICATE/);

    await h.valuationService.processTransfer(
      'comp-1',
      { sourceWarehouseId: 'wh-1', destWarehouseId: 'wh-2', itemId: 'item-ma', qty: 5, sourceId: 'tr-idem', sourceLineId: 'trl-idem' },
      'u1',
      h.fakeTx
    );
    await expect(
      h.valuationService.processTransfer(
        'comp-1',
        { sourceWarehouseId: 'wh-1', destWarehouseId: 'wh-2', itemId: 'item-ma', qty: 5, sourceId: 'tr-idem', sourceLineId: 'trl-idem' },
        'u1',
        h.fakeTx
      )
    ).rejects.toThrow(/IDEMPOTENT_DUPLICATE/);

    // Direct createMaSourceEvent idempotency check
    const firstEv = h.maSourceEvents[0];
    const dupEv = await h.valuationRepo.createMaSourceEvent(
      'comp-1',
      {
        warehouseId: firstEv.warehouseId,
        itemId: firstEv.itemId,
        sourceType: firstEv.sourceType,
        sourceId: firstEv.sourceId,
        sourceLineId: firstEv.sourceLineId,
        originSourceType: firstEv.originSourceType,
        originSourceId: firstEv.originSourceId,
        originSourceLineId: firstEv.originSourceLineId,
        grnId: firstEv.grnId,
        grnLineId: firstEv.grnLineId,
        eventType: firstEv.eventType,
        quantity: firstEv.quantity,
        valueDelta: firstEv.valueDelta,
      },
      h.fakeTx
    );
    expect(dupEv.id).toBe(firstEv.id);
    expect(h.maSourceEvents.filter((e) => e.id === firstEv.id)).toHaveLength(1);
  });

  it('12. Multi-tenant RLS isolation: Migration 053 enforces ENABLE/FORCE RLS & an_app tenant policies and company isolation', async () => {
    const h = createMaTestHarness();
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 15, sourceType: 'GRN', sourceId: 'grn-c1', sourceLineId: 'l-c1' },
      'u1',
      h.fakeTx
    );
    await h.valuationService.processReceipt(
      'comp-2',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 5, unitCost: 99, sourceType: 'GRN', sourceId: 'grn-c2', sourceLineId: 'l-c2' },
      'u2',
      h.fakeTx
    );

    const comp1List = await h.valuationRepo.listMaSourceBalancesForUpdate('comp-1', 'wh-1', 'item-ma', h.fakeTx);
    expect(comp1List).toHaveLength(1);
    expect(comp1List[0].companyId).toBe('comp-1');

    const sql053 = fs.readFileSync(path.join(process.cwd(), 'database/migrations/053_ma_source_value_ledger.sql'), 'utf8');
    expect(sql053).toMatch(/ALTER TABLE public\.inv_ma_source_balances ENABLE ROW LEVEL SECURITY;/);
    expect(sql053).toMatch(/ALTER TABLE public\.inv_ma_source_balances FORCE ROW LEVEL SECURITY;/);
    expect(sql053).toMatch(/ALTER TABLE public\.inv_ma_source_events ENABLE ROW LEVEL SECURITY;/);
    expect(sql053).toMatch(/ALTER TABLE public\.inv_ma_source_events FORCE ROW LEVEL SECURITY;/);
    expect(sql053).toMatch(/TO an_app[\s\S]*app\.current_tenant_id[\s\S]*WITH CHECK/i);
    expect(sql053).toMatch(/REVOKE DELETE ON public\.inv_ma_source_balances FROM an_app;/);
    expect(sql053).toMatch(/REVOKE UPDATE, DELETE ON public\.inv_ma_source_events FROM an_app;/);
  });

  it('13. CHECK constraint guarantees reject negative remaining qty/value or value-sum mismatch', async () => {
    const h = createMaTestHarness();
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 10, sourceType: 'GRN', sourceId: 'grn-chk', sourceLineId: 'grnl-chk' },
      'u1',
      h.fakeTx
    );
    const rowId = h.maSourceBalances[0].id;

    await expect(
      h.valuationRepo.updateMaSourceBalanceQuantities('comp-1', rowId, '-1.0000', '11.0000', h.fakeTx, '0.0000', '100.0000')
    ).rejects.toThrow(/CHECK_VIOLATION/);

    await expect(
      h.valuationRepo.updateMaSourceBalanceQuantities('comp-1', rowId, '5.0000', '5.0000', h.fakeTx, '40.0000', '40.0000')
    ).rejects.toThrow(/CHECK_VIOLATION/);

    const sql053 = fs.readFileSync(path.join(process.cwd(), 'database/migrations/053_ma_source_value_ledger.sql'), 'utf8');
    const sql053NoComments = sql053.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '');
    expect(sql053NoComments).not.toMatch(/\bEXCEPTION\s+WHEN\s+OTHERS\b/i);
    expect(sql053).toMatch(/CHECK\s*\(\s*original_value\s*>=\s*0\s+AND\s+remaining_value\s*>=\s*0\s+AND\s+consumed_value\s*>=\s*0\s*\)/i);
    expect(sql053).toMatch(/CHECK\s*\(\s*remaining_value\s*\+\s*consumed_value\s*=\s*original_value\s*\)/i);
    expect(sql053).toMatch(/'OPENING','RECEIPT','ISSUE','TRANSFER_OUT','TRANSFER_IN','PURCHASE_RETURN','PPV'/);
  });

  it('14. Migration 052 dynamically drops existing reversal_journal_entry_id FKs and adds ON DELETE SET NULL (reversal_journal_entry_id)', () => {
    const sql052 = fs.readFileSync(path.join(process.cwd(), 'database/migrations/052_inventory_valuation_fk_repair.sql'), 'utf8');
    const sqlNoComments = sql052.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '');
    expect(sqlNoComments).not.toMatch(/\bEXCEPTION\s+WHEN\s+OTHERS\b/i);
    expect(sql052).toMatch(/cl\.relname\s*=\s*'inv_sales_cogs_reversals'/);
    expect(sql052).toMatch(/a\.attname\s*=\s*'reversal_journal_entry_id'/);
    expect(sql052).toMatch(/DROP CONSTRAINT IF EXISTS %I/);
    expect(sql052).toMatch(
      /ADD CONSTRAINT fk_inv_cogs_rev_je[\s\S]*FOREIGN KEY \(reversal_journal_entry_id, company_id\)[\s\S]*REFERENCES public\.journal_entries \(id, company_id\)[\s\S]*ON DELETE SET NULL \(reversal_journal_entry_id\)/i
    );
  });

  it('15. Mixed FIFO & MA items stay strictly isolated (FIFO uses layers, MA uses MA source ledger)', async () => {
    const h = createMaTestHarness();
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 10, unitCost: 20, sourceType: 'GRN', sourceId: 'g-fifo', sourceLineId: 'gl-fifo' },
      'u1',
      h.fakeTx
    );
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 10, unitCost: 30, sourceType: 'GRN', sourceId: 'g-ma', sourceLineId: 'gl-ma' },
      'u1',
      h.fakeTx
    );

    await h.valuationService.processIssue(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 4, sourceType: 'SALES_DELIVERY', sourceId: 'd-fifo', sourceLineId: 'dl-fifo' },
      'u1',
      h.fakeTx
    );
    await h.valuationService.processIssue(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', qty: 4, sourceType: 'SALES_DELIVERY', sourceId: 'd-ma', sourceLineId: 'dl-ma' },
      'u1',
      h.fakeTx
    );

    expect(h.layers.filter((l) => l.itemId === 'item-fifo')).toHaveLength(1);
    expect(h.layers.filter((l) => l.itemId === 'item-ma')).toHaveLength(0);
    expect(h.maSourceBalances.filter((b) => b.itemId === 'item-fifo')).toHaveLength(0);
    expect(h.maSourceBalances.filter((b) => b.itemId === 'item-ma')).toHaveLength(1);
    expect(h.maSourceEvents.filter((e) => e.itemId === 'item-fifo')).toHaveLength(0);
    h.assertMaLedgerParity('comp-1', 'wh-1', 'item-ma');
  });
});
