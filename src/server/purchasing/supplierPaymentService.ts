import { defaultSupplierPaymentRepository, SupplierPaymentRepository, SupplierPayment, CreateSupplierPaymentInput } from './supplierPaymentRepository.js';
import { defaultCashRegisterRepository, CashRegisterRepository } from '../cash/cashRegisterRepository.js';
import { defaultCashRegisterService, CashRegisterService } from '../cash/cashRegisterService.js';
import { defaultSupplierRepository, SupplierRepository } from './supplierRepository.js';
import { defaultInvoiceRepository, InvoiceRepository } from './invoiceRepository.js';
import { defaultCompanySettingsRepository, CompanySettingsRepository } from '../org/companySettingsRepository.js';
import { defaultJournalRepository, JournalRepository } from '../accounting/journalRepository.js';
import { defaultJournalService, JournalService } from '../accounting/journalService.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { defaultConfigService, ConfigService } from '../config-platform/configService.js';
import { defaultAccountRepository, AccountRepository } from '../accounting/accountRepository.js';
import { GlMappingService } from '../accounting/glMappingService.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { toDecimal, toMinorUnits } from '../lib/numeric.js';
import {
  assertOptionalCalendarDate,
  isValidCalendarDate,
  resolveCompanyToday,
} from '../lib/calendarDate.js';

export class SupplierPaymentService {
  private glMappingService: GlMappingService;

  constructor(
    private paymentRepo: SupplierPaymentRepository = defaultSupplierPaymentRepository,
    private registerRepo: CashRegisterRepository = defaultCashRegisterRepository,
    private registerService: Pick<CashRegisterService, 'getBalance'> = defaultCashRegisterService,
    private supplierRepo: SupplierRepository = defaultSupplierRepository,
    private invoiceRepo: InvoiceRepository = defaultInvoiceRepository,
    private settingsRepo: CompanySettingsRepository = defaultCompanySettingsRepository,
    private journalRepo: JournalRepository = defaultJournalRepository,
    private journalService: Pick<JournalService, 'createDraftEntry' | 'postEntry'> = defaultJournalService,
    private auditService: AuditService = defaultAuditService,
    private configService: Pick<ConfigService, 'resolveConfig'> = defaultConfigService,
    private accountRepo: AccountRepository = defaultAccountRepository
  ) {
    this.glMappingService = new GlMappingService(this.configService, this.accountRepo);
  }

  async listPayments(companyId: string): Promise<SupplierPayment[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.paymentRepo.listByCompany(companyId);
  }

  async getPayment(companyId: string, paymentId: string): Promise<SupplierPayment> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!paymentId || typeof paymentId !== 'string') {
      throw new ValidationError('paymentId is required');
    }
    const pay = await this.paymentRepo.findById(companyId, paymentId);
    if (!pay) {
      throw new NotFoundError('سند سداد المورد غير موجود');
    }
    return pay;
  }

  async createPayment(
    companyId: string,
    input: CreateSupplierPaymentInput,
    actorId?: string
  ): Promise<SupplierPayment> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!input.supplierId || typeof input.supplierId !== 'string') {
      throw new ValidationError('المورد مطلوب');
    }
    if (!input.invoiceId || typeof input.invoiceId !== 'string') {
      throw new ValidationError('الفاتورة المستهدفة مطلوبة');
    }
    if (!input.registerId || typeof input.registerId !== 'string') {
      throw new ValidationError('صندوق النقدية مطلوب');
    }
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0) {
      throw new ValidationError('مبلغ السداد يجب أن يكون أكبر من الصفر');
    }
    const validatedPaymentDate = assertOptionalCalendarDate(input.paymentDate, 'تاريخ السداد');

    return await withTenantTransaction(companyId, async (tx) => {
      const supplier = await this.supplierRepo.findById(companyId, input.supplierId, tx);
      if (!supplier || !supplier.isActive) {
        throw new ValidationError('المورد غير موجود أو غير نشط');
      }

      const register = await this.registerRepo.findById(companyId, input.registerId, tx);
      if (!register || !register.isActive) {
        throw new ValidationError('صندوق النقدية المحدد غير موجود أو غير نشط');
      }

      const invoice = await this.invoiceRepo.findById(companyId, input.invoiceId, tx);
      if (!invoice || invoice.status !== 'posted') {
        throw new ValidationError('فاتورة المورد غير موجودة أو غير مرحلة');
      }
      if (invoice.supplierId !== input.supplierId) {
        throw new ValidationError('المورد المحدد لا يطابق مورد الفاتورة');
      }

      const effectivePaymentDate = validatedPaymentDate ?? (await resolveCompanyToday(companyId, tx));

      const created = await this.paymentRepo.createDraft(
        companyId,
        {
          supplierId: input.supplierId,
          invoiceId: input.invoiceId,
          registerId: input.registerId,
          paymentDate: effectivePaymentDate,
          amount: input.amount,
          reference: input.reference,
          memo: input.memo,
        },
        actorId,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'SUPPLIER_PAYMENT_CREATE',
          entityType: 'purch_supplier_payments',
          entityId: created.id,
          metadata: { amount: input.amount, invoiceId: input.invoiceId, registerId: input.registerId },
        },
        { executor: tx }
      );

      return created;
    });
  }

  private async resolveApAccount(companyId: string): Promise<string> {
    try {
      const resolved = await this.glMappingService.resolve(companyId, 'accounting.purchase_invoice_mapping');
      const ap = (resolved.accounts.accounts_payable_account_id || '').trim();
      if (ap !== '') return ap;
    } catch {
      // ignore
    }
    const settings = await this.settingsRepo.getByCompanyId(companyId);
    if (!settings || !settings.accountsPayableAccountId) {
      throw new ValidationError('يرجى ضبط حساب الدائنين (الموردون) في إعدادات الشركة لترحيل السداد.');
    }
    return settings.accountsPayableAccountId;
  }

  async postPayment(companyId: string, paymentId: string, actorId?: string): Promise<SupplierPayment> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!paymentId || typeof paymentId !== 'string') {
      throw new ValidationError('paymentId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const locked = await this.paymentRepo.findByIdForUpdate(companyId, paymentId, tx);
      if (!locked) {
        throw new NotFoundError('سند سداد المورد غير موجود');
      }
      if (locked.status === 'posted') {
        throw new ValidationError('سند السداد مرحل مسبقاً');
      }
      if (locked.status === 'cancelled') {
        throw new ValidationError('لا يمكن ترحيل سند ملغى');
      }

      const payment = await this.paymentRepo.findById(companyId, paymentId, tx);
      if (!payment) {
        throw new NotFoundError('سند سداد المورد غير موجود');
      }

      const regLocked = await this.registerRepo.findById(companyId, payment.registerId, tx);
      if (!regLocked || !regLocked.isActive) {
        throw new ValidationError('صندوق النقدية غير موجود أو غير نشط');
      }
      if (!regLocked.glAccountId) {
        throw new ValidationError('صندوق النقدية غير مرتبط بحساب محاسبي (glAccountId)');
      }

      const invLocked = await this.invoiceRepo.findByIdForUpdate(companyId, payment.invoiceId, tx);
      if (!invLocked || invLocked.status !== 'posted') {
        throw new ValidationError('الفاتورة المرتبطة غير موجودة أو غير مرحلة');
      }

      const balanceRes = await tx.query<any>(
        `SELECT
           COALESCE(inv_tot.total, 0) as "invoiceTotal",
           COALESCE(ret_tot.total, 0) as "creditedTotal",
           COALESCE(pay_tot.total, 0) as "paidTotal"
         FROM purch_supplier_invoices si
         LEFT JOIN (
           SELECT invoice_id, SUM(qty * unit_cost) as total FROM purch_supplier_invoice_lines WHERE company_id = $1 AND invoice_id = $2 GROUP BY invoice_id
         ) inv_tot ON TRUE
         LEFT JOIN (
           SELECT pr.invoice_id, SUM(prl.qty * prl.unit_cost) as total FROM purch_return_lines prl INNER JOIN purch_returns pr ON pr.id = prl.return_id AND pr.company_id = prl.company_id WHERE pr.company_id = $1 AND pr.status = 'posted' AND pr.invoice_id = $2 GROUP BY pr.invoice_id
         ) ret_tot ON TRUE
         LEFT JOIN (
           SELECT invoice_id, SUM(amount) as total FROM purch_supplier_payments WHERE company_id = $1 AND status = 'posted' AND invoice_id = $2 AND id <> $3 GROUP BY invoice_id
         ) pay_tot ON TRUE
         WHERE si.company_id = $1 AND si.id = $2;`,
        [companyId, payment.invoiceId, paymentId]
      );

      const r = (balanceRes.rows[0] || {}) as { invoiceTotal?: any; creditedTotal?: any; paidTotal?: any };
      const invoiceTotal = toDecimal(r.invoiceTotal || 0, 2);
      const creditedTotal = toDecimal(r.creditedTotal || 0, 2);
      const paidTotal = toDecimal(r.paidTotal || 0, 2);
      const remainingOpen = Math.max(0, invoiceTotal - creditedTotal - paidTotal);

      if (toMinorUnits(payment.amount, 2) > toMinorUnits(remainingOpen, 2)) {
        throw new ValidationError(
          `مبلغ السداد (${payment.amount}) يتجاوز الرصيد المتبقي المفتوح للفاتورة (${remainingOpen})`
        );
      }

      const registerBalance = await this.registerService.getBalance(companyId, payment.registerId, tx);
      if (registerBalance.currentBalance < payment.amount) {
        throw new ValidationError(
          `رصيد صندوق النقدية غير كافٍ (${registerBalance.currentBalance}) لتغطية مبلغ السداد (${payment.amount})`
        );
      }

      const apAccountId = await this.resolveApAccount(companyId);
      const entryDate = isValidCalendarDate(payment.paymentDate)
        ? payment.paymentDate
        : await resolveCompanyToday(companyId, tx);
      const paymentNo = await this.journalRepo.allocateSequenceNumber(companyId, 'supplier_payment', 'SPAY', tx);

      const draftJe = await this.journalService.createDraftEntry(
        companyId,
        {
          entryDate,
          memo: `ترحيل سند سداد مورد رقم ${paymentNo} من صندوق ${regLocked.nameAr} (مورد: ${payment.supplierNameAr})`,
          lines: [
            {
              accountId: apAccountId,
              debit: payment.amount,
              credit: 0,
              lineMemo: `سداد المورد فاتورة ${payment.supplierInvoiceNo || ''} سند ${paymentNo}`,
            },
            {
              accountId: regLocked.glAccountId,
              debit: 0,
              credit: payment.amount,
              lineMemo: `صرف من صندوق ${regLocked.nameAr} سند ${paymentNo}`,
            },
          ],
        },
        actorId || '',
        false,
        tx
      );

      const postedJe = await this.journalService.postEntry(companyId, draftJe.id, actorId || '', false, tx);

      await this.paymentRepo.markPosted(companyId, paymentId, paymentNo, postedJe.id, actorId || '', tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'SUPPLIER_PAYMENT_POST',
          entityType: 'purch_supplier_payments',
          entityId: paymentId,
          metadata: {
            paymentNo,
            amount: payment.amount,
            registerId: payment.registerId,
            journalEntryId: postedJe.id,
          },
        },
        { executor: tx }
      );

      const updated = await this.paymentRepo.findById(companyId, paymentId, tx);
      return updated!;
    });
  }

  async cancelPayment(companyId: string, paymentId: string, actorId?: string): Promise<void> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!paymentId || typeof paymentId !== 'string') {
      throw new ValidationError('paymentId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const locked = await this.paymentRepo.findByIdForUpdate(companyId, paymentId, tx);
      if (!locked) {
        throw new NotFoundError('سند سداد المورد غير موجود');
      }
      if (locked.status === 'posted') {
        throw new ValidationError('لا يمكن حذف سند سداد مرحل');
      }

      await this.paymentRepo.cancelDraft(companyId, paymentId, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'SUPPLIER_PAYMENT_DELETE',
          entityType: 'purch_supplier_payments',
          entityId: paymentId,
          metadata: {},
        },
        { executor: tx }
      );
    });
  }
}

export const defaultSupplierPaymentService = new SupplierPaymentService();
