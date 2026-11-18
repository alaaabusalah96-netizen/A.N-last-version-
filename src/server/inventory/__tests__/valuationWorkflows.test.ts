import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StockService } from '../stockService.js';
import { InventoryValuationService } from '../inventoryValuationService.js';
import { PurchReturnService } from '../../purchasing/purchReturnService.js';
import { InvoiceService } from '../../purchasing/invoiceService.js';
import { ROLE_PERMISSIONS } from '../../rbac/roles.js';
import { PERMISSIONS } from '../../rbac/permissions.js';
import {
  CostingMethod,
  CostLayer,
  ValuationBalance,
  ValuationMovement,
  CostAdjustmentRecord,
  OpeningValuationRecord,
  ValuationReconciliationRecord,
} from '../inventoryValuationTypes.js';
import { parseExactUnits, fromMinorUnits, QTY_SCALE, COST_SCALE } from '../../lib/numeric.js';

const { fakeTxRef, postedJournals } = vi.hoisted(() => ({
  fakeTxRef: { current: null as any },
  postedJournals: [] as Array<{ id: string; entryDate: string; memo: string; lines: Array<{ accountId: string; debit: number; credit: number }> }>,
}));

vi.mock('../../db/transactionManager.js', () => ({
  withTenantTransaction: vi.fn(async (_companyId: string, fn: (tx: any) => Promise<any>) => {
    return await fn(fakeTxRef.current);
  }),
}));

vi.mock('../../accounting/journalService.js', () => {
  const createDraftEntry = vi.fn(async (_companyId: string, input: any) => {
    const totalDebit = input.lines.reduce((s: number, l: any) => s + Number(l.debit || 0), 0);
    const totalCredit = input.lines.reduce((s: number, l: any) => s + Number(l.credit || 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.005) {
      throw new Error(`Unbalanced JE in test: debit=${totalDebit}, credit=${totalCredit}`);
    }
    const id = `je-${postedJournals.length + 1}`;
    postedJournals.push({ id, entryDate: input.entryDate, memo: input.memo, lines: input.lines });
    return { id, status: 'draft' };
  });
  const postEntry = vi.fn(async (_companyId: string, entryId: string) => ({ id: entryId, status: 'posted' }));
  return {
    JournalService: vi.fn(() => ({ createDraftEntry, postEntry })),
    defaultJournalService: { createDraftEntry, postEntry },
  };
});

function buildStatefulErpHarness() {
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
  const stockMovements: any[] = [];
  const layers: CostLayer[] = [];
  const valMovements: ValuationMovement[] = [];
  const allocations: any[] = [];
  const adjustments: CostAdjustmentRecord[] = [];
  const openings: OpeningValuationRecord[] = [];
  const reconciliations: ValuationReconciliationRecord[] = [];
  let seq = 1;
  const nextId = (p: string) => `${p}-${seq++}`;
  const key = (c: string, w: string, i: string) => `${c}::${w}::${i}`;

  const ACCOUNTS: Record<string, any> = {
    'acct-inv': { id: 'acct-inv', code: '1300', nameAr: 'المخزون', accountType: 'asset', isActive: true, isPostable: true },
    'acct-adj': { id: 'acct-adj', code: '5200', nameAr: 'تسويات وعجز المخزون', accountType: 'expense', isActive: true, isPostable: true },
    'acct-open-eq': { id: 'acct-open-eq', code: '3100', nameAr: 'أرصدة أول المدة', accountType: 'equity', isActive: true, isPostable: true },
    'acct-clr': { id: 'acct-clr', code: '2150', nameAr: 'مشتريات معلقة', accountType: 'liability', isActive: true, isPostable: true },
    'acct-ap': { id: 'acct-ap', code: '2110', nameAr: 'الموردون', accountType: 'liability', isActive: true, isPostable: true },
    'acct-cogs': { id: 'acct-cogs', code: '5100', nameAr: 'تكلفة البضاعة المباعة', accountType: 'expense', isActive: true, isPostable: true },
  };

  const settingsData: any = {
    companyId: 'comp-1',
    inventoryAccountId: 'acct-inv',
    purchasesClearingAccountId: 'acct-clr',
    accountsPayableAccountId: 'acct-ap',
    inventoryAdjustmentAccountId: 'acct-adj',
    openingBalanceEquityAccountId: 'acct-open-eq',
  };

  const grnLinesStore = new Map<string, { id: string; grnId: string; warehouseId: string; itemId: string; qty: number; unitCost: string; status: string; supplierId: string }>();
  const returnHeaders = new Map<string, any>();
  const supplierInvoices = new Map<string, any>();

  const valuationRepo: any = {
    findProfileById: vi.fn(async (_c: string, id: string) => profiles.get(id) || null),
    getItemAssignment: vi.fn(async (companyId: string, itemId: string) => {
      const a = assignments.get(`${companyId}::${itemId}`);
      if (!a) return null;
      return { companyId, itemId, profileId: a.profileId, costingMethod: a.costingMethod, assignedAt: new Date().toISOString() };
    }),
    hasFinancialMovementsForItem: vi.fn(async (companyId: string, itemId: string) =>
      valMovements.some((m) => m.companyId === companyId && m.itemId === itemId)
      || layers.some((l) => l.companyId === companyId && l.itemId === itemId)
    ),
    assignItemProfile: vi.fn(async (companyId: string, itemId: string, profileId: string) => {
      const p = profiles.get(profileId)!;
      assignments.set(`${companyId}::${itemId}`, { profileId, costingMethod: p.costingMethod });
      return { companyId, itemId, profileId, costingMethod: p.costingMethod, assignedAt: new Date().toISOString() };
    }),
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
    findLayersByOriginLineForUpdate: vi.fn(async (companyId: string, sourceId: string, sourceLineId: string) =>
      layers
        .filter((l) => l.companyId === companyId && ((l.sourceId === sourceId && l.sourceLineId === sourceLineId) || (l.originSourceId === sourceId && l.originSourceLineId === sourceLineId)))
        .map((l) => ({ ...l }))
    ),
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
    findValuationMovementByIdempotency: vi.fn(async (companyId: string, warehouseId: string, itemId: string, movementType: string, sourceType: string, sourceId: string, sourceLineId?: string | null) =>
      valMovements.find(
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
      valMovements.push(m);
      return { ...m };
    }),
    linkValuationMovementJournal: vi.fn(async (_c: string, movId: string, jeId: string) => {
      const m = valMovements.find((x) => x.id === movId);
      if (m) m.journalEntryId = jeId;
    }),
    linkCostAdjustmentsJournal: vi.fn(async (_c: string, adjIds: string[], jeId: string) => {
      for (const id of adjIds) {
        const a = adjustments.find((x) => x.id === id);
        if (a) a.journalEntryId = jeId;
      }
    }),
    createCostAllocation: vi.fn(async (companyId: string, input: any) => {
      allocations.push({ id: nextId('alloc'), companyId, ...input });
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
    markOpeningRejected: vi.fn(async (companyId: string, id: string, actorId: string, reason: string) => {
      const o = openings.find((x) => x.companyId === companyId && x.id === id)!;
      o.status = 'rejected';
      o.rejectedBy = actorId;
      o.rejectionReason = reason;
      return { ...o };
    }),
    saveReconciliation: vi.fn(async (companyId: string, input: any) => {
      const r: ValuationReconciliationRecord = {
        id: nextId('rec'),
        companyId,
        warehouseId: input.warehouseId,
        itemId: input.itemId,
        costingMethod: input.costingMethod,
        periodId: input.periodId,
        accountId: input.accountId,
        comparisonScope: input.comparisonScope || 'COMPANY_GL',
        isGlComparable: input.isGlComparable !== undefined ? input.isGlComparable : true,
        subledgerTotal: Number(input.subledgerTotal),
        glControlTotal: Number(input.glControlTotal),
        variance: Number(input.variance),
        status: input.status,
        unmatchedMovementsCount: input.unmatchedMovementsCount,
        unbalancedAdjustmentsCount: input.unbalancedAdjustmentsCount,
        duplicateJournalLinksCount: input.duplicateJournalLinksCount,
        qtyValuationMismatchesCount: input.qtyValuationMismatchesCount,
        openingDiff: Number(input.openingDiff),
        notes: input.notes ?? null,
        reconciledAt: new Date().toISOString(),
        reconciledBy: input.reconciledBy ?? null,
      };
      reconciliations.push(r);
      return { ...r };
    }),
  };

  const stockRepo: any = {
    ensureBalanceRow: vi.fn(async (companyId: string, warehouseId: string, itemId: string) => {
      const k = key(companyId, warehouseId, itemId);
      if (!stockBalances.has(k)) stockBalances.set(k, { companyId, warehouseId, itemId, qty: 0 });
    }),
    getBalanceForUpdate: vi.fn(async (companyId: string, warehouseId: string, itemId: string) => {
      const b = stockBalances.get(key(companyId, warehouseId, itemId));
      return b ? { ...b } : null;
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
    createMovement: vi.fn(async (companyId: string, warehouseId: string, itemId: string, movementType: string, qty: number, memo?: string, actorId?: string, transferId?: string) => {
      const m = { id: nextId('smov'), companyId, warehouseId, itemId, movementType, qty, memo, actorId, transferId, createdAt: new Date().toISOString() };
      stockMovements.push(m);
      return { ...m };
    }),
  };

  const warehouseRepo: any = { findById: vi.fn(async (_c: string, id: string) => ({ id, code: id, nameAr: id, isActive: true })) };
  const itemRepo: any = { findById: vi.fn(async (_c: string, id: string) => ({ id, code: id, nameAr: id, uom: 'unit', isActive: true })) };
  const settingsRepo: any = { getByCompanyId: vi.fn(async () => settingsData) };
  const accountRepo: any = { findById: vi.fn(async (_c: string, id: string) => ACCOUNTS[id] || null) };
  const auditService: any = { record: vi.fn(async () => {}) };

  const fakeTx: any = {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (sql.includes('FROM inv_opening_valuations WHERE company_id') && sql.includes("status = 'approved'")) {
        const [cid, wh, it] = params;
        return { rows: openings.filter((o) => o.companyId === cid && o.warehouseId === wh && o.itemId === it && o.status === 'approved').map((o) => ({ id: o.id })) };
      }
      if (sql.includes('FROM inv_valuation_balances')) {
        const [cid, itemId] = params;
        const rows = Array.from(valBalances.values())
          .filter((b) => b.companyId === cid && (!itemId || b.itemId === itemId) && b.quantity > 0)
          .map((b) => ({ warehouseId: b.warehouseId }));
        const total = Array.from(valBalances.values()).reduce((s, b) => s + b.totalCost, 0).toFixed(4);
        if (sql.includes('SUM(vb.total_cost)')) return { rows: [{ total }] };
        return { rows };
      }
      if (sql.includes('FROM journal_lines') && sql.includes("status = 'posted'")) {
        const acctId = params[1];
        let net = 0;
        for (const je of postedJournals) {
          for (const l of je.lines) {
            if (l.accountId === acctId) net += Number(l.debit || 0) - Number(l.credit || 0);
          }
        }
        return { rows: [{ netBalance: net.toFixed(4) }] };
      }
      if (sql.includes('FROM inv_valuation_movements')) {
        const unmatched = valMovements.filter((m) => !['TRANSFER_OUT', 'TRANSFER_IN'].includes(m.movementType) && !m.journalEntryId).length;
        return { rows: [{ cnt: unmatched }] };
      }
      if (sql.includes('FROM inv_cost_adjustments')) {
        return { rows: [{ cnt: adjustments.filter((a) => !a.journalEntryId).length }] };
      }
      if (sql.includes('FROM inv_stock_balances sb')) {
        let mismatches = 0;
        for (const [k, sb] of stockBalances.entries()) {
          const vb = valBalances.get(k);
          if (sb.qty !== (vb?.quantity ?? 0)) mismatches++;
        }
        return { rows: [{ cnt: mismatches }] };
      }
      if (sql.includes('WITH openings AS')) {
        return { rows: [{ diff: '0.0000' }] };
      }
      if (sql.includes('FROM purch_supplier_invoices')) {
        const inv = supplierInvoices.get(params[1]);
        return { rows: inv && inv.companyId === params[0] ? [{ id: inv.id, status: inv.status, supplier_id: inv.supplierId }] : [] };
      }
      if (sql.includes('FROM inv_warehouses')) {
        return { rows: [{ id: params[1], is_active: true }] };
      }
      if (sql.includes('FROM purch_grn_lines')) {
        const ids: string[] = params[1];
        return {
          rows: ids
            .map((id) => grnLinesStore.get(id))
            .filter(Boolean)
            .map((g) => ({ id: g!.id, grnId: g!.grnId, qty: String(g!.qty), unitCost: g!.unitCost, itemId: g!.itemId })),
        };
      }
      if (sql.includes('FROM purch_return_lines')) {
        return { rows: [{ total: '0' }] };
      }
      if (sql.includes('UPDATE purch_return_lines')) {
        const [unitCost, _cid, lineId] = params;
        for (const rh of returnHeaders.values()) {
          const l = rh.lines.find((x: any) => x.id === lineId);
          if (l) l.unitCost = Number(unitCost);
        }
        return { rows: [] };
      }
      if (sql.includes('SELECT cogs_account_id')) {
        return { rows: [{ cogsAccountId: 'acct-cogs' }] };
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

  return {
    valuationService,
    stockService,
    stockRepo,
    valuationRepo,
    settingsRepo,
    accountRepo,
    auditService,
    stockBalances,
    valBalances,
    layers,
    valMovements,
    adjustments,
    openings,
    reconciliations,
    grnLinesStore,
    returnHeaders,
    supplierInvoices,
    fakeTx,
  };
}

describe('Phase 2–6 Integrated Inventory Valuation Workflows', () => {
  beforeEach(() => {
    postedJournals.length = 0;
  });

  it('15 & 8. StockService rejects zero-cost manual receive & executes controlled write-off/damage/internal consumption with GL journals', async () => {
    const h = buildStatefulErpHarness();

    await expect(
      h.stockService.receiveStock('comp-1', { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 10, unitCost: 0, costSource: 'APPROVED_VALUATION', reason: 'test' }, 'u1')
    ).rejects.toThrow(/تكلفة الوحدة/);

    const rcv = await h.stockService.receiveStock(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 10, unitCost: 25, costSource: 'APPROVED_VALUATION', reason: 'رصيد تكميلي' },
      'u1'
    );
    expect(rcv.totalCost).toBe(250);
    expect(rcv.journalEntryId).toBeTruthy();

    const dmg = await h.stockService.adjustStock(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-fifo', adjustmentType: 'damage', direction: 'decrease', qty: 4, reason: 'تلف رطوبة' },
      'u1'
    );
    expect(dmg.totalCost).toBe(100);
    expect(dmg.balance.qty).toBe(6);
    expect(h.valMovements.find((m) => m.sourceType === 'DAMAGE')?.journalEntryId).toBe(dmg.journalEntryId);
  });

  it('13 & 14. InvoiceService splits PPV (Remaining Inventory + Consumed COGS) and PurchReturnService credits adjusted GRN cost', async () => {
    const h = buildStatefulErpHarness();

    // Seed GRN 100 @ 100
    await h.stockRepo.incrementBalance('comp-1', 'wh-1', 'item-fifo', 100);
    await h.valuationService.processReceipt(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 100, unitCost: 100, sourceType: 'GRN', sourceId: 'grn-1', sourceLineId: 'grnl-1', stockSyncMode: 'external_verified', expectedPreStockQty: 0 },
      'u1',
      h.fakeTx
    );
    h.grnLinesStore.set('grnl-1', { id: 'grnl-1', grnId: 'grn-1', warehouseId: 'wh-1', itemId: 'item-fifo', qty: 100, unitCost: '100.0000', status: 'posted', supplierId: 'sup-1' });

    // Post GRN clearing JE so GL matches 10000 in inventory & -10000 in purchases clearing
    postedJournals.push({
      id: 'je-grn-1',
      entryDate: '2026-01-01',
      memo: 'GRN 1',
      lines: [
        { accountId: 'acct-inv', debit: 10000, credit: 0 },
        { accountId: 'acct-clr', debit: 0, credit: 10000 },
      ],
    });
    await h.valuationService.linkValuationMovementJournal('comp-1', h.valMovements[0].id, 'je-grn-1', h.fakeTx);

    // Sell 40 -> 60 left @ 100 = 6000
    await h.stockRepo.decrementBalance('comp-1', 'wh-1', 'item-fifo', 40);
    const saleIssue = await h.valuationService.processIssue(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-fifo', qty: 40, sourceType: 'SALES_DELIVERY', sourceId: 'del-1', sourceLineId: 'dell-1', stockSyncMode: 'external_verified', expectedPreStockQty: 100 },
      'u1',
      h.fakeTx
    );
    postedJournals.push({
      id: 'je-cogs-1',
      entryDate: '2026-01-02',
      memo: 'COGS 1',
      lines: [
        { accountId: 'acct-cogs', debit: 4000, credit: 0 },
        { accountId: 'acct-inv', debit: 0, credit: 4000 },
      ],
    });
    await h.valuationService.linkValuationMovementJournal('comp-1', saleIssue.movement.id, 'je-cogs-1', h.fakeTx);

    // Post supplier invoice via InvoiceService at 103/unit -> total 10300 (+180 Inv, +120 COGS, Dr Clearing 10000, Cr AP 10300)
    const invoiceObj: any = {
      id: 'sinv-1',
      companyId: 'comp-1',
      supplierId: 'sup-1',
      supplierInvoiceNo: 'SUP-103',
      invoiceDate: '2026-01-03',
      status: 'draft',
      lines: [{ id: 'sinvl-1', grnLineId: 'grnl-1', qty: 100, unitCost: 103 }],
    };
    h.supplierInvoices.set('sinv-1', invoiceObj);
    const invoiceRepo: any = {
      findByIdForUpdate: vi.fn(async () => invoiceObj),
      findById: vi.fn(async () => invoiceObj),
      lockGrnLinesAndGetPostedTotals: vi.fn(async () => new Map([
        ['grnl-1', { grnLineId: 'grnl-1', grnId: 'grn-1', grnQty: 100, grnUnitCost: '100.0000', warehouseId: 'wh-1', itemId: 'item-fifo', postedQty: 0, grnStatus: 'posted', grnSupplierId: 'sup-1' }],
      ])),
      markPosted: vi.fn(async (_c: string, _id: string, no: string, jeId: string) => {
        invoiceObj.status = 'posted';
        invoiceObj.invoiceNo = no;
        invoiceObj.journalEntryId = jeId;
      }),
    };
    const journalRepo: any = { allocateSequenceNumber: vi.fn(async () => 'PINV-001') };
    const configService: any = {
      resolveConfig: vi.fn(async (_c: string, key: string) => ({
        key,
        definitionId: 'def-1',
        source: 'company_published',
        versionNo: 1,
        content: {
          inventory_account_id: 'acct-inv',
          purchases_clearing_account_id: 'acct-clr',
          accounts_payable_account_id: 'acct-ap',
        },
      })),
    };
    const threeWayMatchService: any = { evaluateInvoice: vi.fn(async () => ({ overallStatus: 'matched' })) };

    const invoiceService = new InvoiceService(
      invoiceRepo,
      { findById: vi.fn() } as any,
      h.settingsRepo,
      journalRepo,
      undefined,
      h.auditService,
      configService,
      h.accountRepo,
      threeWayMatchService,
      h.valuationService
    );

    const postedInv = await invoiceService.postInvoice('comp-1', 'sinv-1', 'u1');
    expect(postedInv.status).toBe('posted');

    const ppvJe = postedJournals.find((j) => j.id === postedInv.journalEntryId)!;
    expect(ppvJe.lines.find((l) => l.accountId === 'acct-clr')?.debit).toBe(10000);
    expect(ppvJe.lines.find((l) => l.accountId === 'acct-inv')?.debit).toBe(180);
    expect(ppvJe.lines.find((l) => l.accountId === 'acct-cogs')?.debit).toBe(120);
    expect(ppvJe.lines.find((l) => l.accountId === 'acct-ap')?.credit).toBe(10300);

    // Reconciliation check: subledger 6180 === GL inventory (10000 - 4000 + 180 = 6180)
    const recClean = await h.valuationService.runReconciliation('comp-1', {}, 'u1');
    expect(recClean.status).toBe('reconciled');
    expect(recClean.variance).toBe(0);

    // Purchase return of 10 units via PurchReturnService must override client unitCost=100 with authoritative 103
    const prObj: any = {
      id: 'pr-1',
      supplierId: 'sup-1',
      supplierNameAr: 'المورد أ',
      warehouseId: 'wh-1',
      grnId: 'grn-1',
      invoiceId: 'sinv-1',
      returnDate: '2026-01-04',
      reason: 'عيب تصنيع',
      status: 'draft',
      lines: [{ id: 'prl-1', grnLineId: 'grnl-1', itemId: 'item-fifo', qty: 10, unitCost: 100 }],
    };
    h.returnHeaders.set('pr-1', prObj);
    const returnRepo: any = {
      findByIdForUpdate: vi.fn(async () => prObj),
      findById: vi.fn(async () => prObj),
      markPosted: vi.fn(async (_c: string, _id: string, no: string, jeId: string) => {
        prObj.status = 'posted';
        prObj.returnNo = no;
        prObj.journalEntryId = jeId;
      }),
    };
    const purchReturnService = new PurchReturnService(
      returnRepo,
      { findById: vi.fn() } as any,
      h.settingsRepo,
      { allocateSequenceNumber: vi.fn(async () => 'PRTN-001') } as any,
      undefined,
      h.auditService,
      configService,
      h.accountRepo,
      h.stockRepo,
      h.valuationService
    );

    const postedRet = await purchReturnService.postReturn('comp-1', 'pr-1', 'u1');
    expect(postedRet.status).toBe('posted');
    expect(postedRet.lines?.[0]?.unitCost).toBe(103); // Overwritten from 100 -> 103
    const prJe = postedJournals.find((j) => j.id === postedRet.journalEntryId)!;
    expect(prJe.lines.find((l) => l.accountId === 'acct-ap')?.debit).toBe(1030);
    expect(prJe.lines.find((l) => l.accountId === 'acct-inv')?.credit).toBe(1030);
  });

  it('16 & 17. Opening Valuation approval syncs with GL & Reconciliation detects unposted/unmatched discrepancies', async () => {
    const h = buildStatefulErpHarness();

    // Pre-existing physical stock of 50 units without valuation
    await h.stockRepo.incrementBalance('comp-1', 'wh-1', 'item-ma', 50);

    // Creating with mismatched qty 40 fails upon approve
    const badOpening = await h.valuationService.createOpeningValuation(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', quantity: 40, unitCost: 20, reason: 'جرد افتتاحي خطأ' },
      'u1'
    );
    await expect(
      h.valuationService.approveOpeningValuation('comp-1', badOpening.id, 'admin-1', false)
    ).rejects.toThrow(/لا تطابق الكمية الفعلية/);

    // Reject the bad opening
    const rejected = await h.valuationService.rejectOpeningValuation('comp-1', badOpening.id, 'كمية غير مطابقة للجرد', 'admin-1');
    expect(rejected.status).toBe('rejected');

    // Create matching opening 50 @ 20 = 1000 and approve
    const goodOpening = await h.valuationService.createOpeningValuation(
      'comp-1',
      { warehouseId: 'wh-1', itemId: 'item-ma', quantity: 50, unitCost: 20, reason: 'رصيد أول المدة المعتمد' },
      'u1'
    );
    const approved = await h.valuationService.approveOpeningValuation('comp-1', goodOpening.id, 'admin-1', false);
    expect(approved.status).toBe('approved');
    expect(approved.journalEntryId).toBeTruthy();
    expect(h.valBalances.get('comp-1::wh-1::item-ma')?.totalCost).toBe(1000);

    // Reconciliation passes cleanly (1000 === 1000)
    const recOk = await h.valuationService.runReconciliation('comp-1', {}, 'admin-1');
    expect(recOk.status).toBe('reconciled');

    // Introduce unexplained GL entry -> reconciliation flags discrepancy without creating balancing JE
    const countBefore = postedJournals.length;
    postedJournals.push({
      id: 'je-rogue',
      entryDate: '2026-01-10',
      memo: 'Direct manual JE',
      lines: [{ accountId: 'acct-inv', debit: 500, credit: 0 }, { accountId: 'acct-adj', debit: 0, credit: 500 }],
    });
    const recDiff = await h.valuationService.runReconciliation('comp-1', {}, 'admin-1');
    expect(recDiff.status).toBe('discrepancy_detected');
    expect(recDiff.variance).toBe(-500);
    expect(postedJournals.length).toBe(countBefore + 1); // Never auto-posts balancing journal
  });

  it('19. RBAC enforces granular separation between company_admin and company_user', () => {
    const adminPerms = new Set(ROLE_PERMISSIONS.company_admin);
    const userPerms = new Set(ROLE_PERMISSIONS.company_user);

    const sensitive = [
      PERMISSIONS.INVENTORY_COSTING_PROFILE_WRITE,
      PERMISSIONS.INVENTORY_COSTING_ASSIGN,
      PERMISSIONS.INVENTORY_OPENING_APPROVE,
      PERMISSIONS.INVENTORY_VALUATION_ADJUST,
      PERMISSIONS.INVENTORY_VALUATION_RECONCILE,
    ];

    for (const perm of sensitive) {
      expect(adminPerms.has(perm)).toBe(true);
      expect(userPerms.has(perm)).toBe(false);
    }
  });
});
