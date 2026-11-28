import { SalesCollectionRepository, defaultSalesCollectionRepository } from './salesCollectionRepository.js';
import { assertMaxDocumentLines } from '../http/documentLimits.js';
import { toMoney } from '../lib/numeric.js';
import { POSTED_COLLECTION_ALLOCATIONS_SQL } from './collectionAllocationSql.js';
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
import {
  assertOptionalCalendarDate,
  isValidCalendarDate,
  resolveCompanyToday,
} from '../lib/calendarDate.js';

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
    if (!input.registerId) throw new ValidationError('صندوق النقدية مطلوب');
    assertMaxDocumentLines(input.lines);
    const rawLines: Array<{ invoiceId: string; amount: number }> =
      Array.isArray(input.lines) && input.lines.length > 0
        ? input.lines.map((l) => ({ invoiceId: l?.invoiceId, amount: l?.amount as number }))
        : [{ invoiceId: input.invoiceId as string, amount: input.amount as number }];
    const seen = new Set<string>();
    rawLines.forEach((l, i) => {
      if (!l.invoiceId) throw new ValidationError(`الفاتورة مطلوبة في السطر ${i + 1}`);
      if (typeof l.amount !== 'number' || !Number.isFinite(l.amount) || l.amount <= 0) {
        throw new ValidationError(`مبلغ التحصيل في السطر ${i + 1} يجب أن يكون أكبر من الصفر`);
      }
      l.amount = toMoney(l.amount);
      if (seen.has(l.invoiceId)) throw new ValidationError(`الفاتورة مكررة في السطر ${i + 1}؛ استخدم سطراً واحداً لكل فاتورة`);
      seen.add(l.invoiceId);
    });
    const validatedCollectionDate = assertOptionalCalendarDate(input.collectionDate, 'تاريخ التحصيل');

    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const customer = await this.customerRepo.findById(companyId, input.customerId, tx);
      if (!customer || !customer.isActive) {
        throw new ValidationError('العميل غير موجود أو غير نشط');
      }

      const register = await this.registerRepo.findById(companyId, input.registerId, tx);
      if (!register || !register.isActive) {
        throw new ValidationError('صندوق النقدية غير موجود أو غير نشط');
      }

      const bal = await this.loadInvoiceBalances(companyId, rawLines.map((l) => l.invoiceId), tx);
      for (let i = 0; i < rawLines.length; i++) {
        const l = rawLines[i];
        const invoice = bal.get(l.invoiceId);
        if (!invoice || invoice.status !== 'posted') {
          throw new ValidationError(`فاتورة المبيعات في السطر ${i + 1} غير موجودة أو غير مرحلة`);
        }
        if (invoice.customerId !== input.customerId) {
          throw new ValidationError(`العميل في سند التحصيل لا يطابق عميل فاتورة السطر ${i + 1}`);
        }
        if (l.amount > invoice.open + 0.0001) {
          throw new ValidationError(
            `مبلغ التحصيل (${l.amount.toFixed(2)}) في السطر ${i + 1} يتجاوز الرصيد المتبقي المفتوح للفاتورة (${invoice.open.toFixed(2)})`
          );
        }
      }

      const effectiveCollectionDate = validatedCollectionDate ?? (await resolveCompanyToday(companyId, tx));
      const created = await this.collectionRepo.createDraft(
        companyId,
        {
          ...input,
          lines: rawLines,
          collectionDate: effectiveCollectionDate,
        },
        actorUserId,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorUserId || null,
          companyId,
          action: 'SALES_COLLECTION_CREATE',
          entityType: 'sales_collections',
          entityId: created.id,
          metadata: { amount: created.amount, linesCount: rawLines.length, registerId: input.registerId },
        },
        { executor: tx }
      );

      return created;
    });
  }

  /** One query for all invoices of a collection: status, customer, total and open balance. */
  private async loadInvoiceBalances(
    companyId: string,
    invoiceIds: string[],
    tx: DbExecutor,
    opts: { lock?: boolean; excludeCollectionId?: string } = {}
  ): Promise<Map<string, { status: string; customerId: string; totalAmount: number; open: number }>> {
    const sorted = [...invoiceIds].sort();
    const res = await tx.query<any>(
      `SELECT i.id, i.status, i.customer_id, i.total_amount::float AS total,
         COALESCE((SELECT SUM(a.amount) FROM ${POSTED_COLLECTION_ALLOCATIONS_SQL} a WHERE a.invoice_id = i.id AND a.collection_id <> $3), 0)::float AS paid,
         COALESCE((SELECT SUM(r.total_amount) FROM sales_returns r WHERE r.company_id = $1 AND r.invoice_id = i.id AND r.status = 'posted'), 0)::float AS returned
       FROM sales_invoices i
       WHERE i.company_id = $1 AND i.id = ANY($2::uuid[])
       ${opts.lock ? 'ORDER BY i.id FOR UPDATE OF i' : ''}`,
      [companyId, sorted, opts.excludeCollectionId || '00000000-0000-0000-0000-000000000000']
    );
    const m = new Map<string, { status: string; customerId: string; totalAmount: number; open: number }>();
    for (const r of res.rows) {
      m.set(r.id, { status: r.status, customerId: r.customer_id, totalAmount: r.total, open: Math.max(0, r.total - r.paid - r.returned) });
    }
    return m;
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

      const colLines = collection.lines && collection.lines.length > 0
        ? collection.lines
        : [{ lineNo: 1, invoiceId: collection.invoiceId, invoiceNo: collection.invoiceNo, amount: collection.amount }];
      // Lock all invoices in one statement in id order (stable order avoids deadlocks) and check balances.
      const balPost = await this.loadInvoiceBalances(companyId, colLines.map((l) => l.invoiceId), tx, { lock: true, excludeCollectionId: id });
      for (const l of colLines) {
        const inv = balPost.get(l.invoiceId);
        if (!inv || inv.status !== 'posted') {
          throw new ValidationError(`الفاتورة ${l.invoiceNo || ''} المرتبطة غير موجودة أو غير مرحلة`);
        }
        if (l.amount > inv.open + 0.0001) {
          throw new ValidationError(
            `مبلغ التحصيل (${l.amount.toFixed(2)}) يتجاوز الرصيد المتبقي المفتوح للفاتورة ${l.invoiceNo || ''} (${inv.open.toFixed(2)})`
          );
        }
      }

      const arAccountId = await this.resolveArAccount(companyId, tx);
      const collectionNo = await this.journalRepo.allocateSequenceNumber(companyId, 'customer_collection', 'COL', tx);
      const entryDate = isValidCalendarDate(collection.collectionDate)
        ? collection.collectionDate
        : await resolveCompanyToday(companyId, tx);

      // Balanced journal entry: Dr Cash Register, Cr Accounts Receivable
      const lines: any[] = [
        {
          accountId: register.glAccountId,
          debit: collection.amount,
          credit: 0,
          lineMemo: `تحصيل نقدي في صندوق ${register.nameAr} سند رقم ${collectionNo}`,
        },
      ];
      for (const l of colLines) {
        lines.push({
          accountId: arAccountId,
          debit: 0,
          credit: l.amount,
          lineMemo: `سداد عميل ${collection.customerNameAr || ''} فاتورة ${l.invoiceNo || ''} سند ${collectionNo}`,
        });
      }

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
          metadata: { collectionNo, amount: collection.amount, linesCount: colLines.length, registerId: collection.registerId, journalEntryId: postedJe.id },
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
