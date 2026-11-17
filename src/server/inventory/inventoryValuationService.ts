import { DbExecutor } from '../db/types.js';
import { defaultInventoryValuationRepository, InventoryValuationRepository } from './inventoryValuationRepository.js';
import { defaultWarehouseRepository, WarehouseRepository } from './warehouseRepository.js';
import { defaultItemRepository, ItemRepository } from './itemRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { CostingProfile, CostingMethod, ItemCostingAssignment, ValuationBalance, CostLayer, ValuationMovement } from './inventoryValuationTypes.js';

export class InventoryValuationService {
  constructor(
    private valuationRepo: InventoryValuationRepository = defaultInventoryValuationRepository,
    private warehouseRepo: WarehouseRepository = defaultWarehouseRepository,
    private itemRepo: ItemRepository = defaultItemRepository,
    private auditService: AuditService = defaultAuditService
  ) {}

  async listProfiles(companyId: string): Promise<CostingProfile[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.valuationRepo.listProfiles(companyId);
  }

  async createProfile(companyId: string, input: { name: string; costingMethod: CostingMethod; isDefault?: boolean }, userId?: string): Promise<CostingProfile> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!input.name || !input.costingMethod) throw new ValidationError('اسم ملف التكلفة وطريقة التكلفة مطلوبان');
    if (!['FIFO', 'PERPETUAL_MOVING_AVERAGE'].includes(input.costingMethod)) {
      throw new ValidationError('طريقة التكلفة غير صالحة. الطرق المدعومة هي FIFO أو PERPETUAL_MOVING_AVERAGE');
    }
    return await withTenantTransaction(companyId, async (tx) => {
      const profile = await this.valuationRepo.createProfile(companyId, input, tx);
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

  async getItemAssignment(companyId: string, itemId: string): Promise<ItemCostingAssignment | null> {
    if (!companyId || !itemId) throw new ValidationError('companyId and itemId are required');
    return await this.valuationRepo.getItemAssignment(companyId, itemId);
  }

  async assignItemProfile(companyId: string, itemId: string, profileId: string, userId?: string): Promise<ItemCostingAssignment> {
    if (!companyId || !itemId || !profileId) throw new ValidationError('البيانات غير مكتملة');
    return await withTenantTransaction(companyId, async (tx) => {
      const profile = await this.valuationRepo.findProfileById(companyId, profileId, tx);
      if (!profile) throw new NotFoundError('ملف التكلفة المحدد غير موجود');
      if (!profile.isActive) throw new ValidationError('ملف التكلفة المحدد غير نشط');

      const item = await this.itemRepo.findById(companyId, itemId, tx);
      if (!item) throw new NotFoundError('الصنف المحدد غير موجود');

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

  async getItemCostingMethod(companyId: string, itemId: string, client?: DbExecutor): Promise<CostingMethod> {
    const assignment = await this.valuationRepo.getItemAssignment(companyId, itemId, client);
    if (assignment && assignment.costingMethod) {
      return assignment.costingMethod;
    }
    return 'FIFO';
  }

  /**
   * Process stock receipt (GRN, opening balance, manual receive, return, transfer in)
   */
  async processReceipt(
    companyId: string,
    input: {
      warehouseId: string;
      itemId: string;
      qty: number;
      unitCost: number;
      sourceType: string;
      sourceId: string;
      sourceLineId?: string | null;
      journalEntryId?: string | null;
      movementType?: 'RECEIVE' | 'TRANSFER_IN' | 'OPENING' | 'RETURN' | 'ADJUSTMENT';
    },
    userId?: string,
    tx?: DbExecutor
  ): Promise<{ balance: ValuationBalance; movement: ValuationMovement }> {
    if (input.qty <= 0) throw new ValidationError('كمية الاستلام يجب أن تكون أكبر من الصفر');
    if (input.unitCost < 0) throw new ValidationError('تكلفة الوحدة لا يمكن أن تكون سالبة');

    const totalCost = Number((input.qty * input.unitCost).toFixed(4));
    const movementType = input.movementType || 'RECEIVE';

    const execute = async (client: DbExecutor) => {
      await this.valuationRepo.lockValuationBalanceForUpdate(companyId, input.warehouseId, input.itemId, client);

      const method = await this.getItemCostingMethod(companyId, input.itemId, client);

      if (method === 'FIFO' || movementType === 'OPENING' || movementType === 'RECEIVE' || movementType === 'RETURN') {
        await this.valuationRepo.createCostLayer(
          companyId,
          {
            warehouseId: input.warehouseId,
            itemId: input.itemId,
            originalQty: input.qty,
            unitCost: input.unitCost,
            totalCost,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            sourceLineId: input.sourceLineId,
          },
          client
        );
      }

      const balance = await this.valuationRepo.updateValuationBalance(
        companyId,
        input.warehouseId,
        input.itemId,
        input.qty,
        totalCost,
        client
      );

      const movement = await this.valuationRepo.createValuationMovement(
        companyId,
        {
          warehouseId: input.warehouseId,
          itemId: input.itemId,
          movementType,
          qty: input.qty,
          unitCost: input.unitCost,
          totalCost,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          sourceLineId: input.sourceLineId,
          journalEntryId: input.journalEntryId,
          createdBy: userId,
        },
        client
      );

      return { balance, movement };
    };

    if (tx) {
      return await execute(tx);
    } else {
      return await withTenantTransaction(companyId, async (client) => {
        return await execute(client);
      });
    }
  }

  /**
   * Process stock issue with strict no-negative stock protection & FIFO/Moving Average cost calculation.
   */
  async processIssue(
    companyId: string,
    input: {
      warehouseId: string;
      itemId: string;
      qty: number;
      sourceType: string;
      sourceId: string;
      sourceLineId?: string | null;
      journalEntryId?: string | null;
      movementType?: 'ISSUE' | 'TRANSFER_OUT' | 'ADJUSTMENT';
    },
    userId?: string,
    tx?: DbExecutor
  ): Promise<{ balance: ValuationBalance; movement: ValuationMovement; unitCost: number; totalCost: number }> {
    if (input.qty <= 0) throw new ValidationError('كمية الصرف يجب أن تكون أكبر من الصفر');
    const movementType = input.movementType || 'ISSUE';

    const execute = async (client: DbExecutor) => {
      const currentBalance = await this.valuationRepo.lockValuationBalanceForUpdate(companyId, input.warehouseId, input.itemId, client);
      const availableQty = currentBalance ? Number(currentBalance.quantity) : 0;

      if (availableQty < input.qty) {
        const item = await this.itemRepo.findById(companyId, input.itemId, client);
        throw new ValidationError(
          `رصيد مخزني غير كافٍ للصنف (${item?.code || input.itemId}). المتاح: ${availableQty}، المطلوب للصرف: ${input.qty}. لا يمكن السماح برصيد بالسالب.`
        );
      }

      const method = await this.getItemCostingMethod(companyId, input.itemId, client);
      let totalIssuedCost = 0;
      const allocatedLayers: { layerId: string | null; qty: number; unitCost: number; cost: number }[] = [];

      if (method === 'FIFO') {
        const layers = await this.valuationRepo.listActiveCostLayersForUpdate(companyId, input.warehouseId, input.itemId, client);
        let remainingToIssue = input.qty;

        for (const layer of layers) {
          if (remainingToIssue <= 0) break;
          const layerRem = Number(layer.remainingQty);
          if (layerRem <= 0) continue;

          const takeQty = Math.min(remainingToIssue, layerRem);
          const takeCost = Number((takeQty * Number(layer.unitCost)).toFixed(4));
          totalIssuedCost += takeCost;

          const newLayerRem = Number((layerRem - takeQty).toFixed(4));
          const newLayerTotal = Number((Number(layer.totalCost) - takeCost).toFixed(4));
          const isExh = newLayerRem <= 0;

          await this.valuationRepo.updateCostLayerRemaining(companyId, layer.id, newLayerRem, Math.max(0, newLayerTotal), isExh, client);

          allocatedLayers.push({
            layerId: layer.id,
            qty: takeQty,
            unitCost: Number(layer.unitCost),
            cost: takeCost,
          });

          remainingToIssue = Number((remainingToIssue - takeQty).toFixed(4));
        }

        if (remainingToIssue > 0) {
          const fallbackUnitCost = currentBalance && Number(currentBalance.quantity) > 0 ? Number(currentBalance.unitCost) : 0;
          const fallbackCost = Number((remainingToIssue * fallbackUnitCost).toFixed(4));
          totalIssuedCost += fallbackCost;
          allocatedLayers.push({
            layerId: null,
            qty: remainingToIssue,
            unitCost: fallbackUnitCost,
            cost: fallbackCost,
          });
        }
      } else {
        const currentAvgUnitCost = currentBalance && Number(currentBalance.quantity) > 0 ? Number(currentBalance.unitCost) : 0;
        totalIssuedCost = Number((input.qty * currentAvgUnitCost).toFixed(4));
        allocatedLayers.push({
          layerId: null,
          qty: input.qty,
          unitCost: currentAvgUnitCost,
          cost: totalIssuedCost,
        });
      }

      totalIssuedCost = Number(totalIssuedCost.toFixed(4));
      const effectiveUnitCost = Number((totalIssuedCost / input.qty).toFixed(4));

      const balance = await this.valuationRepo.updateValuationBalance(
        companyId,
        input.warehouseId,
        input.itemId,
        -input.qty,
        -totalIssuedCost,
        client
      );

      const movement = await this.valuationRepo.createValuationMovement(
        companyId,
        {
          warehouseId: input.warehouseId,
          itemId: input.itemId,
          movementType,
          qty: input.qty,
          unitCost: effectiveUnitCost,
          totalCost: totalIssuedCost,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          sourceLineId: input.sourceLineId,
          journalEntryId: input.journalEntryId,
          createdBy: userId,
        },
        client
      );

      for (const alloc of allocatedLayers) {
        await this.valuationRepo.createCostAllocation(
          companyId,
          {
            valuationMovementId: movement.id,
            costLayerId: alloc.layerId,
            allocatedQty: alloc.qty,
            unitCost: alloc.unitCost,
            allocatedCost: alloc.cost,
          },
          client
        );
      }

      return {
        balance,
        movement,
        unitCost: effectiveUnitCost,
        totalCost: totalIssuedCost,
      };
    };

    if (tx) {
      return await execute(tx);
    } else {
      return await withTenantTransaction(companyId, async (client) => {
        return await execute(client);
      });
    }
  }

  /**
   * Process warehouse transfer preserving total value and cost lineage.
   */
  async processTransfer(
    companyId: string,
    input: {
      sourceWarehouseId: string;
      destWarehouseId: string;
      itemId: string;
      qty: number;
      sourceId: string;
      sourceLineId?: string | null;
    },
    userId?: string
  ): Promise<void> {
    if (input.sourceWarehouseId === input.destWarehouseId) {
      throw new ValidationError('مستودع المصدر ومستودع الوجهة لا يمكن أن يكونا متطابقين');
    }

    await withTenantTransaction(companyId, async (client) => {
      const issueResult = await this.processIssue(
        companyId,
        {
          warehouseId: input.sourceWarehouseId,
          itemId: input.itemId,
          qty: input.qty,
          sourceType: 'WAREHOUSE_TRANSFER',
          sourceId: input.sourceId,
          sourceLineId: input.sourceLineId,
          movementType: 'TRANSFER_OUT',
        },
        userId,
        client
      );

      await this.processReceipt(
        companyId,
        {
          warehouseId: input.destWarehouseId,
          itemId: input.itemId,
          qty: input.qty,
          unitCost: issueResult.unitCost,
          sourceType: 'WAREHOUSE_TRANSFER',
          sourceId: input.sourceId,
          sourceLineId: input.sourceLineId,
          movementType: 'TRANSFER_IN',
        },
        userId,
        client
      );
    });
  }
}

export const defaultInventoryValuationService = new InventoryValuationService();
