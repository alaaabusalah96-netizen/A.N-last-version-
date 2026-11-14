import { defaultInvoiceRepository, InvoiceRepository } from './invoiceRepository.js';
import { defaultSupplierRepository, SupplierRepository } from './supplierRepository.js';
import { defaultCompanySettingsRepository, CompanySettingsRepository } from '../org/companySettingsRepository.js';
import { defaultJournalRepository, JournalRepository } from '../accounting/journalRepository.js';
import { defaultJournalService, JournalService } from '../accounting/journalService.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { defaultConfigService, ConfigService } from '../config-platform/configService.js';
import { defaultAccountRepository, AccountRepository } from '../accounting/accountRepository.js';
import { findGlEvent } from '../accounting/glEventCatalog.js';
import { GlMappingService } from '../accounting/glMappingService.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { SupplierInvoice, CreateSupplierInvoiceInput, OutstandingGrnLineRow } from './purchasingTypes.js';
import { toDecimal, toMoney } from '../lib/numeric.js';
import { CompanySettings } from '../org/companySettingsTypes.js';
import { DbExecutor } from '../db/types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class InvoiceService {
  private glMappingService: GlMappingService;

  constructor(
    private invoiceRepo: InvoiceRepository = defaultInvoiceRepository,
    private supplierRepo: SupplierRepository = defaultSupplierRepository,
    private settingsRepo: CompanySettingsRepository = defaultCompanySettingsRepository,
    private journalRepo: JournalRepository = defaultJournalRepository,
    private journalService: Pick<JournalService, 'createDraftEntry' | 'postEntry'> = defaultJournalService,
    private auditService: AuditService = defaultAuditService,
    private configService: Pick<ConfigService, 'resolveConfig'> = defaultConfigService,
    private accountRepo: AccountRepository = defaultAccountRepository
  ) {
    this.glMappingService = new GlMappingService(this.configService, this.accountRepo);
  }

  async listInvoices(companyId: string): Promise<SupplierInvoice[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.invoiceRepo.listByCompany(companyId);
  }

  async getInvoice(companyId: string, invoiceId: string): Promise<SupplierInvoice> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!invoiceId || typeof invoiceId !== 'string') {
      throw new ValidationError('invoiceId is required');
    }
    const inv = await this.invoiceRepo.findById(companyId, invoiceId);
    if (!inv) {
      throw new NotFoundError('فاتورة المورد غير موجودة');
    }
    return inv;
  }

  async getOutstandingLines(companyId: string, supplierId: string): Promise<OutstandingGrnLineRow[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!supplierId || typeof supplierId !== 'string') {
      throw new ValidationError('supplierId is required');
    }
    return await this.invoiceRepo.listOutstandingLines(companyId, supplierId);
  }

  async createInvoice(
    companyId: string,
    input: CreateSupplierInvoiceInput,
    actorId?: string
  ): Promise<SupplierInvoice> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!input.supplierId || typeof input.supplierId !== 'string') {
      throw new ValidationError('المورد مطلوب');
    }
    if (!input.supplierInvoiceNo || typeof input.supplierInvoiceNo !== 'string' || input.supplierInvoiceNo.trim() === '') {
      throw new ValidationError('رقم فاتورة المورد مطلوب');
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new ValidationError('يجب إضافة بند واحد على الأقل في فاتورة المورد');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const supplier = await this.supplierRepo.findById(companyId, input.supplierId, tx);
      if (!supplier) {
        throw new NotFoundError('المورد المحدد غير موجود');
      }
      if (!supplier.isActive) {
        throw new ValidationError('المورد المحدد غير نشط');
      }

      // Check unique supplierInvoiceNo per supplier & company
      const dupCheck = await tx.query(
        `SELECT id FROM purch_supplier_invoices WHERE company_id = $1 AND supplier_id = $2 AND supplier_invoice_no = $3`,
        [companyId, input.supplierId, input.supplierInvoiceNo.trim()]
      );
      if (dupCheck.rows.length > 0) {
        throw new ValidationError('رقم فاتورة المورد موجود مسبقاً لهذا المورد');
      }

      const outstandingLines = await this.invoiceRepo.listOutstandingLines(companyId, input.supplierId, tx);
      const outstandingMap = new Map<string, OutstandingGrnLineRow>();
      for (const ol of outstandingLines) {
        outstandingMap.set(ol.grnLineId, ol);
      }

      for (const line of input.lines) {
        if (!line.grnLineId || typeof line.grnLineId !== 'string') {
          throw new ValidationError('كافة بنود الفاتورة تتطلب ربطاً ببند سند استلام (grnLineId)');
        }
        if (typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0) {
          throw new ValidationError('كمية البند يجب أن تكون أكبر من الصفر');
        }
        if (typeof line.unitCost !== 'number' || !Number.isFinite(line.unitCost) || line.unitCost < 0) {
          throw new ValidationError('تكلفة الوحدة يجب أن تكون رقمًا صالحًا غير سالبة');
        }

        const outLine = outstandingMap.get(line.grnLineId);
        if (!outLine) {
          throw new ValidationError('بند استلام البضائع المحدد غير موجود، غير مرحل، أو تم ترفيع فاتورته كاملاً');
        }

        if (toDecimal(line.qty) > toDecimal(outLine.remainingQty)) {
          throw new ValidationError(
            `كمية البند المطلوبة (${line.qty}) تتجاوز الكمية المتبقية غير المفوترة (${outLine.remainingQty}) للبند`
          );
        }
      }

      const created = await this.invoiceRepo.createDraft(
        companyId,
        {
          supplierId: input.supplierId,
          supplierInvoiceNo: input.supplierInvoiceNo.trim(),
          invoiceDate: input.invoiceDate,
          dueDate: input.dueDate,
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
          action: 'SUPPLIER_INVOICE_CREATE',
          entityType: 'purch_supplier_invoices',
          entityId: created.id,
          metadata: {
            supplierId: input.supplierId,
            supplierInvoiceNo: input.supplierInvoiceNo.trim(),
            lineCount: input.lines.length,
          },
        },
        { executor: tx }
      );

      const full = await this.invoiceRepo.findById(companyId, created.id, tx);
      return full || created;
    });
  }

  private requireGlAccounts(settings: CompanySettings | null): {
    purchasesClearingAccountId: string;
    accountsPayableAccountId: string;
  } {
    if (!settings || !settings.purchasesClearingAccountId || !settings.accountsPayableAccountId) {
      throw new ValidationError(
        'لا يمكن ترحيل فاتورة المورد محاسبياً قبل ضبط "حساب المشتريات المعلقة" و"حساب الدائنين (الموردون)" في إعدادات الشركة.'
      );
    }
    return {
      purchasesClearingAccountId: settings.purchasesClearingAccountId,
      accountsPayableAccountId: settings.accountsPayableAccountId,
    };
  }

  private async resolveGlMapping(
    companyId: string
  ): Promise<{
    purchasesClearingAccountId: string;
    accountsPayableAccountId: string;
    source: 'config_platform' | 'company_settings';
    versionNo: number | null;
  }> {
    try {
      const resolved = await this.glMappingService.resolve(companyId, 'accounting.purchase_invoice_mapping');
      const clr = (resolved.accounts.purchases_clearing_account_id || '').trim();
      const ap = (resolved.accounts.accounts_payable_account_id || '').trim();
      if (clr !== '' && ap !== '') {
        return {
          purchasesClearingAccountId: clr,
          accountsPayableAccountId: ap,
          source: 'config_platform',
          versionNo: resolved.versionNo,
        };
      }
    } catch (err) {
      if (!(err instanceof NotFoundError) && !(err instanceof Error && /not found|غير موجود/i.test(err.message))) {
        throw err;
      }
    }

    const settings = await this.settingsRepo.getByCompanyId(companyId);
    const gl = this.requireGlAccounts(settings);
    return { ...gl, source: 'company_settings', versionNo: null };
  }

  private async assertGlAccountsUsable(
    companyId: string,
    gl: { purchasesClearingAccountId: string; accountsPayableAccountId: string },
    tx: DbExecutor
  ): Promise<void> {
    const def = findGlEvent('accounting.purchase_invoice_mapping');
    if (!def) {
      throw new ValidationError('تعريف حدث الربط المحاسبي accounting.purchase_invoice_mapping مفقود من الكتالوج');
    }
    await this.glMappingService.assertUsable(
      companyId,
      def,
      {
        purchases_clearing_account_id: gl.purchasesClearingAccountId,
        accounts_payable_account_id: gl.accountsPayableAccountId,
      },
      tx
    );
  }

  async postInvoice(companyId: string, invoiceId: string, actorId?: string): Promise<SupplierInvoice> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!invoiceId || typeof invoiceId !== 'string') {
      throw new ValidationError('invoiceId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const locked = await this.invoiceRepo.findByIdForUpdate(companyId, invoiceId, tx);
      if (!locked) {
        throw new NotFoundError('فاتورة المورد غير موجودة');
      }
      if (locked.status === 'posted') {
        throw new ValidationError('فاتورة المورد مرحلة مسبقاً ولا يمكن تكرار ترحيلها');
      }
      if (locked.status === 'cancelled') {
        throw new ValidationError('لا يمكن ترحيل فاتورة ملغاة');
      }

      const invoice = await this.invoiceRepo.findById(companyId, invoiceId, tx);
      if (!invoice || !invoice.lines || invoice.lines.length === 0) {
        throw new ValidationError('فاتورة المورد لا تحتوي على بنود لترحيلها');
      }

      // Re-check remaining quantities for concurrency protection
      const outstandingLines = await this.invoiceRepo.listOutstandingLines(companyId, invoice.supplierId, tx);
      const outstandingMap = new Map<string, OutstandingGrnLineRow>();
      for (const ol of outstandingLines) {
        outstandingMap.set(ol.grnLineId, ol);
      }

      let totalAmount = 0;
      for (const line of invoice.lines) {
        const outLine = outstandingMap.get(line.grnLineId);
        if (!outLine) {
          throw new ValidationError('أحد بنود الفاتورة لم يعد لديه كميات استلام متبقية غير مفوترة');
        }
        if (toDecimal(line.qty) > toDecimal(outLine.remainingQty)) {
          throw new ValidationError(
            `كمية البند تتجاوز الكمية المتبقية غير المفوترة (${outLine.remainingQty})`
          );
        }
        totalAmount += toDecimal(line.qty) * toDecimal(line.unitCost);
      }

      totalAmount = toMoney(totalAmount);
      if (!(totalAmount > 0)) {
        throw new ValidationError('لا يمكن ترحيل فاتورة بقيمة إجمالية صفر أو سالبة');
      }

      const gl = await this.resolveGlMapping(companyId);
      await this.assertGlAccountsUsable(companyId, gl, tx);

      const entryDate = ISO_DATE.test(invoice.invoiceDate) ? invoice.invoiceDate : new Date().toISOString().slice(0, 10);
      const invoiceNo = await this.journalRepo.allocateSequenceNumber(companyId, 'purchase_invoice', 'PINV', tx);

      const draftJe = await this.journalService.createDraftEntry(
        companyId,
        {
          entryDate,
          memo: `ترحيل فاتورة مورد رقم ${invoiceNo} (فاتورة رقم: ${invoice.supplierInvoiceNo})`,
          lines: [
            {
              accountId: gl.purchasesClearingAccountId,
              debit: totalAmount,
              credit: 0,
              lineMemo: `استحقاق مشتريات فاتورة ${invoice.supplierInvoiceNo}`,
            },
            {
              accountId: gl.accountsPayableAccountId,
              debit: 0,
              credit: totalAmount,
              lineMemo: `حساب المورد / الدائنين فاتورة ${invoice.supplierInvoiceNo}`,
            },
          ],
        },
        actorId || '',
        false,
        tx
      );

      const postedJe = await this.journalService.postEntry(companyId, draftJe.id, actorId || '', false, tx);

      await this.invoiceRepo.markPosted(companyId, invoiceId, invoiceNo, postedJe.id, actorId || '', tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'SUPPLIER_INVOICE_POST',
          entityType: 'purch_supplier_invoices',
          entityId: invoiceId,
          metadata: {
            invoiceNo,
            supplierInvoiceNo: invoice.supplierInvoiceNo,
            totalAmount,
            journalEntryId: postedJe.id,
            glSource: gl.source,
          },
        },
        { executor: tx }
      );

      const updated = await this.invoiceRepo.findById(companyId, invoiceId, tx);
      return updated!;
    });
  }

  async deleteInvoice(companyId: string, invoiceId: string, actorId?: string): Promise<void> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!invoiceId || typeof invoiceId !== 'string') {
      throw new ValidationError('invoiceId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const locked = await this.invoiceRepo.findByIdForUpdate(companyId, invoiceId, tx);
      if (!locked) {
        throw new NotFoundError('فاتورة المورد غير موجودة');
      }
      if (locked.status === 'posted') {
        throw new ValidationError('لا يمكن حذف فاتورة مورد مرحلة');
      }

      await this.invoiceRepo.deleteDraft(companyId, invoiceId, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'SUPPLIER_INVOICE_DELETE',
          entityType: 'purch_supplier_invoices',
          entityId: invoiceId,
          metadata: { supplierInvoiceNo: locked.supplierInvoiceNo },
        },
        { executor: tx }
      );
    });
  }
}

export const defaultInvoiceService = new InvoiceService();
