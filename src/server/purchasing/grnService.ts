import { defaultGrnRepository, GrnRepository } from './grnRepository.js';
import { defaultSupplierRepository, SupplierRepository } from './supplierRepository.js';
import { defaultWarehouseRepository, WarehouseRepository } from '../inventory/warehouseRepository.js';
import { defaultItemRepository, ItemRepository } from '../inventory/itemRepository.js';
import { defaultStockRepository, StockRepository } from '../inventory/stockRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { defaultJournalRepository, JournalRepository } from '../accounting/journalRepository.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { GrnHeader, CreateGrnInput } from './purchasingTypes.js';

export class GrnService {
  constructor(
    private grnRepo: GrnRepository = defaultGrnRepository,
    private supplierRepo: SupplierRepository = defaultSupplierRepository,
    private warehouseRepo: WarehouseRepository = defaultWarehouseRepository,
    private itemRepo: ItemRepository = defaultItemRepository,
    private stockRepo: StockRepository = defaultStockRepository,
    private auditService: AuditService = defaultAuditService,
    private journalRepo: JournalRepository = defaultJournalRepository
  ) {}

  async listGrns(companyId: string): Promise<GrnHeader[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.grnRepo.listByCompany(companyId);
  }

  async getGrn(companyId: string, grnId: string): Promise<GrnHeader> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!grnId || typeof grnId !== 'string') {
      throw new ValidationError('grnId is required');
    }
    const grn = await this.grnRepo.findById(companyId, grnId);
    if (!grn) {
      throw new NotFoundError('سند استلام البضائع (GRN) غير موجود');
    }
    return grn;
  }

  async createGrn(
    companyId: string,
    input: CreateGrnInput,
    actorId?: string
  ): Promise<GrnHeader> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    if (!input.supplierId || typeof input.supplierId !== 'string') {
      throw new ValidationError('المورد مطلوب');
    }

    if (!input.warehouseId || typeof input.warehouseId !== 'string') {
      throw new ValidationError('مستودع الاستلام مطلوب');
    }

    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new ValidationError('يجب إضافة صنف واحد على الأقل في سند الاستلام');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const supplier = await this.supplierRepo.findById(companyId, input.supplierId, tx);
      if (!supplier) {
        throw new NotFoundError('المورد المحدد غير موجود');
      }
      if (!supplier.isActive) {
        throw new ValidationError('المورد المحدد غير نشط');
      }

      const warehouse = await this.warehouseRepo.findById(companyId, input.warehouseId, tx);
      if (!warehouse) {
        throw new NotFoundError('المستودع المحدد غير موجود');
      }
      if (!warehouse.isActive) {
        throw new ValidationError('المستودع المحدد غير نشط');
      }

      for (const line of input.lines) {
        if (!line.itemId || typeof line.itemId !== 'string') {
          throw new ValidationError('كافة بنود السند تتطلب صنفاً محدداً');
        }
        if (typeof line.qty !== 'number' || isNaN(line.qty) || line.qty <= 0) {
          throw new ValidationError('كمية البند يجب أن تكون عدداً أكبر من الصفر');
        }
        const item = await this.itemRepo.findById(companyId, line.itemId, tx);
        if (!item) {
          throw new NotFoundError('أحد الأصناف المحددة في البنود غير موجود');
        }
        if (!item.isActive) {
          throw new ValidationError(`الصنف (${item.code} - ${item.nameAr}) غير نشط`);
        }
      }

      const grn = await this.grnRepo.createDraft(companyId, input, actorId, tx);

      await this.auditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'GRN_CREATE_DRAFT',
        entityType: 'purch_grn',
        entityId: grn.id,
        metadata: { supplierId: input.supplierId, warehouseId: input.warehouseId, lineCount: input.lines.length },
      });

      return grn;
    });
  }

  /**
   * Confirm & Post Goods Receipt Note (ترحيل سند استلام البضائع إلى المخزون)
   * Atomic stock increase across all GRN lines in a single tenant transaction.
   */
  async postGrn(companyId: string, grnId: string, actorId?: string): Promise<GrnHeader> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!grnId || typeof grnId !== 'string') {
      throw new ValidationError('grnId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      // 1. Lock GRN row for update
      const grnLock = await this.grnRepo.findByIdForUpdate(companyId, grnId, tx);
      if (!grnLock) {
        throw new NotFoundError('سند استلام البضائع غير موجود');
      }

      if (grnLock.status === 'posted') {
        throw new ValidationError('سند استلام البضائع مرحل مسبقاً ولا يمكن تكرار ترحيله');
      }

      // 2. Fetch full GRN header + lines
      const grn = await this.grnRepo.findById(companyId, grnId, tx);
      if (!grn || !grn.lines || grn.lines.length === 0) {
        throw new ValidationError('سند استلام البضائع لا يحتوي على بنود لترحيلها');
      }

      const warehouse = await this.warehouseRepo.findById(companyId, grn.warehouseId, tx);
      if (!warehouse || !warehouse.isActive) {
        throw new ValidationError('مستودع الاستلام غير موجود أو غير نشط');
      }

      const grnNo = await this.journalRepo.allocateSequenceNumber(companyId, 'goods_receipt', 'GRN', tx);

      // 3. Post each line to stock inventory atomically
      for (const line of grn.lines) {
        const item = await this.itemRepo.findById(companyId, line.itemId, tx);
        if (!item || !item.isActive) {
          throw new ValidationError(`الصنف بـ ID (${line.itemId}) غير موجود أو غير نشط`);
        }

        // Lock existing stock balance
        const existingBalance = await this.stockRepo.getBalanceForUpdate(
          companyId,
          grn.warehouseId,
          line.itemId,
          tx
        );

        const currentQty = existingBalance ? Number(existingBalance.qty) : 0;
        const newQty = currentQty + Number(line.qty);

        // Upsert new stock balance
        await this.stockRepo.upsertBalance(
          companyId,
          grn.warehouseId,
          line.itemId,
          newQty,
          tx
        );

        // Record stock movement
        await this.stockRepo.createMovement(
          companyId,
          grn.warehouseId,
          line.itemId,
          'receive',
          Number(line.qty),
          `استلام مشتريات (سند رقم ${grnNo})`,
          actorId,
          undefined,
          tx
        );
      }

      // 4. Mark GRN as posted
      await this.grnRepo.markPosted(companyId, grnId, grnNo, actorId || '', tx);

      await this.auditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'GRN_POST',
        entityType: 'purch_grn',
        entityId: grnId,
        metadata: { grnNo, warehouseId: grn.warehouseId, lineCount: grn.lines.length },
      });

      const updatedGrn = await this.grnRepo.findById(companyId, grnId, tx);
      return updatedGrn!;
    });
  }
}

export const defaultGrnService = new GrnService();
