import { SalesCollectionRepository, defaultSalesCollectionRepository } from './salesCollectionRepository.js';
import { CustomerRepository, defaultCustomerRepository } from './customerRepository.js';
import { SalesInvoiceRepository, defaultSalesInvoiceRepository } from './salesInvoiceRepository.js';
import { CashRegisterRepository, defaultCashRegisterRepository } from '../cash/cashRegisterRepository.js';
import { JournalRepository, defaultJournalRepository } from '../accounting/journalRepository.js';
import { JournalService, defaultJournalService } from '../accounting/journalService.js';
import { AuditService, defaultAuditService } from '../audit/auditService.js';
import { SalesCollection, CreateSalesCollectionInput } from './salesTypes.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class SalesCollectionService {
  constructor(
    private collectionRepo: SalesCollectionRepository = defaultSalesCollectionRepository,
    private customerRepo: CustomerRepository = defaultCustomerRepository,
    private invoiceRepo: SalesInvoiceRepository = defaultSalesInvoiceRepository,
    private registerRepo: CashRegisterRepository = defaultCashRegisterRepository,
    private journalRepo: JournalRepository = defaultJournalRepository,
    private journalService: JournalService = defaultJournalService,
    private auditService: AuditService = defaultAuditService
  ) {}

  async listCollections(companyId: string): Promise<SalesCollection[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.collectionRepo.list(companyId);
  }

  async getCollection(companyId: string, id: string): Promise<SalesCollection> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');
    const collection = await this.collectionRepo.findById(companyId, id);
    if (!collection) throw new NotFoundError('سند التحصيل غير موجود');
    return collection;
  }

  async createCollection(companyId: string, input: CreateSalesCollectionInput, actorUserId?: string): Promise<SalesCollection> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!input.customerId) throw new ValidationError('العميل مطلوب');
    if (!input.invoiceId) throw new ValidationError('الفاتورة مطلوبة');
    if (!input.registerId) throw new ValidationError('صندوق النقدية مطلوب');
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0) {
      throw new ValidationError('مبلغ التحصيل يجب أن يكون أكبر من الصفر');
    }

    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const customer = await this.customerRepo.findById(companyId, input.customerId, tx);
      if (!customer || !customer.isActive) {
        throw new ValidationError('العميل غير موجود أو غير نشط');
      }

      const register = await this.registerRepo.findById(companyId, input.registerId, tx);
      if (!register || !register.isActive) {
        throw new ValidationError('صندوق النقدية غير موجود أو غير نشط');
      }

      const invoice = await this.invoiceRepo.findById(companyId, input.invoiceId, tx);
      if (!invoice || invoice.status !== 'posted') {
        throw new ValidationError('فاتورة المبيعات المراد تحصيلها غير موجودة أو غير مرحلة');
      }
      if (invoice.customerId !== input.customerId) {
        throw new ValidationError('العميل في سند التحصيل لا يطابق عميل الفاتورة');
      }

      // Check remaining open amount
      const balRes = await tx.query<any>(
        `SELECT COALESCE(SUM(amount), 0) as paid
         FROM sales_collections
         WHERE company_id = $1 AND invoice_id = $2 AND status = 'posted'`,
        [companyId, input.invoiceId]
      );
      const alreadyPaid = parseFloat(balRes.rows[0]?.paid || '0');
      const openAmount = Math.max(0, invoice.totalAmount - alreadyPaid);

      if (input.amount > openAmount + 0.0001) {
        throw new ValidationError(
          `مبلغ التحصيل (${input.amount.toFixed(2)}) يتجاوز الرصيد المتبقي المفتوح للفاتورة (${openAmount.toFixed(2)})`
        );
      }

      const created = await this.collectionRepo.createDraft(companyId, input, actorUserId, tx);

      await this.auditService.record(
        {
          actorUserId: actorUserId || null,
          companyId,
          action: 'SALES_COLLECTION_CREATE',
          entityType: 'sales_collections',
          entityId: created.id,
          metadata: { amount: input.amount, invoiceId: input.invoiceId, registerId: input.registerId },
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

    const sql = `
      SELECT id FROM accounts
      WHERE company_id = $1 AND is_active = true AND is_postable = true
        AND (code = '1200' OR (account_type = 'asset' AND (name_ar LIKE '%عملاء%' OR name_ar LIKE '%مدين%')))
      ORDER BY code ASC
      LIMIT 1
    `;
    const res = await executor.query<any>(sql, [companyId]);
    if (res.rows.length > 0) return res.rows[0].id;

    const anyAsset = await executor.query<any>(
      `SELECT id FROM accounts WHERE company_id = $1 AND is_active = true AND is_postable = true AND account_type = 'asset' ORDER BY code ASC LIMIT 1`,
      [companyId]
    );
    if (anyAsset.rows.length > 0) return anyAsset.rows[0].id;

    throw new ValidationError('يرجى ضبط حساب العملاء / الذمم المدينة (AR) في إعدادات الشركة قبل ترحيل التحصيلات');
  }

  async postCollection(companyId: string, id: string, actorUserId?: string): Promise<SalesCollection> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');

    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const locked = await this.collectionRepo.findByIdForUpdate(companyId, id, tx);
      if (!locked) {
        throw new NotFoundError('سند التحصيل غير موجود');
      }
      if (locked.status === 'posted') {
        throw new ValidationError('سند التحصيل مرحل مسبقاً');
      }
      if (locked.status === 'cancelled') {
        throw new ValidationError('لا يمكن ترحيل سند ملغى');
      }

      const collection = await this.collectionRepo.findById(companyId, id, tx);
      if (!collection) {
        throw new NotFoundError('سند التحصيل غير موجود');
      }

      const register = await this.registerRepo.findById(companyId, collection.registerId, tx);
      if (!register || !register.isActive) {
        throw new ValidationError('صندوق النقدية غير موجود أو غير نشط');
      }
      if (!register.glAccountId) {
        throw new ValidationError('صندوق النقدية غير مرتبط بحساب محاسبي (glAccountId)');
      }

      const invoiceLocked = await this.invoiceRepo.findByIdForUpdate(companyId, collection.invoiceId, tx);
      if (!invoiceLocked || invoiceLocked.status !== 'posted') {
        throw new ValidationError('الفاتورة المرتبطة غير موجودة أو غير مرحلة');
      }

      // Check open balance under lock
      const balRes = await tx.query<any>(
        `SELECT COALESCE(SUM(amount), 0) as paid
         FROM sales_collections
         WHERE company_id = $1 AND invoice_id = $2 AND status = 'posted' AND id <> $3`,
        [companyId, collection.invoiceId, id]
      );
      const alreadyPaid = parseFloat(balRes.rows[0]?.paid || '0');
      const openAmount = Math.max(0, invoiceLocked.totalAmount - alreadyPaid);

      if (collection.amount > openAmount + 0.0001) {
        throw new ValidationError(
          `مبلغ التحصيل (${collection.amount.toFixed(2)}) يتجاوز الرصيد المتبقي المفتوح للفاتورة (${openAmount.toFixed(2)})`
        );
      }

      const arAccountId = await this.resolveArAccount(companyId, tx);
      const collectionNo = await this.journalRepo.allocateSequenceNumber(companyId, 'customer_collection', 'COL', tx);
      const entryDate = ISO_DATE.test(collection.collectionDate) ? collection.collectionDate : new Date().toISOString().slice(0, 10);

      // Balanced journal entry: Dr Cash Register, Cr Accounts Receivable
      const lines: any[] = [
        {
          accountId: register.glAccountId,
          debit: collection.amount,
          credit: 0,
          lineMemo: `تحصيل نقدي في صندوق ${register.nameAr} سند رقم ${collectionNo}`,
        },
        {
          accountId: arAccountId,
          debit: 0,
          credit: collection.amount,
          lineMemo: `سداد عميل ${collection.customerNameAr || ''} فاتورة ${collection.invoiceNo || ''} سند ${collectionNo}`,
        },
      ];

      const draftJe = await this.journalService.createDraftEntry(
        companyId,
        {
          entryDate,
          memo: `ترحيل سند تحصيل نقدي رقم ${collectionNo} من العميل ${collection.customerNameAr || collection.customerId}`,
          lines,
        },
        actorUserId || '',
        false,
        tx
      );

      const postedJe = await this.journalService.postEntry(companyId, draftJe.id, actorUserId || '', false, tx);

      await this.collectionRepo.markPosted(companyId, id, collectionNo, postedJe.id, actorUserId, tx);

      await this.auditService.record(
        {
          actorUserId: actorUserId || null,
          companyId,
          action: 'SALES_COLLECTION_POST',
          entityType: 'sales_collections',
          entityId: id,
          metadata: { collectionNo, amount: collection.amount, registerId: collection.registerId, journalEntryId: postedJe.id },
        },
        { executor: tx }
      );

      const posted = await this.collectionRepo.findById(companyId, id, tx);
      return posted!;
    });
  }

  async deleteCollection(companyId: string, id: string, actorUserId?: string): Promise<boolean> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');

    const success = await this.collectionRepo.delete(companyId, id);
    if (!success) throw new NotFoundError('سند التحصيل غير موجود أو تم ترحيله مسبقاً ولا يمكن حذفه');

    await this.auditService.record({
      actorUserId: actorUserId || null,
      companyId,
      action: 'SALES_COLLECTION_DELETE',
      entityType: 'sales_collections',
      entityId: id,
    });

    return true;
  }
}

export const defaultSalesCollectionService = new SalesCollectionService();
