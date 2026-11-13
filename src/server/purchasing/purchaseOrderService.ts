import { defaultPurchaseOrderRepository, PurchaseOrderRepository } from './purchaseOrderRepository.js';
import { defaultSupplierRepository, SupplierRepository } from './supplierRepository.js';
import { defaultItemRepository, ItemRepository } from '../inventory/itemRepository.js';
import { defaultJournalRepository, JournalRepository } from '../accounting/journalRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { CreatePoInput, PurchaseOrder } from './purchasingTypes.js';
import { toDecimal } from '../lib/numeric.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

export class PurchaseOrderService {
  constructor(
    private poRepo: PurchaseOrderRepository = defaultPurchaseOrderRepository,
    private supplierRepo: SupplierRepository = defaultSupplierRepository,
    private itemRepo: ItemRepository = defaultItemRepository,
    private auditService: AuditService = defaultAuditService,
    private journalRepo: JournalRepository = defaultJournalRepository
  ) {}

  async listPurchaseOrders(companyId: string): Promise<PurchaseOrder[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.poRepo.listByCompany(companyId);
  }

  async getPurchaseOrder(companyId: string, poId: string): Promise<PurchaseOrder> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!poId || typeof poId !== 'string') {
      throw new ValidationError('poId is required');
    }
    const po = await this.poRepo.findById(companyId, poId);
    if (!po) {
      throw new NotFoundError('أمر الشراء غير موجود');
    }
    return po;
  }

  async createPurchaseOrder(
    companyId: string,
    input: CreatePoInput,
    actorId?: string
  ): Promise<PurchaseOrder> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!input.supplierId || typeof input.supplierId !== 'string') {
      throw new ValidationError('المورد مطلوب');
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new ValidationError('يجب إضافة صنف واحد على الأقل في أمر الشراء');
    }

    const normalizedExpectedDate =
      typeof input.expectedDate === 'string' && input.expectedDate.trim() !== ''
        ? input.expectedDate.trim()
        : undefined;
    if (normalizedExpectedDate && !isValidIsoDate(normalizedExpectedDate)) {
      throw new ValidationError('تاريخ التسليم المتوقع غير صالح (المتوقع YYYY-MM-DD)');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const supplier = await this.supplierRepo.findById(companyId, input.supplierId, tx);
      if (!supplier) {
        throw new NotFoundError('المورد المحدد غير موجود');
      }
      if (!supplier.isActive) {
        throw new ValidationError('المورد المحدد غير نشط');
      }

      for (const line of input.lines) {
        if (!line.itemId || typeof line.itemId !== 'string') {
          throw new ValidationError('كافة بنود أمر الشراء تتطلب صنفاً محدداً');
        }
        if (typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0) {
          throw new ValidationError('كمية البند يجب أن تكون عدداً أكبر من الصفر');
        }
        if (line.unitCost !== undefined && line.unitCost !== null) {
          const rawCost = typeof line.unitCost === 'number' ? line.unitCost : Number(line.unitCost);
          if (!Number.isFinite(rawCost)) {
            throw new ValidationError('تكلفة الوحدة في البند يجب أن تكون رقماً صالحاً');
          }
          if (toDecimal(line.unitCost, 4) < 0) {
            throw new ValidationError('تكلفة الوحدة في البند لا يمكن أن تكون بالسالب');
          }
        }
        const item = await this.itemRepo.findById(companyId, line.itemId, tx);
        if (!item) {
          throw new NotFoundError('أحد الأصناف المحددة في البنود غير موجود');
        }
        if (!item.isActive) {
          throw new ValidationError(`الصنف (${item.code} - ${item.nameAr}) غير نشط`);
        }
      }

      const created = await this.poRepo.create(
        companyId,
        {
          supplierId: input.supplierId,
          expectedDate: normalizedExpectedDate,
          memo: input.memo,
          lines: input.lines,
        },
        actorId,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'PO_CREATE',
          entityType: 'purch_purchase_orders',
          entityId: created.id,
          metadata: {
            supplierId: input.supplierId,
            lineCount: input.lines.length,
            expectedDate: normalizedExpectedDate || null,
          },
        },
        { mode: 'required', executor: tx }
      );

      const fullPo = await this.poRepo.findById(companyId, created.id, tx);
      return fullPo || created;
    });
  }

  async approvePurchaseOrder(
    companyId: string,
    poId: string,
    actorId?: string
  ): Promise<PurchaseOrder> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!poId || typeof poId !== 'string') {
      throw new ValidationError('poId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const locked = await this.poRepo.findByIdForUpdate(companyId, poId, tx);
      if (!locked) {
        throw new NotFoundError('أمر الشراء غير موجود');
      }

      if (locked.status !== 'draft') {
        throw new ValidationError('لا يمكن اعتماد أمر الشراء إلا إذا كان في حالة مسودة (draft)');
      }

      const full = await this.poRepo.findById(companyId, poId, tx);
      if (!full || !full.lines || full.lines.length === 0) {
        throw new ValidationError('أمر الشراء لا يحتوي على بنود لاعتماده');
      }

      const poNo =
        locked.poNo ||
        (await this.journalRepo.allocateSequenceNumber(companyId, 'purchase_order', 'PO', tx));

      await this.poRepo.updateStatus(
        companyId,
        poId,
        {
          status: 'approved',
          poNo,
          approvedBy: actorId || null,
        },
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'PO_APPROVE',
          entityType: 'purch_purchase_orders',
          entityId: poId,
          metadata: {
            poNo,
            previousStatus: locked.status,
            newStatus: 'approved',
          },
        },
        { mode: 'required', executor: tx }
      );

      const updated = await this.poRepo.findById(companyId, poId, tx);
      return updated!;
    });
  }

  async cancelPurchaseOrder(
    companyId: string,
    poId: string,
    actorId?: string
  ): Promise<PurchaseOrder> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!poId || typeof poId !== 'string') {
      throw new ValidationError('poId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const locked = await this.poRepo.findByIdForUpdate(companyId, poId, tx);
      if (!locked) {
        throw new NotFoundError('أمر الشراء غير موجود');
      }

      if (locked.status !== 'draft' && locked.status !== 'approved') {
        throw new ValidationError('لا يمكن إلغاء أمر الشراء إلا في حالة مسودة أو معتمد');
      }

      await this.poRepo.updateStatus(
        companyId,
        poId,
        { status: 'cancelled' },
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'PO_CANCEL',
          entityType: 'purch_purchase_orders',
          entityId: poId,
          metadata: {
            poNo: locked.poNo || null,
            previousStatus: locked.status,
            newStatus: 'cancelled',
          },
        },
        { mode: 'required', executor: tx }
      );

      const updated = await this.poRepo.findById(companyId, poId, tx);
      return updated!;
    });
  }

  async closePurchaseOrder(
    companyId: string,
    poId: string,
    actorId?: string
  ): Promise<PurchaseOrder> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!poId || typeof poId !== 'string') {
      throw new ValidationError('poId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const locked = await this.poRepo.findByIdForUpdate(companyId, poId, tx);
      if (!locked) {
        throw new NotFoundError('أمر الشراء غير موجود');
      }

      if (locked.status !== 'approved') {
        throw new ValidationError('لا يمكن إغلاق أمر الشراء إلا إذا كان في حالة معتمد (approved)');
      }

      await this.poRepo.updateStatus(
        companyId,
        poId,
        {
          status: 'closed',
          closedBy: actorId || null,
        },
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'PO_CLOSE',
          entityType: 'purch_purchase_orders',
          entityId: poId,
          metadata: {
            poNo: locked.poNo || null,
            previousStatus: locked.status,
            newStatus: 'closed',
          },
        },
        { mode: 'required', executor: tx }
      );

      const updated = await this.poRepo.findById(companyId, poId, tx);
      return updated!;
    });
  }
}

export const defaultPurchaseOrderService = new PurchaseOrderService();
