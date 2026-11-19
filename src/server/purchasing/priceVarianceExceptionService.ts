import { defaultPriceVarianceExceptionRepository, PriceVarianceExceptionRepository, PriceVarianceExceptionRow } from './priceVarianceExceptionRepository.js';
import { defaultInvoiceRepository, InvoiceRepository } from './invoiceRepository.js';
import { defaultThreeWayMatchService, ThreeWayMatchService } from './threeWayMatchService.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { DbExecutor } from '../db/types.js';

export class PriceVarianceExceptionService {
  constructor(
    private exceptionRepo: PriceVarianceExceptionRepository = defaultPriceVarianceExceptionRepository,
    private invoiceRepo: InvoiceRepository = defaultInvoiceRepository,
    private threeWayMatchService: Pick<ThreeWayMatchService, 'evaluateInvoice'> = defaultThreeWayMatchService,
    private auditService: AuditService = defaultAuditService
  ) {}

  async requestException(
    companyId: string,
    invoiceId: string,
    reason: string,
    actorId?: string
  ): Promise<PriceVarianceExceptionRow> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!invoiceId || typeof invoiceId !== 'string') {
      throw new ValidationError('invoiceId is required');
    }
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
      throw new ValidationError('سبب طلب الاستثناء مطلوب');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const invoice = await this.invoiceRepo.findByIdForUpdate(companyId, invoiceId, tx);
      if (!invoice) {
        throw new NotFoundError('فاتورة المورد غير موجودة');
      }
      if (invoice.status === 'posted') {
        throw new ValidationError('لا يمكن طلب استثناء لفاتورة مرحلة');
      }
      if (invoice.status === 'cancelled') {
        throw new ValidationError('لا يمكن طلب استثناء لفاتورة ملغاة');
      }

      const report = await this.threeWayMatchService.evaluateInvoice(companyId, invoiceId, tx);
      if (report.overallStatus !== 'variance_exceeded') {
        throw new ValidationError('فاتورة المورد مطابقة ضمن سياسة التسامح ولا تتطلب طلب استثناء تباين');
      }

      if (report.hasQtyExceeded || report.lines.some((l) => Boolean(l.qtyExceeded) || l.invoiceQty > l.grnQty || (typeof l.poQty === 'number' && l.invoiceQty > l.poQty))) {
        throw new ValidationError('تجاوزت الكمية المفوترة حدود الكمية المسموحة. استثناء تباين الأسعار مخصص لتباين الأسعار فقط ولا يمكن تجاوز فروقات الكمية.');
      }

      const invoiceLines = invoice.lines || [];
      if (invoiceLines.length === 0) {
        throw new ValidationError('لا توجد بنود في فاتورة المورد');
      }

      const linesPayload = invoiceLines.map((l) => {
        const matchLine = report.lines.find((m) => m.grnLineId === l.grnLineId);
        const refUnitCost = (matchLine?.poLineId && matchLine.poUnitCost !== null && matchLine.poUnitCost !== undefined)
          ? matchLine.poUnitCost
          : (matchLine?.grnUnitCost ?? 0);
        return {
          invoiceLineId: l.id,
          itemId: l.itemId,
          grnLineId: l.grnLineId,
          qty: l.qty,
          unitCost: l.unitCost,
          refUnitCost,
        };
      });

      const maxVariancePct = report.lines.reduce((max, l) => Math.max(max, l.priceVariancePct || 0), 0);

      const fingerprint = this.exceptionRepo.computeFingerprint(
        companyId,
        invoiceId,
        invoice.supplierId,
        linesPayload
      );

      const created = await this.exceptionRepo.create(
        companyId,
        {
          invoiceId,
          supplierId: invoice.supplierId,
          reason: reason.trim(),
          fingerprint,
          snapshot: { invoice, report, lines: linesPayload },
          requestedBy: actorId || null,
          maxVariancePct,
        },
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'PURCHASING_VARIANCE_REQUEST',
          entityType: 'purch_price_variance_exceptions',
          entityId: created.id,
          metadata: { invoiceId, supplierInvoiceNo: invoice.supplierInvoiceNo, reason: reason.trim(), maxVariancePct },
        },
        { executor: tx }
      );

      return created;
    });
  }

  async approveException(
    companyId: string,
    exceptionId: string,
    decisionReason?: string,
    actorId?: string
  ): Promise<PriceVarianceExceptionRow> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!exceptionId || typeof exceptionId !== 'string') {
      throw new ValidationError('exceptionId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const exc = await this.exceptionRepo.findByIdForUpdate(companyId, exceptionId, tx);
      if (!exc) {
        throw new NotFoundError('طلب استثناء تباين الأسعار غير موجود');
      }
      if (exc.status !== 'pending') {
        throw new ValidationError(`لا يمكن اعتماد طلب استثناء حالته الحالية هي '${exc.status}'`);
      }

      // Segregation of Duties (SoD): Approver cannot be requester
      if (actorId && exc.requestedBy && actorId === exc.requestedBy) {
        throw new ValidationError('قواعد فصل المهام (SoD) تمنع مقدم طلب الاستثناء من اعتماده بنفسه');
      }

      // Lock target invoice FOR UPDATE in same transaction
      const invoice = await this.invoiceRepo.findByIdForUpdate(companyId, exc.invoiceId, tx);
      if (!invoice) {
        throw new NotFoundError('فاتورة المورد المرتبطة غير موجودة');
      }
      if (invoice.status === 'posted') {
        throw new ValidationError('فاتورة المورد مرحلة بالفعل');
      }
      if (invoice.status === 'cancelled') {
        throw new ValidationError('فاتورة المورد ملغاة');
      }

      const report = await this.threeWayMatchService.evaluateInvoice(companyId, exc.invoiceId, tx);
      if (report.hasQtyExceeded || report.lines.some((l) => Boolean(l.qtyExceeded) || l.invoiceQty > l.grnQty || (typeof l.poQty === 'number' && l.invoiceQty > l.poQty))) {
        throw new ValidationError('تجاوزت الكمية المفوترة حدود الكمية المسموحة. لا يمكن اعتماد استثناء سعر عند وجود تجاوز كمية.');
      }

      const invoiceLines = invoice.lines || [];
      if (invoiceLines.length === 0) {
        throw new ValidationError('لا توجد بنود في فاتورة المورد');
      }

      const currentLinesPayload = invoiceLines.map((l) => {
        const matchLine = report.lines.find((m) => m.grnLineId === l.grnLineId);
        const refUnitCost = (matchLine?.poLineId && matchLine.poUnitCost !== null && matchLine.poUnitCost !== undefined)
          ? matchLine.poUnitCost
          : (matchLine?.grnUnitCost ?? 0);
        return {
          invoiceLineId: l.id,
          itemId: l.itemId,
          grnLineId: l.grnLineId,
          qty: l.qty,
          unitCost: l.unitCost,
          refUnitCost,
        };
      });

      const currentFingerprint = this.exceptionRepo.computeFingerprint(
        companyId,
        exc.invoiceId,
        invoice.supplierId,
        currentLinesPayload
      );

      if (currentFingerprint !== exc.fingerprint) {
        await this.exceptionRepo.updateStatus(companyId, exceptionId, 'superseded', actorId || null, 'تغيرت بنود الفاتورة', tx);
        throw new ValidationError('تغيرت بنود الفاتورة أو أسعارها بعد تقديم طلب الاستثناء؛ تم إلغاء الطلب ويجب تقديم طلب جديد.');
      }

      const approved = await this.exceptionRepo.updateStatus(
        companyId,
        exceptionId,
        'approved',
        actorId || null,
        decisionReason?.trim() || null,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'PURCHASING_VARIANCE_APPROVE',
          entityType: 'purch_price_variance_exceptions',
          entityId: exceptionId,
          metadata: { invoiceId: exc.invoiceId, decisionReason: decisionReason?.trim() || null },
        },
        { executor: tx }
      );

      return approved;
    });
  }

  async rejectException(
    companyId: string,
    exceptionId: string,
    decisionReason?: string,
    actorId?: string
  ): Promise<PriceVarianceExceptionRow> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!exceptionId || typeof exceptionId !== 'string') {
      throw new ValidationError('exceptionId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const exc = await this.exceptionRepo.findByIdForUpdate(companyId, exceptionId, tx);
      if (!exc) {
        throw new NotFoundError('طلب استثناء تباين الأسعار غير موجود');
      }
      if (exc.status !== 'pending') {
        throw new ValidationError(`لا يمكن رفض طلب استثناء حالته الحالية هي '${exc.status}'`);
      }

      const rejected = await this.exceptionRepo.updateStatus(
        companyId,
        exceptionId,
        'rejected',
        actorId || null,
        decisionReason?.trim() || null,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'PURCHASING_VARIANCE_REJECT',
          entityType: 'purch_price_variance_exceptions',
          entityId: exceptionId,
          metadata: { invoiceId: exc.invoiceId, decisionReason: decisionReason?.trim() || null },
        },
        { executor: tx }
      );

      return rejected;
    });
  }

  async listExceptions(companyId: string, invoiceId: string): Promise<PriceVarianceExceptionRow[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!invoiceId || typeof invoiceId !== 'string') {
      throw new ValidationError('invoiceId is required');
    }
    return await this.exceptionRepo.listByInvoice(companyId, invoiceId);
  }
}

export const defaultPriceVarianceExceptionService = new PriceVarianceExceptionService();
