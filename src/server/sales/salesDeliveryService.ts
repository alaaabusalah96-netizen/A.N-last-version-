import { SalesDeliveryRepository, defaultSalesDeliveryRepository } from './salesDeliveryRepository.js';
import { CustomerRepository, defaultCustomerRepository } from './customerRepository.js';
import { StockRepository, defaultStockRepository } from '../inventory/stockRepository.js';
import { JournalRepository, defaultJournalRepository } from '../accounting/journalRepository.js';
import { AuditService, defaultAuditService } from '../audit/auditService.js';
import { SalesDeliveryNote, CreateDeliveryInput } from './salesTypes.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { defaultInventoryValuationService } from '../inventory/inventoryValuationService.js';
import { toDecimal } from '../lib/numeric.js';
import {
  assertOptionalCalendarDate,
  resolveCompanyToday,
} from '../lib/calendarDate.js';
import { assertMaxDocumentLines } from '../http/documentLimits.js';

export class SalesDeliveryService {
  constructor(
    private deliveryRepo: SalesDeliveryRepository = defaultSalesDeliveryRepository,
    private customerRepo: CustomerRepository = defaultCustomerRepository,
    private stockRepo: StockRepository = defaultStockRepository,
    private journalRepo: JournalRepository = defaultJournalRepository,
    private auditService: AuditService = defaultAuditService
  ) {}

  async listDeliveries(companyId: string): Promise<SalesDeliveryNote[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.deliveryRepo.list(companyId);
  }

  async getDelivery(companyId: string, id: string): Promise<SalesDeliveryNote> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');
    const note = await this.deliveryRepo.findById(companyId, id);
    if (!note) throw new NotFoundError('إذن التسليم غير موجود');
    return note;
  }

  async createDelivery(companyId: string, input: CreateDeliveryInput, actorUserId?: string): Promise<SalesDeliveryNote> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!input.customerId) throw new ValidationError('العميل مطلوب');
    if (!input.warehouseId) throw new ValidationError('المستودع مطلوب');
    assertMaxDocumentLines(input.lines);
    if (!input.lines || input.lines.length === 0) {
      throw new ValidationError('يجب إضافة بند واحد على الأقل في إذن التسليم');
    }
    const validatedDeliveryDate = assertOptionalCalendarDate(input.deliveryDate, 'تاريخ التسليم');

    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const customer = await this.customerRepo.findById(companyId, input.customerId, tx);
      if (!customer || !customer.isActive) {
        throw new ValidationError('العميل غير موجود أو غير نشط');
      }

      const whRes = await tx.query<any>(
        `SELECT id, is_active FROM inv_warehouses WHERE company_id = $1 AND id = $2`,
        [companyId, input.warehouseId]
      );
      if (whRes.rows.length === 0 || !whRes.rows[0].is_active) {
        throw new ValidationError('المستودع المحدد غير موجود أو غير نشط');
      }

      for (const line of input.lines) {
        if (!line.itemId) throw new ValidationError('الصنف مطلوب في جميع البنود');
        if (typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0) {
          throw new ValidationError('الكمية يجب أن تكون أكبر من الصفر');
        }
      }

      const effectiveDeliveryDate = validatedDeliveryDate ?? (await resolveCompanyToday(companyId, tx));
      const created = await this.deliveryRepo.createDraft(
        companyId,
        {
          ...input,
          deliveryDate: effectiveDeliveryDate,
        },
        actorUserId,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorUserId || null,
          companyId,
          action: 'SALES_DELIVERY_CREATE',
          entityType: 'sales_delivery_notes',
          entityId: created.id,
          metadata: { customerId: input.customerId, warehouseId: input.warehouseId, linesCount: input.lines.length },
        },
        { executor: tx }
      );

      return created;
    });
  }

  async postDelivery(companyId: string, id: string, actorUserId?: string): Promise<SalesDeliveryNote> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');

    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const locked = await this.deliveryRepo.findByIdForUpdate(companyId, id, tx);
      if (!locked) {
        throw new NotFoundError('إذن التسليم غير موجود');
      }
      if (locked.status === 'posted') {
        throw new ValidationError('إذن التسليم مرحل مسبقاً');
      }
      if (locked.status === 'cancelled') {
        throw new ValidationError('لا يمكن ترحيل إذن تسليم ملغى');
      }

      const note = await this.deliveryRepo.findById(companyId, id, tx);
      if (!note || !note.lines || note.lines.length === 0) {
        throw new ValidationError('إذن التسليم لا يحتوي على بنود لترحيلها');
      }

      // Check warehouse active
      const whRes = await tx.query<any>(
        `SELECT id, is_active FROM inv_warehouses WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        [companyId, note.warehouseId]
      );
      if (whRes.rows.length === 0 || !whRes.rows[0].is_active) {
        throw new ValidationError('المستودع المحدد غير موجود أو غير نشط');
      }

      const deliveryNo = await this.journalRepo.allocateSequenceNumber(companyId, 'sales_delivery', 'DLV', tx);

      // Coordinated atomic stock decrement + stock movement + valuation issue + immutable cost snapshot
      for (const line of note.lines) {
        const curStock = await this.stockRepo.getBalanceForUpdate(companyId, note.warehouseId, line.itemId, tx);
        const currentQty = toDecimal(curStock?.qty ?? 0, 4);
        const reqQty = toDecimal(line.qty, 4);
        if (currentQty < reqQty) {
          throw new ValidationError(
            `رصيد غير كافٍ في المستودع للصنف (${line.itemNameAr || line.itemId}). المتاح: ${currentQty}، المطلوب للتسليم: ${reqQty}.`
          );
        }

        const decremented = await this.stockRepo.decrementBalance(
          companyId,
          note.warehouseId,
          line.itemId,
          reqQty,
          tx
        );
        if (!decremented) {
          throw new ValidationError('رصيد غير كافٍ في المستودع لإتمام عملية التسليم');
        }

        await this.stockRepo.createMovement(
          companyId,
          note.warehouseId,
          line.itemId,
          'issue',
          reqQty,
          `تسليم مبيعات إذن رقم ${deliveryNo}`,
          actorUserId,
          undefined,
          tx
        );

        const issueResult = await defaultInventoryValuationService.processIssue(
          companyId,
          {
            warehouseId: note.warehouseId,
            itemId: line.itemId,
            qty: reqQty,
            sourceType: 'SALES_DELIVERY',
            sourceId: id,
            sourceLineId: line.id,
            movementType: 'ISSUE',
            reason: `تسليم مبيعات إذن رقم ${deliveryNo}`,
            costSource: 'SYSTEM_VALUATION',
            stockSyncMode: 'external_verified',
            expectedPreStockQty: currentQty,
          },
          actorUserId,
          tx
        );

        const valMovId = (issueResult as any)?.movement?.id ?? null;
        if (!valMovId) {
          throw new ValidationError('فشل إنشاء حركة تقييم البضاعة المباعة لإذن التسليم');
        }
        const frozenTotalCost = toDecimal(issueResult?.totalCost ?? 0, 4);
        const frozenUnitCost = toDecimal(issueResult?.unitCost ?? 0, 4);

        // Store immutable server-frozen cost snapshot and valuation movement reference
        await tx.query(
          `UPDATE sales_delivery_lines
           SET unit_cost = $1, frozen_total_cost = $2, valuation_movement_id = $3
           WHERE company_id = $4 AND id = $5`,
          [frozenUnitCost, frozenTotalCost, valMovId, companyId, line.id]
        );
      }

      await this.deliveryRepo.markPosted(companyId, id, deliveryNo, actorUserId, tx);

      await this.auditService.record(
        {
          actorUserId: actorUserId || null,
          companyId,
          action: 'SALES_DELIVERY_POST',
          entityType: 'sales_delivery_notes',
          entityId: id,
          metadata: { deliveryNo, warehouseId: note.warehouseId },
        },
        { executor: tx }
      );

      const posted = await this.deliveryRepo.findById(companyId, id, tx);
      return posted!;
    });
  }

  async deleteDelivery(companyId: string, id: string, actorUserId?: string): Promise<boolean> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');

    const success = await this.deliveryRepo.delete(companyId, id);
    if (!success) throw new NotFoundError('إذن التسليم غير موجود أو تم ترحيله مسبقاً ولا يمكن حذفه');

    await this.auditService.record({
      actorUserId: actorUserId || null,
      companyId,
      action: 'SALES_DELIVERY_DELETE',
      entityType: 'sales_delivery_notes',
      entityId: id,
    });

    return true;
  }
}

export const defaultSalesDeliveryService = new SalesDeliveryService();
