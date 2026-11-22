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
    if (!actorId || typeof actorId !== 'string' || actorId.trim() === '') {
      throw new ValidationError('معرف المستخدم (actorId) مطلوب لتقديم طلب الاستثناء');
    }
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
      throw new ValidationError('سبب طلب الاستثناء مطلوب');
    }
    const normalizedActorId = actorId.trim();

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
          requestedBy: normalizedActorId,
          maxVariancePct,
        },
        tx
      );

      await this.auditService.record(
        {
          actorUserId: normalizedActorId,
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
    if (!actorId || typeof actorId !== 'string' || actorId.trim() === '') {
      throw new ValidationError('معرف المستخدم (actorId) مطلوب لاعتماد الاستثناء');
    }
    const normalizedActorId = actorId.trim();

    let fingerprintMismatch = false;
    let approvedResult: PriceVarianceExceptionRow;

    await withTenantTransaction(companyId, async (tx) => {
      // 1. Initial lookup to identify target invoice
      const excInfo = await this.exceptionRepo.findById(companyId, exceptionId, tx);
      if (!excInfo) {
        throw new NotFoundError('طلب استثناء تباين الأسعار غير موجود');
      }
      if (excInfo.status !== 'pending') {
        throw new ValidationError(`لا يمكن اعتماد طلب استثناء حالته الحالية هي '${excInfo.status}'`);
      }

      // Segregation of Duties (SoD): Requester must exist and Approver cannot be requester
      if (!excInfo.requestedBy) {
        throw new ValidationError('لا يمكن التحقق من فصل المهام (SoD) لعدم توفر معرف مقدم الطلب');
      }
      if (normalizedActorId === excInfo.requestedBy) {
        throw new ValidationError('قواعد فصل المهام (SoD) تمنع مقدم طلب الاستثناء من اعتماده بنفسه');
      }

      // 2. WP-6: Lock target invoice FOR UPDATE FIRST
      const invoice = await this.invoiceRepo.findByIdForUpdate(companyId, excInfo.invoiceId, tx);
      if (!invoice) {
        throw new NotFoundError('فاتورة المورد المرتبطة غير موجودة');
      }
      if (invoice.status === 'posted') {
        throw new ValidationError('فاتورة المورد مرحلة بالفعل');
      }
      if (invoice.status === 'cancelled') {
        throw new ValidationError('فاتورة المورد ملغاة');
      }

      // 3. WP-6: Lock target exception FOR UPDATE SECOND
      const exc = await this.exceptionRepo.findByIdForUpdate(companyId, exceptionId, tx);
      if (!exc) {
        throw new NotFoundError('طلب استثناء تباين الأسعار غير موجود');
      }
      if (exc.invoiceId !== invoice.id || exc.companyId !== companyId) {
        throw new ValidationError('عدم تطابق بين طلب الاستثناء والفاتورة المرتبطة');
      }
      if (exc.status !== 'pending') {
        throw new ValidationError(`لا يمكن اعتماد طلب استثناء حالته الحالية هي '${exc.status}'`);
      }
      if (!exc.requestedBy) {
        throw new ValidationError('لا يمكن التحقق من فصل المهام (SoD) لعدم توفر معرف مقدم الطلب');
      }
      if (normalizedActorId === exc.requestedBy) {
        throw new ValidationError('قواعد فصل المهام (SoD) تمنع مقدم طلب الاستثناء من اعتماده بنفسه');
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
        // WP-4 Option A: Persist status='superseded' inside committed transaction boundary
        await this.exceptionRepo.updateStatus(
          companyId,
          exceptionId,
          'superseded',
          normalizedActorId,
          'تغيرت بنود الفاتورة أو أسعارها بعد تقديم طلب الاستثناء',
          tx
        );

        await this.auditService.record(
          {
            actorUserId: normalizedActorId,
            companyId,
            action: 'PURCHASING_VARIANCE_SUPERSEDE',
            entityType: 'purch_price_variance_exceptions',
            entityId: exceptionId,
            metadata: {
              invoiceId: exc.invoiceId,
              reason: 'تغيرت بنود الفاتورة أو أسعارها بعد تقديم طلب الاستثناء',
              oldFingerprint: exc.fingerprint,
              newFingerprint: currentFingerprint,
            },
          },
          { executor: tx }
        );

        fingerprintMismatch = true;
        return; // Exits transaction block cleanly to commit status='superseded'
      }

      approvedResult = await this.exceptionRepo.updateStatus(
        companyId,
        exceptionId,
        'approved',
        normalizedActorId,
        decisionReason?.trim() || null,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: normalizedActorId,
          companyId,
          action: 'PURCHASING_VARIANCE_APPROVE',
          entityType: 'purch_price_variance_exceptions',
          entityId: exceptionId,
          metadata: { invoiceId: exc.invoiceId, decisionReason: decisionReason?.trim() || null },
        },
        { executor: tx }
      );
    });

    if (fingerprintMismatch) {
      throw new ValidationError('تغيرت بنود الفاتورة أو أسعارها بعد تقديم طلب الاستثناء؛ تم إلغاء الطلب ويجب تقديم طلب جديد.');
    }

    return approvedResult!;
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
    if (!actorId || typeof actorId !== 'string' || actorId.trim() === '') {
      throw new ValidationError('معرف المستخدم (actorId) مطلوب لرفض الاستثناء');
    }
    const normalizedActorId = actorId.trim();

    return await withTenantTransaction(companyId, async (tx) => {
      // 1. Initial lookup to identify target invoice and validate basic status
      const excInfo = await this.exceptionRepo.findById(companyId, exceptionId, tx);
      if (!excInfo) {
        throw new NotFoundError('طلب استثناء تباين الأسعار غير موجود');
      }
      if (excInfo.status !== 'pending') {
        throw new ValidationError(`لا يمكن رفض طلب استثناء حالته الحالية هي '${excInfo.status}'`);
      }

      // WP-5: SoD check on reject (requester cannot reject their own request)
      if (!excInfo.requestedBy) {
        throw new ValidationError('لا يمكن التحقق من فصل المهام (SoD) لعدم توفر معرف مقدم الطلب');
      }
      if (normalizedActorId === excInfo.requestedBy) {
        throw new ValidationError('قواعد فصل المهام (SoD) تمنع مقدم طلب الاستثناء من رفضه بنفسه');
      }

      // 2. WP-6: Lock target invoice FOR UPDATE FIRST
      const invoice = await this.invoiceRepo.findByIdForUpdate(companyId, excInfo.invoiceId, tx);
      if (!invoice) {
        throw new NotFoundError('فاتورة المورد المرتبطة غير موجودة');
      }
      if (invoice.status === 'posted') {
        throw new ValidationError('فاتورة المورد مرحلة بالفعل');
      }
      if (invoice.status === 'cancelled') {
        throw new ValidationError('فاتورة المورد ملغاة');
      }

      // 3. WP-6: Lock target exception FOR UPDATE SECOND
      const exc = await this.exceptionRepo.findByIdForUpdate(companyId, exceptionId, tx);
      if (!exc) {
        throw new NotFoundError('طلب استثناء تباين الأسعار غير موجود');
      }
      if (exc.invoiceId !== invoice.id || exc.companyId !== companyId) {
        throw new ValidationError('عدم تطابق بين طلب الاستثناء والفاتورة المرتبطة');
      }
      if (exc.status !== 'pending') {
        throw new ValidationError(`لا يمكن رفض طلب استثناء حالته الحالية هي '${exc.status}'`);
      }
      if (!exc.requestedBy) {
        throw new ValidationError('لا يمكن التحقق من فصل المهام (SoD) لعدم توفر معرف مقدم الطلب');
      }
      if (normalizedActorId === exc.requestedBy) {
        throw new ValidationError('قواعد فصل المهام (SoD) تمنع مقدم طلب الاستثناء من رفضه بنفسه');
      }

      const rejected = await this.exceptionRepo.updateStatus(
        companyId,
        exceptionId,
        'rejected',
        normalizedActorId,
        decisionReason?.trim() || null,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: normalizedActorId,
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

    return await withTenantTransaction(companyId, async (tx) => {
      const invoice = await this.invoiceRepo.findById(companyId, invoiceId, tx);
      if (!invoice) {
        throw new NotFoundError('فاتورة المورد غير موجودة');
      }

      const invoiceLines = invoice.lines || [];
      let currentFingerprint: string | null = null;
      if (invoiceLines.length > 0) {
        const report = await this.threeWayMatchService.evaluateInvoice(companyId, invoiceId, tx);
        const linesPayload = invoiceLines.map((l) => {
          const matchLine = report.lines.find((m) => m.grnLineId === l.grnLineId);
          const refUnitCost =
            matchLine?.poLineId && matchLine.poUnitCost !== null && matchLine.poUnitCost !== undefined
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
        currentFingerprint = this.exceptionRepo.computeFingerprint(
          companyId,
          invoiceId,
          invoice.supplierId,
          linesPayload
        );
      }

      const rows = await this.exceptionRepo.listByInvoice(companyId, invoiceId, tx);
      return rows.map((row) => {
        const isFingerprintValid = Boolean(currentFingerprint && row.fingerprint === currentFingerprint);
        const isExpired = (row.status === 'pending' || row.status === 'approved') && !isFingerprintValid;
        return {
          ...row,
          isFingerprintValid,
          isExpired,
        };
      });
    });
  }
}

export const defaultPriceVarianceExceptionService = new PriceVarianceExceptionService();
