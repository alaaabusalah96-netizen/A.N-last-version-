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
import { assertMaxDocumentLines } from '../http/documentLimits.js';
import { POSTED_PAYMENT_ALLOCATIONS_SQL } from './paymentAllocationSql.js';
import type { DbExecutor } from '../db/types.js';
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
    if (!input.registerId || typeof input.registerId !== 'string') {
      throw new ValidationError('صندوق النقدية مطلوب');
    }
    assertMaxDocumentLines(input.lines);
    const rawLines: Array<{ invoiceId: string; amount: number }> =
      Array.isArray(input.lines) && input.lines.length > 0
        ? input.lines.map((l) => ({ invoiceId: l?.invoiceId, amount: l?.amount as number }))
        : [{ invoiceId: input.invoiceId as string, amount: input.amount as number }];
    const seen = new Set<string>();
    rawLines.forEach((l, i) => {
      if (!l.invoiceId || typeof l.invoiceId !== 'string') throw new ValidationError(`الفاتورة المستهدفة مطلوبة في السطر ${i + 1}`);
      if (typeof l.amount !== 'number' || !Number.isFinite(l.amount) || l.amount <= 0) {
        throw new ValidationError(`مبلغ السداد في السطر ${i + 1} يجب أن يكون أكبر من الصفر`);
      }
      l.amount = toDecimal(l.amount, 2);
      if (seen.has(l.invoiceId)) throw new ValidationError(`الفاتورة مكررة في السطر ${i + 1}؛ استخدم سطراً واحداً لكل فاتورة`);
      seen.add(l.invoiceId);
    });
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

      const bal = await this.loadInvoiceBalances(companyId, rawLines.map((l) => l.invoiceId), tx);
      for (let i = 0; i < rawLines.length; i++) {
        const l = rawLines[i];
        const inv = bal.get(l.invoiceId);
        if (!inv || inv.status !== 'posted') {
          throw new ValidationError(`فاتورة المورد في السطر ${i + 1} غير موجودة أو غير مرحلة`);
        }
        if (inv.supplierId !== input.supplierId) {
          throw new ValidationError(`المورد المحدد لا يطابق مورد فاتورة السطر ${i + 1}`);
        }
        if (toMinorUnits(l.amount, 2) > toMinorUnits(inv.open, 2)) {
          throw new ValidationError(
            `مبلغ السداد (${l.amount.toFixed(2)}) في السطر ${i + 1} يتجاوز الرصيد المتبقي المفتوح للفاتورة (${inv.open.toFixed(2)})`
          );
        }
      }

      const effectivePaymentDate = validatedPaymentDate ?? (await resolveCompanyToday(companyId, tx));

      const created = await this.paymentRepo.createDraft(
        companyId,
        {
          supplierId: input.supplierId,
          lines: rawLines,
          registerId: input.registerId,
          paymentDate: effectivePaymentDate,
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
          metadata: { amount: created.amount, linesCount: rawLines.length, registerId: input.registerId },
        },
        { executor: tx }
      );

      return created;
    });
  }

  /** One query for all invoices of a payment: status, supplier and open balance (total - returns - posted payments). */
  private async loadInvoiceBalances(
    companyId: string,
    invoiceIds: string[],
    tx: DbExecutor,
    opts: { lock?: boolean; excludePaymentId?: string } = {}
  ): Promise<Map<string, { status: string; supplierId: string; open: number }>> {
    const sorted = [...invoiceIds].sort();
    const res = await tx.query<any>(
      `SELECT si.id, si.status, si.supplier_id,
         COALESCE((SELECT SUM(qty * unit_cost) FROM purch_supplier_invoice_lines WHERE company_id = $1 AND invoice_id = si.id), 0) AS total,
         COALESCE((SELECT SUM(prl.qty * prl.unit_cost) FROM purch_return_lines prl INNER JOIN purch_returns pr ON pr.id = prl.return_id AND pr.company_id = prl.company_id WHERE pr.company_id = $1 AND pr.status = 'posted' AND pr.invoice_id = si.id), 0) AS credited,
         COALESCE((SELECT SUM(a.amount) FROM ${POSTED_PAYMENT_ALLOCATIONS_SQL} a WHERE a.invoice_id = si.id AND a.payment_id <> $3), 0) AS paid
       FROM purch_supplier_invoices si
       WHERE si.company_id = $1 AND si.id = ANY($2::uuid[])
       ${opts.lock ? 'ORDER BY si.id FOR UPDATE OF si' : ''}`,
      [companyId, sorted, opts.excludePaymentId || '00000000-0000-0000-0000-000000000000']
    );
    const m = new Map<string, { status: string; supplierId: string; open: number }>();
    for (const r of res.rows) {
      m.set(r.id, {
        status: r.status,
        supplierId: r.supplier_id,
        open: Math.max(0, toDecimal(r.total || 0, 2) - toDecimal(r.credited || 0, 2) - toDecimal(r.paid || 0, 2)),
      });
    }
    return m;
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

      const payLines = payment.lines && payment.lines.length > 0
        ? payment.lines
        : [{ lineNo: 1, invoiceId: payment.invoiceId, supplierInvoiceNo: payment.supplierInvoiceNo, amount: payment.amount }];
      // Lock all invoices in one statement in id order (stable order avoids deadlocks) and check balances.
      const balPost = await this.loadInvoiceBalances(companyId, payLines.map((l) => l.invoiceId), tx, { lock: true, excludePaymentId: paymentId });
      for (const l of payLines) {
        const inv = balPost.get(l.invoiceId);
        if (!inv || inv.status !== 'posted') {
          throw new ValidationError(`الفاتورة ${l.supplierInvoiceNo || ''} المرتبطة غير موجودة أو غير مرحلة`);
        }
        if (toMinorUnits(l.amount, 2) > toMinorUnits(inv.open, 2)) {
          throw new ValidationError(
            `مبلغ السداد (${l.amount}) يتجاوز الرصيد المتبقي المفتوح للفاتورة ${l.supplierInvoiceNo || ''} (${inv.open})`
          );
        }
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
            ...payLines.map((l) => ({
              accountId: apAccountId,
              debit: l.amount,
              credit: 0,
              lineMemo: `سداد المورد فاتورة ${l.supplierInvoiceNo || ''} سند ${paymentNo}`,
            })),
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
            linesCount: payLines.length,
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
