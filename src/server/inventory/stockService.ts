import { defaultStockRepository, StockRepository } from './stockRepository.js';
import { defaultWarehouseRepository, WarehouseRepository } from './warehouseRepository.js';
import { defaultItemRepository, ItemRepository } from './itemRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { StockBalance, StockMovement, RecordMovementInput, TransferInput } from './inventoryTypes.js';
import { randomUUID } from 'node:crypto';

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
        undefined,
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
        undefined,
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

  /**
   * Transfer stock (تحويل بضاعة بين مستودعين لنفس الشركة)
   * Atomic same-company warehouse transfer with deadlock-safe row locking.
   */
  async transfer(
    companyId: string,
    input: TransferInput,
    actorId?: string
  ): Promise<{
    transferId: string;
    sourceBalance: StockBalance;
    destBalance: StockBalance;
    movementOut: StockMovement;
    movementIn: StockMovement;
  }> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    if (!input.sourceWarehouseId || typeof input.sourceWarehouseId !== 'string') {
      throw new ValidationError('مستودع المصدر مطلوب');
    }

    if (!input.destWarehouseId || typeof input.destWarehouseId !== 'string') {
      throw new ValidationError('مستودع الوجهة مطلوب');
    }

    if (!input.itemId || typeof input.itemId !== 'string') {
      throw new ValidationError('الصنف/المنتج مطلوب');
    }

    if (typeof input.qty !== 'number' || isNaN(input.qty) || input.qty <= 0) {
      throw new ValidationError('كمية التحويل يجب أن تكون عدداً أكبر من الصفر');
    }

    if (input.sourceWarehouseId === input.destWarehouseId) {
      throw new ValidationError('مستودع المصدر ومستودع الوجهة هما نفس المستودع');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const sourceWh = await this.warehouseRepo.findById(companyId, input.sourceWarehouseId, tx);
      if (!sourceWh) {
        throw new NotFoundError('مستودع المصدر المحدد غير موجود أو لا ينتمي لهذه الشركة');
      }
      if (!sourceWh.isActive) {
        throw new ValidationError('مستودع المصدر المحدد غير نشط');
      }

      const destWh = await this.warehouseRepo.findById(companyId, input.destWarehouseId, tx);
      if (!destWh) {
        throw new NotFoundError('مستودع الوجهة المحدد غير موجود أو لا ينتمي لهذه الشركة');
      }
      if (!destWh.isActive) {
        throw new ValidationError('مستودع الوجهة المحدد غير نشط');
      }

      const item = await this.itemRepo.findById(companyId, input.itemId, tx);
      if (!item) {
        throw new NotFoundError('الصنف المحدد غير موجود');
      }
      if (!item.isActive) {
        throw new ValidationError('الصنف المحدد غير نشط');
      }

      // Deadlock-safe lock ordering: lock balance rows in deterministic order sorted by warehouseId
      const [firstWhId, secondWhId] = [input.sourceWarehouseId, input.destWarehouseId].sort();

      const balance1 = await this.stockRepo.getBalanceForUpdate(companyId, firstWhId, input.itemId, tx);
      const balance2 = await this.stockRepo.getBalanceForUpdate(companyId, secondWhId, input.itemId, tx);

      const sourceBalanceRow = firstWhId === input.sourceWarehouseId ? balance1 : balance2;
      const destBalanceRow = firstWhId === input.destWarehouseId ? balance1 : balance2;

      const sourceQty = sourceBalanceRow ? Number(sourceBalanceRow.qty) : 0;

      // STRICT NON-NEGATIVE STOCK GUARD FOR SOURCE WAREHOUSE
      if (sourceQty < input.qty) {
        throw new ValidationError(
          `رصيد غير كافٍ في مستودع المصدر (${sourceWh.nameAr}) للصنف (${item.code} - ${item.nameAr}). الرصيد الحالي: ${sourceQty} ${item.uom}، الكمية المطلوبة للتحويل: ${input.qty} ${item.uom}.`
        );
      }

      const destQty = destBalanceRow ? Number(destBalanceRow.qty) : 0;

      const newSourceQty = sourceQty - input.qty;
      const newDestQty = destQty + input.qty;

      const sourceBalance = await this.stockRepo.upsertBalance(
        companyId,
        input.sourceWarehouseId,
        input.itemId,
        newSourceQty,
        tx
      );

      const destBalance = await this.stockRepo.upsertBalance(
        companyId,
        input.destWarehouseId,
        input.itemId,
        newDestQty,
        tx
      );

      const transferId = randomUUID();

      const movementOut = await this.stockRepo.createMovement(
        companyId,
        input.sourceWarehouseId,
        input.itemId,
        'transfer_out',
        input.qty,
        input.memo || `تحويل إلى ${destWh.nameAr}`,
        actorId,
        transferId,
        tx
      );

      const movementIn = await this.stockRepo.createMovement(
        companyId,
        input.destWarehouseId,
        input.itemId,
        'transfer_in',
        input.qty,
        input.memo || `تحويل من ${sourceWh.nameAr}`,
        actorId,
        transferId,
        tx
      );

      await this.auditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'INVENTORY_TRANSFER',
        entityType: 'inv_stock_movement',
        entityId: transferId,
        metadata: {
          sourceWarehouseId: input.sourceWarehouseId,
          destWarehouseId: input.destWarehouseId,
          itemId: input.itemId,
          qty: input.qty,
        },
      });

      return {
        transferId,
        sourceBalance,
        destBalance,
        movementOut,
        movementIn,
      };
    });
  }
}

export const defaultStockService = new StockService();

