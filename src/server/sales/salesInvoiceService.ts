import { SalesInvoiceRepository, defaultSalesInvoiceRepository } from './salesInvoiceRepository.js';
import { CustomerRepository, defaultCustomerRepository } from './customerRepository.js';
import { JournalRepository, defaultJournalRepository } from '../accounting/journalRepository.js';
import { JournalService, defaultJournalService } from '../accounting/journalService.js';
import { AuditService, defaultAuditService } from '../audit/auditService.js';
import { SalesInvoice, CreateSalesInvoiceInput } from './salesTypes.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class SalesInvoiceService {
  constructor(
    private invoiceRepo: SalesInvoiceRepository = defaultSalesInvoiceRepository,
    private customerRepo: CustomerRepository = defaultCustomerRepository,
    private journalRepo: JournalRepository = defaultJournalRepository,
    private journalService: JournalService = defaultJournalService,
    private auditService: AuditService = defaultAuditService
  ) {}

  async listInvoices(companyId: string): Promise<SalesInvoice[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.invoiceRepo.list(companyId);
  }

  async getInvoice(companyId: string, id: string): Promise<SalesInvoice> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');
    const invoice = await this.invoiceRepo.findById(companyId, id);
    if (!invoice) throw new NotFoundError('فاتورة المبيعات غير موجودة');
    return invoice;
  }

  async listOutstandingInvoices(companyId: string, customerId?: string): Promise<any[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.invoiceRepo.listOutstandingInvoices(companyId, customerId);
  }

  async createInvoice(companyId: string, input: CreateSalesInvoiceInput, actorUserId?: string): Promise<SalesInvoice> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!input.customerId) throw new ValidationError('العميل مطلوب');
    if (!input.lines || input.lines.length === 0) {
      throw new ValidationError('يجب إضافة بند واحد على الأقل في فاتورة المبيعات');
    }

    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const customer = await this.customerRepo.findById(companyId, input.customerId, tx);
      if (!customer || !customer.isActive) {
        throw new ValidationError('العميل غير موجود أو غير نشط');
      }

      if (input.deliveryId) {
        const delRes = await tx.query<any>(
          `SELECT id, status, customer_id FROM sales_delivery_notes WHERE company_id = $1 AND id = $2`,
          [companyId, input.deliveryId]
        );
        if (delRes.rows.length === 0) {
          throw new NotFoundError('إذن التسليم المحدد غير موجود');
        }
        if (delRes.rows[0].status !== 'posted') {
          throw new ValidationError('لا يمكن إنشاء فاتورة مبيعات مرتبطة بإذن تسليم غير مرحل');
        }
        if (delRes.rows[0].customer_id !== input.customerId) {
          throw new ValidationError('عميل الفاتورة لا يطابق عميل إذن التسليم');
        }
      }

      const seenDeliveryLines = new Set<string>();
      for (const line of input.lines) {
        if (!line.itemId) throw new ValidationError('الصنف مطلوب في جميع البنود');
        if (typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0) {
          throw new ValidationError('الكمية يجب أن تكون أكبر من الصفر');
        }
        if (typeof line.unitPrice !== 'number' || !Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
          throw new ValidationError('سعر الوحدة غير صالح');
        }
        if (line.deliveryLineId) {
          if (seenDeliveryLines.has(line.deliveryLineId)) {
            throw new ValidationError('لا يمكن تكرار نفس بند إذن التسليم في نفس الفاتورة');
          }
          seenDeliveryLines.add(line.deliveryLineId);

          const dlRes = await tx.query<any>(
            `SELECT dl.id, dl.qty, dl.item_id
             FROM sales_delivery_lines dl
             INNER JOIN sales_delivery_notes dn ON dn.id = dl.delivery_id AND dn.company_id = dl.company_id
             WHERE dl.company_id = $1 AND dl.id = $2 AND dn.status = 'posted'
             FOR UPDATE OF dl`,
            [companyId, line.deliveryLineId]
          );
          if (dlRes.rows.length === 0) {
            throw new ValidationError('بند إذن التسليم المرتبط غير موجود أو غير مرحل');
          }
          const invSumRes = await tx.query<any>(
            `SELECT COALESCE(SUM(sil.qty), 0) as invoiced_qty
             FROM sales_invoice_lines sil
             INNER JOIN sales_invoices si ON si.id = sil.invoice_id AND si.company_id = sil.company_id
             WHERE sil.company_id = $1 AND sil.delivery_line_id = $2 AND si.status <> 'cancelled'`,
            [companyId, line.deliveryLineId]
          );
          const deliveredQty = parseFloat(dlRes.rows[0].qty || '0');
          const alreadyInvoicedQty = parseFloat(invSumRes.rows[0]?.invoiced_qty || '0');
          const remainingQty = Math.max(0, deliveredQty - alreadyInvoicedQty);
          if (line.qty > remainingQty + 0.0001) {
            throw new ValidationError(
              `كمية الفاتورة (${line.qty}) تتجاوز الكمية المتبقية غير المفوترة من إذن التسليم (${remainingQty})`
            );
          }
        }
      }

      const created = await this.invoiceRepo.createDraft(companyId, input, actorUserId, tx);

      await this.auditService.record(
        {
          actorUserId: actorUserId || null,
          companyId,
          action: 'SALES_INVOICE_CREATE',
          entityType: 'sales_invoices',
          entityId: created.id,
          metadata: { customerId: input.customerId, totalAmount: created.totalAmount, linesCount: input.lines.length },
        },
        { executor: tx }
      );

      return created;
    });
  }

  private async resolveArAccount(companyId: string, executor: DbExecutor): Promise<string> {
    const settingsRes = await executor.query<any>(
      `SELECT accounts_receivable_account_id as "arAccountId" FROM company_settings WHERE company_id = $1`,
      [companyId]
    );
    if (settingsRes.rows[0]?.arAccountId) {
      return settingsRes.rows[0].arAccountId;
    }

    // Fallback: look for postable AR account (code 1200 or asset account named عملاء / مدينون)
    const sql = `
      SELECT id FROM accounts
      WHERE company_id = $1 AND is_active = true AND is_postable = true
        AND (code = '1200' OR (account_type = 'asset' AND (name_ar LIKE '%عملاء%' OR name_ar LIKE '%مدين%')))
      ORDER BY code ASC
      LIMIT 1
    `;
    const res = await executor.query<any>(sql, [companyId]);
    if (res.rows.length > 0) {
      return res.rows[0].id;
    }

    // General fallback: first active postable asset account
    const anyAsset = await executor.query<any>(
      `SELECT id FROM accounts WHERE company_id = $1 AND is_active = true AND is_postable = true AND account_type = 'asset' ORDER BY code ASC LIMIT 1`,
      [companyId]
    );
    if (anyAsset.rows.length > 0) return anyAsset.rows[0].id;

    throw new ValidationError('يرجى ضبط حساب العملاء / الذمم المدينة (AR) في إعدادات الشركة قبل ترحيل الفواتير');
  }

  private async resolveRevenueAccount(companyId: string, executor: DbExecutor): Promise<string> {
    const settingsRes = await executor.query<any>(
      `SELECT sales_revenue_account_id as "revAccountId" FROM company_settings WHERE company_id = $1`,
      [companyId]
    );
    if (settingsRes.rows[0]?.revAccountId) {
      return settingsRes.rows[0].revAccountId;
    }

    // Fallback: look for postable revenue account (code 4100 or revenue account)
    const sql = `
      SELECT id FROM accounts
      WHERE company_id = $1 AND is_active = true AND is_postable = true
        AND (code = '4100' OR account_type = 'revenue')
      ORDER BY code ASC
      LIMIT 1
    `;
    const res = await executor.query<any>(sql, [companyId]);
    if (res.rows.length > 0) {
      return res.rows[0].id;
    }

    throw new ValidationError('يرجى ضبط حساب إيراد المبيعات في إعدادات الشركة قبل ترحيل الفواتير');
  }

  async postInvoice(companyId: string, id: string, actorUserId?: string): Promise<SalesInvoice> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');

    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const locked = await this.invoiceRepo.findByIdForUpdate(companyId, id, tx);
      if (!locked) {
        throw new NotFoundError('فاتورة المبيعات غير موجودة');
      }
      if (locked.status === 'posted') {
        throw new ValidationError('فاتورة المبيعات مرحلة مسبقاً');
      }
      if (locked.status === 'cancelled') {
        throw new ValidationError('لا يمكن ترحيل فاتورة ملغاة');
      }

      const invoice = await this.invoiceRepo.findById(companyId, id, tx);
      if (!invoice || !invoice.lines || invoice.lines.length === 0) {
        throw new ValidationError('فاتورة المبيعات لا تحتوي على بنود لترحيلها');
      }

      // Re-verify linked delivery line remaining quantity under FOR UPDATE
      for (const line of invoice.lines) {
        if (line.deliveryLineId) {
          const dlRes = await tx.query<any>(
            `SELECT dl.id, dl.qty
             FROM sales_delivery_lines dl
             INNER JOIN sales_delivery_notes dn ON dn.id = dl.delivery_id AND dn.company_id = dl.company_id
             WHERE dl.company_id = $1 AND dl.id = $2 AND dn.status = 'posted'
             FOR UPDATE OF dl`,
            [companyId, line.deliveryLineId]
          );
          if (dlRes.rows.length === 0) {
            throw new ValidationError('بند إذن التسليم المرتبط غير موجود أو غير مرحل');
          }
          const invSumRes = await tx.query<any>(
            `SELECT COALESCE(SUM(sil.qty), 0) as invoiced_qty
             FROM sales_invoice_lines sil
             INNER JOIN sales_invoices si ON si.id = sil.invoice_id AND si.company_id = sil.company_id
             WHERE sil.company_id = $1 AND sil.delivery_line_id = $2 AND si.status <> 'cancelled' AND si.id <> $3`,
            [companyId, line.deliveryLineId, id]
          );
          const deliveredQty = parseFloat(dlRes.rows[0].qty || '0');
          const otherInvoicedQty = parseFloat(invSumRes.rows[0]?.invoiced_qty || '0');
          const remainingQty = Math.max(0, deliveredQty - otherInvoicedQty);
          if (line.qty > remainingQty + 0.0001) {
            throw new ValidationError(
              `كمية الفاتورة (${line.qty}) تتجاوز الكمية المتبقية غير المفوترة من إذن التسليم (${remainingQty})`
            );
          }
        }
      }

      if (!(invoice.totalAmount > 0)) {
        throw new ValidationError('قيمة فاتورة المبيعات الإجمالية يجب أن تكون أكبر من الصفر لترحيلها');
      }

      const arAccountId = await this.resolveArAccount(companyId, tx);
      const revAccountId = await this.resolveRevenueAccount(companyId, tx);

      const invoiceNo = await this.journalRepo.allocateSequenceNumber(companyId, 'sales_invoice', 'SINV', tx);
      const entryDate = ISO_DATE.test(invoice.invoiceDate) ? invoice.invoiceDate : new Date().toISOString().slice(0, 10);

      // Construct balanced journal entry
      const lines: any[] = [
        {
          accountId: arAccountId,
          debit: invoice.totalAmount,
          credit: 0,
          lineMemo: `إثبات مديونية عميل فاتورة مبيعات رقم ${invoiceNo} (${invoice.customerNameAr || ''})`,
        },
        {
          accountId: revAccountId,
          debit: 0,
          credit: invoice.totalAmount, // Subtotal + Tax credited to sales revenue (or tax if split)
          lineMemo: `إيراد مبيعات فاتورة رقم ${invoiceNo}`,
        },
      ];

      const draftJe = await this.journalService.createDraftEntry(
        companyId,
        {
          entryDate,
          memo: `ترحيل فاتورة مبيعات رقم ${invoiceNo} للعميل ${invoice.customerNameAr || invoice.customerId}`,
          lines,
        },
        actorUserId || '',
        false,
        tx
      );

      const postedJe = await this.journalService.postEntry(companyId, draftJe.id, actorUserId || '', false, tx);

      await this.invoiceRepo.markPosted(companyId, id, invoiceNo, postedJe.id, actorUserId, tx);

      await this.auditService.record(
        {
          actorUserId: actorUserId || null,
          companyId,
          action: 'SALES_INVOICE_POST',
          entityType: 'sales_invoices',
          entityId: id,
          metadata: { invoiceNo, totalAmount: invoice.totalAmount, journalEntryId: postedJe.id },
        },
        { executor: tx }
      );

      const posted = await this.invoiceRepo.findById(companyId, id, tx);
      return posted!;
    });
  }

  async deleteInvoice(companyId: string, id: string, actorUserId?: string): Promise<boolean> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');

    const success = await this.invoiceRepo.delete(companyId, id);
    if (!success) throw new NotFoundError('فاتورة المبيعات غير موجودة أو تم ترحيلها مسبقاً ولا يمكن حذفها');

    await this.auditService.record({
      actorUserId: actorUserId || null,
      companyId,
      action: 'SALES_INVOICE_DELETE',
      entityType: 'sales_invoices',
      entityId: id,
    });

    return true;
  }
}

export const defaultSalesInvoiceService = new SalesInvoiceService();
