import {
  SalesInvoiceRepository,
  defaultSalesInvoiceRepository,
  multiplyToMinorUnits,
} from './salesInvoiceRepository.js';
import { CustomerRepository, defaultCustomerRepository } from './customerRepository.js';
import { computeSalesInvoiceTotals } from './salesInvoiceRepository.js';
import { JournalRepository, defaultJournalRepository } from '../accounting/journalRepository.js';
import { JournalService, defaultJournalService } from '../accounting/journalService.js';
import { AuditService, defaultAuditService } from '../audit/auditService.js';
import { SalesInvoice, CreateSalesInvoiceInput } from './salesTypes.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import {
  MONEY_SCALE,
  COST_SCALE,
  QTY_SCALE,
  fromMinorUnits,
  toMinorUnits,
  toMoney,
  parseExactUnits,
  rescaleUnits,
  divExactUnits,
  allocateProportionalUnits,
} from '../lib/numeric.js';
import {
  assertOptionalCalendarDate,
  isValidCalendarDate,
  resolveCompanyToday,
} from '../lib/calendarDate.js';
import { assertMaxDocumentLines } from '../http/documentLimits.js';

interface AccountRow {
  id: string;
  code: string;
  nameAr: string;
  accountType: string;
  isActive: boolean;
  isPostable: boolean;
}

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
    assertMaxDocumentLines(input.lines);
    if (!input.lines || input.lines.length === 0) {
      throw new ValidationError('يجب إضافة بند واحد على الأقل في فاتورة المبيعات');
    }
    const validatedInvoiceDate = assertOptionalCalendarDate(input.invoiceDate, 'تاريخ الفاتورة');
    const validatedDueDate = assertOptionalCalendarDate(input.dueDate, 'تاريخ الاستحقاق');

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

      // Invoice-level money fields are not accepted as input: tax and totals come only from the lines.
      // If a client sends them anyway they must agree with the lines, otherwise reject (never ignore silently).
      {
        const supplied = input as unknown as Record<string, unknown>;
        const keys = ['subtotal', 'taxAmount', 'totalAmount'] as const;
        const present = keys.filter((k) => supplied[k] !== undefined && supplied[k] !== null && String(supplied[k]).trim() !== '');
        if (present.length > 0) {
          let computed: ReturnType<typeof computeSalesInvoiceTotals> | null = null;
          try {
            computed = computeSalesInvoiceTotals(input.lines);
          } catch {
            computed = null; // invalid lines are reported by the line checks below
          }
          if (computed) {
            for (const k of present) {
              const got = toMinorUnits(supplied[k] as any, MONEY_SCALE);
              const want = toMinorUnits(computed[k], MONEY_SCALE);
              if (got !== want) {
                throw new ValidationError(
                  `قيمة ${k === 'taxAmount' ? 'الضريبة' : k === 'subtotal' ? 'الإجمالي قبل الضريبة' : 'الإجمالي'} على مستوى الفاتورة لا تطابق البنود (المرسل ${String(supplied[k])} والمحسوب ${computed[k]}). تُحسب الضريبة والإجماليات من بنود الفاتورة فقط.`
                );
              }
            }
          }
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
        if (line.taxRate !== undefined && line.taxRate !== null) {
          if (typeof line.taxRate !== 'number' || !Number.isFinite(line.taxRate) || line.taxRate < 0 || line.taxRate > 100) {
            throw new ValidationError('نسبة الضريبة يجب أن تكون بين 0 و 100');
          }
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
          const deliveredUnits = toMinorUnits(dlRes.rows[0].qty ?? '0', 4);
          const alreadyInvoicedUnits = toMinorUnits(invSumRes.rows[0]?.invoiced_qty ?? '0', 4);
          const lineQtyUnits = toMinorUnits(line.qty, 4);
          const remainingUnits = deliveredUnits > alreadyInvoicedUnits ? deliveredUnits - alreadyInvoicedUnits : 0n;
          if (lineQtyUnits > remainingUnits) {
            throw new ValidationError(
              `كمية الفاتورة (${line.qty}) تتجاوز الكمية المتبقية غير المفوترة من إذن التسليم (${fromMinorUnits(remainingUnits, 4)})`
            );
          }
        }
      }

      const effectiveInvoiceDate = validatedInvoiceDate ?? (await resolveCompanyToday(companyId, tx));
      const lineItemIds = Array.from(new Set(input.lines.map((l) => l.itemId).filter(Boolean)));
      if (lineItemIds.length > 0) {
        const itemRes = await tx.query<any>(
          `SELECT id, code, is_active FROM inv_items WHERE company_id = $1 AND id = ANY($2::uuid[])`,
          [companyId, lineItemIds]
        );
        const inactive = (itemRes?.rows || []).filter((r: any) => r && r.is_active === false);
        if (inactive.length > 0) {
          throw new ValidationError(
            `الصنف ${inactive[0].code || ''} معطّل ولا يمكن إضافته إلى فاتورة جديدة. أعد تفعيله من بيانات الأصناف أو احذفه من البنود.`
          );
        }
      }

      const created = await this.invoiceRepo.createDraft(
        companyId,
        {
          ...input,
          invoiceDate: effectiveInvoiceDate,
          dueDate: validatedDueDate ?? undefined,
        },
        actorUserId,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorUserId || null,
          companyId,
          action: 'SALES_INVOICE_CREATE',
          entityType: 'sales_invoices',
          entityId: created.id,
          metadata: {
            customerId: input.customerId,
            subtotal: created.subtotal,
            taxAmount: created.taxAmount,
            totalAmount: created.totalAmount,
            linesCount: input.lines.length,
          },
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

  /**
   * Fail-closed output VAT account resolver from company_settings (NO fallback to arbitrary accounts).
   */
  private async resolveVatPayableAccount(companyId: string, executor: DbExecutor): Promise<string> {
    const settingsRes = await executor.query<{ vatAccountId?: string | null }>(
      `SELECT vat_payable_account_id as "vatAccountId" FROM company_settings WHERE company_id = $1`,
      [companyId]
    );
    const vatAccountId = settingsRes.rows[0]?.vatAccountId?.trim() || '';
    if (!vatAccountId) {
      throw new ValidationError(
        'لا يمكن ترحيل فاتورة خاضعة للضريبة قبل ضبط "حساب ضريبة القيمة المضافة المستحقة" (vat_payable_account_id) في إعدادات الشركة.'
      );
    }

    const accRes = await executor.query<AccountRow>(
      `SELECT id, code, name_ar as "nameAr", account_type as "accountType", is_active as "isActive", is_postable as "isPostable"
       FROM accounts
       WHERE company_id = $1 AND id = $2`,
      [companyId, vatAccountId]
    );
    const acc = accRes.rows[0];
    if (!acc) {
      throw new ValidationError('حساب ضريبة القيمة المضافة المحدد في إعدادات الشركة غير موجود في دليل الحسابات');
    }
    if (!acc.isActive) {
      throw new ValidationError(`حساب الضريبة ${acc.code} (${acc.nameAr}) غير نشط`);
    }
    if (!acc.isPostable) {
      throw new ValidationError(`حساب الضريبة ${acc.code} (${acc.nameAr}) حساب رئيسي غير قابل للترحيل`);
    }
    if (acc.accountType !== 'liability') {
      throw new ValidationError(
        `حساب ضريبة المبيعات (${acc.code}) نوعه ${acc.accountType} ويجب أن يكون من نوع التزامات (liability)`
      );
    }

    return vatAccountId;
  }

  /**
   * Fail-closed COGS & Inventory accounts resolver from company_settings (NO fallback to arbitrary accounts).
   */
  private async resolveCogsAndInventoryAccounts(
    companyId: string,
    executor: DbExecutor
  ): Promise<{ cogsAccountId: string; inventoryAccountId: string }> {
    const settingsRes = await executor.query<{
      cogsAccountId?: string | null;
      inventoryAccountId?: string | null;
    }>(
      `SELECT cogs_account_id as "cogsAccountId", inventory_account_id as "inventoryAccountId"
       FROM company_settings
       WHERE company_id = $1`,
      [companyId]
    );

    const cogsAccountId = settingsRes.rows[0]?.cogsAccountId?.trim() || '';
    const inventoryAccountId = settingsRes.rows[0]?.inventoryAccountId?.trim() || '';

    if (!cogsAccountId || !inventoryAccountId) {
      throw new ValidationError(
        'لا يمكن ترحيل فاتورة مبيعات ذات تكلفة بضاعة مباعة قبل ضبط "حساب تكلفة البضاعة المباعة (COGS)" و"حساب المخزون" في إعدادات الشركة.'
      );
    }

    if (cogsAccountId === inventoryAccountId) {
      throw new ValidationError('لا يمكن تعيين نفس الحساب لكل من تكلفة البضاعة المباعة والمخزون');
    }

    const accRes = await executor.query<AccountRow>(
      `SELECT id, code, name_ar as "nameAr", account_type as "accountType", is_active as "isActive", is_postable as "isPostable"
       FROM accounts
       WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [companyId, [cogsAccountId, inventoryAccountId]]
    );

    const byId = new Map<string, AccountRow>(accRes.rows.map((r) => [r.id, r]));
    const cogsAcc = byId.get(cogsAccountId);
    const invAcc = byId.get(inventoryAccountId);

    if (!cogsAcc) {
      throw new ValidationError('حساب تكلفة البضاعة المباعة المحدد في إعدادات الشركة غير موجود في دليل الحسابات');
    }
    if (!cogsAcc.isActive || !cogsAcc.isPostable) {
      throw new ValidationError(`حساب تكلفة البضاعة المباعة ${cogsAcc.code} (${cogsAcc.nameAr}) غير نشط أو غير قابل للترحيل`);
    }
    if (cogsAcc.accountType !== 'expense') {
      throw new ValidationError(
        `حساب تكلفة البضاعة المباعة (${cogsAcc.code}) نوعه ${cogsAcc.accountType} ويجب أن يكون مصروف (expense)`
      );
    }

    if (!invAcc) {
      throw new ValidationError('حساب المخزون المحدد في إعدادات الشركة غير موجود في دليل الحسابات');
    }
    if (!invAcc.isActive || !invAcc.isPostable) {
      throw new ValidationError(`حساب المخزون ${invAcc.code} (${invAcc.nameAr}) غير نشط أو غير قابل للترحيل`);
    }
    if (invAcc.accountType !== 'asset') {
      throw new ValidationError(
        `حساب المخزون (${invAcc.code}) نوعه ${invAcc.accountType} ويجب أن يكون أصل (asset)`
      );
    }

    return { cogsAccountId, inventoryAccountId };
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

      if (invoice.cogsPostedAt) {
        throw new ValidationError('تم ترحيل تكلفة البضاعة المباعة (COGS) لهذه الفاتورة مسبقاً ولا يمكن تكرارها');
      }

      // A draft created before an item was disabled must not be posted with that item.
      const postItemIds = Array.from(new Set(invoice.lines.map((l: any) => l.itemId).filter(Boolean)));
      if (postItemIds.length > 0) {
        const itemRes = await tx.query<any>(
          `SELECT id, code, is_active FROM inv_items WHERE company_id = $1 AND id = ANY($2::uuid[])`,
          [companyId, postItemIds]
        );
        const inactive = (itemRes?.rows || []).filter((r: any) => r && r.is_active === false);
        if (inactive.length > 0) {
          throw new ValidationError(
            `لا يمكن ترحيل الفاتورة: الصنف ${inactive[0].code || ''} معطّل. أعد تفعيله من بيانات الأصناف أو احذف البند من المسودة.`
          );
        }
      }

      // Customer credit limit (0 / unset = no limit). Exposure = open posted receivables + this invoice.
      const customerForLimit = await this.customerRepo.findById(companyId, invoice.customerId, tx);
      const creditLimit = Number(customerForLimit?.creditLimit ?? 0);
      if (creditLimit > 0) {
        const openRes = await tx.query<any>(
          `SELECT COALESCE(SUM(
              GREATEST(0, i.total_amount - COALESCE(col.total, 0) - COALESCE(ret.total, 0))
            ), 0)::text AS open_total
           FROM sales_invoices i
           LEFT JOIN (
             SELECT invoice_id, SUM(amount) AS total FROM sales_collections
             WHERE company_id = $1 AND status = 'posted' GROUP BY invoice_id
           ) col ON col.invoice_id = i.id
           LEFT JOIN (
             SELECT invoice_id, SUM(total_amount) AS total FROM sales_returns
             WHERE company_id = $1 AND status = 'posted' GROUP BY invoice_id
           ) ret ON ret.invoice_id = i.id
           WHERE i.company_id = $1 AND i.customer_id = $2 AND i.status = 'posted' AND i.id <> $3`,
          [companyId, invoice.customerId, invoice.id]
        );
        const openTotal = Number(openRes.rows[0]?.open_total ?? 0);
        const exposure = Math.round((openTotal + Number(invoice.totalAmount)) * 100) / 100;
        if (exposure > creditLimit) {
          throw new ValidationError(
            `تجاوز حد الائتمان للعميل: الحد المسموح ${creditLimit.toFixed(2)}، الرصيد المفتوح ${openTotal.toFixed(2)}، قيمة الفاتورة ${Number(invoice.totalAmount).toFixed(2)}، الإجمالي ${exposure.toFixed(2)}. لا يمكن ترحيل الفاتورة قبل تحصيل مبلغ أو رفع حد الائتمان من بيانات العميل.`
          );
        }
      }

      // Re-verify linked delivery line remaining quantity under FOR UPDATE & compute frozen COGS (exact cumulative target formula)
      let totalCogsUnits = 0n;
      const lineCogsAllocations: Array<{
        invoiceLineId: string;
        deliveryLineId: string;
        valuationMovementId: string | null;
        qty: number;
        cogsCostStr: string;
      }> = [];

      for (const line of invoice.lines) {
        if (line.deliveryLineId) {
          const dlRes = await tx.query<any>(
            `SELECT
               dl.id,
               dl.qty,
               dl.unit_cost,
               dl.frozen_total_cost,
               dl.valuation_movement_id,
               dl.item_id as dl_item_id,
               dn.customer_id as dn_customer_id,
               dn.status as dn_status
             FROM sales_delivery_lines dl
             INNER JOIN sales_delivery_notes dn ON dn.id = dl.delivery_id AND dn.company_id = dl.company_id
             WHERE dl.company_id = $1 AND dl.id = $2 AND dn.status = 'posted'
             FOR UPDATE OF dl`,
            [companyId, line.deliveryLineId]
          );
          if (dlRes.rows.length === 0) {
            throw new ValidationError('بند إذن التسليم المرتبط غير موجود أو غير مرحل');
          }
          const dlRow = dlRes.rows[0];
          if (dlRow.dn_customer_id && dlRow.dn_customer_id !== invoice.customerId) {
            throw new ValidationError('عميل فاتورة المبيعات لا يطابق عميل إذن التسليم المرتبط');
          }
          if (dlRow.dl_item_id && dlRow.dl_item_id !== line.itemId) {
            throw new ValidationError('الصنف في بند فاتورة المبيعات لا يطابق الصنف في بند إذن التسليم المرتبط');
          }
          if (!dlRow.valuation_movement_id) {
            throw new ValidationError(
              'بند إذن التسليم المرتبط يفتقر إلى حركة تقييم معتمدة وتكلفة مجمدة (valuation_movement_id). لا يمكن إثبات تكلفة البضاعة المباعة.'
            );
          }

          const existingLinkRes = await tx.query<any>(
            `SELECT id FROM inv_sales_cogs_links WHERE company_id = $1 AND invoice_line_id = $2`,
            [companyId, line.id]
          );
          if (existingLinkRes.rows.length > 0) {
            throw new ValidationError('تم إثبات تكلفة البضاعة المباعة لهذا البند مسبقاً (منع تكرار COGS)');
          }

          // Lock existing links for this delivery line FOR UPDATE
          await tx.query(
            `SELECT id FROM inv_sales_cogs_links WHERE company_id = $1 AND delivery_line_id = $2 FOR UPDATE`,
            [companyId, line.deliveryLineId]
          );

          const invSumRes = await tx.query<any>(
            `SELECT COALESCE(SUM(invoiced_qty), 0) as invoiced_qty
             FROM inv_sales_cogs_links
             WHERE company_id = $1 AND delivery_line_id = $2 AND invoice_id <> $3
               AND NOT EXISTS (
                 SELECT 1 FROM inv_sales_cogs_reversals r
                 WHERE r.company_id = inv_sales_cogs_links.company_id
                   AND r.original_cogs_link_id = inv_sales_cogs_links.id
               )`,
            [companyId, line.deliveryLineId, id]
          );
          const deliveredUnits = toMinorUnits(dlRow.qty ?? '0', QTY_SCALE);
          const alreadyLinkedQtyUnits = toMinorUnits(invSumRes.rows[0]?.invoiced_qty ?? '0', QTY_SCALE);
          const lineQtyUnits = toMinorUnits(line.qty, QTY_SCALE);
          const remainingUnits = deliveredUnits > alreadyLinkedQtyUnits ? deliveredUnits - alreadyLinkedQtyUnits : 0n;
          if (lineQtyUnits > remainingUnits) {
            throw new ValidationError(
              `كمية الفاتورة (${line.qty}) تتجاوز الكمية المتبقية غير المفوترة من إذن التسليم (${fromMinorUnits(remainingUnits, QTY_SCALE)})`
            );
          }

          let lineCogsMoneyUnits = 0n;
          const totalFrozenCostUnits = parseExactUnits(dlRow.frozen_total_cost ?? '0', COST_SCALE, 'frozenTotalCost');
          const cumulativeQtyUnits = alreadyLinkedQtyUnits + lineQtyUnits;

          const cogsLinkedRes = await tx.query<any>(
            `SELECT COALESCE(SUM(cogs_amount), 0) as linked_cost
             FROM inv_sales_cogs_links
             WHERE company_id = $1 AND delivery_line_id = $2 AND invoice_id <> $3
               AND NOT EXISTS (
                 SELECT 1 FROM inv_sales_cogs_reversals r
                 WHERE r.company_id = inv_sales_cogs_links.company_id
                   AND r.original_cogs_link_id = inv_sales_cogs_links.id
               )`,
            [companyId, line.deliveryLineId, id]
          );
          const alreadyLinkedMoneyUnits = toMinorUnits(cogsLinkedRes.rows[0]?.linked_cost ?? '0', MONEY_SCALE);

          let targetMoneyUnits: bigint;
          if (cumulativeQtyUnits >= deliveredUnits || deliveredUnits === 0n) {
            targetMoneyUnits = rescaleUnits(totalFrozenCostUnits, COST_SCALE, MONEY_SCALE);
          } else {
            const product = totalFrozenCostUnits * cumulativeQtyUnits;
            const targetCostUnits = divExactUnits(product, COST_SCALE + QTY_SCALE, deliveredUnits, QTY_SCALE, COST_SCALE);
            targetMoneyUnits = rescaleUnits(targetCostUnits, COST_SCALE, MONEY_SCALE);
          }

          lineCogsMoneyUnits = targetMoneyUnits > alreadyLinkedMoneyUnits ? targetMoneyUnits - alreadyLinkedMoneyUnits : 0n;

          totalCogsUnits += lineCogsMoneyUnits;
          lineCogsAllocations.push({
            invoiceLineId: line.id,
            deliveryLineId: line.deliveryLineId,
            valuationMovementId: dlRow.valuation_movement_id || null,
            qty: line.qty,
            cogsCostStr: fromMinorUnits(lineCogsMoneyUnits, MONEY_SCALE),
          });
        }
      }

      // Compute exact minor-unit net vs tax vs gross (gross = net + tax)
      const grossUnits = toMinorUnits(invoice.totalAmount ?? 0, MONEY_SCALE);
      const taxUnits = toMinorUnits(invoice.taxAmount ?? 0, MONEY_SCALE);
      if (taxUnits < 0n) {
        throw new ValidationError('قيمة الضريبة في فاتورة المبيعات لا يمكن أن تكون سالبة');
      }

      const hasExplicitSubtotal = invoice.subtotal !== undefined && invoice.subtotal !== null;
      const netUnits = hasExplicitSubtotal ? toMinorUnits(invoice.subtotal, MONEY_SCALE) : grossUnits - taxUnits;

      if (hasExplicitSubtotal && netUnits + taxUnits !== grossUnits) {
        throw new ValidationError(
          `عدم توازن مجاميع الفاتورة: الصافي (${fromMinorUnits(netUnits, 2)}) + الضريبة (${fromMinorUnits(taxUnits, 2)}) لا يساوي الإجمالي (${fromMinorUnits(grossUnits, 2)})`
        );
      }

      if (!(grossUnits > 0n) || netUnits < 0n) {
        throw new ValidationError('قيمة فاتورة المبيعات الإجمالية يجب أن تكون أكبر من الصفر لترحيلها');
      }

      const arAccountId = await this.resolveArAccount(companyId, tx);
      const revAccountId = await this.resolveRevenueAccount(companyId, tx);

      let vatAccountId: string | null = null;
      if (taxUnits > 0n) {
        vatAccountId = await this.resolveVatPayableAccount(companyId, tx);
        if (vatAccountId === revAccountId || vatAccountId === arAccountId) {
          throw new ValidationError('حساب ضريبة المبيعات يجب أن يكون حساباً مستقلاً عن حساب الإيراد وحساب العملاء');
        }
      }

      let cogsAccounts: { cogsAccountId: string; inventoryAccountId: string } | null = null;
      if (totalCogsUnits > 0n) {
        cogsAccounts = await this.resolveCogsAndInventoryAccounts(companyId, tx);
      }

      const invoiceNo = await this.journalRepo.allocateSequenceNumber(companyId, 'sales_invoice', 'SINV', tx);
      const entryDate = isValidCalendarDate(invoice.invoiceDate)
        ? invoice.invoiceDate
        : await resolveCompanyToday(companyId, tx);

      const grossAmount = toMoney(fromMinorUnits(grossUnits, MONEY_SCALE));
      const netAmount = toMoney(fromMinorUnits(netUnits, MONEY_SCALE));
      const taxAmount = toMoney(fromMinorUnits(taxUnits, MONEY_SCALE));
      const cogsAmount = toMoney(fromMinorUnits(totalCogsUnits, MONEY_SCALE));

      const lines: Array<{
        accountId: string;
        debit: number;
        credit: number;
        lineMemo: string;
      }> = [
        {
          accountId: arAccountId,
          debit: grossAmount,
          credit: 0,
          lineMemo: `إثبات مديونية عميل فاتورة مبيعات رقم ${invoiceNo} (${invoice.customerNameAr || ''})`,
        },
      ];

      if (netUnits > 0n) {
        lines.push({
          accountId: revAccountId,
          debit: 0,
          credit: netAmount,
          lineMemo: `إيراد مبيعات (صافي) فاتورة رقم ${invoiceNo}`,
        });
      }

      if (taxUnits > 0n && vatAccountId) {
        lines.push({
          accountId: vatAccountId,
          debit: 0,
          credit: taxAmount,
          lineMemo: `ضريبة القيمة المضافة المستحقة (VAT) فاتورة رقم ${invoiceNo}`,
        });
      }

      if (totalCogsUnits > 0n && cogsAccounts) {
        lines.push(
          {
            accountId: cogsAccounts.cogsAccountId,
            debit: cogsAmount,
            credit: 0,
            lineMemo: `تكلفة البضاعة المباعة (COGS) فاتورة رقم ${invoiceNo}`,
          },
          {
            accountId: cogsAccounts.inventoryAccountId,
            debit: 0,
            credit: cogsAmount,
            lineMemo: `تخفيض المخزون مقابل المبيعات فاتورة رقم ${invoiceNo}`,
          }
        );
      }

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

      for (const alloc of lineCogsAllocations) {
        await tx.query(
          `UPDATE sales_invoice_lines SET cogs_cost = $1 WHERE company_id = $2 AND id = $3`,
          [alloc.cogsCostStr, companyId, alloc.invoiceLineId]
        );
        if (alloc.valuationMovementId) {
          await tx.query(
            `INSERT INTO inv_sales_cogs_links (
               company_id, invoice_id, invoice_line_id,
               delivery_line_id, valuation_movement_id,
               invoiced_qty, cogs_amount, journal_entry_id
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              companyId,
              id,
              alloc.invoiceLineId,
              alloc.deliveryLineId,
              alloc.valuationMovementId,
              alloc.qty,
              alloc.cogsCostStr,
              postedJe.id,
            ]
          );
        }
      }

      if (totalCogsUnits > 0n) {
        await tx.query(
          `UPDATE sales_invoices SET cogs_amount = $1, cogs_posted_at = NOW() WHERE company_id = $2 AND id = $3`,
          [cogsAmount, companyId, id]
        );
      }

      await this.invoiceRepo.markPosted(companyId, id, invoiceNo, postedJe.id, actorUserId, tx);

      await this.auditService.record(
        {
          actorUserId: actorUserId || null,
          companyId,
          action: 'SALES_INVOICE_POST',
          entityType: 'sales_invoices',
          entityId: id,
          metadata: {
            invoiceNo,
            subtotal: netAmount,
            taxAmount,
            totalAmount: grossAmount,
            cogsAmount,
            journalEntryId: postedJe.id,
          },
        },
        { executor: tx }
      );

      const posted = await this.invoiceRepo.findById(companyId, id, tx);
      if (posted) {
        posted.cogsAmount = cogsAmount;
      }
      return posted!;
    });
  }

  async cancelPostedInvoice(
    companyId: string,
    id: string,
    reason: string,
    actorUserId?: string
  ): Promise<SalesInvoice> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!trimmedReason) {
      throw new ValidationError('سبب إلغاء فاتورة المبيعات مطلوب');
    }

    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const locked = await this.invoiceRepo.findByIdForUpdate(companyId, id, tx);
      if (!locked) {
        throw new NotFoundError('فاتورة المبيعات غير موجودة');
      }
      if (locked.status === 'draft') {
        throw new ValidationError('لا يمكن إلغاء فاتورة مسودة؛ استخدم الحذف بدلاً من الإلغاء');
      }
      if (locked.status === 'cancelled') {
        throw new ValidationError('فاتورة المبيعات ملغاة مسبقاً');
      }

      const colRes = await tx.query<any>(
        `SELECT id FROM sales_collections WHERE company_id = $1 AND invoice_id = $2 AND status = 'posted' LIMIT 1`,
        [companyId, id]
      );
      if (colRes.rows.length > 0) {
        throw new ValidationError('لا يمكن إلغاء فاتورة مبيعات مرتبطة بسندات تحصيل مرحلة');
      }

      const retRes = await tx.query<any>(
        `SELECT id FROM sales_returns WHERE company_id = $1 AND invoice_id = $2 AND status = 'posted' LIMIT 1`,
        [companyId, id]
      );
      if (retRes.rows.length > 0) {
        throw new ValidationError('لا يمكن إلغاء فاتورة مبيعات مرتبطة بمرتجعات مبيعات مرحلة');
      }

      const invoice = await this.invoiceRepo.findById(companyId, id, tx);
      if (!invoice || !invoice.journalEntryId) {
        throw new ValidationError('فاتورة المبيعات تفتقر إلى القيد المحاسبي المرحل ولا يمكن إلغاؤها');
      }

      const reversalJe = await this.journalService.reverseEntry(
        companyId,
        invoice.journalEntryId,
        actorUserId || '',
        `إلغاء فاتورة مبيعات رقم ${invoice.invoiceNo || invoice.id}: ${trimmedReason}`,
        false,
        tx
      );

      const linksRes = await tx.query<any>(
        `SELECT id, invoice_id, invoice_line_id, delivery_line_id, invoiced_qty, cogs_amount
         FROM inv_sales_cogs_links
         WHERE company_id = $1 AND invoice_id = $2
         FOR UPDATE`,
        [companyId, id]
      );

      for (const link of linksRes.rows) {
        const existingRev = await tx.query<any>(
          `SELECT id FROM inv_sales_cogs_reversals WHERE company_id = $1 AND original_cogs_link_id = $2`,
          [companyId, link.id]
        );
        if (existingRev.rows.length > 0) {
          throw new ValidationError('تم عكس تكلفة البضاعة المباعة لهذه الفاتورة مسبقاً');
        }
        await tx.query(
          `INSERT INTO inv_sales_cogs_reversals (
             company_id, original_cogs_link_id, invoice_id, invoice_line_id,
             delivery_line_id, reversed_qty, reversed_cogs_amount, reason,
             reversal_journal_entry_id, created_by
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            companyId,
            link.id,
            link.invoice_id,
            link.invoice_line_id,
            link.delivery_line_id,
            link.invoiced_qty,
            link.cogs_amount,
            trimmedReason,
            reversalJe.id,
            actorUserId || null,
          ]
        );
      }

      await this.invoiceRepo.markCancelled(
        companyId,
        id,
        reversalJe.id,
        trimmedReason,
        actorUserId,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorUserId || null,
          companyId,
          action: 'SALES_INVOICE_CANCEL',
          entityType: 'sales_invoices',
          entityId: id,
          metadata: {
            invoiceNo: invoice.invoiceNo,
            originalJournalEntryId: invoice.journalEntryId,
            reversalJournalEntryId: reversalJe.id,
            reason: trimmedReason,
          },
        },
        { executor: tx }
      );

      const cancelled = await this.invoiceRepo.findById(companyId, id, tx);
      return cancelled!;
    });
  }

  async reversePostedInvoiceCogs(
    companyId: string,
    invoiceId: string,
    reason: string,
    actorUserId?: string
  ): Promise<void> {
    if (!companyId || !invoiceId) throw new ValidationError('companyId and invoiceId are required');
    await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const lockedInv = await this.invoiceRepo.findByIdForUpdate(companyId, invoiceId, tx);
      if (lockedInv?.status === 'cancelled') {
        throw new ValidationError('الفاتورة ملغاة مسبقاً وتم عكس قيودها');
      }

      const linksRes = await tx.query<any>(
        `SELECT id, invoice_id, invoice_line_id, delivery_line_id, invoiced_qty, cogs_amount, journal_entry_id
         FROM inv_sales_cogs_links
         WHERE company_id = $1 AND invoice_id = $2
         FOR UPDATE`,
        [companyId, invoiceId]
      );
      if (linksRes.rows.length === 0) return;

      for (const link of linksRes.rows) {
        const existingRev = await tx.query<any>(
          `SELECT id FROM inv_sales_cogs_reversals WHERE company_id = $1 AND original_cogs_link_id = $2`,
          [companyId, link.id]
        );
        if (existingRev.rows.length > 0) continue;

        const cogsAccounts = await this.resolveCogsAndInventoryAccounts(companyId, tx);
        const amountNum = toMoney(link.cogs_amount);
        if (amountNum <= 0) continue;

        const today = await resolveCompanyToday(companyId, tx);
        const draftJe = await this.journalService.createDraftEntry(
          companyId,
          {
            entryDate: today,
            memo: `عكس تكلفة البضاعة المباعة (COGS) للفاتورة ${invoiceId} — ${reason}`,
            lines: [
              {
                accountId: cogsAccounts.inventoryAccountId,
                debit: amountNum,
                credit: 0,
                lineMemo: 'إعادة المخزون المعكوس',
              },
              {
                accountId: cogsAccounts.cogsAccountId,
                debit: 0,
                credit: amountNum,
                lineMemo: 'عكس تكلفة البضاعة المباعة',
              },
            ],
          },
          actorUserId || '',
          false,
          tx
        );
        const postedJe = await this.journalService.postEntry(companyId, draftJe.id, actorUserId || '', false, tx);

        await tx.query(
          `INSERT INTO inv_sales_cogs_reversals (
             company_id, original_cogs_link_id, invoice_id, invoice_line_id,
             delivery_line_id, reversed_qty, reversed_cogs_amount, reason,
             reversal_journal_entry_id, created_by
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            companyId,
            link.id,
            link.invoice_id,
            link.invoice_line_id,
            link.delivery_line_id,
            link.invoiced_qty,
            link.cogs_amount,
            reason,
            postedJe.id,
            actorUserId || null,
          ]
        );
      }
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
