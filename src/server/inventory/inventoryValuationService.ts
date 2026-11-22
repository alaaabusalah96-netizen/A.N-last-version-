import { DbExecutor } from '../db/types.js';
import { defaultInventoryValuationRepository, InventoryValuationRepository } from './inventoryValuationRepository.js';
import { defaultWarehouseRepository, WarehouseRepository } from './warehouseRepository.js';
import { defaultItemRepository, ItemRepository } from './itemRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { defaultStockRepository, StockRepository } from './stockRepository.js';
import { defaultCompanySettingsRepository, CompanySettingsRepository } from '../org/companySettingsRepository.js';
import { defaultAccountRepository, AccountRepository } from '../accounting/accountRepository.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import {
  CostingProfile,
  CostingMethod,
  ItemCostingAssignment,
  ValuationBalance,
  CostLayer,
  ValuationMovement,
  CostAllocationRecord,
  CostAdjustmentRecord,
  OpeningValuationInput,
  OpeningValuationRecord,
  ValuationSetupStatusSummary,
  ValuationSetupStatusItem,
  ValuationReconciliationInput,
  ValuationReconciliationRecord,
  StockSyncMode,
  MaSourceEventType,
} from './inventoryValuationTypes.js';
import {
  QTY_SCALE,
  COST_SCALE,
  MONEY_SCALE,
  parseExactUnits,
  fromMinorUnits,
  mulExactUnits,
  divExactUnits,
  rescaleUnits,
  allocateProportionalUnits,
  unitsToSafeNumber,
} from '../lib/numeric.js';
import { resolveCompanyToday } from '../lib/calendarDate.js';

export interface AllocatedLayerSlice {
  layerId: string | null;
  qty: number;
  unitCost: number;
  cost: number;
  sourceType?: string;
  sourceId?: string;
  sourceLineId?: string | null;
  originLayerId?: string | null;
  originSourceType?: string | null;
  originSourceId?: string | null;
  originSourceLineId?: string | null;
  effectiveDate?: string | null;
}

export interface AllocatedMaSourceSlice {
  sourceBalanceId: string;
  qty: number;
  cost: number;
  originSourceType: string;
  originSourceId: string;
  originSourceLineId?: string | null;
  grnId?: string | null;
  grnLineId?: string | null;
}

export interface ProcessReceiptInput {
  warehouseId: string;
  itemId: string;
  qty: number | string;
  unitCost?: number | string;
  totalCost?: number | string;
  sourceType: string;
  sourceId: string;
  sourceLineId?: string | null;
  journalEntryId?: string | null;
  movementType?: 'RECEIVE' | 'TRANSFER_IN' | 'OPENING' | 'RETURN' | 'ADJUSTMENT';
  reason?: string | null;
  costSource?: string | null;
  referenceMovementId?: string | null;
  effectiveDate?: string | null;
  notes?: string | null;
  stockSyncMode?: StockSyncMode;
  expectedPreStockQty?: number | string;
  expectedPostStockQty?: number | string;
  originLayerId?: string | null;
  originSourceType?: string | null;
  originSourceId?: string | null;
  originSourceLineId?: string | null;
}

export interface ProcessIssueInput {
  warehouseId: string;
  itemId: string;
  qty: number | string;
  sourceType: string;
  sourceId: string;
  sourceLineId?: string | null;
  journalEntryId?: string | null;
  movementType?: 'ISSUE' | 'TRANSFER_OUT' | 'ADJUSTMENT' | 'RETURN';
  reason?: string | null;
  costSource?: string | null;
  notes?: string | null;
  stockSyncMode?: StockSyncMode;
  expectedPreStockQty?: number | string;
}

export interface PurchasePriceVarianceInput {
  grnId: string;
  grnLineId: string;
  invoiceId: string;
  invoiceLineId: string;
  warehouseId: string;
  itemId: string;
  invoicedQty: number | string;
  grnUnitCost: number | string;
  invoiceUnitCost: number | string;
  reason?: string | null;
  journalEntryId?: string | null;
  approvedBy?: string | null;
  createdBy?: string | null;
}

export interface PurchasePriceVarianceResult {
  costingMethod: CostingMethod;
  qtyBasis: number;
  grnTotalUnits: bigint;
  invoiceTotalUnits: bigint;
  totalVarianceUnits: bigint;
  remainingAllocationUnits: bigint;
  consumedAllocationUnits: bigint;
  grnMoneyUnits: bigint;
  invoiceMoneyUnits: bigint;
  totalVarianceMoneyUnits: bigint;
  remainingMoneyUnits: bigint;
  consumedMoneyUnits: bigint;
  adjustments: CostAdjustmentRecord[];
}

export interface PurchaseReturnValuationInput {
  grnId: string;
  grnLineId: string;
  grnQty: number | string;
  grnUnitCost: number | string;
  warehouseId: string;
  itemId: string;
  returnId: string;
  returnLineId: string;
  qty: number | string;
  reason?: string | null;
  journalEntryId?: string | null;
  stockSyncMode?: StockSyncMode;
  expectedPreStockQty?: number | string;
}

export interface SalesReturnValuationInput {
  warehouseId: string;
  itemId: string;
  qty: number | string;
  returnId: string;
  returnLineId: string;
  deliveryLineId?: string | null;
  deliveryValuationMovementId?: string | null;
  deliveryQty: number | string;
  deliveryFrozenTotalCost: number | string;
  journalEntryId?: string | null;
  reason?: string | null;
  stockSyncMode?: StockSyncMode;
  expectedPreStockQty?: number | string;
  expectedPostStockQty?: number | string;
}

export class InventoryValuationService {
  constructor(
    private valuationRepo: InventoryValuationRepository = defaultInventoryValuationRepository,
    private warehouseRepo: WarehouseRepository = defaultWarehouseRepository,
    private itemRepo: ItemRepository = defaultItemRepository,
    private auditService: AuditService = defaultAuditService,
    private stockRepo: StockRepository = defaultStockRepository,
    private companySettingsRepo: CompanySettingsRepository = defaultCompanySettingsRepository,
    private accountRepo: AccountRepository = defaultAccountRepository
  ) {}

  private async getJournalService() {
    const mod = await import('../accounting/journalService.js');
    return mod.defaultJournalService;
  }

  async listProfiles(companyId: string): Promise<CostingProfile[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.valuationRepo.listProfiles(companyId);
  }

  async createProfile(
    companyId: string,
    input: { name: string; costingMethod: CostingMethod; isDefault?: boolean },
    userId?: string
  ): Promise<CostingProfile> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!input.name?.trim() || !input.costingMethod) {
      throw new ValidationError('اسم ملف التكلفة وطريقة التكلفة مطلوبان');
    }
    if (!['FIFO', 'PERPETUAL_MOVING_AVERAGE'].includes(input.costingMethod)) {
      throw new ValidationError('طريقة التكلفة غير صالحة. الطرق المدعومة هي FIFO أو PERPETUAL_MOVING_AVERAGE');
    }
    return await withTenantTransaction(companyId, async (tx) => {
      const profile = await this.valuationRepo.createProfile(
        companyId,
        {
          name: input.name.trim(),
          costingMethod: input.costingMethod,
          isDefault: Boolean(input.isDefault),
        },
        tx
      );
      await this.auditService.record(
        {
          actorUserId: userId || null,
          companyId,
          action: 'CREATE_COSTING_PROFILE',
          entityType: 'inv_costing_profile',
          entityId: profile.id,
          metadata: { name: profile.name, method: profile.costingMethod },
        },
        { executor: tx }
      );
      return profile;
    });
  }

  async listItemAssignments(companyId: string): Promise<ItemCostingAssignment[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.valuationRepo.listItemAssignments(companyId);
  }

  async listUnassignedItems(
    companyId: string
  ): Promise<Array<{ itemId: string; itemCode: string; itemNameAr: string; hasStock: boolean }>> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.valuationRepo.listUnassignedItems(companyId);
  }

  async getItemAssignment(companyId: string, itemId: string): Promise<ItemCostingAssignment | null> {
    if (!companyId || !itemId) throw new ValidationError('companyId and itemId are required');
    return await this.valuationRepo.getItemAssignment(companyId, itemId);
  }

  async assignItemProfile(
    companyId: string,
    itemId: string,
    profileId: string,
    userId?: string
  ): Promise<ItemCostingAssignment> {
    if (!companyId || !itemId || !profileId) throw new ValidationError('البيانات غير مكتملة');
    return await withTenantTransaction(companyId, async (tx) => {
      const profile = await this.valuationRepo.findProfileById(companyId, profileId, tx);
      if (!profile) throw new NotFoundError('ملف التكلفة المحدد غير موجود');
      if (!profile.isActive) throw new ValidationError('ملف التكلفة المحدد غير نشط');

      const item = await this.itemRepo.findById(companyId, itemId, tx);
      if (!item) throw new NotFoundError('الصنف المحدد غير موجود');
      if (item.isActive === false) throw new ValidationError('الصنف المحدد غير نشط');

      const existing = await this.valuationRepo.getItemAssignment(companyId, itemId, tx);
      if (existing && existing.costingMethod && existing.costingMethod !== profile.costingMethod) {
        const hasMovements = await this.valuationRepo.hasFinancialMovementsForItem(companyId, itemId, tx);
        if (hasMovements) {
          throw new ValidationError(
            `COSTING_METHOD_LOCKED: لا يمكن تغيير طريقة تقييم المخزون للصنف (${item.code}) من (${existing.costingMethod}) إلى (${profile.costingMethod}) بعد وجود حركات أو أرصدة تقييم مالية مسجلة.`
          );
        }
      }

      const assignment = await this.valuationRepo.assignItemProfile(companyId, itemId, profileId, userId, tx);
      await this.auditService.record(
        {
          actorUserId: userId || null,
          companyId,
          action: 'ASSIGN_ITEM_COSTING_PROFILE',
          entityType: 'inv_item_costing_profile',
          entityId: itemId,
          metadata: { itemId, profileId, method: profile.costingMethod },
        },
        { executor: tx }
      );
      return assignment;
    });
  }

  async getWarehouseValuationBalances(companyId: string): Promise<ValuationBalance[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.valuationRepo.listValuationBalances(companyId);
  }

  async listCostLayers(
    companyId: string,
    filters?: { warehouseId?: string; itemId?: string; includeExhausted?: boolean }
  ): Promise<CostLayer[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.valuationRepo.listCostLayers(companyId, filters);
  }

  async listValuationMovements(
    companyId: string,
    filters?: { warehouseId?: string; itemId?: string; limit?: number }
  ): Promise<ValuationMovement[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.valuationRepo.listValuationMovements(companyId, filters);
  }

  async listAllocationsForMovement(companyId: string, valuationMovementId: string): Promise<CostAllocationRecord[]> {
    if (!companyId || !valuationMovementId) throw new ValidationError('companyId and valuationMovementId are required');
    return await this.valuationRepo.listAllocationsForMovement(companyId, valuationMovementId);
  }

  async listCostAdjustments(companyId: string): Promise<CostAdjustmentRecord[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.valuationRepo.listCostAdjustments(companyId);
  }

  async linkValuationMovementJournal(
    companyId: string,
    valuationMovementId: string,
    journalEntryId: string,
    executor: DbExecutor
  ): Promise<void> {
    await this.valuationRepo.linkValuationMovementJournal(companyId, valuationMovementId, journalEntryId, executor);
  }

  async linkCostAdjustmentsJournal(
    companyId: string,
    adjustmentIds: string[],
    journalEntryId: string,
    executor: DbExecutor
  ): Promise<void> {
    await this.valuationRepo.linkCostAdjustmentsJournal(companyId, adjustmentIds, journalEntryId, executor);
  }

  async getItemCostingMethod(
    companyId: string,
    itemId: string,
    client?: DbExecutor
  ): Promise<{ method: CostingMethod; profileId: string }> {
    const assignment = await this.valuationRepo.getItemAssignment(companyId, itemId, client);
    if (!assignment || !assignment.profileId || !assignment.costingMethod) {
      throw new ValidationError(
        `COSTING_PROFILE_REQUIRED: الصنف غير مرتبط بملف تكلفة معتمد. يجب تعيين ملف تكلفة (FIFO أو PERPETUAL_MOVING_AVERAGE) للصنف قبل إجراء أي حركات مالية.`
      );
    }
    return { method: assignment.costingMethod, profileId: assignment.profileId };
  }

  /**
   * Process stock receipt (GRN, opening balance, manual receive, return, transfer in).
   * Strict BigInt fixed-point arithmetic; creates FIFO layers ONLY when method === 'FIFO'.
   */
  async processReceipt(
    companyId: string,
    input: ProcessReceiptInput,
    userId?: string,
    tx?: DbExecutor
  ): Promise<{ balance: ValuationBalance; movement: ValuationMovement; layer?: CostLayer | null }> {
    const qtyUnits = parseExactUnits(input.qty, QTY_SCALE, 'qty');
    if (qtyUnits <= 0n) {
      throw new ValidationError('كمية الاستلام يجب أن تكون أكبر من الصفر');
    }

    let totalCostUnits: bigint;
    let unitCostUnits: bigint;
    if (input.totalCost !== undefined && input.totalCost !== null) {
      totalCostUnits = parseExactUnits(input.totalCost, COST_SCALE, 'totalCost');
      if (totalCostUnits < 0n) {
        throw new ValidationError('التكلفة الإجمالية لا يمكن أن تكون سالبة');
      }
      unitCostUnits =
        input.unitCost !== undefined && input.unitCost !== null
          ? parseExactUnits(input.unitCost, COST_SCALE, 'unitCost')
          : divExactUnits(totalCostUnits, COST_SCALE, qtyUnits, QTY_SCALE, COST_SCALE);
    } else if (input.unitCost !== undefined && input.unitCost !== null) {
      unitCostUnits = parseExactUnits(input.unitCost, COST_SCALE, 'unitCost');
      if (unitCostUnits < 0n) {
        throw new ValidationError('تكلفة الوحدة لا يمكن أن تكون سالبة');
      }
      totalCostUnits = mulExactUnits(qtyUnits, QTY_SCALE, unitCostUnits, COST_SCALE, COST_SCALE);
    } else {
      throw new ValidationError('يجب تحديد تكلفة الوحدة أو التكلفة الإجمالية للاستلام');
    }

    if (unitCostUnits < 0n) {
      throw new ValidationError('تكلفة الوحدة لا يمكن أن تكون سالبة');
    }

    const movementType = input.movementType || 'RECEIVE';
    if (
      (movementType === 'OPENING' ||
        movementType === 'ADJUSTMENT' ||
        input.sourceType === 'MANUAL_RECEIPT' ||
        input.sourceType === 'STOCK_ADJUSTMENT') &&
      totalCostUnits <= 0n
    ) {
      throw new ValidationError('لا يُسمح بإنشاء مخزون مالي بتكلفة صفرية في الاستلام اليدوي أو التسوية أو الرصيد الافتتاحي');
    }

    const stockSyncMode: StockSyncMode = input.stockSyncMode || 'internal';

    const execute = async (client: DbExecutor) => {
      // Idempotency guard before mutating state
      const existingMov = await this.valuationRepo.findValuationMovementByIdempotency(
        companyId,
        input.warehouseId,
        input.itemId,
        movementType,
        input.sourceType,
        input.sourceId,
        input.sourceLineId ?? null,
        client
      );
      if (existingMov) {
        throw new ValidationError(
          `IDEMPOTENT_DUPLICATE: تم تسجيل حركة تقييم (${movementType}) مسبقاً للمصدر (${input.sourceType}:${input.sourceId}).`
        );
      }

      const currentBalance = await this.valuationRepo.lockValuationBalanceForUpdate(
        companyId,
        input.warehouseId,
        input.itemId,
        client
      );
      const prevQtyUnits = currentBalance ? parseExactUnits(currentBalance.quantity, QTY_SCALE, 'prevQty') : 0n;
      const prevTotalUnits = currentBalance ? parseExactUnits(currentBalance.totalCost, COST_SCALE, 'prevTotalCost') : 0n;

      const { method } = await this.getItemCostingMethod(companyId, input.itemId, client);

      const newQtyUnits = prevQtyUnits + qtyUnits;
      const newTotalUnits = prevTotalUnits + totalCostUnits;
      const newUnitCostUnits =
        newQtyUnits > 0n ? divExactUnits(newTotalUnits, COST_SCALE, newQtyUnits, QTY_SCALE, COST_SCALE) : 0n;

      // Sync or verify stock balance parity inside the same transaction
      if (stockSyncMode === 'internal') {
        const preStock = await this.stockRepo.getBalanceForUpdate(companyId, input.warehouseId, input.itemId, client);
        const preStockUnits = preStock ? parseExactUnits(preStock.qty, QTY_SCALE, 'stockQty') : 0n;
        if (movementType !== 'OPENING' && preStockUnits !== prevQtyUnits) {
          throw new ValidationError(
            `VALUATION_INTEGRITY_ERROR: يوجد اختلاف بين الرصيد الكمي بالمخزون (${fromMinorUnits(preStockUnits, QTY_SCALE)}) ورصيد التقييم (${fromMinorUnits(prevQtyUnits, QTY_SCALE)}). يجب اعتماد الرصيد الافتتاحي المقيّم أو تسوية التطابق أولاً.`
          );
        }
        await this.stockRepo.incrementBalance(
          companyId,
          input.warehouseId,
          input.itemId,
          unitsToSafeNumber(qtyUnits, QTY_SCALE),
          client
        );
      } else {
        if (input.expectedPreStockQty !== undefined) {
          const preUnits = parseExactUnits(input.expectedPreStockQty, QTY_SCALE, 'expectedPreStockQty');
          if (preUnits !== prevQtyUnits) {
            throw new ValidationError(
              `VALUATION_INTEGRITY_ERROR: رصيد المخزون قبل الاستلام (${fromMinorUnits(preUnits, QTY_SCALE)}) لا يطابق رصيد التقييم (${fromMinorUnits(prevQtyUnits, QTY_SCALE)}).`
            );
          }
        }
        if (input.expectedPostStockQty !== undefined) {
          const postUnits = parseExactUnits(input.expectedPostStockQty, QTY_SCALE, 'expectedPostStockQty');
          if (postUnits !== newQtyUnits) {
            throw new ValidationError(
              `VALUATION_INTEGRITY_ERROR: رصيد المخزون بعد الاستلام (${fromMinorUnits(postUnits, QTY_SCALE)}) لا يطابق رصيد التقييم (${fromMinorUnits(newQtyUnits, QTY_SCALE)}).`
            );
          }
        }
      }

      let createdLayer: CostLayer | null = null;
      if (method === 'FIFO') {
        createdLayer = await this.valuationRepo.createCostLayer(
          companyId,
          {
            warehouseId: input.warehouseId,
            itemId: input.itemId,
            originalQty: fromMinorUnits(qtyUnits, QTY_SCALE),
            unitCost: fromMinorUnits(unitCostUnits, COST_SCALE),
            totalCost: fromMinorUnits(totalCostUnits, COST_SCALE),
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            sourceLineId: input.sourceLineId ?? null,
            originLayerId: input.originLayerId ?? null,
            originSourceType: input.originSourceType ?? input.sourceType,
            originSourceId: input.originSourceId ?? input.sourceId,
            originSourceLineId: input.originSourceLineId ?? input.sourceLineId ?? null,
            effectiveDate: input.effectiveDate ?? null,
          },
          client
        );
      }

      const balance = await this.valuationRepo.setValuationBalanceExact(
        companyId,
        input.warehouseId,
        input.itemId,
        fromMinorUnits(newQtyUnits, QTY_SCALE),
        fromMinorUnits(newTotalUnits, COST_SCALE),
        fromMinorUnits(newUnitCostUnits, COST_SCALE),
        client
      );

      const movement = await this.valuationRepo.createValuationMovement(
        companyId,
        {
          warehouseId: input.warehouseId,
          itemId: input.itemId,
          movementType,
          qty: fromMinorUnits(qtyUnits, QTY_SCALE),
          unitCost: fromMinorUnits(unitCostUnits, COST_SCALE),
          totalCost: fromMinorUnits(totalCostUnits, COST_SCALE),
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          sourceLineId: input.sourceLineId ?? null,
          journalEntryId: input.journalEntryId ?? null,
          reason: input.reason ?? null,
          costSource: input.costSource ?? null,
          costingMethod: method,
          referenceMovementId: input.referenceMovementId ?? null,
          notes: input.notes ?? null,
          createdBy: userId ?? null,
        },
        client
      );

      if (method === 'PERPETUAL_MOVING_AVERAGE') {
        const originSourceType = input.originSourceType ?? input.sourceType;
        const originSourceId = input.originSourceId ?? input.sourceId;
        const originSourceLineId = input.originSourceLineId ?? input.sourceLineId ?? null;
        const grnId = originSourceType === 'GRN' ? originSourceId : null;
        const grnLineId = originSourceType === 'GRN' ? originSourceLineId : null;
        const qtyStr = fromMinorUnits(qtyUnits, QTY_SCALE);
        const totalCostStr = fromMinorUnits(totalCostUnits, COST_SCALE);
        const maEventType: MaSourceEventType =
          movementType === 'OPENING'
            ? 'OPENING'
            : movementType === 'TRANSFER_IN'
              ? 'TRANSFER_IN'
              : 'RECEIPT';

        await this.valuationRepo.upsertMaSourceBalance(
          companyId,
          {
            warehouseId: input.warehouseId,
            itemId: input.itemId,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            sourceLineId: input.sourceLineId ?? null,
            originSourceType,
            originSourceId,
            originSourceLineId,
            grnId,
            grnLineId,
            receivedQty: qtyStr,
            remainingQty: qtyStr,
            consumedQty: '0.0000',
            originalValue: totalCostStr,
            remainingValue: totalCostStr,
            consumedValue: '0.0000',
          },
          client
        );

        await this.valuationRepo.createMaSourceEvent(
          companyId,
          {
            warehouseId: input.warehouseId,
            itemId: input.itemId,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            sourceLineId: input.sourceLineId ?? null,
            originSourceType,
            originSourceId,
            originSourceLineId,
            grnId,
            grnLineId,
            eventType: maEventType,
            quantity: qtyStr,
            valueDelta: totalCostStr,
            referenceMovementId: movement.id,
          },
          client
        );
      }

      return { balance, movement, layer: createdLayer };
    };

    if (tx) {
      return await execute(tx);
    }
    return await withTenantTransaction(companyId, execute);
  }

  /**
   * Process stock issue with strict no-negative protection, exact BigInt decimal math,
   * strict FIFO layer reconciliation (ZERO fallback), and exact Moving Average pool depletion.
   */
  async processIssue(
    companyId: string,
    input: ProcessIssueInput,
    userId?: string,
    tx?: DbExecutor
  ): Promise<{
    balance: ValuationBalance;
    movement: ValuationMovement;
    unitCost: number;
    totalCost: number;
    allocatedLayers: AllocatedLayerSlice[];
    allocatedMaSources?: AllocatedMaSourceSlice[];
  }> {
    const qtyUnits = parseExactUnits(input.qty, QTY_SCALE, 'qty');
    if (qtyUnits <= 0n) {
      throw new ValidationError('كمية الصرف يجب أن تكون أكبر من الصفر');
    }
    const movementType = input.movementType || 'ISSUE';
    const stockSyncMode: StockSyncMode = input.stockSyncMode || 'internal';

    const execute = async (client: DbExecutor) => {
      // Idempotency check
      const existingMov = await this.valuationRepo.findValuationMovementByIdempotency(
        companyId,
        input.warehouseId,
        input.itemId,
        movementType,
        input.sourceType,
        input.sourceId,
        input.sourceLineId ?? null,
        client
      );
      if (existingMov) {
        throw new ValidationError(
          `IDEMPOTENT_DUPLICATE: تم تسجيل حركة صرف التقييم (${movementType}) مسبقاً للمصدر (${input.sourceType}:${input.sourceId}).`
        );
      }

      const currentBalance = await this.valuationRepo.lockValuationBalanceForUpdate(
        companyId,
        input.warehouseId,
        input.itemId,
        client
      );
      const prevQtyUnits = currentBalance ? parseExactUnits(currentBalance.quantity, QTY_SCALE, 'prevQty') : 0n;
      const prevTotalUnits = currentBalance ? parseExactUnits(currentBalance.totalCost, COST_SCALE, 'prevTotalCost') : 0n;

      if (prevQtyUnits < qtyUnits) {
        const item = await this.itemRepo.findById(companyId, input.itemId, client);
        throw new ValidationError(
          `رصيد مخزني غير كافٍ للصنف (${item?.code || input.itemId}). المتاح: ${fromMinorUnits(prevQtyUnits, QTY_SCALE)}، المطلوب للصرف: ${fromMinorUnits(qtyUnits, QTY_SCALE)}. لا يمكن السماح برصيد بالسالب.`
        );
      }

      if (stockSyncMode === 'internal') {
        const stockBal = await this.stockRepo.getBalanceForUpdate(companyId, input.warehouseId, input.itemId, client);
        const stockQtyUnits = stockBal ? parseExactUnits(stockBal.qty, QTY_SCALE, 'stockQty') : 0n;
        if (stockQtyUnits !== prevQtyUnits) {
          throw new ValidationError(
            `VALUATION_INTEGRITY_ERROR: عدم تطابق الرصيد الكمي بالمستودع (${fromMinorUnits(stockQtyUnits, QTY_SCALE)}) مع رصيد التقييم (${fromMinorUnits(prevQtyUnits, QTY_SCALE)}).`
          );
        }
      } else if (input.expectedPreStockQty !== undefined) {
        const preUnits = parseExactUnits(input.expectedPreStockQty, QTY_SCALE, 'expectedPreStockQty');
        if (preUnits !== prevQtyUnits) {
          throw new ValidationError(
            `VALUATION_INTEGRITY_ERROR: رصيد المخزون قبل الصرف (${fromMinorUnits(preUnits, QTY_SCALE)}) لا يطابق رصيد التقييم (${fromMinorUnits(prevQtyUnits, QTY_SCALE)}).`
          );
        }
      }

      const { method } = await this.getItemCostingMethod(companyId, input.itemId, client);

      let totalIssuedCostUnits = 0n;
      const internalAllocations: Array<{
        layerId: string | null;
        qtyUnits: bigint;
        unitCostUnits: bigint;
        costUnits: bigint;
        sourceType?: string;
        sourceId?: string;
        sourceLineId?: string | null;
        originLayerId?: string | null;
        originSourceType?: string | null;
        originSourceId?: string | null;
        originSourceLineId?: string | null;
        effectiveDate?: string | null;
      }> = [];

      if (method === 'FIFO') {
        const layers = await this.valuationRepo.listActiveCostLayersForUpdate(
          companyId,
          input.warehouseId,
          input.itemId,
          client
        );

        let totalLayerQtyUnits = 0n;
        for (const layer of layers) {
          totalLayerQtyUnits += parseExactUnits(layer.remainingQty, QTY_SCALE, 'layerRemainingQty');
        }
        if (totalLayerQtyUnits !== prevQtyUnits) {
          throw new ValidationError(
            `VALUATION_INTEGRITY_ERROR: مجموع الكميات المتبقية في طبقات FIFO (${fromMinorUnits(totalLayerQtyUnits, QTY_SCALE)}) لا يطابق رصيد التقييم (${fromMinorUnits(prevQtyUnits, QTY_SCALE)}).`
          );
        }

        let remainingToIssueUnits = qtyUnits;
        for (const layer of layers) {
          if (remainingToIssueUnits <= 0n) break;
          const layerRemUnits = parseExactUnits(layer.remainingQty, QTY_SCALE, 'layerRemainingQty');
          if (layerRemUnits <= 0n) continue;

          const layerTotalUnits = parseExactUnits(layer.totalCost, COST_SCALE, 'layerTotalCost');
          const layerUnitCostUnits = parseExactUnits(layer.unitCost, COST_SCALE, 'layerUnitCost');

          const takeQtyUnits = remainingToIssueUnits < layerRemUnits ? remainingToIssueUnits : layerRemUnits;
          let takeCostUnits: bigint;
          if (takeQtyUnits === layerRemUnits) {
            // Exact layer exhaustion: consume 100% of remaining layer value (no penny residue)
            takeCostUnits = layerTotalUnits;
          } else {
            takeCostUnits = mulExactUnits(takeQtyUnits, QTY_SCALE, layerUnitCostUnits, COST_SCALE, COST_SCALE);
            if (takeCostUnits > layerTotalUnits) takeCostUnits = layerTotalUnits;
          }

          const newLayerRemUnits = layerRemUnits - takeQtyUnits;
          const newLayerTotalUnits = layerTotalUnits - takeCostUnits;
          const isExhausted = newLayerRemUnits === 0n;

          await this.valuationRepo.updateCostLayerRemaining(
            companyId,
            layer.id,
            fromMinorUnits(newLayerRemUnits, QTY_SCALE),
            fromMinorUnits(newLayerTotalUnits, COST_SCALE),
            isExhausted,
            client
          );

          totalIssuedCostUnits += takeCostUnits;
          const allocUnitCostUnits =
            takeQtyUnits > 0n ? divExactUnits(takeCostUnits, COST_SCALE, takeQtyUnits, QTY_SCALE, COST_SCALE) : layerUnitCostUnits;

          internalAllocations.push({
            layerId: layer.id,
            qtyUnits: takeQtyUnits,
            unitCostUnits: allocUnitCostUnits,
            costUnits: takeCostUnits,
            sourceType: layer.sourceType,
            sourceId: layer.sourceId,
            sourceLineId: layer.sourceLineId ?? null,
            originLayerId: layer.originLayerId ?? null,
            originSourceType: layer.originSourceType ?? layer.sourceType,
            originSourceId: layer.originSourceId ?? layer.sourceId,
            originSourceLineId: layer.originSourceLineId ?? layer.sourceLineId ?? null,
            effectiveDate: layer.effectiveDate,
          });

          remainingToIssueUnits -= takeQtyUnits;
        }

        if (remainingToIssueUnits > 0n) {
          throw new ValidationError(
            `VALUATION_INTEGRITY_ERROR: رصيد طبقات FIFO غير كافٍ لتغطية كمية الصرف المطلوبة (المتبقي بدون تغطية طبقة: ${fromMinorUnits(remainingToIssueUnits, QTY_SCALE)}). لا يُسمح بالرجوع لمتوسط التكلفة أو التكلفة الصفرية في نظام FIFO.`
          );
        }
      } else {
        // PERPETUAL_MOVING_AVERAGE
        if (qtyUnits === prevQtyUnits) {
          // Full depletion resets residual cost completely to exact 0
          totalIssuedCostUnits = prevTotalUnits;
        } else {
          const liveAvgUnitCostUnits =
            prevQtyUnits > 0n ? divExactUnits(prevTotalUnits, COST_SCALE, prevQtyUnits, QTY_SCALE, COST_SCALE) : 0n;
          totalIssuedCostUnits = mulExactUnits(qtyUnits, QTY_SCALE, liveAvgUnitCostUnits, COST_SCALE, COST_SCALE);
          if (totalIssuedCostUnits > prevTotalUnits) {
            totalIssuedCostUnits = prevTotalUnits;
          }
        }
        const effectiveAvgUnitUnits = divExactUnits(totalIssuedCostUnits, COST_SCALE, qtyUnits, QTY_SCALE, COST_SCALE);
        internalAllocations.push({
          layerId: null,
          qtyUnits,
          unitCostUnits: effectiveAvgUnitUnits,
          costUnits: totalIssuedCostUnits,
        });
      }

      if (totalIssuedCostUnits > prevTotalUnits) {
        totalIssuedCostUnits = prevTotalUnits;
      }

      // Deterministic Moving Average source balance attribution (before movement creation so balances lock & update)
      const internalMaSlices: Array<{
        sourceBalanceId: string;
        qtyUnits: bigint;
        costUnits: bigint;
        originSourceType: string;
        originSourceId: string;
        originSourceLineId: string | null;
        grnId: string | null;
        grnLineId: string | null;
      }> = [];

      if (method === 'PERPETUAL_MOVING_AVERAGE') {
        const maBalances = await this.valuationRepo.listMaSourceBalancesForUpdate(
          companyId,
          input.warehouseId,
          input.itemId,
          client
        );

        if (maBalances.length > 0) {
          const parsedBalances = maBalances.map((b) => ({
            row: b,
            remQtyUnits: parseExactUnits(b.remainingQty, QTY_SCALE, 'maRemQty'),
            consumedQtyUnits: parseExactUnits(b.consumedQty, QTY_SCALE, 'maConsumedQty'),
            remValUnits: parseExactUnits(b.remainingValue, COST_SCALE, 'maRemVal'),
            consumedValUnits: parseExactUnits(b.consumedValue, COST_SCALE, 'maConsumedVal'),
          }));

          const maTotalRemQtyUnits = parsedBalances.reduce((s, x) => s + x.remQtyUnits, 0n);
          const maTotalRemValUnits = parsedBalances.reduce((s, x) => s + x.remValUnits, 0n);

          if (maTotalRemQtyUnits > 0n) {
            const attrQtyUnits = qtyUnits <= maTotalRemQtyUnits ? qtyUnits : maTotalRemQtyUnits;
            let attrCostUnits =
              attrQtyUnits === qtyUnits
                ? totalIssuedCostUnits
                : mulExactUnits(
                    attrQtyUnits,
                    QTY_SCALE,
                    divExactUnits(maTotalRemValUnits, COST_SCALE, maTotalRemQtyUnits, QTY_SCALE, COST_SCALE),
                    COST_SCALE,
                    COST_SCALE
                  );
            if (attrCostUnits > maTotalRemValUnits) {
              attrCostUnits = maTotalRemValUnits;
            }

            const takeQtyArr = new Array<bigint>(parsedBalances.length).fill(0n);
            const takeValArr = new Array<bigint>(parsedBalances.length).fill(0n);

            if (attrQtyUnits === maTotalRemQtyUnits) {
              for (let i = 0; i < parsedBalances.length; i++) {
                takeQtyArr[i] = parsedBalances[i].remQtyUnits;
                takeValArr[i] = parsedBalances[i].remValUnits;
              }
            } else {
              const allocatedQty = allocateProportionalUnits(
                attrQtyUnits,
                parsedBalances.map((x) => x.remQtyUnits)
              );
              for (let i = 0; i < parsedBalances.length; i++) {
                takeQtyArr[i] = allocatedQty[i];
              }

              // Safeguard: ensure active slices with takeQty > 0 have combined remainingValue >= attrCostUnits
              let sumActiveRemVal = parsedBalances.reduce(
                (s, x, idx) => s + (takeQtyArr[idx] > 0n ? x.remValUnits : 0n),
                0n
              );
              while (sumActiveRemVal < attrCostUnits) {
                const candidateZeroIdx = parsedBalances
                  .map((x, idx) => ({ idx, remVal: x.remValUnits }))
                  .filter((c) => takeQtyArr[c.idx] === 0n && parsedBalances[c.idx].remQtyUnits > 0n && c.remVal > 0n)
                  .sort((a, b) => (b.remVal > a.remVal ? 1 : b.remVal < a.remVal ? -1 : a.idx - b.idx))[0]?.idx;
                const donorIdx = parsedBalances
                  .map((_, idx) => idx)
                  .filter((idx) => takeQtyArr[idx] > 1n)
                  .sort((a, b) => (takeQtyArr[b] > takeQtyArr[a] ? 1 : takeQtyArr[b] < takeQtyArr[a] ? -1 : a - b))[0];
                if (candidateZeroIdx === undefined || donorIdx === undefined) break;
                takeQtyArr[donorIdx] -= 1n;
                takeQtyArr[candidateZeroIdx] += 1n;
                sumActiveRemVal = parsedBalances.reduce(
                  (s, x, idx) => s + (takeQtyArr[idx] > 0n ? x.remValUnits : 0n),
                  0n
                );
              }

              const activeIndices = parsedBalances
                .map((_, idx) => idx)
                .filter((idx) => takeQtyArr[idx] > 0n);

              const exhaustedActive = activeIndices.filter(
                (idx) => takeQtyArr[idx] === parsedBalances[idx].remQtyUnits
              );
              const nonExhaustedActive = activeIndices.filter(
                (idx) => takeQtyArr[idx] < parsedBalances[idx].remQtyUnits
              );

              const exhaustedValSum = exhaustedActive.reduce(
                (s, idx) => s + parsedBalances[idx].remValUnits,
                0n
              );
              const nonExhaustedValSum = nonExhaustedActive.reduce(
                (s, idx) => s + parsedBalances[idx].remValUnits,
                0n
              );

              if (
                exhaustedActive.length > 0 &&
                exhaustedValSum <= attrCostUnits &&
                (nonExhaustedActive.length === 0
                  ? exhaustedValSum === attrCostUnits
                  : attrCostUnits - exhaustedValSum <= nonExhaustedValSum)
              ) {
                for (const idx of exhaustedActive) {
                  takeValArr[idx] = parsedBalances[idx].remValUnits;
                }
                if (nonExhaustedActive.length > 0) {
                  const remCost = attrCostUnits - exhaustedValSum;
                  const allocRem = allocateProportionalUnits(
                    remCost,
                    nonExhaustedActive.map((idx) => parsedBalances[idx].remValUnits)
                  );
                  nonExhaustedActive.forEach((idx, pos) => {
                    takeValArr[idx] = allocRem[pos];
                  });
                }
              } else {
                const allocAll = allocateProportionalUnits(
                  attrCostUnits,
                  activeIndices.map((idx) => parsedBalances[idx].remValUnits)
                );
                activeIndices.forEach((idx, pos) => {
                  takeValArr[idx] = allocAll[pos];
                });
              }
            }

            for (let i = 0; i < parsedBalances.length; i++) {
              const tq = takeQtyArr[i];
              const tv = takeValArr[i];
              if (tq <= 0n && tv <= 0n) continue;

              const p = parsedBalances[i];
              const newRemQty = p.remQtyUnits - tq;
              const newConsumedQty = p.consumedQtyUnits + tq;
              const newRemVal = p.remValUnits - tv;
              const newConsumedVal = p.consumedValUnits + tv;

              await this.valuationRepo.updateMaSourceBalanceQuantities(
                companyId,
                p.row.id,
                fromMinorUnits(newRemQty, QTY_SCALE),
                fromMinorUnits(newConsumedQty, QTY_SCALE),
                client,
                fromMinorUnits(newRemVal, COST_SCALE),
                fromMinorUnits(newConsumedVal, COST_SCALE)
              );

              if (tq > 0n) {
                internalMaSlices.push({
                  sourceBalanceId: p.row.id,
                  qtyUnits: tq,
                  costUnits: tv,
                  originSourceType: p.row.originSourceType,
                  originSourceId: p.row.originSourceId,
                  originSourceLineId: p.row.originSourceLineId ?? null,
                  grnId: p.row.grnId ?? null,
                  grnLineId: p.row.grnLineId ?? null,
                });
              }
            }
          }
        }
      }

      const newQtyUnits = prevQtyUnits - qtyUnits;
      const newTotalUnits = newQtyUnits === 0n ? 0n : prevTotalUnits - totalIssuedCostUnits;
      const newUnitCostUnits =
        newQtyUnits > 0n ? divExactUnits(newTotalUnits, COST_SCALE, newQtyUnits, QTY_SCALE, COST_SCALE) : 0n;
      const effectiveIssueUnitCostUnits = divExactUnits(totalIssuedCostUnits, COST_SCALE, qtyUnits, QTY_SCALE, COST_SCALE);

      if (stockSyncMode === 'internal') {
        const decremented = await this.stockRepo.decrementBalance(
          companyId,
          input.warehouseId,
          input.itemId,
          unitsToSafeNumber(qtyUnits, QTY_SCALE),
          client
        );
        if (!decremented) {
          throw new ValidationError('فشل خصم الكمية من رصيد المستودع (الرصيد غير كافٍ)');
        }
      }

      const balance = await this.valuationRepo.setValuationBalanceExact(
        companyId,
        input.warehouseId,
        input.itemId,
        fromMinorUnits(newQtyUnits, QTY_SCALE),
        fromMinorUnits(newTotalUnits, COST_SCALE),
        fromMinorUnits(newUnitCostUnits, COST_SCALE),
        client
      );

      const movement = await this.valuationRepo.createValuationMovement(
        companyId,
        {
          warehouseId: input.warehouseId,
          itemId: input.itemId,
          movementType,
          qty: fromMinorUnits(qtyUnits, QTY_SCALE),
          unitCost: fromMinorUnits(effectiveIssueUnitCostUnits, COST_SCALE),
          totalCost: fromMinorUnits(totalIssuedCostUnits, COST_SCALE),
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          sourceLineId: input.sourceLineId ?? null,
          journalEntryId: input.journalEntryId ?? null,
          reason: input.reason ?? null,
          costSource: input.costSource ?? (method === 'FIFO' ? 'FIFO_LAYERS' : 'MOVING_AVERAGE_POOL'),
          costingMethod: method,
          notes: input.notes ?? null,
          createdBy: userId ?? null,
        },
        client
      );

      for (const alloc of internalAllocations) {
        await this.valuationRepo.createCostAllocation(
          companyId,
          {
            valuationMovementId: movement.id,
            costLayerId: alloc.layerId,
            allocatedQty: fromMinorUnits(alloc.qtyUnits, QTY_SCALE),
            unitCost: fromMinorUnits(alloc.unitCostUnits, COST_SCALE),
            allocatedCost: fromMinorUnits(alloc.costUnits, COST_SCALE),
          },
          client
        );
      }

      if (method === 'PERPETUAL_MOVING_AVERAGE' && internalMaSlices.length > 0) {
        const maEventType: MaSourceEventType =
          movementType === 'TRANSFER_OUT'
            ? 'TRANSFER_OUT'
            : movementType === 'RETURN'
              ? 'PURCHASE_RETURN'
              : 'ISSUE';

        const groupedByOrigin = new Map<
          string,
          {
            originSourceType: string;
            originSourceId: string;
            originSourceLineId: string | null;
            grnId: string | null;
            grnLineId: string | null;
            qtyUnits: bigint;
            costUnits: bigint;
          }
        >();

        for (const s of internalMaSlices) {
          const originKey = `${s.originSourceType}::${s.originSourceId}::${s.originSourceLineId ?? ''}`;
          const cur = groupedByOrigin.get(originKey);
          if (cur) {
            cur.qtyUnits += s.qtyUnits;
            cur.costUnits += s.costUnits;
          } else {
            groupedByOrigin.set(originKey, {
              originSourceType: s.originSourceType,
              originSourceId: s.originSourceId,
              originSourceLineId: s.originSourceLineId,
              grnId: s.grnId,
              grnLineId: s.grnLineId,
              qtyUnits: s.qtyUnits,
              costUnits: s.costUnits,
            });
          }
        }

        for (const g of groupedByOrigin.values()) {
          await this.valuationRepo.createMaSourceEvent(
            companyId,
            {
              warehouseId: input.warehouseId,
              itemId: input.itemId,
              sourceType: input.sourceType,
              sourceId: input.sourceId,
              sourceLineId: input.sourceLineId ?? null,
              originSourceType: g.originSourceType,
              originSourceId: g.originSourceId,
              originSourceLineId: g.originSourceLineId,
              grnId: g.grnId,
              grnLineId: g.grnLineId,
              eventType: maEventType,
              quantity: fromMinorUnits(g.qtyUnits, QTY_SCALE),
              valueDelta: fromMinorUnits(-g.costUnits, COST_SCALE),
              referenceMovementId: movement.id,
            },
            client
          );
        }
      }

      const allocatedLayers: AllocatedLayerSlice[] = internalAllocations.map((a) => ({
        layerId: a.layerId,
        qty: unitsToSafeNumber(a.qtyUnits, QTY_SCALE),
        unitCost: unitsToSafeNumber(a.unitCostUnits, COST_SCALE),
        cost: unitsToSafeNumber(a.costUnits, COST_SCALE),
        sourceType: a.sourceType,
        sourceId: a.sourceId,
        sourceLineId: a.sourceLineId ?? null,
        originLayerId: a.originLayerId ?? null,
        originSourceType: a.originSourceType ?? null,
        originSourceId: a.originSourceId ?? null,
        originSourceLineId: a.originSourceLineId ?? null,
        effectiveDate: a.effectiveDate ?? null,
      }));

      const allocatedMaSources: AllocatedMaSourceSlice[] = internalMaSlices.map((s) => ({
        sourceBalanceId: s.sourceBalanceId,
        qty: unitsToSafeNumber(s.qtyUnits, QTY_SCALE),
        cost: unitsToSafeNumber(s.costUnits, COST_SCALE),
        originSourceType: s.originSourceType,
        originSourceId: s.originSourceId,
        originSourceLineId: s.originSourceLineId,
        grnId: s.grnId,
        grnLineId: s.grnLineId,
      }));

      return {
        balance,
        movement,
        unitCost: unitsToSafeNumber(effectiveIssueUnitCostUnits, COST_SCALE),
        totalCost: unitsToSafeNumber(totalIssuedCostUnits, COST_SCALE),
        allocatedLayers,
        allocatedMaSources,
      };
    };

    if (tx) {
      return await execute(tx);
    }
    return await withTenantTransaction(companyId, execute);
  }

  /**
   * Process warehouse transfer preserving exact total value, multi-hop FIFO source layer lineage,
   * deadlock-safe warehouse lock ordering, and single TRANSFER_IN movement per transfer.
   */
  async processTransfer(
    companyId: string,
    input: {
      sourceWarehouseId: string;
      destWarehouseId: string;
      itemId: string;
      qty: number | string;
      sourceId: string;
      sourceLineId?: string | null;
      notes?: string | null;
      stockSyncMode?: StockSyncMode;
      expectedPreSourceStockQty?: number | string;
      expectedPreDestStockQty?: number | string;
    },
    userId?: string,
    tx?: DbExecutor
  ): Promise<{
    movementOut: ValuationMovement;
    movementIn: ValuationMovement;
    unitCost: number;
    totalCost: number;
    allocatedLayers: AllocatedLayerSlice[];
  }> {
    if (input.sourceWarehouseId === input.destWarehouseId) {
      throw new ValidationError('مستودع المصدر ومستودع الوجهة لا يمكن أن يكونا متطابقين');
    }
    const qtyUnits = parseExactUnits(input.qty, QTY_SCALE, 'qty');
    if (qtyUnits <= 0n) {
      throw new ValidationError('كمية التحويل يجب أن تكون أكبر من الصفر');
    }

    const stockSyncMode: StockSyncMode = input.stockSyncMode || 'internal';

    const execute = async (client: DbExecutor) => {
      const sourceWh = await this.warehouseRepo.findById(companyId, input.sourceWarehouseId, client);
      if (!sourceWh) throw new NotFoundError('مستودع المصدر المحدد غير موجود');
      if (sourceWh.isActive === false) throw new ValidationError('مستودع المصدر المحدد غير نشط');

      const destWh = await this.warehouseRepo.findById(companyId, input.destWarehouseId, client);
      if (!destWh) throw new NotFoundError('مستودع الوجهة المحدد غير موجود');
      if (destWh.isActive === false) throw new ValidationError('مستودع الوجهة المحدد غير نشط');

      const item = await this.itemRepo.findById(companyId, input.itemId, client);
      if (!item) throw new NotFoundError('الصنف المحدد غير موجود');
      if (item.isActive === false) throw new ValidationError('الصنف المحدد غير نشط');

      const { method } = await this.getItemCostingMethod(companyId, input.itemId, client);

      // Deadlock-safe deterministic lock ordering across both warehouses
      const [firstWh, secondWh] = [input.sourceWarehouseId, input.destWarehouseId].sort();
      await this.valuationRepo.lockValuationBalanceForUpdate(companyId, firstWh, input.itemId, client);
      await this.valuationRepo.lockValuationBalanceForUpdate(companyId, secondWh, input.itemId, client);

      if (stockSyncMode === 'internal') {
        await this.stockRepo.ensureBalanceRow(companyId, firstWh, input.itemId, client);
        await this.stockRepo.ensureBalanceRow(companyId, secondWh, input.itemId, client);
        await this.stockRepo.getBalanceForUpdate(companyId, firstWh, input.itemId, client);
        await this.stockRepo.getBalanceForUpdate(companyId, secondWh, input.itemId, client);
      }

      // Check destination TRANSFER_IN idempotency before mutating source
      const existingTransferIn = await this.valuationRepo.findValuationMovementByIdempotency(
        companyId,
        input.destWarehouseId,
        input.itemId,
        'TRANSFER_IN',
        'WAREHOUSE_TRANSFER',
        input.sourceId,
        input.sourceLineId ?? null,
        client
      );
      if (existingTransferIn) {
        throw new ValidationError('IDEMPOTENT_DUPLICATE: تم تسجيل حركة استلام التحويل المخزني مسبقاً');
      }

      const issueResult = await this.processIssue(
        companyId,
        {
          warehouseId: input.sourceWarehouseId,
          itemId: input.itemId,
          qty: fromMinorUnits(qtyUnits, QTY_SCALE),
          sourceType: 'WAREHOUSE_TRANSFER',
          sourceId: input.sourceId,
          sourceLineId: input.sourceLineId ?? null,
          movementType: 'TRANSFER_OUT',
          costSource: 'WAREHOUSE_TRANSFER',
          notes: input.notes ?? null,
          stockSyncMode,
          expectedPreStockQty: input.expectedPreSourceStockQty,
        },
        userId,
        client
      );

      // Re-read locked destination balance and compute exact new destination balance
      const destCurrent = await this.valuationRepo.lockValuationBalanceForUpdate(
        companyId,
        input.destWarehouseId,
        input.itemId,
        client
      );
      const destPrevQtyUnits = destCurrent ? parseExactUnits(destCurrent.quantity, QTY_SCALE, 'destPrevQty') : 0n;
      const destPrevTotalUnits = destCurrent ? parseExactUnits(destCurrent.totalCost, COST_SCALE, 'destPrevTotal') : 0n;

      if (stockSyncMode === 'external_verified' && input.expectedPreDestStockQty !== undefined) {
        const preDestUnits = parseExactUnits(input.expectedPreDestStockQty, QTY_SCALE, 'expectedPreDestStockQty');
        if (preDestUnits !== destPrevQtyUnits) {
          throw new ValidationError(
            `VALUATION_INTEGRITY_ERROR: رصيد مستودع الوجهة (${fromMinorUnits(preDestUnits, QTY_SCALE)}) لا يطابق رصيد التقييم (${fromMinorUnits(destPrevQtyUnits, QTY_SCALE)}).`
          );
        }
      } else if (stockSyncMode === 'internal') {
        const destStock = await this.stockRepo.getBalanceForUpdate(companyId, input.destWarehouseId, input.itemId, client);
        const destStockUnits = destStock ? parseExactUnits(destStock.qty, QTY_SCALE, 'destStockQty') : 0n;
        if (destStockUnits !== destPrevQtyUnits) {
          throw new ValidationError(
            `VALUATION_INTEGRITY_ERROR: عدم تطابق رصيد مستودع الوجهة مع رصيد التقييم.`
          );
        }
        await this.stockRepo.incrementBalance(
          companyId,
          input.destWarehouseId,
          input.itemId,
          unitsToSafeNumber(qtyUnits, QTY_SCALE),
          client
        );
      }

      const transferTotalUnits = parseExactUnits(issueResult.totalCost, COST_SCALE, 'transferTotalCost');
      const transferUnitCostUnits = parseExactUnits(issueResult.unitCost, COST_SCALE, 'transferUnitCost');

      // Preserve FIFO layers individually in destination warehouse with full root + immediate layer lineage
      if (method === 'FIFO') {
        for (const alloc of issueResult.allocatedLayers) {
          const allocQtyUnits = parseExactUnits(alloc.qty, QTY_SCALE, 'allocQty');
          const allocCostUnits = parseExactUnits(alloc.cost, COST_SCALE, 'allocCost');
          const allocUnitCostUnits = parseExactUnits(alloc.unitCost, COST_SCALE, 'allocUnitCost');

          await this.valuationRepo.createCostLayer(
            companyId,
            {
              warehouseId: input.destWarehouseId,
              itemId: input.itemId,
              originalQty: fromMinorUnits(allocQtyUnits, QTY_SCALE),
              unitCost: fromMinorUnits(allocUnitCostUnits, COST_SCALE),
              totalCost: fromMinorUnits(allocCostUnits, COST_SCALE),
              sourceType: 'WAREHOUSE_TRANSFER',
              sourceId: input.sourceId,
              sourceLineId: input.sourceLineId ?? null,
              originLayerId: alloc.layerId,
              originSourceType: alloc.originSourceType || alloc.sourceType || 'WAREHOUSE_TRANSFER',
              originSourceId: alloc.originSourceId || alloc.sourceId || input.sourceId,
              originSourceLineId: alloc.originSourceLineId ?? alloc.sourceLineId ?? input.sourceLineId ?? null,
              effectiveDate: alloc.effectiveDate ?? null,
            },
            client
          );
        }
      }

      const destNewQtyUnits = destPrevQtyUnits + qtyUnits;
      const destNewTotalUnits = destPrevTotalUnits + transferTotalUnits;
      const destNewUnitCostUnits =
        destNewQtyUnits > 0n ? divExactUnits(destNewTotalUnits, COST_SCALE, destNewQtyUnits, QTY_SCALE, COST_SCALE) : 0n;

      await this.valuationRepo.setValuationBalanceExact(
        companyId,
        input.destWarehouseId,
        input.itemId,
        fromMinorUnits(destNewQtyUnits, QTY_SCALE),
        fromMinorUnits(destNewTotalUnits, COST_SCALE),
        fromMinorUnits(destNewUnitCostUnits, COST_SCALE),
        client
      );

      // Single TRANSFER_IN valuation movement linked to TRANSFER_OUT
      const movementIn = await this.valuationRepo.createValuationMovement(
        companyId,
        {
          warehouseId: input.destWarehouseId,
          itemId: input.itemId,
          movementType: 'TRANSFER_IN',
          qty: fromMinorUnits(qtyUnits, QTY_SCALE),
          unitCost: fromMinorUnits(transferUnitCostUnits, COST_SCALE),
          totalCost: fromMinorUnits(transferTotalUnits, COST_SCALE),
          sourceType: 'WAREHOUSE_TRANSFER',
          sourceId: input.sourceId,
          sourceLineId: input.sourceLineId ?? null,
          costSource: 'WAREHOUSE_TRANSFER',
          costingMethod: method,
          referenceMovementId: issueResult.movement.id,
          notes: input.notes ?? null,
          createdBy: userId ?? null,
        },
        client
      );

      if (method === 'PERPETUAL_MOVING_AVERAGE') {
        const groupedDestOrigins = new Map<
          string,
          {
            originSourceType: string;
            originSourceId: string;
            originSourceLineId: string | null;
            grnId: string | null;
            grnLineId: string | null;
            qtyUnits: bigint;
            costUnits: bigint;
          }
        >();

        for (const s of issueResult.allocatedMaSources || []) {
          const sQtyUnits = parseExactUnits(s.qty, QTY_SCALE, 'transferMaSliceQty');
          const sCostUnits = parseExactUnits(s.cost, COST_SCALE, 'transferMaSliceCost');
          if (sQtyUnits <= 0n) continue;
          const originKey = `${s.originSourceType}::${s.originSourceId}::${s.originSourceLineId ?? ''}`;
          const cur = groupedDestOrigins.get(originKey);
          if (cur) {
            cur.qtyUnits += sQtyUnits;
            cur.costUnits += sCostUnits;
          } else {
            groupedDestOrigins.set(originKey, {
              originSourceType: s.originSourceType,
              originSourceId: s.originSourceId,
              originSourceLineId: s.originSourceLineId ?? null,
              grnId: s.grnId ?? null,
              grnLineId: s.grnLineId ?? null,
              qtyUnits: sQtyUnits,
              costUnits: sCostUnits,
            });
          }
        }

        for (const destSlice of groupedDestOrigins.values()) {
          const sliceQtyStr = fromMinorUnits(destSlice.qtyUnits, QTY_SCALE);
          const sliceValStr = fromMinorUnits(destSlice.costUnits, COST_SCALE);

          await this.valuationRepo.upsertMaSourceBalance(
            companyId,
            {
              warehouseId: input.destWarehouseId,
              itemId: input.itemId,
              sourceType: 'WAREHOUSE_TRANSFER',
              sourceId: input.sourceId,
              sourceLineId: input.sourceLineId ?? null,
              originSourceType: destSlice.originSourceType,
              originSourceId: destSlice.originSourceId,
              originSourceLineId: destSlice.originSourceLineId,
              grnId: destSlice.grnId,
              grnLineId: destSlice.grnLineId,
              receivedQty: sliceQtyStr,
              remainingQty: sliceQtyStr,
              consumedQty: '0.0000',
              originalValue: sliceValStr,
              remainingValue: sliceValStr,
              consumedValue: '0.0000',
            },
            client
          );

          await this.valuationRepo.createMaSourceEvent(
            companyId,
            {
              warehouseId: input.destWarehouseId,
              itemId: input.itemId,
              sourceType: 'WAREHOUSE_TRANSFER',
              sourceId: input.sourceId,
              sourceLineId: input.sourceLineId ?? null,
              originSourceType: destSlice.originSourceType,
              originSourceId: destSlice.originSourceId,
              originSourceLineId: destSlice.originSourceLineId,
              grnId: destSlice.grnId,
              grnLineId: destSlice.grnLineId,
              eventType: 'TRANSFER_IN',
              quantity: sliceQtyStr,
              valueDelta: sliceValStr,
              referenceMovementId: movementIn.id,
            },
            client
          );
        }
      }

      return {
        movementOut: issueResult.movement,
        movementIn,
        unitCost: issueResult.unitCost,
        totalCost: issueResult.totalCost,
        allocatedLayers: issueResult.allocatedLayers,
      };
    };

    if (tx) {
      return await execute(tx);
    }
    return await withTenantTransaction(companyId, execute);
  }

  /**
   * Allocates Purchase Price Variance (final supplier invoice unit cost vs GRN estimated unit cost)
   * proportionally between Remaining Inventory (even after inter-warehouse transfers) and Consumed/COGS.
   * Never creates artificial quantity movements and prevents duplicate reconciliation.
   */
  async applyPurchasePriceVariance(
    companyId: string,
    input: PurchasePriceVarianceInput,
    tx: DbExecutor
  ): Promise<PurchasePriceVarianceResult> {
    if (!input.grnId || !input.grnLineId || !input.invoiceId || !input.invoiceLineId) {
      throw new ValidationError('معرّفات إذن الاستلام وفاتورة المورد مطلوبة لتسوية فرق السعر');
    }

    const existingAdjs = await this.valuationRepo.findCostAdjustmentsByInvoiceLine(
      companyId,
      input.invoiceLineId,
      tx
    );
    if (existingAdjs.length > 0) {
      throw new ValidationError(
        `IDEMPOTENT_DUPLICATE: تم تسوية فرق السعر لسطر فاتورة المورد (${input.invoiceLineId}) مسبقاً.`
      );
    }

    const { method } = await this.getItemCostingMethod(companyId, input.itemId, tx);

    const qtyBasisUnits = parseExactUnits(input.invoicedQty, QTY_SCALE, 'invoicedQty');
    if (qtyBasisUnits <= 0n) {
      throw new ValidationError('الكمية المفوترة يجب أن تكون أكبر من الصفر');
    }

    const origUnitCostUnits = parseExactUnits(input.grnUnitCost, COST_SCALE, 'grnUnitCost');
    const finalUnitCostUnits = parseExactUnits(input.invoiceUnitCost, COST_SCALE, 'invoiceUnitCost');
    const unitVarianceUnits = finalUnitCostUnits - origUnitCostUnits;

    const grnTotalUnits = mulExactUnits(qtyBasisUnits, QTY_SCALE, origUnitCostUnits, COST_SCALE, COST_SCALE);
    const invoiceTotalUnits = mulExactUnits(qtyBasisUnits, QTY_SCALE, finalUnitCostUnits, COST_SCALE, COST_SCALE);
    const totalVarianceUnits = invoiceTotalUnits - grnTotalUnits;

    const grnMoneyUnits = rescaleUnits(grnTotalUnits, COST_SCALE, MONEY_SCALE);
    const invoiceMoneyUnits = rescaleUnits(invoiceTotalUnits, COST_SCALE, MONEY_SCALE);
    const totalVarianceMoneyUnits = invoiceMoneyUnits - grnMoneyUnits;

    if (totalVarianceUnits === 0n && totalVarianceMoneyUnits === 0n) {
      return {
        costingMethod: method,
        qtyBasis: unitsToSafeNumber(qtyBasisUnits, QTY_SCALE),
        grnTotalUnits,
        invoiceTotalUnits,
        totalVarianceUnits: 0n,
        remainingAllocationUnits: 0n,
        consumedAllocationUnits: 0n,
        grnMoneyUnits,
        invoiceMoneyUnits,
        totalVarianceMoneyUnits: 0n,
        remainingMoneyUnits: 0n,
        consumedMoneyUnits: 0n,
        adjustments: [],
      };
    }

    const adjustments: CostAdjustmentRecord[] = [];
    let remainingAllocationUnits = 0n;
    let consumedAllocationUnits = 0n;

    if (method === 'FIFO') {
      const originLayers = await this.valuationRepo.findLayersByOriginLineForUpdate(
        companyId,
        input.grnId,
        input.grnLineId,
        tx
      );
      const activeLayers = originLayers.filter(
        (l) => !l.isExhausted && parseExactUnits(l.remainingQty, QTY_SCALE, 'remQty') > 0n
      );

      let totalLayerRemQtyUnits = 0n;
      for (const layer of activeLayers) {
        totalLayerRemQtyUnits += parseExactUnits(layer.remainingQty, QTY_SCALE, 'remQty');
      }

      const coveredRemQtyUnits = totalLayerRemQtyUnits < qtyBasisUnits ? totalLayerRemQtyUnits : qtyBasisUnits;
      const consumedQtyUnits = qtyBasisUnits - coveredRemQtyUnits;

      const [plannedRemUnits, plannedConsUnits] = allocateProportionalUnits(totalVarianceUnits, [
        coveredRemQtyUnits,
        consumedQtyUnits,
      ]);
      consumedAllocationUnits = plannedConsUnits;

      if (activeLayers.length > 0 && plannedRemUnits !== 0n) {
        const layerWeights = activeLayers.map((l) => parseExactUnits(l.remainingQty, QTY_SCALE, 'remQty'));
        const layerShares = allocateProportionalUnits(plannedRemUnits, layerWeights);

        // Lock warehouse balances in deterministic order for all touched warehouses
        const touchedWhs = Array.from(new Set(activeLayers.map((l) => l.warehouseId))).sort();
        for (const whId of touchedWhs) {
          await this.valuationRepo.lockValuationBalanceForUpdate(companyId, whId, input.itemId, tx);
        }

        const whDeltaMap = new Map<string, bigint>();
        for (let i = 0; i < activeLayers.length; i++) {
          const layer = activeLayers[i];
          const layerRemUnits = parseExactUnits(layer.remainingQty, QTY_SCALE, 'remQty');
          const layerTotalUnits = parseExactUnits(layer.totalCost, COST_SCALE, 'layerTotalCost');
          let shareUnits = layerShares[i];

          // Prevent negative layer valuation when negative variance exceeds remaining layer book value
          if (layerTotalUnits + shareUnits < 0n) {
            const maxReduction = -layerTotalUnits;
            const overflow = shareUnits - maxReduction;
            shareUnits = maxReduction;
            consumedAllocationUnits += overflow;
          }

          const newLayerTotalUnits = layerTotalUnits + shareUnits;
          const newLayerUnitCostUnits =
            layerRemUnits > 0n ? divExactUnits(newLayerTotalUnits, COST_SCALE, layerRemUnits, QTY_SCALE, COST_SCALE) : 0n;

          await this.valuationRepo.updateCostLayerValuation(
            companyId,
            layer.id,
            fromMinorUnits(newLayerUnitCostUnits, COST_SCALE),
            fromMinorUnits(newLayerTotalUnits, COST_SCALE),
            tx
          );

          remainingAllocationUnits += shareUnits;
          whDeltaMap.set(layer.warehouseId, (whDeltaMap.get(layer.warehouseId) || 0n) + shareUnits);

          const isFirst = i === 0;
          const rowConsumed = isFirst ? 0n : 0n; // finalized below if multi-layer
          if (!isFirst) {
            const adj = await this.valuationRepo.createCostAdjustment(
              companyId,
              {
                sourceType: 'SUPPLIER_INVOICE_PPV',
                sourceId: input.invoiceId,
                sourceLineId: input.invoiceLineId,
                grnId: input.grnId,
                grnLineId: input.grnLineId,
                invoiceId: input.invoiceId,
                invoiceLineId: input.invoiceLineId,
                costLayerId: layer.id,
                itemId: input.itemId,
                warehouseId: layer.warehouseId,
                costingMethod: method,
                qtyBasis: fromMinorUnits(layerRemUnits, QTY_SCALE),
                originalUnitCost: fromMinorUnits(origUnitCostUnits, COST_SCALE),
                finalUnitCost: fromMinorUnits(finalUnitCostUnits, COST_SCALE),
                unitVariance: fromMinorUnits(unitVarianceUnits, COST_SCALE),
                adjustmentAmount: fromMinorUnits(shareUnits, COST_SCALE),
                remainingAllocation: fromMinorUnits(shareUnits, COST_SCALE),
                consumedAllocation: fromMinorUnits(rowConsumed, COST_SCALE),
                status: 'posted',
                reason: input.reason || 'تسوية فرق سعر فاتورة المورد عن تكلفة الاستلام',
                journalEntryId: input.journalEntryId ?? null,
                approvedBy: input.approvedBy ?? null,
                createdBy: input.createdBy ?? null,
              },
              tx
            );
            adjustments.push(adj);
          }
        }

        // Update warehouse valuation balances once per touched warehouse (handling negative clamp safety)
        for (const whId of touchedWhs) {
          const delta = whDeltaMap.get(whId) || 0n;
          if (delta === 0n) continue;
          const bal = await this.valuationRepo.lockValuationBalanceForUpdate(companyId, whId, input.itemId, tx);
          const curQtyUnits = bal ? parseExactUnits(bal.quantity, QTY_SCALE, 'curQty') : 0n;
          const curTotalUnits = bal ? parseExactUnits(bal.totalCost, COST_SCALE, 'curTotal') : 0n;
          let actualDelta = delta;
          if (curTotalUnits + actualDelta < 0n) {
            const clamped = -curTotalUnits;
            const diff = actualDelta - clamped;
            actualDelta = clamped;
            remainingAllocationUnits += diff; // reduces negative or shifts difference to consumed
            consumedAllocationUnits += diff;
          }
          const nextTotalUnits = curTotalUnits + actualDelta;
          const nextUnitCostUnits =
            curQtyUnits > 0n ? divExactUnits(nextTotalUnits, COST_SCALE, curQtyUnits, QTY_SCALE, COST_SCALE) : 0n;
          await this.valuationRepo.setValuationBalanceExact(
            companyId,
            whId,
            input.itemId,
            fromMinorUnits(curQtyUnits, QTY_SCALE),
            fromMinorUnits(nextTotalUnits, COST_SCALE),
            fromMinorUnits(nextUnitCostUnits, COST_SCALE),
            tx
          );
        }

        // Create adjustment record for first layer carrying any consumed allocation too
        const firstLayer = activeLayers[0];
        const firstLayerAdjustedShare =
          totalVarianceUnits - consumedAllocationUnits - adjustments.reduce(
            (acc, a) => acc + parseExactUnits(a.remainingAllocation, COST_SCALE, 'remAlloc'),
            0n
          );
        const firstAdj = await this.valuationRepo.createCostAdjustment(
          companyId,
          {
            sourceType: 'SUPPLIER_INVOICE_PPV',
            sourceId: input.invoiceId,
            sourceLineId: input.invoiceLineId,
            grnId: input.grnId,
            grnLineId: input.grnLineId,
            invoiceId: input.invoiceId,
            invoiceLineId: input.invoiceLineId,
            costLayerId: firstLayer.id,
            itemId: input.itemId,
            warehouseId: firstLayer.warehouseId,
            costingMethod: method,
            qtyBasis: fromMinorUnits(qtyBasisUnits, QTY_SCALE),
            originalUnitCost: fromMinorUnits(origUnitCostUnits, COST_SCALE),
            finalUnitCost: fromMinorUnits(finalUnitCostUnits, COST_SCALE),
            unitVariance: fromMinorUnits(unitVarianceUnits, COST_SCALE),
            adjustmentAmount: fromMinorUnits(firstLayerAdjustedShare + consumedAllocationUnits, COST_SCALE),
            remainingAllocation: fromMinorUnits(firstLayerAdjustedShare, COST_SCALE),
            consumedAllocation: fromMinorUnits(consumedAllocationUnits, COST_SCALE),
            status: 'posted',
            reason: input.reason || 'تسوية فرق سعر فاتورة المورد عن تكلفة الاستلام',
            journalEntryId: input.journalEntryId ?? null,
            approvedBy: input.approvedBy ?? null,
            createdBy: input.createdBy ?? null,
          },
          tx
        );
        adjustments.unshift(firstAdj);
      } else {
        // 100% consumed inventory (0 active FIFO layers left)
        remainingAllocationUnits = 0n;
        consumedAllocationUnits = totalVarianceUnits;
        const adj = await this.valuationRepo.createCostAdjustment(
          companyId,
          {
            sourceType: 'SUPPLIER_INVOICE_PPV',
            sourceId: input.invoiceId,
            sourceLineId: input.invoiceLineId,
            grnId: input.grnId,
            grnLineId: input.grnLineId,
            invoiceId: input.invoiceId,
            invoiceLineId: input.invoiceLineId,
            costLayerId: null,
            itemId: input.itemId,
            warehouseId: input.warehouseId,
            costingMethod: method,
            qtyBasis: fromMinorUnits(qtyBasisUnits, QTY_SCALE),
            originalUnitCost: fromMinorUnits(origUnitCostUnits, COST_SCALE),
            finalUnitCost: fromMinorUnits(finalUnitCostUnits, COST_SCALE),
            unitVariance: fromMinorUnits(unitVarianceUnits, COST_SCALE),
            adjustmentAmount: fromMinorUnits(totalVarianceUnits, COST_SCALE),
            remainingAllocation: '0.0000',
            consumedAllocation: fromMinorUnits(totalVarianceUnits, COST_SCALE),
            status: 'posted',
            reason: input.reason || 'تسوية فرق سعر فاتورة المورد عن مخزون مستنفد (COGS)',
            journalEntryId: input.journalEntryId ?? null,
            approvedBy: input.approvedBy ?? null,
            createdBy: input.createdBy ?? null,
          },
          tx
        );
        adjustments.push(adj);
      }
    } else {
      // PERPETUAL_MOVING_AVERAGE: allocate strictly via Moving Average Source Value Ledger (inv_ma_source_balances)
      const sourceRows = await this.valuationRepo.findMaSourceBalancesByGrnLineForUpdate(
        companyId,
        input.grnLineId,
        tx
      );
      if (sourceRows.length === 0) {
        throw new ValidationError(
          `VALUATION_INTEGRITY_ERROR: لا توجد سجلات مصدر لمتوسط التكلفة مرتبطة بسطر إذن الاستلام (${input.grnLineId}).`
        );
      }

      const parsedSources = sourceRows.map((r) => {
        if (r.itemId !== input.itemId) {
          throw new ValidationError('VALUATION_INTEGRITY_ERROR: عدم تطابق الصنف في سجل مصدر متوسط التكلفة');
        }
        if (r.grnId && r.grnId !== input.grnId) {
          throw new ValidationError('VALUATION_INTEGRITY_ERROR: عدم تطابق إذن الاستلام في سجل مصدر متوسط التكلفة');
        }
        const recvQtyUnits = parseExactUnits(r.receivedQty, QTY_SCALE, 'srcRecvQty');
        const remQtyUnits = parseExactUnits(r.remainingQty, QTY_SCALE, 'srcRemQty');
        const consQtyUnits = parseExactUnits(r.consumedQty, QTY_SCALE, 'srcConsQty');
        const origValUnits = parseExactUnits(r.originalValue, COST_SCALE, 'srcOrigVal');
        const remValUnits = parseExactUnits(r.remainingValue, COST_SCALE, 'srcRemVal');
        const consValUnits = parseExactUnits(r.consumedValue, COST_SCALE, 'srcConsVal');

        if (remQtyUnits < 0n || consQtyUnits < 0n || remQtyUnits + consQtyUnits !== recvQtyUnits) {
          throw new ValidationError('VALUATION_INTEGRITY_ERROR: عدم توازن الكميات في سجل مصدر متوسط التكلفة');
        }
        if (origValUnits < 0n || remValUnits < 0n || consValUnits < 0n || remValUnits + consValUnits !== origValUnits) {
          throw new ValidationError('VALUATION_INTEGRITY_ERROR: عدم توازن القيم في سجل مصدر متوسط التكلفة');
        }

        return {
          row: r,
          recvQtyUnits,
          remQtyUnits,
          consQtyUnits,
          origValUnits,
          remValUnits,
          consValUnits,
        };
      });

      const rootSources = parsedSources.filter(
        (s) =>
          s.row.sourceType === 'GRN' ||
          (s.row.originSourceType === 'GRN' && s.row.sourceId === input.grnId && s.row.sourceLineId === input.grnLineId)
      );
      if (rootSources.length === 0) {
        throw new ValidationError('VALUATION_INTEGRITY_ERROR: سجل الاستلام الأصلي غير موجود في دفتر مصادر متوسط التكلفة');
      }

      const rootReceivedQtyUnits = rootSources.reduce((acc, s) => acc + s.recvQtyUnits, 0n);
      const totalRemainingQtyUnits = parsedSources.reduce((acc, s) => acc + s.remQtyUnits, 0n);

      if (totalRemainingQtyUnits > rootReceivedQtyUnits) {
        throw new ValidationError('VALUATION_INTEGRITY_ERROR: إجمالي الكمية المتبقية بالمصادر يتجاوز كمية الاستلام الأصلية');
      }
      if (qtyBasisUnits > rootReceivedQtyUnits) {
        throw new ValidationError(
          `VALUATION_INTEGRITY_ERROR: الكمية المفوترة (${fromMinorUnits(qtyBasisUnits, QTY_SCALE)}) تتجاوز كمية الاستلام المسجلة في دفتر المصادر (${fromMinorUnits(rootReceivedQtyUnits, QTY_SCALE)}).`
        );
      }

      const activeSources = parsedSources.filter((s) => s.remQtyUnits > 0n);
      const coveredRemQtyUnits = totalRemainingQtyUnits < qtyBasisUnits ? totalRemainingQtyUnits : qtyBasisUnits;
      const consumedQtyUnits = qtyBasisUnits - coveredRemQtyUnits;

      const [plannedRemUnits, plannedConsUnits] = allocateProportionalUnits(totalVarianceUnits, [
        coveredRemQtyUnits,
        consumedQtyUnits,
      ]);
      consumedAllocationUnits = plannedConsUnits;

      if (activeSources.length > 0 && plannedRemUnits !== 0n) {
        // Deadlock-safe lock order for touched warehouse balances
        const touchedWhs = Array.from(new Set(activeSources.map((s) => s.row.warehouseId))).sort();
        const whPoolRemaining = new Map<string, bigint>();
        const whCurQty = new Map<string, bigint>();
        for (const whId of touchedWhs) {
          const bal = await this.valuationRepo.lockValuationBalanceForUpdate(companyId, whId, input.itemId, tx);
          whPoolRemaining.set(whId, bal ? parseExactUnits(bal.totalCost, COST_SCALE, 'whTotal') : 0n);
          whCurQty.set(whId, bal ? parseExactUnits(bal.quantity, QTY_SCALE, 'whQty') : 0n);
        }

        const shares = allocateProportionalUnits(
          plannedRemUnits,
          activeSources.map((s) => s.remQtyUnits)
        );

        const whDeltaMap = new Map<string, bigint>();
        const whCoveredQtyMap = new Map<string, bigint>();
        for (let i = 0; i < activeSources.length; i++) {
          const src = activeSources[i];
          const whId = src.row.warehouseId;
          let shareUnits = shares[i];

          const minRowDelta = -src.remValUnits;
          const curWhPool = whPoolRemaining.get(whId) ?? 0n;
          const minWhDelta = -curWhPool;
          const tightestFloor = minRowDelta > minWhDelta ? minRowDelta : minWhDelta;

          if (shareUnits < tightestFloor) {
            const overflow = shareUnits - tightestFloor;
            shareUnits = tightestFloor;
            consumedAllocationUnits += overflow;
          }

          if (shareUnits !== 0n) {
            await this.valuationRepo.applyPpvToMaSourceBalance(
              companyId,
              src.row.id,
              fromMinorUnits(shareUnits, COST_SCALE),
              tx
            );
          }

          whPoolRemaining.set(whId, curWhPool + shareUnits);
          whDeltaMap.set(whId, (whDeltaMap.get(whId) ?? 0n) + shareUnits);
          whCoveredQtyMap.set(whId, (whCoveredQtyMap.get(whId) ?? 0n) + src.remQtyUnits);
          remainingAllocationUnits += shareUnits;
        }

        const orderedWhs = [...whDeltaMap.keys()].sort((a, b) => {
          if (a === input.warehouseId) return -1;
          if (b === input.warehouseId) return 1;
          return a.localeCompare(b);
        });

        for (const whId of orderedWhs) {
          const whDelta = whDeltaMap.get(whId) ?? 0n;
          const curQtyUnits = whCurQty.get(whId) ?? 0n;
          const nextTotalUnits = whPoolRemaining.get(whId) ?? 0n;
          if (whDelta !== 0n) {
            const nextUnitCostUnits =
              curQtyUnits > 0n ? divExactUnits(nextTotalUnits, COST_SCALE, curQtyUnits, QTY_SCALE, COST_SCALE) : 0n;
            await this.valuationRepo.setValuationBalanceExact(
              companyId,
              whId,
              input.itemId,
              fromMinorUnits(curQtyUnits, QTY_SCALE),
              fromMinorUnits(nextTotalUnits, COST_SCALE),
              fromMinorUnits(nextUnitCostUnits, COST_SCALE),
              tx
            );
          }

          const whEventQtyUnits = whCoveredQtyMap.get(whId) ?? qtyBasisUnits;
          if (whDelta !== 0n || whId === orderedWhs[0]) {
            await this.valuationRepo.createMaSourceEvent(
              companyId,
              {
                warehouseId: whId,
                itemId: input.itemId,
                sourceType: 'SUPPLIER_INVOICE_PPV',
                sourceId: input.invoiceId,
                sourceLineId: input.invoiceLineId,
                originSourceType: 'GRN',
                originSourceId: input.grnId,
                originSourceLineId: input.grnLineId,
                grnId: input.grnId,
                grnLineId: input.grnLineId,
                eventType: 'PPV',
                quantity: fromMinorUnits(whEventQtyUnits > 0n ? whEventQtyUnits : qtyBasisUnits, QTY_SCALE),
                valueDelta: fromMinorUnits(whDelta, COST_SCALE),
              },
              tx
            );
          }
        }

        for (let i = 1; i < orderedWhs.length; i++) {
          const whId = orderedWhs[i];
          const whDelta = whDeltaMap.get(whId) ?? 0n;
          const whQtyCovered = whCoveredQtyMap.get(whId) ?? 0n;
          const adj = await this.valuationRepo.createCostAdjustment(
            companyId,
            {
              sourceType: 'SUPPLIER_INVOICE_PPV',
              sourceId: input.invoiceId,
              sourceLineId: input.invoiceLineId,
              grnId: input.grnId,
              grnLineId: input.grnLineId,
              invoiceId: input.invoiceId,
              invoiceLineId: input.invoiceLineId,
              costLayerId: null,
              itemId: input.itemId,
              warehouseId: whId,
              costingMethod: method,
              qtyBasis: fromMinorUnits(whQtyCovered > 0n ? whQtyCovered : qtyBasisUnits, QTY_SCALE),
              originalUnitCost: fromMinorUnits(origUnitCostUnits, COST_SCALE),
              finalUnitCost: fromMinorUnits(finalUnitCostUnits, COST_SCALE),
              unitVariance: fromMinorUnits(unitVarianceUnits, COST_SCALE),
              adjustmentAmount: fromMinorUnits(whDelta, COST_SCALE),
              remainingAllocation: fromMinorUnits(whDelta, COST_SCALE),
              consumedAllocation: '0.0000',
              status: 'posted',
              reason: input.reason || 'تسوية فرق سعر فاتورة المورد عن تكلفة الاستلام',
              journalEntryId: input.journalEntryId ?? null,
              approvedBy: input.approvedBy ?? null,
              createdBy: input.createdBy ?? null,
            },
            tx
          );
          adjustments.push(adj);
        }

        const primaryWh = orderedWhs[0];
        const primaryRem = whDeltaMap.get(primaryWh) ?? 0n;
        const firstAdj = await this.valuationRepo.createCostAdjustment(
          companyId,
          {
            sourceType: 'SUPPLIER_INVOICE_PPV',
            sourceId: input.invoiceId,
            sourceLineId: input.invoiceLineId,
            grnId: input.grnId,
            grnLineId: input.grnLineId,
            invoiceId: input.invoiceId,
            invoiceLineId: input.invoiceLineId,
            costLayerId: null,
            itemId: input.itemId,
            warehouseId: primaryWh,
            costingMethod: method,
            qtyBasis: fromMinorUnits(qtyBasisUnits, QTY_SCALE),
            originalUnitCost: fromMinorUnits(origUnitCostUnits, COST_SCALE),
            finalUnitCost: fromMinorUnits(finalUnitCostUnits, COST_SCALE),
            unitVariance: fromMinorUnits(unitVarianceUnits, COST_SCALE),
            adjustmentAmount: fromMinorUnits(primaryRem + consumedAllocationUnits, COST_SCALE),
            remainingAllocation: fromMinorUnits(primaryRem, COST_SCALE),
            consumedAllocation: fromMinorUnits(consumedAllocationUnits, COST_SCALE),
            status: 'posted',
            reason: input.reason || 'تسوية فرق سعر فاتورة المورد عن تكلفة الاستلام',
            journalEntryId: input.journalEntryId ?? null,
            approvedBy: input.approvedBy ?? null,
            createdBy: input.createdBy ?? null,
          },
          tx
        );
        adjustments.unshift(firstAdj);
      } else {
        remainingAllocationUnits = 0n;
        consumedAllocationUnits = totalVarianceUnits;
        const adj = await this.valuationRepo.createCostAdjustment(
          companyId,
          {
            sourceType: 'SUPPLIER_INVOICE_PPV',
            sourceId: input.invoiceId,
            sourceLineId: input.invoiceLineId,
            grnId: input.grnId,
            grnLineId: input.grnLineId,
            invoiceId: input.invoiceId,
            invoiceLineId: input.invoiceLineId,
            costLayerId: null,
            itemId: input.itemId,
            warehouseId: input.warehouseId,
            costingMethod: method,
            qtyBasis: fromMinorUnits(qtyBasisUnits, QTY_SCALE),
            originalUnitCost: fromMinorUnits(origUnitCostUnits, COST_SCALE),
            finalUnitCost: fromMinorUnits(finalUnitCostUnits, COST_SCALE),
            unitVariance: fromMinorUnits(unitVarianceUnits, COST_SCALE),
            adjustmentAmount: fromMinorUnits(totalVarianceUnits, COST_SCALE),
            remainingAllocation: '0.0000',
            consumedAllocation: fromMinorUnits(totalVarianceUnits, COST_SCALE),
            status: 'posted',
            reason: input.reason || 'تسوية فرق سعر فاتورة المورد عن مخزون مستنفد (COGS)',
            journalEntryId: input.journalEntryId ?? null,
            approvedBy: input.approvedBy ?? null,
            createdBy: input.createdBy ?? null,
          },
          tx
        );
        adjustments.push(adj);

        await this.valuationRepo.createMaSourceEvent(
          companyId,
          {
            warehouseId: input.warehouseId,
            itemId: input.itemId,
            sourceType: 'SUPPLIER_INVOICE_PPV',
            sourceId: input.invoiceId,
            sourceLineId: input.invoiceLineId,
            originSourceType: 'GRN',
            originSourceId: input.grnId,
            originSourceLineId: input.grnLineId,
            grnId: input.grnId,
            grnLineId: input.grnLineId,
            eventType: 'PPV',
            quantity: fromMinorUnits(qtyBasisUnits, QTY_SCALE),
            valueDelta: '0.0000',
          },
          tx
        );
      }
    }

    // Exact MONEY_SCALE (2 decimals) split preserving remainingMoney + consumedMoney === totalVarianceMoneyUnits
    let remainingMoneyUnits = 0n;
    let consumedMoneyUnits = 0n;
    if (totalVarianceMoneyUnits !== 0n) {
      if (remainingAllocationUnits === 0n) {
        consumedMoneyUnits = totalVarianceMoneyUnits;
      } else if (consumedAllocationUnits === 0n) {
        remainingMoneyUnits = totalVarianceMoneyUnits;
      } else {
        const absRem = remainingAllocationUnits < 0n ? -remainingAllocationUnits : remainingAllocationUnits;
        const absCons = consumedAllocationUnits < 0n ? -consumedAllocationUnits : consumedAllocationUnits;
        const [remM, consM] = allocateProportionalUnits(totalVarianceMoneyUnits, [absRem, absCons]);
        remainingMoneyUnits = remM;
        consumedMoneyUnits = consM;
      }
    }

    return {
      costingMethod: method,
      qtyBasis: unitsToSafeNumber(qtyBasisUnits, QTY_SCALE),
      grnTotalUnits,
      invoiceTotalUnits,
      totalVarianceUnits,
      remainingAllocationUnits,
      consumedAllocationUnits,
      grnMoneyUnits,
      invoiceMoneyUnits,
      totalVarianceMoneyUnits,
      remainingMoneyUnits,
      consumedMoneyUnits,
      adjustments,
    };
  }

  /**
   * Resolves authoritative source cost for a Purchase Return linked to a specific GRN line,
   * accounting for prior issues, inter-warehouse transfers, and posted supplier invoice PPVs.
   * Rejects return if source provenance cannot be satisfied.
   */
  async resolveAndIssuePurchaseReturn(
    companyId: string,
    input: PurchaseReturnValuationInput,
    userId?: string,
    tx?: DbExecutor
  ): Promise<{
    balance: ValuationBalance;
    movement: ValuationMovement;
    unitCost: number;
    totalCost: number;
    costingMethod: CostingMethod;
  }> {
    const qtyUnits = parseExactUnits(input.qty, QTY_SCALE, 'qty');
    const grnQtyUnits = parseExactUnits(input.grnQty, QTY_SCALE, 'grnQty');
    const grnUnitCostUnits = parseExactUnits(input.grnUnitCost, COST_SCALE, 'grnUnitCost');
    if (qtyUnits <= 0n || grnQtyUnits <= 0n) {
      throw new ValidationError('كمية المرتجع وكمية الاستلام الأصلية يجب أن تكون أكبر من الصفر');
    }

    const stockSyncMode: StockSyncMode = input.stockSyncMode || 'internal';

    const execute = async (client: DbExecutor) => {
      const existingMov = await this.valuationRepo.findValuationMovementByIdempotency(
        companyId,
        input.warehouseId,
        input.itemId,
        'RETURN',
        'PURCHASE_RETURN',
        input.returnId,
        input.returnLineId,
        client
      );
      if (existingMov) {
        throw new ValidationError('IDEMPOTENT_DUPLICATE: تم تسجيل حركة التقييم لمرتجع المشتريات هذا مسبقاً');
      }

      const { method } = await this.getItemCostingMethod(companyId, input.itemId, client);

      const currentBalance = await this.valuationRepo.lockValuationBalanceForUpdate(
        companyId,
        input.warehouseId,
        input.itemId,
        client
      );
      const prevQtyUnits = currentBalance ? parseExactUnits(currentBalance.quantity, QTY_SCALE, 'prevQty') : 0n;
      const prevTotalUnits = currentBalance ? parseExactUnits(currentBalance.totalCost, COST_SCALE, 'prevTotalCost') : 0n;

      if (prevQtyUnits < qtyUnits) {
        throw new ValidationError(
          `رصيد مخزني غير كافٍ لإتمام مرتجع المشتريات (المتاح: ${fromMinorUnits(prevQtyUnits, QTY_SCALE)}، المطلوب: ${fromMinorUnits(qtyUnits, QTY_SCALE)}).`
        );
      }

      if (stockSyncMode === 'external_verified' && input.expectedPreStockQty !== undefined) {
        const preUnits = parseExactUnits(input.expectedPreStockQty, QTY_SCALE, 'expectedPreStockQty');
        if (preUnits !== prevQtyUnits) {
          throw new ValidationError(
            `VALUATION_INTEGRITY_ERROR: عدم تطابق الرصيد الكمي بالمستودع (${fromMinorUnits(preUnits, QTY_SCALE)}) مع رصيد التقييم (${fromMinorUnits(prevQtyUnits, QTY_SCALE)}).`
          );
        }
      } else if (stockSyncMode === 'internal') {
        const stockBal = await this.stockRepo.getBalanceForUpdate(companyId, input.warehouseId, input.itemId, client);
        const stockUnits = stockBal ? parseExactUnits(stockBal.qty, QTY_SCALE, 'stockQty') : 0n;
        if (stockUnits !== prevQtyUnits) {
          throw new ValidationError('VALUATION_INTEGRITY_ERROR: عدم تطابق الرصيد الكمي بالمستودع مع رصيد التقييم');
        }
      }

      let returnTotalUnits = 0n;
      const allocated: Array<{ layerId: string | null; qtyUnits: bigint; unitCostUnits: bigint; costUnits: bigint }> = [];

      if (method === 'FIFO') {
        // Lock all layers descending from (grnId, grnLineId) across warehouses
        const originLayers = await this.valuationRepo.findLayersByOriginLineForUpdate(
          companyId,
          input.grnId,
          input.grnLineId,
          client
        );

        const whLayers = originLayers.filter(
          (l) => l.warehouseId === input.warehouseId && !l.isExhausted && parseExactUnits(l.remainingQty, QTY_SCALE, 'rem') > 0n
        );
        const whLayerRemSum = whLayers.reduce(
          (sum, l) => sum + parseExactUnits(l.remainingQty, QTY_SCALE, 'rem'),
          0n
        );
        if (whLayerRemSum < qtyUnits) {
          const allWhRemSum = originLayers
            .filter((l) => !l.isExhausted)
            .reduce((sum, l) => sum + parseExactUnits(l.remainingQty, QTY_SCALE, 'rem'), 0n);
          throw new ValidationError(
            allWhRemSum >= qtyUnits
              ? `الكمية المتاحة من طبقات الاستلام الأصلية في هذا المستودع (${fromMinorUnits(whLayerRemSum, QTY_SCALE)}) أقل من كمية المرتجع (${fromMinorUnits(qtyUnits, QTY_SCALE)}) بسبب تحويل جزء من البضاعة لمستودع آخر.`
              : `VALUATION_INTEGRITY_ERROR: الكمية المتبقية في طبقات FIFO المرتبطة بإذن الاستلام الأصلي (${fromMinorUnits(whLayerRemSum, QTY_SCALE)}) غير كافية لمرتجع (${fromMinorUnits(qtyUnits, QTY_SCALE)}).`
          );
        }

        let remToReturn = qtyUnits;
        for (const layer of whLayers) {
          if (remToReturn <= 0n) break;
          const layerRem = parseExactUnits(layer.remainingQty, QTY_SCALE, 'rem');
          const layerTotal = parseExactUnits(layer.totalCost, COST_SCALE, 'layerTotal');
          const layerUnitCost = parseExactUnits(layer.unitCost, COST_SCALE, 'layerUnitCost');

          const takeQty = remToReturn < layerRem ? remToReturn : layerRem;
          let takeCost =
            takeQty === layerRem
              ? layerTotal
              : mulExactUnits(takeQty, QTY_SCALE, layerUnitCost, COST_SCALE, COST_SCALE);
          if (takeCost > layerTotal) takeCost = layerTotal;

          await this.valuationRepo.updateCostLayerRemaining(
            companyId,
            layer.id,
            fromMinorUnits(layerRem - takeQty, QTY_SCALE),
            fromMinorUnits(layerTotal - takeCost, COST_SCALE),
            layerRem - takeQty === 0n,
            client
          );

          returnTotalUnits += takeCost;
          allocated.push({
            layerId: layer.id,
            qtyUnits: takeQty,
            unitCostUnits: divExactUnits(takeCost, COST_SCALE, takeQty, QTY_SCALE, COST_SCALE),
            costUnits: takeCost,
          });
          remToReturn -= takeQty;
        }
      } else {
        // PERPETUAL_MOVING_AVERAGE: derive & validate provenance from locked MA source balances
        const originSources = await this.valuationRepo.findMaSourceBalancesByGrnLineForUpdate(
          companyId,
          input.grnLineId,
          client
        );
        if (originSources.length === 0) {
          throw new ValidationError(
            `VALUATION_INTEGRITY_ERROR: لا توجد سجلات مصدر لمتوسط التكلفة مرتبطة بسطر إذن الاستلام الأصلي (${input.grnLineId}).`
          );
        }

        const whSources = originSources.filter((s) => {
          if (s.itemId !== input.itemId) {
            throw new ValidationError('VALUATION_INTEGRITY_ERROR: عدم تطابق الصنف في سجل مصدر مرتجع المشتريات');
          }
          if (s.grnId && s.grnId !== input.grnId) {
            throw new ValidationError('VALUATION_INTEGRITY_ERROR: عدم تطابق إذن الاستلام في سجل مصدر مرتجع المشتريات');
          }
          return s.warehouseId === input.warehouseId && parseExactUnits(s.remainingQty, QTY_SCALE, 'rem') > 0n;
        });

        const whSourceRemSum = whSources.reduce(
          (sum, s) => sum + parseExactUnits(s.remainingQty, QTY_SCALE, 'rem'),
          0n
        );
        if (whSourceRemSum < qtyUnits) {
          const allWhRemSum = originSources.reduce(
            (sum, s) => sum + parseExactUnits(s.remainingQty, QTY_SCALE, 'rem'),
            0n
          );
          throw new ValidationError(
            allWhRemSum >= qtyUnits
              ? `الكمية المتاحة من أرصدة مصدر الاستلام الأصلي في هذا المستودع (${fromMinorUnits(whSourceRemSum, QTY_SCALE)}) أقل من كمية المرتجع (${fromMinorUnits(qtyUnits, QTY_SCALE)}) بسبب تحويل أو صرف جزء من البضاعة.`
              : `VALUATION_INTEGRITY_ERROR: الكمية المتبقية في دفتر مصادر الاستلام (${fromMinorUnits(whSourceRemSum, QTY_SCALE)}) غير كافية لمرتجع (${fromMinorUnits(qtyUnits, QTY_SCALE)}).`
          );
        }

        let remToReturn = qtyUnits;
        const maUpdates: Array<{
          id: string;
          nextRemQty: bigint;
          nextConsQty: bigint;
          nextRemVal: bigint;
          nextConsVal: bigint;
          takeVal: bigint;
        }> = [];

        for (const src of whSources) {
          if (remToReturn <= 0n) break;
          const remQtyU = parseExactUnits(src.remainingQty, QTY_SCALE, 'remQty');
          const consQtyU = parseExactUnits(src.consumedQty, QTY_SCALE, 'consQty');
          const remValU = parseExactUnits(src.remainingValue, COST_SCALE, 'remVal');
          const consValU = parseExactUnits(src.consumedValue, COST_SCALE, 'consVal');

          const takeQty = remToReturn < remQtyU ? remToReturn : remQtyU;
          let takeVal: bigint;
          if (takeQty === remQtyU) {
            takeVal = remValU;
          } else {
            const unitVal = divExactUnits(remValU, COST_SCALE, remQtyU, QTY_SCALE, COST_SCALE);
            takeVal = mulExactUnits(takeQty, QTY_SCALE, unitVal, COST_SCALE, COST_SCALE);
            if (takeVal > remValU) takeVal = remValU;
          }

          maUpdates.push({
            id: src.id,
            nextRemQty: remQtyU - takeQty,
            nextConsQty: consQtyU + takeQty,
            nextRemVal: remValU - takeVal,
            nextConsVal: consValU + takeVal,
            takeVal,
          });
          returnTotalUnits += takeVal;
          remToReturn -= takeQty;
        }

        if (returnTotalUnits > prevTotalUnits) {
          const diff = returnTotalUnits - prevTotalUnits;
          if (qtyUnits === prevQtyUnits && diff <= 10n && maUpdates.length > 0) {
            const last = maUpdates[maUpdates.length - 1];
            if (last.takeVal >= diff) {
              last.takeVal -= diff;
              last.nextRemVal += diff;
              last.nextConsVal -= diff;
              returnTotalUnits = prevTotalUnits;
            } else {
              throw new ValidationError(
                `VALUATION_INTEGRITY_ERROR: القيمة الدفترية المتبقية بالمستودع (${fromMinorUnits(prevTotalUnits, COST_SCALE)}) لا تكفي لتغطية تكلفة المرتجع الأصلية (${fromMinorUnits(returnTotalUnits, COST_SCALE)}).`
              );
            }
          } else {
            throw new ValidationError(
              `VALUATION_INTEGRITY_ERROR: القيمة الدفترية المتبقية بالمستودع (${fromMinorUnits(prevTotalUnits, COST_SCALE)}) لا تكفي لتغطية تكلفة المرتجع الأصلية (${fromMinorUnits(returnTotalUnits, COST_SCALE)}).`
            );
          }
        }

        for (const u of maUpdates) {
          await this.valuationRepo.updateMaSourceBalanceQuantities(
            companyId,
            u.id,
            fromMinorUnits(u.nextRemQty, QTY_SCALE),
            fromMinorUnits(u.nextConsQty, QTY_SCALE),
            client,
            fromMinorUnits(u.nextRemVal, COST_SCALE),
            fromMinorUnits(u.nextConsVal, COST_SCALE)
          );
        }

        const effectiveUnit = divExactUnits(returnTotalUnits, COST_SCALE, qtyUnits, QTY_SCALE, COST_SCALE);
        allocated.push({
          layerId: null,
          qtyUnits,
          unitCostUnits: effectiveUnit,
          costUnits: returnTotalUnits,
        });
      }

      if (returnTotalUnits > prevTotalUnits) {
        throw new ValidationError('VALUATION_INTEGRITY_ERROR: تتجاوز تكلفة المرتجع الرصيد القيمي المتاح بالمستودع');
      }

      const newQtyUnits = prevQtyUnits - qtyUnits;
      const newTotalUnits = newQtyUnits === 0n ? 0n : prevTotalUnits - returnTotalUnits;
      const newUnitCostUnits =
        newQtyUnits > 0n ? divExactUnits(newTotalUnits, COST_SCALE, newQtyUnits, QTY_SCALE, COST_SCALE) : 0n;
      const effectiveReturnUnitCostUnits = divExactUnits(returnTotalUnits, COST_SCALE, qtyUnits, QTY_SCALE, COST_SCALE);

      if (stockSyncMode === 'internal') {
        const decremented = await this.stockRepo.decrementBalance(
          companyId,
          input.warehouseId,
          input.itemId,
          unitsToSafeNumber(qtyUnits, QTY_SCALE),
          client
        );
        if (!decremented) {
          throw new ValidationError('رصيد غير كافٍ لإتمام مرتجع المشتريات');
        }
      }

      const balance = await this.valuationRepo.setValuationBalanceExact(
        companyId,
        input.warehouseId,
        input.itemId,
        fromMinorUnits(newQtyUnits, QTY_SCALE),
        fromMinorUnits(newTotalUnits, COST_SCALE),
        fromMinorUnits(newUnitCostUnits, COST_SCALE),
        client
      );

      const movement = await this.valuationRepo.createValuationMovement(
        companyId,
        {
          warehouseId: input.warehouseId,
          itemId: input.itemId,
          movementType: 'RETURN',
          qty: fromMinorUnits(qtyUnits, QTY_SCALE),
          unitCost: fromMinorUnits(effectiveReturnUnitCostUnits, COST_SCALE),
          totalCost: fromMinorUnits(returnTotalUnits, COST_SCALE),
          sourceType: 'PURCHASE_RETURN',
          sourceId: input.returnId,
          sourceLineId: input.returnLineId,
          journalEntryId: input.journalEntryId ?? null,
          reason: input.reason ?? 'مرتجع مشتريات بتكلفة الاستلام الأصلية',
          costSource: 'GRN_SOURCE_PROVENANCE',
          costingMethod: method,
          createdBy: userId ?? null,
        },
        client
      );

      for (const alloc of allocated) {
        await this.valuationRepo.createCostAllocation(
          companyId,
          {
            valuationMovementId: movement.id,
            costLayerId: alloc.layerId,
            allocatedQty: fromMinorUnits(alloc.qtyUnits, QTY_SCALE),
            unitCost: fromMinorUnits(alloc.unitCostUnits, COST_SCALE),
            allocatedCost: fromMinorUnits(alloc.costUnits, COST_SCALE),
          },
          client
        );
      }

      if (method === 'PERPETUAL_MOVING_AVERAGE') {
        await this.valuationRepo.createMaSourceEvent(
          companyId,
          {
            warehouseId: input.warehouseId,
            itemId: input.itemId,
            sourceType: 'PURCHASE_RETURN',
            sourceId: input.returnId,
            sourceLineId: input.returnLineId,
            originSourceType: 'GRN',
            originSourceId: input.grnId,
            originSourceLineId: input.grnLineId,
            grnId: input.grnId,
            grnLineId: input.grnLineId,
            eventType: 'PURCHASE_RETURN',
            quantity: fromMinorUnits(qtyUnits, QTY_SCALE),
            valueDelta: fromMinorUnits(-returnTotalUnits, COST_SCALE),
            referenceMovementId: movement.id,
          },
          client
        );
      }

      return {
        balance,
        movement,
        unitCost: unitsToSafeNumber(effectiveReturnUnitCostUnits, COST_SCALE),
        totalCost: unitsToSafeNumber(returnTotalUnits, COST_SCALE),
        costingMethod: method,
      };
    };

    if (tx) {
      return await execute(tx);
    }
    return await withTenantTransaction(companyId, execute);
  }

  /**
   * Restores inventory valuation upon a posted Sales Return using ONLY the original frozen delivery
   * cost layers (FIFO) or original frozen delivery cost (MA — never current pool average).
   */
  async restoreSalesReturnInventory(
    companyId: string,
    input: SalesReturnValuationInput,
    userId?: string,
    tx?: DbExecutor
  ): Promise<{
    balance: ValuationBalance;
    movement: ValuationMovement;
    unitCost: number;
    totalCost: number;
    costingMethod: CostingMethod;
  }> {
    const qtyUnits = parseExactUnits(input.qty, QTY_SCALE, 'qty');
    const delQtyUnits = parseExactUnits(input.deliveryQty, QTY_SCALE, 'deliveryQty');
    const delFrozenTotalUnits = parseExactUnits(input.deliveryFrozenTotalCost, COST_SCALE, 'deliveryFrozenTotalCost');

    if (qtyUnits <= 0n || delQtyUnits <= 0n || delFrozenTotalUnits < 0n) {
      throw new ValidationError('كمية مرتجع المبيعات وبيانات التسليم الأصلية يجب أن تكون صالحة');
    }

    const stockSyncMode: StockSyncMode = input.stockSyncMode || 'internal';

    const execute = async (client: DbExecutor) => {
      const existingMov = await this.valuationRepo.findValuationMovementByIdempotency(
        companyId,
        input.warehouseId,
        input.itemId,
        'RETURN',
        'SALES_RETURN',
        input.returnId,
        input.returnLineId,
        client
      );
      if (existingMov) {
        throw new ValidationError('IDEMPOTENT_DUPLICATE: تم تسجيل حركة التقييم لمرتجع المبيعات هذا مسبقاً');
      }

      const { method } = await this.getItemCostingMethod(companyId, input.itemId, client);

      const currentBalance = await this.valuationRepo.lockValuationBalanceForUpdate(
        companyId,
        input.warehouseId,
        input.itemId,
        client
      );
      const prevQtyUnits = currentBalance ? parseExactUnits(currentBalance.quantity, QTY_SCALE, 'prevQty') : 0n;
      const prevTotalUnits = currentBalance ? parseExactUnits(currentBalance.totalCost, COST_SCALE, 'prevTotalCost') : 0n;

      if (stockSyncMode === 'internal') {
        const stockBal = await this.stockRepo.getBalanceForUpdate(companyId, input.warehouseId, input.itemId, client);
        const stockUnits = stockBal ? parseExactUnits(stockBal.qty, QTY_SCALE, 'stockQty') : 0n;
        if (stockUnits !== prevQtyUnits) {
          throw new ValidationError('VALUATION_INTEGRITY_ERROR: عدم تطابق الرصيد الكمي بالمستودع مع رصيد التقييم قبل مرتجع المبيعات');
        }
      } else {
        if (input.expectedPreStockQty !== undefined) {
          const preUnits = parseExactUnits(input.expectedPreStockQty, QTY_SCALE, 'expectedPreStockQty');
          if (preUnits !== prevQtyUnits) {
            throw new ValidationError(
              `VALUATION_INTEGRITY_ERROR: رصيد المخزون قبل المرتجع (${fromMinorUnits(preUnits, QTY_SCALE)}) لا يطابق رصيد التقييم (${fromMinorUnits(prevQtyUnits, QTY_SCALE)}).`
            );
          }
        }
        if (input.expectedPostStockQty !== undefined) {
          const postUnits = parseExactUnits(input.expectedPostStockQty, QTY_SCALE, 'expectedPostStockQty');
          if (postUnits !== prevQtyUnits + qtyUnits) {
            throw new ValidationError(
              `VALUATION_INTEGRITY_ERROR: رصيد المخزون بعد المرتجع (${fromMinorUnits(postUnits, QTY_SCALE)}) لا يطابق رصيد التقييم (${fromMinorUnits(prevQtyUnits + qtyUnits, QTY_SCALE)}).`
            );
          }
        }
      }

      const priorReturnMovs = input.deliveryValuationMovementId
        ? await this.valuationRepo.listSalesReturnMovementsByReference(
            companyId,
            input.deliveryValuationMovementId,
            client
          )
        : [];

      let alreadyReturnedQtyUnits = 0n;
      let alreadyReturnedCostUnits = 0n;
      for (const m of priorReturnMovs) {
        alreadyReturnedQtyUnits += parseExactUnits(m.qty, QTY_SCALE, 'priorRetQty');
        alreadyReturnedCostUnits += parseExactUnits(m.totalCost, COST_SCALE, 'priorRetCost');
      }

      const cumulativeReturnedQtyUnits = alreadyReturnedQtyUnits + qtyUnits;
      if (cumulativeReturnedQtyUnits > delQtyUnits) {
        throw new ValidationError(
          `كمية مرتجع المبيعات (${fromMinorUnits(qtyUnits, QTY_SCALE)}) تتجاوز الكمية القابلة للإرجاع من إذن التسليم (${fromMinorUnits(delQtyUnits - alreadyReturnedQtyUnits, QTY_SCALE)}).`
        );
      }

      let restoredTotalUnits = 0n;
      const restoredAllocations: Array<{ layerId: string | null; qtyUnits: bigint; unitCostUnits: bigint; costUnits: bigint }> = [];

      if (method === 'FIFO') {
        if (!input.deliveryValuationMovementId) {
          throw new ValidationError(
            'VALUATION_INTEGRITY_ERROR: مرتجع المبيعات لنظام FIFO يتطلب الارتباط بحركة تقييم التسليم الأصلية لاستعادة الطبقات بدقة.'
          );
        }
        const origAllocs = await this.valuationRepo.listAllocationsForMovement(
          companyId,
          input.deliveryValuationMovementId,
          client
        );
        if (origAllocs.length === 0) {
          throw new ValidationError(
            `VALUATION_INTEGRITY_ERROR: لا توجد تخصيصات طبقات FIFO لحركة التسليم (${input.deliveryValuationMovementId}).`
          );
        }

        let cursor = 0n;
        for (const alloc of origAllocs) {
          const allocQtyU = parseExactUnits(alloc.allocatedQty, QTY_SCALE, 'allocQty');
          const allocCostU = parseExactUnits(alloc.allocatedCost, COST_SCALE, 'allocCost');
          const allocUnitCostU = parseExactUnits(alloc.unitCost, COST_SCALE, 'allocUnitCost');
          const segStart = cursor;
          const segEnd = cursor + allocQtyU;
          cursor = segEnd;

          const ovStart = segStart > alreadyReturnedQtyUnits ? segStart : alreadyReturnedQtyUnits;
          const ovEnd = segEnd < cumulativeReturnedQtyUnits ? segEnd : cumulativeReturnedQtyUnits;
          if (ovEnd <= ovStart) continue;

          const takeQty = ovEnd - ovStart;
          const prevOffset = ovStart - segStart;
          const newOffset = ovEnd - segStart;

          let costAtNew =
            newOffset >= allocQtyU
              ? allocCostU
              : mulExactUnits(newOffset, QTY_SCALE, allocUnitCostU, COST_SCALE, COST_SCALE);
          if (costAtNew > allocCostU) costAtNew = allocCostU;

          let costAtPrev =
            prevOffset === 0n
              ? 0n
              : prevOffset >= allocQtyU
                ? allocCostU
                : mulExactUnits(prevOffset, QTY_SCALE, allocUnitCostU, COST_SCALE, COST_SCALE);
          if (costAtPrev > allocCostU) costAtPrev = allocCostU;

          const takeCost = costAtNew > costAtPrev ? costAtNew - costAtPrev : 0n;
          const layerUnitCostU = divExactUnits(takeCost, COST_SCALE, takeQty, QTY_SCALE, COST_SCALE);

          const origLayer = alloc.costLayerId
            ? await this.valuationRepo.findCostLayerById(companyId, alloc.costLayerId, client)
            : null;

          const createdLayer = await this.valuationRepo.createCostLayer(
            companyId,
            {
              warehouseId: input.warehouseId,
              itemId: input.itemId,
              originalQty: fromMinorUnits(takeQty, QTY_SCALE),
              unitCost: fromMinorUnits(layerUnitCostU, COST_SCALE),
              totalCost: fromMinorUnits(takeCost, COST_SCALE),
              sourceType: 'SALES_RETURN',
              sourceId: input.returnId,
              sourceLineId: input.returnLineId,
              originLayerId: origLayer?.id ?? alloc.costLayerId ?? null,
              originSourceType: origLayer?.originSourceType ?? origLayer?.sourceType ?? 'SALES_RETURN',
              originSourceId: origLayer?.originSourceId ?? origLayer?.sourceId ?? input.returnId,
              originSourceLineId: origLayer?.originSourceLineId ?? origLayer?.sourceLineId ?? input.returnLineId,
              effectiveDate: origLayer?.effectiveDate ?? null,
            },
            client
          );

          restoredTotalUnits += takeCost;
          restoredAllocations.push({
            layerId: createdLayer.id,
            qtyUnits: takeQty,
            unitCostUnits: layerUnitCostU,
            costUnits: takeCost,
          });
        }

        if (cursor < cumulativeReturnedQtyUnits) {
          throw new ValidationError('VALUATION_INTEGRITY_ERROR: مجموع طبقات التسليم الأصلية أقل من الكمية المرتجعة');
        }
      } else {
        // PERPETUAL_MOVING_AVERAGE: restore ONLY at frozen delivery average cost (never current pool average)
        let targetCostUnits: bigint;
        if (cumulativeReturnedQtyUnits >= delQtyUnits) {
          targetCostUnits = delFrozenTotalUnits;
        } else {
          targetCostUnits = divExactUnits(
            delFrozenTotalUnits * cumulativeReturnedQtyUnits,
            COST_SCALE + QTY_SCALE,
            delQtyUnits,
            QTY_SCALE,
            COST_SCALE
          );
        }
        restoredTotalUnits =
          targetCostUnits > alreadyReturnedCostUnits ? targetCostUnits - alreadyReturnedCostUnits : 0n;
        const restoredUnitU = divExactUnits(restoredTotalUnits, COST_SCALE, qtyUnits, QTY_SCALE, COST_SCALE);
        restoredAllocations.push({
          layerId: null,
          qtyUnits,
          unitCostUnits: restoredUnitU,
          costUnits: restoredTotalUnits,
        });
      }

      const newQtyUnits = prevQtyUnits + qtyUnits;
      const newTotalUnits = prevTotalUnits + restoredTotalUnits;
      const newUnitCostUnits =
        newQtyUnits > 0n ? divExactUnits(newTotalUnits, COST_SCALE, newQtyUnits, QTY_SCALE, COST_SCALE) : 0n;
      const effectiveUnitCostUnits = divExactUnits(restoredTotalUnits, COST_SCALE, qtyUnits, QTY_SCALE, COST_SCALE);

      if (stockSyncMode === 'internal') {
        await this.stockRepo.incrementBalance(
          companyId,
          input.warehouseId,
          input.itemId,
          unitsToSafeNumber(qtyUnits, QTY_SCALE),
          client
        );
      }

      const balance = await this.valuationRepo.setValuationBalanceExact(
        companyId,
        input.warehouseId,
        input.itemId,
        fromMinorUnits(newQtyUnits, QTY_SCALE),
        fromMinorUnits(newTotalUnits, COST_SCALE),
        fromMinorUnits(newUnitCostUnits, COST_SCALE),
        client
      );

      const movement = await this.valuationRepo.createValuationMovement(
        companyId,
        {
          warehouseId: input.warehouseId,
          itemId: input.itemId,
          movementType: 'RETURN',
          qty: fromMinorUnits(qtyUnits, QTY_SCALE),
          unitCost: fromMinorUnits(effectiveUnitCostUnits, COST_SCALE),
          totalCost: fromMinorUnits(restoredTotalUnits, COST_SCALE),
          sourceType: 'SALES_RETURN',
          sourceId: input.returnId,
          sourceLineId: input.returnLineId,
          journalEntryId: input.journalEntryId ?? null,
          reason: input.reason ?? 'مرتجع مبيعات بتكلفة التسليم المجمدة الأصلية',
          costSource: 'DELIVERY_FROZEN_COST',
          costingMethod: method,
          referenceMovementId: input.deliveryValuationMovementId ?? null,
          createdBy: userId ?? null,
        },
        client
      );

      for (const alloc of restoredAllocations) {
        await this.valuationRepo.createCostAllocation(
          companyId,
          {
            valuationMovementId: movement.id,
            costLayerId: alloc.layerId,
            allocatedQty: fromMinorUnits(alloc.qtyUnits, QTY_SCALE),
            unitCost: fromMinorUnits(alloc.unitCostUnits, COST_SCALE),
            allocatedCost: fromMinorUnits(alloc.costUnits, COST_SCALE),
          },
          client
        );
      }

      if (method === 'PERPETUAL_MOVING_AVERAGE') {
        const qtyStr = fromMinorUnits(qtyUnits, QTY_SCALE);
        const totalCostStr = fromMinorUnits(restoredTotalUnits, COST_SCALE);

        await this.valuationRepo.upsertMaSourceBalance(
          companyId,
          {
            warehouseId: input.warehouseId,
            itemId: input.itemId,
            sourceType: 'SALES_RETURN',
            sourceId: input.returnId,
            sourceLineId: input.returnLineId,
            originSourceType: 'SALES_RETURN',
            originSourceId: input.returnId,
            originSourceLineId: input.returnLineId,
            grnId: null,
            grnLineId: null,
            receivedQty: qtyStr,
            remainingQty: qtyStr,
            consumedQty: '0.0000',
            originalValue: totalCostStr,
            remainingValue: totalCostStr,
            consumedValue: '0.0000',
          },
          client
        );

        await this.valuationRepo.createMaSourceEvent(
          companyId,
          {
            warehouseId: input.warehouseId,
            itemId: input.itemId,
            sourceType: 'SALES_RETURN',
            sourceId: input.returnId,
            sourceLineId: input.returnLineId,
            originSourceType: 'SALES_RETURN',
            originSourceId: input.returnId,
            originSourceLineId: input.returnLineId,
            grnId: null,
            grnLineId: null,
            eventType: 'SALES_RETURN',
            quantity: qtyStr,
            valueDelta: totalCostStr,
            referenceMovementId: movement.id,
          },
          client
        );
      }

      return {
        balance,
        movement,
        unitCost: unitsToSafeNumber(effectiveUnitCostUnits, COST_SCALE),
        totalCost: unitsToSafeNumber(restoredTotalUnits, COST_SCALE),
        costingMethod: method,
      };
    };

    if (tx) {
      return await execute(tx);
    }
    return await withTenantTransaction(companyId, execute);
  }

  // =========================================================================
  // Opening Valuation & Existing Company Setup Status
  // =========================================================================

  async getSetupStatus(companyId: string): Promise<ValuationSetupStatusSummary> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await withTenantTransaction(companyId, async (tx) => {
      const unassignedItems = await this.valuationRepo.listUnassignedItems(companyId, tx);
      const rowsRes = await tx.query<any>(
        `SELECT
           COALESCE(sb.warehouse_id, vb.warehouse_id, ov.warehouse_id) as "warehouseId",
           w.code as "warehouseCode",
           w.name_ar as "warehouseNameAr",
           COALESCE(sb.item_id, vb.item_id, ov.item_id) as "itemId",
           i.code as "itemCode",
           i.name_ar as "itemNameAr",
           cp.costing_method as "costingMethod",
           cp.name as "profileName",
           COALESCE(sb.qty, 0)::text as "stockQty",
           COALESCE(vb.quantity, 0)::text as "valuationQty",
           COALESCE(vb.total_cost, 0)::text as "valuationTotalCost",
           ov.status as "openingStatus"
         FROM inv_stock_balances sb
         FULL OUTER JOIN inv_valuation_balances vb
           ON vb.company_id = sb.company_id AND vb.warehouse_id = sb.warehouse_id AND vb.item_id = sb.item_id
         LEFT JOIN LATERAL (
           SELECT ov1.warehouse_id, ov1.item_id, ov1.status
           FROM inv_opening_valuations ov1
           WHERE ov1.company_id = COALESCE(sb.company_id, vb.company_id)
             AND ov1.warehouse_id = COALESCE(sb.warehouse_id, vb.warehouse_id)
             AND ov1.item_id = COALESCE(sb.item_id, vb.item_id)
           ORDER BY CASE WHEN ov1.status = 'approved' THEN 0 WHEN ov1.status = 'pending_setup' THEN 1 ELSE 2 END, ov1.created_at DESC
           LIMIT 1
         ) ov ON true
         JOIN inv_warehouses w
           ON w.company_id = COALESCE(sb.company_id, vb.company_id) AND w.id = COALESCE(sb.warehouse_id, vb.warehouse_id)
         JOIN inv_items i
           ON i.company_id = COALESCE(sb.company_id, vb.company_id) AND i.id = COALESCE(sb.item_id, vb.item_id)
         LEFT JOIN inv_item_costing_profiles icp
           ON icp.company_id = i.company_id AND icp.item_id = i.id
         LEFT JOIN inv_costing_profiles cp
           ON cp.company_id = icp.company_id AND cp.id = icp.profile_id AND cp.is_active = true
         WHERE COALESCE(sb.company_id, vb.company_id) = $1
         ORDER BY w.code ASC, i.code ASC;`,
        [companyId]
      );

      let readyCount = 0;
      let blockedCount = 0;
      const warehouseItemStatuses: ValuationSetupStatusItem[] = rowsRes.rows.map((r: any) => {
        const stockQtyUnits = parseExactUnits(r.stockQty || '0', QTY_SCALE, 'stockQty');
        const valQtyUnits = parseExactUnits(r.valuationQty || '0', QTY_SCALE, 'valQty');
        const openingStatus = (r.openingStatus || 'not_created') as ValuationSetupStatusItem['openingStatus'];

        let issueReason: string | null = null;
        if (!r.costingMethod) {
          issueReason = 'لم يتم تعيين ملف تكلفة للصنف';
        } else if (stockQtyUnits !== valQtyUnits) {
          issueReason =
            openingStatus === 'pending_setup'
              ? 'كمية المخزون لم تُعتمد قيمتها الافتتاحية بعد'
              : 'يوجد رصيد مخزني بدون تقييم مطابق — يتطلب تقييماً افتتاحياً معتمداً';
        }

        const isReady = issueReason === null;
        if (isReady) readyCount++;
        else blockedCount++;

        return {
          warehouseId: r.warehouseId,
          warehouseCode: r.warehouseCode,
          warehouseNameAr: r.warehouseNameAr,
          itemId: r.itemId,
          itemCode: r.itemCode,
          itemNameAr: r.itemNameAr,
          costingMethod: r.costingMethod ?? null,
          profileName: r.profileName ?? null,
          stockQty: unitsToSafeNumber(stockQtyUnits, QTY_SCALE),
          valuationQty: unitsToSafeNumber(valQtyUnits, QTY_SCALE),
          valuationTotalCost: unitsToSafeNumber(parseExactUnits(r.valuationTotalCost || '0', COST_SCALE, 'valTotal'), COST_SCALE),
          openingStatus,
          isReady,
          issueReason,
        };
      });

      return {
        companyId,
        unassignedItems,
        warehouseItemStatuses,
        readyCount,
        blockedCount,
      };
    });
  }

  async listOpeningValuations(companyId: string): Promise<OpeningValuationRecord[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.valuationRepo.listOpeningValuations(companyId);
  }

  async createOpeningValuation(
    companyId: string,
    input: OpeningValuationInput,
    userId?: string
  ): Promise<OpeningValuationRecord> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!input.warehouseId || !input.itemId) {
      throw new ValidationError('المستودع والصنف مطلوبان لتسجيل الرصيد الافتتاحي');
    }

    const qtyUnits = parseExactUnits(input.quantity, QTY_SCALE, 'quantity');
    if (qtyUnits <= 0n) {
      throw new ValidationError('كمية الرصيد الافتتاحي يجب أن تكون أكبر من الصفر');
    }

    let totalCostUnits: bigint;
    let unitCostUnits: bigint;
    if (input.totalCost !== undefined && input.totalCost !== null) {
      totalCostUnits = parseExactUnits(input.totalCost, COST_SCALE, 'totalCost');
      if (totalCostUnits <= 0n) {
        throw new ValidationError('التكلفة الإجمالية للرصيد الافتتاحي يجب أن تكون أكبر من الصفر');
      }
      unitCostUnits = divExactUnits(totalCostUnits, COST_SCALE, qtyUnits, QTY_SCALE, COST_SCALE);
    } else if (input.unitCost !== undefined && input.unitCost !== null) {
      unitCostUnits = parseExactUnits(input.unitCost, COST_SCALE, 'unitCost');
      if (unitCostUnits <= 0n) {
        throw new ValidationError('تكلفة الوحدة للرصيد الافتتاحي يجب أن تكون أكبر من الصفر');
      }
      totalCostUnits = mulExactUnits(qtyUnits, QTY_SCALE, unitCostUnits, COST_SCALE, COST_SCALE);
    } else {
      throw new ValidationError('يجب تحديد التكلفة الإجمالية أو تكلفة الوحدة للرصيد الافتتاحي');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const wh = await this.warehouseRepo.findById(companyId, input.warehouseId, tx);
      if (!wh) throw new NotFoundError('المستودع المحدد غير موجود');
      if (wh.isActive === false) throw new ValidationError('المستودع المحدد غير نشط');

      const item = await this.itemRepo.findById(companyId, input.itemId, tx);
      if (!item) throw new NotFoundError('الصنف المحدد غير موجود');
      if (item.isActive === false) throw new ValidationError('الصنف المحدد غير نشط');

      const { method } = await this.getItemCostingMethod(companyId, input.itemId, tx);

      const existingApprovedRes = await tx.query<{ id: string }>(
        `SELECT id FROM inv_opening_valuations WHERE company_id = $1 AND warehouse_id = $2 AND item_id = $3 AND status = 'approved' LIMIT 1;`,
        [companyId, input.warehouseId, input.itemId]
      );
      if (existingApprovedRes.rows.length > 0) {
        throw new ValidationError('يوجد تقييم رصيد افتتاحي معتمد مسبقاً لهذا الصنف في هذا المستودع');
      }

      const record = await this.valuationRepo.createOpeningValuation(
        companyId,
        {
          warehouseId: input.warehouseId,
          itemId: input.itemId,
          costingMethod: method,
          quantity: fromMinorUnits(qtyUnits, QTY_SCALE),
          totalCost: fromMinorUnits(totalCostUnits, COST_SCALE),
          unitCost: fromMinorUnits(unitCostUnits, COST_SCALE),
          reason: input.reason ?? null,
          evidenceRef: input.evidenceRef ?? null,
          createdBy: userId ?? null,
        },
        tx
      );

      await this.auditService.record(
        {
          actorUserId: userId || null,
          companyId,
          action: 'CREATE_OPENING_VALUATION',
          entityType: 'inv_opening_valuation',
          entityId: record.id,
          metadata: {
            warehouseId: input.warehouseId,
            itemId: input.itemId,
            quantity: record.quantity,
            totalCost: record.totalCost,
            costingMethod: method,
          },
        },
        { executor: tx }
      );

      return record;
    });
  }

  async approveOpeningValuation(
    companyId: string,
    openingId: string,
    actorId: string,
    isPlatformAdmin: boolean = false
  ): Promise<OpeningValuationRecord> {
    if (!companyId || !openingId || !actorId) {
      throw new ValidationError('البيانات غير مكتملة لاعتماد التقييم الافتتاحي');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const opening = await this.valuationRepo.findOpeningByIdForUpdate(companyId, openingId, tx);
      if (!opening) throw new NotFoundError('سجل التقييم الافتتاحي غير موجود');
      if (opening.status !== 'pending_setup') {
        throw new ValidationError(`لا يمكن اعتماد سجل تقييم افتتاحي في حالة '${opening.status}'`);
      }

      const { method } = await this.getItemCostingMethod(companyId, opening.itemId, tx);
      if (opening.costingMethod && opening.costingMethod !== method) {
        throw new ValidationError('طريقة التكلفة الحالية للصنف تختلف عن الطريقة المسجلة في الرصيد الافتتاحي');
      }

      const qtyUnits = parseExactUnits(opening.quantity, QTY_SCALE, 'openingQty');
      const totalCostUnits = parseExactUnits(opening.totalCost, COST_SCALE, 'openingTotalCost');
      const unitCostUnits = parseExactUnits(opening.unitCost, COST_SCALE, 'openingUnitCost');

      const curValBal = await this.valuationRepo.lockValuationBalanceForUpdate(
        companyId,
        opening.warehouseId,
        opening.itemId,
        tx
      );
      const curValQtyUnits = curValBal ? parseExactUnits(curValBal.quantity, QTY_SCALE, 'curValQty') : 0n;
      if (curValQtyUnits > 0n) {
        throw new ValidationError('لا يمكن اعتماد تقييم افتتاحي بعد وجود رصيد تقييم نشط لنفس الصنف والمستودع');
      }

      await this.stockRepo.ensureBalanceRow(companyId, opening.warehouseId, opening.itemId, tx);
      const curStockBal = await this.stockRepo.getBalanceForUpdate(companyId, opening.warehouseId, opening.itemId, tx);
      const curStockQtyUnits = curStockBal ? parseExactUnits(curStockBal.qty, QTY_SCALE, 'curStockQty') : 0n;

      if (curStockQtyUnits > 0n && curStockQtyUnits !== qtyUnits) {
        throw new ValidationError(
          `كمية التقييم الافتتاحي (${fromMinorUnits(qtyUnits, QTY_SCALE)}) لا تطابق الكمية الفعلية الموجودة بالمستودع (${fromMinorUnits(curStockQtyUnits, QTY_SCALE)}).`
        );
      }

      // Resolve & verify company settings GL accounts for opening valuation
      const settings = await this.companySettingsRepo.getByCompanyId(companyId, tx);
      const inventoryAccountId = settings?.inventoryAccountId || null;
      const openingEquityAccountId = settings?.openingBalanceEquityAccountId || null;
      if (!inventoryAccountId || !openingEquityAccountId) {
        throw new ValidationError(
          'إعدادات الحسابات المحاسبية للشركة غير مكتملة لاعتماد الرصيد الافتتاحي: يجب تحديد حساب المخزون وحساب رصيد أول المدة في إعدادات الشركة.'
        );
      }
      if (inventoryAccountId === openingEquityAccountId) {
        throw new ValidationError('حساب المخزون وحساب رصيد أول المدة لا يمكن أن يكونا نفس الحساب');
      }

      const invAccount = await this.accountRepo.findById(companyId, inventoryAccountId, tx);
      if (!invAccount || !invAccount.isActive || !invAccount.isPostable || invAccount.accountType !== 'asset') {
        throw new ValidationError('حساب المخزون المحدد في الإعدادات غير صالح أو غير قابل للترحيل');
      }
      const eqAccount = await this.accountRepo.findById(companyId, openingEquityAccountId, tx);
      if (!eqAccount || !eqAccount.isActive || !eqAccount.isPostable) {
        throw new ValidationError('حساب رصيد أول المدة المحدد في الإعدادات غير صالح أو غير قابل للترحيل');
      }

      const openingMoneyUnits = rescaleUnits(totalCostUnits, COST_SCALE, MONEY_SCALE);
      const openingAmountNum = unitsToSafeNumber(openingMoneyUnits, MONEY_SCALE);
      if (openingAmountNum <= 0) {
        throw new ValidationError('القيمة المحاسبية للرصيد الافتتاحي يجب أن تكون أكبر من صفر');
      }

      const today = await resolveCompanyToday(companyId, tx);
      const journalService = await this.getJournalService();
      const draftJe = await journalService.createDraftEntry(
        companyId,
        {
          entryDate: today,
          memo: `تقييم رصيد مخزني افتتاحي — ${opening.reason || openingId}`,
          lines: [
            {
              accountId: inventoryAccountId,
              debit: openingAmountNum,
              credit: 0,
              lineMemo: 'رصيد مخزون أول المدة',
            },
            {
              accountId: openingEquityAccountId,
              debit: 0,
              credit: openingAmountNum,
              lineMemo: 'مقابل رصيد أول المدة للمخزون',
            },
          ],
        },
        actorId,
        isPlatformAdmin,
        tx
      );
      const postedJe = await journalService.postEntry(companyId, draftJe.id, actorId, isPlatformAdmin, tx);

      // Sync stock balance only if stock was 0; if pre-existing unvalued stock equaled qtyUnits, keep stock qty as-is
      if (curStockQtyUnits === 0n) {
        await this.stockRepo.incrementBalance(
          companyId,
          opening.warehouseId,
          opening.itemId,
          unitsToSafeNumber(qtyUnits, QTY_SCALE),
          tx
        );
        await this.stockRepo.createMovement(
          companyId,
          opening.warehouseId,
          opening.itemId,
          'opening',
          unitsToSafeNumber(qtyUnits, QTY_SCALE),
          opening.reason || 'اعتماد الرصيد الافتتاحي المقيّم',
          actorId,
          undefined,
          tx
        );
      }

      if (method === 'FIFO') {
        await this.valuationRepo.createCostLayer(
          companyId,
          {
            warehouseId: opening.warehouseId,
            itemId: opening.itemId,
            originalQty: fromMinorUnits(qtyUnits, QTY_SCALE),
            unitCost: fromMinorUnits(unitCostUnits, COST_SCALE),
            totalCost: fromMinorUnits(totalCostUnits, COST_SCALE),
            sourceType: 'OPENING_VALUATION',
            sourceId: opening.id,
            sourceLineId: null,
            originSourceType: 'OPENING_VALUATION',
            originSourceId: opening.id,
            originSourceLineId: null,
          },
          tx
        );
      }

      await this.valuationRepo.setValuationBalanceExact(
        companyId,
        opening.warehouseId,
        opening.itemId,
        fromMinorUnits(qtyUnits, QTY_SCALE),
        fromMinorUnits(totalCostUnits, COST_SCALE),
        fromMinorUnits(unitCostUnits, COST_SCALE),
        tx
      );

      const movement = await this.valuationRepo.createValuationMovement(
        companyId,
        {
          warehouseId: opening.warehouseId,
          itemId: opening.itemId,
          movementType: 'OPENING',
          qty: fromMinorUnits(qtyUnits, QTY_SCALE),
          unitCost: fromMinorUnits(unitCostUnits, COST_SCALE),
          totalCost: fromMinorUnits(totalCostUnits, COST_SCALE),
          sourceType: 'OPENING_VALUATION',
          sourceId: opening.id,
          sourceLineId: null,
          journalEntryId: postedJe.id,
          reason: opening.reason ?? null,
          costSource: 'OPENING_VALUATION_APPROVED',
          costingMethod: method,
          createdBy: actorId,
        },
        tx
      );

      if (method === 'PERPETUAL_MOVING_AVERAGE') {
        const openQtyStr = fromMinorUnits(qtyUnits, QTY_SCALE);
        const openValStr = fromMinorUnits(totalCostUnits, COST_SCALE);

        await this.valuationRepo.upsertMaSourceBalance(
          companyId,
          {
            warehouseId: opening.warehouseId,
            itemId: opening.itemId,
            sourceType: 'OPENING_VALUATION',
            sourceId: opening.id,
            sourceLineId: null,
            originSourceType: 'OPENING_VALUATION',
            originSourceId: opening.id,
            originSourceLineId: null,
            grnId: null,
            grnLineId: null,
            receivedQty: openQtyStr,
            remainingQty: openQtyStr,
            consumedQty: '0.0000',
            originalValue: openValStr,
            remainingValue: openValStr,
            consumedValue: '0.0000',
          },
          tx
        );

        await this.valuationRepo.createMaSourceEvent(
          companyId,
          {
            warehouseId: opening.warehouseId,
            itemId: opening.itemId,
            sourceType: 'OPENING_VALUATION',
            sourceId: opening.id,
            sourceLineId: null,
            originSourceType: 'OPENING_VALUATION',
            originSourceId: opening.id,
            originSourceLineId: null,
            grnId: null,
            grnLineId: null,
            eventType: 'OPENING',
            quantity: openQtyStr,
            valueDelta: openValStr,
            referenceMovementId: movement.id,
          },
          tx
        );
      }

      const approved = await this.valuationRepo.markOpeningApproved(
        companyId,
        opening.id,
        actorId,
        postedJe.id,
        movement.id,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId,
          companyId,
          action: 'APPROVE_OPENING_VALUATION',
          entityType: 'inv_opening_valuation',
          entityId: opening.id,
          metadata: {
            warehouseId: opening.warehouseId,
            itemId: opening.itemId,
            journalEntryId: postedJe.id,
            valuationMovementId: movement.id,
            totalCost: approved.totalCost,
          },
        },
        { executor: tx }
      );

      return approved;
    });
  }

  async rejectOpeningValuation(
    companyId: string,
    openingId: string,
    rejectionReason: string,
    actorId: string
  ): Promise<OpeningValuationRecord> {
    if (!companyId || !openingId || !rejectionReason?.trim()) {
      throw new ValidationError('سبب الرفض مطلوب لرفض التقييم الافتتاحي');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const opening = await this.valuationRepo.findOpeningByIdForUpdate(companyId, openingId, tx);
      if (!opening) throw new NotFoundError('سجل التقييم الافتتاحي غير موجود');
      if (opening.status !== 'pending_setup') {
        throw new ValidationError(`لا يمكن رفض سجل تقييم افتتاحي في حالة '${opening.status}'`);
      }

      const rejected = await this.valuationRepo.markOpeningRejected(
        companyId,
        openingId,
        actorId,
        rejectionReason.trim(),
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId,
          companyId,
          action: 'REJECT_OPENING_VALUATION',
          entityType: 'inv_opening_valuation',
          entityId: openingId,
          metadata: { rejectionReason: rejectionReason.trim() },
        },
        { executor: tx }
      );

      return rejected;
    });
  }

  // =========================================================================
  // Inventory-to-GL Reconciliation (Auditable, zero automatic balancing JEs)
  // =========================================================================

  async listReconciliations(companyId: string): Promise<ValuationReconciliationRecord[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.valuationRepo.listReconciliations(companyId);
  }

  async runReconciliation(
    companyId: string,
    input: ValuationReconciliationInput,
    actorId?: string
  ): Promise<ValuationReconciliationRecord> {
    if (!companyId) throw new ValidationError('companyId is required');

    return await withTenantTransaction(companyId, async (tx) => {
      const settings = await this.companySettingsRepo.getByCompanyId(companyId, tx);
      const inventoryAccountId = settings?.inventoryAccountId || null;
      if (!inventoryAccountId) {
        throw new ValidationError('يجب تحديد حساب المخزون في إعدادات الشركة قبل تشغيل تسوية المخزون مع الأستاذ العام');
      }

      let periodEndDate: string | null = null;
      if (input.periodId) {
        const periodRes = await tx.query<{ end_date: string }>(
          `SELECT end_date::text as end_date FROM accounting_periods WHERE company_id = $1 AND id = $2;`,
          [companyId, input.periodId]
        );
        if (periodRes.rows.length === 0) {
          throw new NotFoundError('الفترة المحاسبية المحددة غير موجودة');
        }
        periodEndDate = periodRes.rows[0].end_date;
      }

      const hasScopedFilter = Boolean(input.warehouseId || input.itemId || input.costingMethod);
      const isHistoricalPeriod = Boolean(input.periodId) && !hasScopedFilter;

      // 1. Subledger Valuation Total (filtered cleanly by warehouse/item/costingMethod)
      const subClauses = ['vb.company_id = $1'];
      const subParams: any[] = [companyId];
      if (input.warehouseId) {
        subParams.push(input.warehouseId);
        subClauses.push(`vb.warehouse_id = $${subParams.length}`);
      }
      if (input.itemId) {
        subParams.push(input.itemId);
        subClauses.push(`vb.item_id = $${subParams.length}`);
      }
      if (input.costingMethod) {
        subParams.push(input.costingMethod);
        subClauses.push(`cp.costing_method = $${subParams.length}`);
      }
      const subRes = await tx.query<{ total: string }>(
        `SELECT COALESCE(SUM(vb.total_cost), 0)::text as total
         FROM inv_valuation_balances vb
         LEFT JOIN inv_item_costing_profiles icp ON icp.company_id = vb.company_id AND icp.item_id = vb.item_id
         LEFT JOIN inv_costing_profiles cp ON cp.company_id = icp.company_id AND cp.id = icp.profile_id
         WHERE ${subClauses.join(' AND ')};`,
        subParams
      );
      let subledgerTotalUnits = parseExactUnits(subRes.rows[0]?.total || '0', COST_SCALE, 'subledgerTotal');

      // Diagnostic scope filters when filtered reconciliation is requested
      const vmClauses = [
        'vm.company_id = $1',
        `vm.movement_type NOT IN ('TRANSFER_OUT', 'TRANSFER_IN')`,
        'vm.journal_entry_id IS NULL',
        // Deliveries post their COGS journal at invoice time via inv_sales_cogs_links, not on the movement itself;
        // a movement with a posted COGS link is linked, not unmatched.
        `NOT EXISTS (
          SELECT 1 FROM inv_sales_cogs_links scl
          WHERE scl.company_id = vm.company_id
            AND scl.valuation_movement_id = vm.id
            AND scl.journal_entry_id IS NOT NULL
        )`,
      ];
      const vmParams: any[] = [companyId];
      const caClauses = ['ca.company_id = $1', `((ca.remaining_allocation + ca.consumed_allocation) <> ca.adjustment_amount OR (ca.status = 'posted' AND ca.journal_entry_id IS NULL))`];
      const caParams: any[] = [companyId];
      const dupMovClauses = ['vm.company_id = $1', 'vm.journal_entry_id IS NOT NULL'];
      const dupMovParams: any[] = [companyId];
      const dupAdjClauses = ['ca.company_id = $1', 'ca.journal_entry_id IS NOT NULL'];
      const dupAdjParams: any[] = [companyId];
      const openClauses = ['company_id = $1', `status = 'approved'`];
      const openParams: any[] = [companyId];

      if (hasScopedFilter) {
        if (input.warehouseId) {
          vmParams.push(input.warehouseId);
          vmClauses.push(`vm.warehouse_id = $${vmParams.length}`);
          caParams.push(input.warehouseId);
          caClauses.push(`ca.warehouse_id = $${caParams.length}`);
          dupMovParams.push(input.warehouseId);
          dupMovClauses.push(`vm.warehouse_id = $${dupMovParams.length}`);
          dupAdjParams.push(input.warehouseId);
          dupAdjClauses.push(`ca.warehouse_id = $${dupAdjParams.length}`);
          openParams.push(input.warehouseId);
          openClauses.push(`warehouse_id = $${openParams.length}`);
        }
        if (input.itemId) {
          vmParams.push(input.itemId);
          vmClauses.push(`vm.item_id = $${vmParams.length}`);
          caParams.push(input.itemId);
          caClauses.push(`ca.item_id = $${caParams.length}`);
          dupMovParams.push(input.itemId);
          dupMovClauses.push(`vm.item_id = $${dupMovParams.length}`);
          dupAdjParams.push(input.itemId);
          dupAdjClauses.push(`ca.item_id = $${dupAdjParams.length}`);
          openParams.push(input.itemId);
          openClauses.push(`item_id = $${openParams.length}`);
        }
        if (input.costingMethod) {
          vmParams.push(input.costingMethod);
          vmClauses.push(`vm.costing_method = $${vmParams.length}`);
          caParams.push(input.costingMethod);
          caClauses.push(`ca.costing_method = $${caParams.length}`);
          dupMovParams.push(input.costingMethod);
          dupMovClauses.push(`vm.costing_method = $${dupMovParams.length}`);
          dupAdjParams.push(input.costingMethod);
          dupAdjClauses.push(`ca.costing_method = $${dupAdjParams.length}`);
          openParams.push(input.costingMethod);
          openClauses.push(`costing_method = $${openParams.length}`);
        }
      }

      // 3. Unmatched non-transfer valuation movements (missing journal link)
      const unmatchedRes = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int as cnt
         FROM inv_valuation_movements vm
         WHERE ${vmClauses.join(' AND ')};`,
        vmParams
      );
      const unmatchedMovementsCount = Number(unmatchedRes.rows[0]?.cnt || 0);

      // 4. Unbalanced PPV/cost adjustments or missing journal link
      const adjMismatchRes = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int as cnt
         FROM inv_cost_adjustments ca
         WHERE ${caClauses.join(' AND ')};`,
        caParams
      );
      const unbalancedAdjustmentsCount = Number(adjMismatchRes.rows[0]?.cnt || 0);

      // 5. Duplicate journal links across distinct sources
      let duplicateJournalLinksCount = 0;
      if (hasScopedFilter) {
        const dupMovRes = await tx.query<{ cnt: number }>(
          `SELECT COUNT(*)::int as cnt FROM (
             SELECT vm.journal_entry_id
             FROM inv_valuation_movements vm
             WHERE ${dupMovClauses.join(' AND ')}
             GROUP BY vm.journal_entry_id
             HAVING COUNT(DISTINCT vm.source_id) > 1
           ) x;`,
          dupMovParams
        );
        const dupAdjRes = await tx.query<{ cnt: number }>(
          `SELECT COUNT(*)::int as cnt FROM (
             SELECT ca.journal_entry_id
             FROM inv_cost_adjustments ca
             WHERE ${dupAdjClauses.join(' AND ')}
             GROUP BY ca.journal_entry_id
             HAVING COUNT(DISTINCT ca.invoice_id) > 1
           ) y;`,
          dupAdjParams
        );
        duplicateJournalLinksCount = Number(dupMovRes.rows[0]?.cnt || 0) + Number(dupAdjRes.rows[0]?.cnt || 0);
      } else {
        const dupRes = await tx.query<{ cnt: number }>(
          `SELECT (
             (SELECT COUNT(*)::int FROM (
               SELECT journal_entry_id
               FROM inv_valuation_movements
               WHERE company_id = $1 AND journal_entry_id IS NOT NULL
               GROUP BY journal_entry_id
               HAVING COUNT(DISTINCT source_id) > 1
             ) x)
             +
             (SELECT COUNT(*)::int FROM (
               SELECT journal_entry_id
               FROM inv_cost_adjustments
               WHERE company_id = $1 AND journal_entry_id IS NOT NULL
               GROUP BY journal_entry_id
               HAVING COUNT(DISTINCT invoice_id) > 1
             ) y)
           )::int as cnt;`,
          [companyId]
        );
        duplicateJournalLinksCount = Number(dupRes.rows[0]?.cnt || 0);
      }

      // 6. Qty vs Valuation Qty vs FIFO Layer Sum Mismatches
      const qtyFilterClauses = ['COALESCE(sb.company_id, vb.company_id) = $1'];
      const qtyFilterParams: any[] = [companyId];
      if (hasScopedFilter) {
        if (input.warehouseId) {
          qtyFilterParams.push(input.warehouseId);
          qtyFilterClauses.push(`COALESCE(sb.warehouse_id, vb.warehouse_id) = $${qtyFilterParams.length}`);
        }
        if (input.itemId) {
          qtyFilterParams.push(input.itemId);
          qtyFilterClauses.push(`COALESCE(sb.item_id, vb.item_id) = $${qtyFilterParams.length}`);
        }
        if (input.costingMethod) {
          qtyFilterParams.push(input.costingMethod);
          qtyFilterClauses.push(`cp.costing_method = $${qtyFilterParams.length}`);
        }
      }
      const qtyMismatchRes = await tx.query<{ cnt: number }>(
        `SELECT COUNT(*)::int as cnt
         FROM inv_stock_balances sb
         FULL OUTER JOIN inv_valuation_balances vb
           ON vb.company_id = sb.company_id AND vb.warehouse_id = sb.warehouse_id AND vb.item_id = sb.item_id
         LEFT JOIN inv_item_costing_profiles icp
           ON icp.company_id = COALESCE(sb.company_id, vb.company_id) AND icp.item_id = COALESCE(sb.item_id, vb.item_id)
         LEFT JOIN inv_costing_profiles cp
           ON cp.company_id = icp.company_id AND cp.id = icp.profile_id
         LEFT JOIN (
           SELECT company_id, warehouse_id, item_id, COALESCE(SUM(remaining_qty), 0) as layer_qty
           FROM inv_cost_layers
           WHERE company_id = $1 AND is_exhausted = false AND remaining_qty > 0
           GROUP BY company_id, warehouse_id, item_id
         ) cl
           ON cl.company_id = COALESCE(sb.company_id, vb.company_id)
          AND cl.warehouse_id = COALESCE(sb.warehouse_id, vb.warehouse_id)
          AND cl.item_id = COALESCE(sb.item_id, vb.item_id)
         WHERE ${qtyFilterClauses.join(' AND ')}
           AND (
             COALESCE(sb.qty, 0) <> COALESCE(vb.quantity, 0)
             OR (cp.costing_method = 'FIFO' AND COALESCE(vb.quantity, 0) <> COALESCE(cl.layer_qty, 0))
           );`,
        qtyFilterParams
      );
      const qtyValuationMismatchesCount = Number(qtyMismatchRes.rows[0]?.cnt || 0);

      // 7. Opening balance difference
      let openingDiffUnits = 0n;
      if (hasScopedFilter) {
        const scopedOpenRes = await tx.query<{ diff: string }>(
          `WITH openings AS (
             SELECT COALESCE(SUM(total_cost), 0) as sub_open,
                    ARRAY_AGG(journal_entry_id) FILTER (WHERE journal_entry_id IS NOT NULL) as je_ids
             FROM inv_opening_valuations
             WHERE ${openClauses.join(' AND ')}
           ),
           gl_open AS (
             SELECT COALESCE(SUM(l.debit - l.credit), 0) as gl_open
             FROM journal_lines l
             JOIN openings o ON l.entry_id = ANY(o.je_ids)
             WHERE l.company_id = $1 AND l.account_id = $${openParams.length + 1}
           )
           SELECT (o.sub_open - g.gl_open)::text as diff FROM openings o, gl_open g;`,
          [...openParams, inventoryAccountId]
        );
        openingDiffUnits = parseExactUnits(scopedOpenRes.rows[0]?.diff || '0', COST_SCALE, 'openingDiff');
      } else {
        const openingDiffRes = await tx.query<{ diff: string }>(
          `WITH openings AS (
             SELECT COALESCE(SUM(total_cost), 0) as sub_open,
                    ARRAY_AGG(journal_entry_id) FILTER (WHERE journal_entry_id IS NOT NULL) as je_ids
             FROM inv_opening_valuations
             WHERE company_id = $1 AND status = 'approved'
           ),
           gl_open AS (
             SELECT COALESCE(SUM(l.debit - l.credit), 0) as gl_open
             FROM journal_lines l
             JOIN openings o ON l.entry_id = ANY(o.je_ids)
             WHERE l.company_id = $1 AND l.account_id = $2
           )
           SELECT (o.sub_open - g.gl_open)::text as diff FROM openings o, gl_open g;`,
          [companyId, inventoryAccountId]
        );
        openingDiffUnits = parseExactUnits(openingDiffRes.rows[0]?.diff || '0', COST_SCALE, 'openingDiff');
      }

      // Filtered run -> SUBLEDGER_ONLY (never compare filtered warehouse/item/method subledger against whole-company GL)
      if (hasScopedFilter) {
        const record = await this.valuationRepo.saveReconciliation(
          companyId,
          {
            warehouseId: input.warehouseId ?? null,
            itemId: input.itemId ?? null,
            costingMethod: input.costingMethod ?? null,
            periodId: input.periodId ?? null,
            accountId: inventoryAccountId,
            comparisonScope: 'SUBLEDGER_ONLY',
            isGlComparable: false,
            subledgerTotal: fromMinorUnits(subledgerTotalUnits, COST_SCALE),
            glControlTotal: '0.0000',
            variance: '0.0000',
            status: 'subledger_only',
            unmatchedMovementsCount,
            unbalancedAdjustmentsCount,
            duplicateJournalLinksCount,
            qtyValuationMismatchesCount,
            openingDiff: fromMinorUnits(openingDiffUnits, COST_SCALE),
            details: {
              comparisonScope: 'SUBLEDGER_ONLY',
              scopedFilterApplied: true,
              periodEndDate,
              filters: {
                warehouseId: input.warehouseId ?? null,
                itemId: input.itemId ?? null,
                costingMethod: input.costingMethod ?? null,
              },
              diagnostics: {
                unmatchedMovementsCount,
                unbalancedAdjustmentsCount,
                duplicateJournalLinksCount,
                qtyValuationMismatchesCount,
                openingDiff: fromMinorUnits(openingDiffUnits, COST_SCALE),
              },
            },
            notes: input.notes ?? 'تقييم مرشّح للدفتر الفرعي فقط (لا يُقارن برصيد حساب مراقبة الأستاذ العام للشركة)',
            reconciledBy: actorId ?? null,
          },
          tx
        );

        await this.auditService.record(
          {
            actorUserId: actorId || null,
            companyId,
            action: 'RUN_INVENTORY_GL_RECONCILIATION',
            entityType: 'inv_valuation_reconciliation',
            entityId: record.id,
            metadata: {
              status: record.status,
              comparisonScope: record.comparisonScope,
              isGlComparable: record.isGlComparable,
              subledgerTotal: record.subledgerTotal,
              glControlTotal: record.glControlTotal,
              variance: record.variance,
              qtyValuationMismatchesCount,
              unmatchedMovementsCount,
            },
          },
          { executor: tx }
        );

        return record;
      }

      // 2. GL Control Account Net Posted Balance (Debit - Credit)
      const glRes = await tx.query<{ netBalance: string }>(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0)::text as "netBalance"
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
         WHERE l.company_id = $1
           AND l.account_id = $2
           AND e.status = 'posted'
           AND ($3::date IS NULL OR e.entry_date <= $3::date);`,
        [companyId, inventoryAccountId, periodEndDate]
      );
      const glControlTotalUnits = parseExactUnits(glRes.rows[0]?.netBalance || '0', COST_SCALE, 'glControlTotal');

      if (isHistoricalPeriod && periodEndDate) {
        // Reconstruct point-in-time historical subledger rather than comparing current subledger against historical GL.
        const histRes = await tx.query<{
          ambiguousAdjCount: number;
          crossPeriodUnlinkedCount: number;
          inflowTotal: string;
          outflowTotal: string;
          adjRemTotal: string;
        }>(
          `WITH period_movs AS (
             SELECT vm.id, vm.movement_type, vm.source_type, vm.total_cost, vm.journal_entry_id,
                    vm.created_at::date as mov_date,
                    je.entry_date as je_date,
                    je.status as je_status
             FROM inv_valuation_movements vm
             LEFT JOIN journal_entries je ON je.id = vm.journal_entry_id AND je.company_id = vm.company_id
             WHERE vm.company_id = $1
               AND (
                 (je.id IS NOT NULL AND je.status = 'posted' AND je.entry_date <= $2::date)
                 OR (je.id IS NULL AND vm.created_at::date <= $2::date)
               )
           ),
           period_adjs AS (
             SELECT ca.remaining_allocation, ca.journal_entry_id, je.entry_date as je_date, je.status as je_status
             FROM inv_cost_adjustments ca
             LEFT JOIN journal_entries je ON je.id = ca.journal_entry_id AND je.company_id = ca.company_id
             WHERE ca.company_id = $1
               AND ca.status = 'posted'
               AND je.id IS NOT NULL
               AND je.status = 'posted'
               AND je.entry_date <= $2::date
           ),
           adj_after_or_unlinked AS (
             SELECT COUNT(*)::int as cnt
             FROM inv_cost_adjustments ca
             LEFT JOIN journal_entries je ON je.id = ca.journal_entry_id AND je.company_id = ca.company_id
             WHERE ca.company_id = $1
               AND ca.created_at::date <= $2::date
               AND (je.id IS NULL OR je.status <> 'posted' OR je.entry_date > $2::date)
           )
           SELECT
             COALESCE((SELECT COUNT(*)::int FROM period_movs WHERE movement_type = 'ADJUSTMENT'), 0) as "ambiguousAdjCount",
             COALESCE((SELECT COUNT(*)::int FROM period_movs WHERE movement_type NOT IN ('TRANSFER_OUT', 'TRANSFER_IN') AND (journal_entry_id IS NULL OR je_status <> 'posted') AND NOT EXISTS (
                 SELECT 1 FROM inv_sales_cogs_links scl
                 WHERE scl.company_id = $1
                   AND scl.valuation_movement_id = period_movs.id
                   AND scl.journal_entry_id IS NOT NULL
               )), 0)
               + COALESCE((SELECT cnt FROM adj_after_or_unlinked), 0) as "crossPeriodUnlinkedCount",
             COALESCE((SELECT SUM(total_cost) FROM period_movs WHERE movement_type IN ('RECEIVE', 'OPENING', 'TRANSFER_IN') OR (movement_type = 'RETURN' AND source_type = 'SALES_RETURN')), 0)::text as "inflowTotal",
             COALESCE((SELECT SUM(total_cost) FROM period_movs WHERE movement_type IN ('ISSUE', 'TRANSFER_OUT') OR (movement_type = 'RETURN' AND source_type = 'PURCHASE_RETURN')), 0)::text as "outflowTotal",
             COALESCE((SELECT SUM(remaining_allocation) FROM period_adjs), 0)::text as "adjRemTotal";`,
          [companyId, periodEndDate]
        );

        const row = histRes.rows[0];
        const ambiguousAdjCount = Number(row?.ambiguousAdjCount || 0);
        const crossPeriodUnlinkedCount = Number(row?.crossPeriodUnlinkedCount || 0);
        const inflowUnits = parseExactUnits(row?.inflowTotal || '0', COST_SCALE, 'histInflow');
        const outflowUnits = parseExactUnits(row?.outflowTotal || '0', COST_SCALE, 'histOutflow');
        const adjRemUnits = parseExactUnits(row?.adjRemTotal || '0', COST_SCALE, 'histAdjRem');
        const reconstructedUnits = inflowUnits - outflowUnits + adjRemUnits;

        const cannotReconstruct =
          ambiguousAdjCount > 0 ||
          crossPeriodUnlinkedCount > 0 ||
          reconstructedUnits < 0n;

        if (cannotReconstruct) {
          const reasonMsg =
            ambiguousAdjCount > 0
              ? 'يتعذر إعادة بناء رصيد الدفتر الفرعي التاريخي بدقة لوجود حركات تسوية غير موقعة الاتجاه في الفترة.'
              : crossPeriodUnlinkedCount > 0
                ? 'يتعذر إعادة بناء رصيد الدفتر الفرعي التاريخي بدقة لوجود حركات أو فروق أسعار غير مرتبطة بقيود مرحلة في نطاق الفترة.'
                : 'تعذر إعادة بناء رصيد تاريخي متسق للدفتر الفرعي نهاية الفترة.';

          const record = await this.valuationRepo.saveReconciliation(
            companyId,
            {
              warehouseId: null,
              itemId: null,
              costingMethod: null,
              periodId: input.periodId ?? null,
              accountId: inventoryAccountId,
              comparisonScope: 'HISTORICAL_GL',
              isGlComparable: false,
              subledgerTotal: fromMinorUnits(subledgerTotalUnits, COST_SCALE),
              glControlTotal: fromMinorUnits(glControlTotalUnits, COST_SCALE),
              variance: '0.0000',
              status: 'historical_unavailable',
              unmatchedMovementsCount,
              unbalancedAdjustmentsCount,
              duplicateJournalLinksCount,
              qtyValuationMismatchesCount,
              openingDiff: fromMinorUnits(openingDiffUnits, COST_SCALE),
              details: {
                comparisonScope: 'HISTORICAL_GL',
                periodEndDate,
                ambiguousAdjCount,
                crossPeriodUnlinkedCount,
                historicalReason: reasonMsg,
              },
              notes: input.notes ?? reasonMsg,
              reconciledBy: actorId ?? null,
            },
            tx
          );

          await this.auditService.record(
            {
              actorUserId: actorId || null,
              companyId,
              action: 'RUN_INVENTORY_GL_RECONCILIATION',
              entityType: 'inv_valuation_reconciliation',
              entityId: record.id,
              metadata: {
                status: record.status,
                comparisonScope: record.comparisonScope,
                isGlComparable: record.isGlComparable,
                periodEndDate,
              },
            },
            { executor: tx }
          );

          return record;
        }

        subledgerTotalUnits = reconstructedUnits;
      }

      const varianceUnits = subledgerTotalUnits - glControlTotalUnits;
      const comparisonScope = isHistoricalPeriod ? 'HISTORICAL_GL' : 'COMPANY_GL';
      const isReconciled =
        varianceUnits === 0n &&
        unmatchedMovementsCount === 0 &&
        unbalancedAdjustmentsCount === 0 &&
        duplicateJournalLinksCount === 0 &&
        qtyValuationMismatchesCount === 0 &&
        openingDiffUnits === 0n;

      const record = await this.valuationRepo.saveReconciliation(
        companyId,
        {
          warehouseId: input.warehouseId ?? null,
          itemId: input.itemId ?? null,
          costingMethod: input.costingMethod ?? null,
          periodId: input.periodId ?? null,
          accountId: inventoryAccountId,
          comparisonScope,
          isGlComparable: true,
          subledgerTotal: fromMinorUnits(subledgerTotalUnits, COST_SCALE),
          glControlTotal: fromMinorUnits(glControlTotalUnits, COST_SCALE),
          variance: fromMinorUnits(varianceUnits, COST_SCALE),
          status: isReconciled ? 'reconciled' : 'discrepancy_detected',
          unmatchedMovementsCount,
          unbalancedAdjustmentsCount,
          duplicateJournalLinksCount,
          qtyValuationMismatchesCount,
          openingDiff: fromMinorUnits(openingDiffUnits, COST_SCALE),
          details: {
            comparisonScope,
            scopedFilterApplied: false,
            periodEndDate,
            reconstructedFromHistoricalLedger: isHistoricalPeriod,
          },
          notes: input.notes ?? (isHistoricalPeriod ? `تسوية تاريخية للدفتر الفرعي والأستاذ العام حتى ${periodEndDate}` : null),
          reconciledBy: actorId ?? null,
        },
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'RUN_INVENTORY_GL_RECONCILIATION',
          entityType: 'inv_valuation_reconciliation',
          entityId: record.id,
          metadata: {
            status: record.status,
            comparisonScope: record.comparisonScope,
            isGlComparable: record.isGlComparable,
            subledgerTotal: record.subledgerTotal,
            glControlTotal: record.glControlTotal,
            variance: record.variance,
            qtyValuationMismatchesCount,
            unmatchedMovementsCount,
          },
        },
        { executor: tx }
      );

      return record;
    });
  }
}

export const defaultInventoryValuationService = new InventoryValuationService();
