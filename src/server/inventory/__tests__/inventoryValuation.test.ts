import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InventoryValuationService } from '../inventoryValuationService.js';

describe('InventoryValuationService Unit Tests', () => {
  let valuationService: InventoryValuationService;
  let mockValuationRepo: any;
  let mockWarehouseRepo: any;
  let mockItemRepo: any;
  let mockAuditService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockValuationRepo = {
      listProfiles: vi.fn().mockResolvedValue([]),
      findProfileById: vi.fn().mockResolvedValue({ id: 'prof-1', name: 'FIFO Profile', costingMethod: 'FIFO', isActive: true }),
      getItemAssignment: vi.fn().mockResolvedValue({ costingMethod: 'FIFO' }),
      assignItemProfile: vi.fn().mockResolvedValue({ itemId: 'item-1', profileId: 'prof-1', costingMethod: 'FIFO' }),
      getValuationBalance: vi.fn().mockResolvedValue({ quantity: 100, totalCost: 1000, unitCost: 10 }),
      lockValuationBalanceForUpdate: vi.fn().mockResolvedValue({ quantity: 100, totalCost: 1000, unitCost: 10 }),
      updateValuationBalance: vi.fn().mockResolvedValue({ quantity: 120, totalCost: 1300, unitCost: 10.8333 }),
      createCostLayer: vi.fn().mockResolvedValue({ id: 'layer-1' }),
      listActiveCostLayersForUpdate: vi.fn().mockResolvedValue([
        { id: 'layer-1', remainingQty: 50, unitCost: 10, totalCost: 500, effectiveDate: new Date().toISOString() },
        { id: 'layer-2', remainingQty: 50, unitCost: 12, totalCost: 600, effectiveDate: new Date().toISOString() },
      ]),
      updateCostLayerRemaining: vi.fn().mockResolvedValue(undefined),
      createValuationMovement: vi.fn().mockResolvedValue({ id: 'mov-1' }),
      createCostAllocation: vi.fn().mockResolvedValue(undefined),
    };

    mockWarehouseRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'wh-1', isActive: true }),
    };

    mockItemRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'item-1', code: 'ITM-1', nameAr: 'صنف تجريبي', isActive: true, uom: 'وحدة' }),
    };

    mockAuditService = {
      record: vi.fn().mockResolvedValue(undefined),
    };

    valuationService = new InventoryValuationService(
      mockValuationRepo,
      mockWarehouseRepo,
      mockItemRepo,
      mockAuditService
    );
  });

  it('validates receipt calculation and layer creation', async () => {
    const result = await valuationService.processReceipt(
      'comp-1',
      {
        warehouseId: 'wh-1',
        itemId: 'item-1',
        qty: 20,
        unitCost: 15,
        sourceType: 'GRN',
        sourceId: 'grn-1',
      },
      'user-1',
      { query: vi.fn().mockResolvedValue({ rows: [] }), withTransaction: vi.fn() } as any
    );

    expect(result.balance).toBeDefined();
    expect(mockValuationRepo.createCostLayer).toHaveBeenCalledWith(
      'comp-1',
      expect.objectContaining({ originalQty: 20, unitCost: 15, totalCost: 300 }),
      expect.any(Object)
    );
  });

  it('blocks negative stock and insufficient quantity on issue', async () => {
    mockValuationRepo.lockValuationBalanceForUpdate.mockResolvedValueOnce({ quantity: 10, totalCost: 100, unitCost: 10 });

    await expect(
      valuationService.processIssue(
        'comp-1',
        {
          warehouseId: 'wh-1',
          itemId: 'item-1',
          qty: 25,
          sourceType: 'SALES_DELIVERY',
          sourceId: 'del-1',
        },
        'user-1',
        { query: vi.fn().mockResolvedValue({ rows: [] }), withTransaction: vi.fn() } as any
      )
    ).rejects.toThrow(/رصيد مخزني غير كافٍ/);
  });
});
