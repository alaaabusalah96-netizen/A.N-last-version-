import { defaultStockRepository, StockRepository } from './stockRepository.js';
import { defaultWarehouseRepository, WarehouseRepository } from './warehouseRepository.js';
import { defaultItemRepository, ItemRepository } from './itemRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { StockBalance, StockMovement, RecordMovementInput } from './inventoryTypes.js';

export class StockService {
  constructor(
    private stockRepo: StockRepository = defaultStockRepository,
    private warehouseRepo: WarehouseRepository = defaultWarehouseRepository,
    private itemRepo: ItemRepository = defaultItemRepository,
    private auditService: AuditService = defaultAuditService
  ) {}

  async listStockBalances(companyId: string): Promise<StockBalance[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.stockRepo.listBalancesByCompany(companyId);
  }

  async listStockMovements(companyId: string): Promise<StockMovement[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.stockRepo.listMovementsByCompany(companyId);
  }

  /**
   * Receive stock (إستلام بضاعة/أصناف)
   * Increases warehouse item balance and records movement in a single transaction.
   */
  async receiveStock(
    companyId: string,
    input: RecordMovementInput,
    actorId?: string
  ): Promise<{ balance: StockBalance; movement: StockMovement }> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    if (!input.warehouseId || typeof input.warehouseId !== 'string') {
      throw new ValidationError('المستودع مطلوب');
    }

    if (!input.itemId || typeof input.itemId !== 'string') {
      throw new ValidationError('الصنف/المنتج مطلوب');
    }

    if (typeof input.qty !== 'number' || isNaN(input.qty) || input.qty <= 0) {
      throw new ValidationError('كمية الاستلام يجب أن تكون عدداً أكبر من الصفر');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const warehouse = await this.warehouseRepo.findById(companyId, input.warehouseId, tx);
      if (!warehouse) {
        throw new NotFoundError('المستودع المحدد غير موجود');
      }
      if (!warehouse.isActive) {
        throw new ValidationError('المستودع المحدد غير نشط');
      }

      const item = await this.itemRepo.findById(companyId, input.itemId, tx);
      if (!item) {
        throw new NotFoundError('الصنف المحدد غير موجود');
      }
      if (!item.isActive) {
        throw new ValidationError('الصنف المحدد غير نشط');
      }

      // Lock existing balance row
      const existingBalance = await this.stockRepo.getBalanceForUpdate(
        companyId,
        input.warehouseId,
        input.itemId,
        tx
      );

      const currentQty = existingBalance ? Number(existingBalance.qty) : 0;
      const newQty = currentQty + input.qty;

      const balance = await this.stockRepo.upsertBalance(
        companyId,
        input.warehouseId,
        input.itemId,
        newQty,
        tx
      );

      const movement = await this.stockRepo.createMovement(
        companyId,
        input.warehouseId,
        input.itemId,
        'receive',
        input.qty,
        input.memo,
        actorId,
        tx
      );

      await this.auditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'STOCK_RECEIVE',
        entityType: 'inv_stock_movement',
        entityId: movement.id,
        metadata: {
          warehouseId: input.warehouseId,
          itemId: input.itemId,
          receivedQty: input.qty,
          newQty,
        },
      });

      return { balance, movement };
    });
  }

  /**
   * Issue stock (صرف بضاعة/أصناف)
   * Decreases warehouse item balance and records movement in a single transaction.
   * STRICTLY BLOCKS INSUFFICIENT STOCK (NO NEGATIVE STOCK PERMITTED).
   */
  async issueStock(
    companyId: string,
    input: RecordMovementInput,
    actorId?: string
  ): Promise<{ balance: StockBalance; movement: StockMovement }> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    if (!input.warehouseId || typeof input.warehouseId !== 'string') {
      throw new ValidationError('المستودع مطلوب');
    }

    if (!input.itemId || typeof input.itemId !== 'string') {
      throw new ValidationError('الصنف/المنتج مطلوب');
    }

    if (typeof input.qty !== 'number' || isNaN(input.qty) || input.qty <= 0) {
      throw new ValidationError('كمية الصرف يجب أن تكون عدداً أكبر من الصفر');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const warehouse = await this.warehouseRepo.findById(companyId, input.warehouseId, tx);
      if (!warehouse) {
        throw new NotFoundError('المستودع المحدد غير موجود');
      }
      if (!warehouse.isActive) {
        throw new ValidationError('المستودع المحدد غير نشط');
      }

      const item = await this.itemRepo.findById(companyId, input.itemId, tx);
      if (!item) {
        throw new NotFoundError('الصنف المحدد غير موجود');
      }
      if (!item.isActive) {
        throw new ValidationError('الصنف المحدد غير نشط');
      }

      // Lock existing balance row
      const existingBalance = await this.stockRepo.getBalanceForUpdate(
        companyId,
        input.warehouseId,
        input.itemId,
        tx
      );

      const currentQty = existingBalance ? Number(existingBalance.qty) : 0;

      // STRICT NON-NEGATIVE STOCK GUARD
      if (currentQty < input.qty) {
        throw new ValidationError(
          `رصيد غير كافٍ في المستودع للصنف (${item.code} - ${item.nameAr}). الرصيد الحالي: ${currentQty} ${item.uom}، الكمية المطلوبة للصرف: ${input.qty} ${item.uom}. لا يمكن إتمام العملية برصيد بالسالب.`
        );
      }

      const newQty = currentQty - input.qty;

      const balance = await this.stockRepo.upsertBalance(
        companyId,
        input.warehouseId,
        input.itemId,
        newQty,
        tx
      );

      const movement = await this.stockRepo.createMovement(
        companyId,
        input.warehouseId,
        input.itemId,
        'issue',
        input.qty,
        input.memo,
        actorId,
        tx
      );

      await this.auditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'STOCK_ISSUE',
        entityType: 'inv_stock_movement',
        entityId: movement.id,
        metadata: {
          warehouseId: input.warehouseId,
          itemId: input.itemId,
          issuedQty: input.qty,
          newQty,
        },
      });

      return { balance, movement };
    });
  }
}

export const defaultStockService = new StockService();
