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
import {
  MONEY_SCALE,
  COST_SCALE,
  QTY_SCALE,
  fromMinorUnits,
  toMinorUnits,
  parseExactUnits,
  mulExactUnits,
  rescaleUnits,
  unitsToSafeNumber,
} from '../lib/numeric.js';
import { CompanySettings } from '../org/companySettingsTypes.js';
import { DbExecutor } from '../db/types.js';
import { defaultThreeWayMatchService, ThreeWayMatchService } from './threeWayMatchService.js';
import {
  defaultInventoryValuationService,
  InventoryValuationService,
} from '../inventory/inventoryValuationService.js';
import { defaultPriceVarianceExceptionRepository } from './priceVarianceExceptionRepository.js';
import {
  assertOptionalCalendarDate,
  isValidCalendarDate,
  resolveCompanyToday,
} from '../lib/calendarDate.js';
import { assertMaxDocumentLines } from '../http/documentLimits.js';

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
    private accountRepo: AccountRepository = defaultAccountRepository,
    private threeWayMatchService: Pick<ThreeWayMatchService, 'evaluateInvoice'> = defaultThreeWayMatchService,
    private valuationService: Pick<
      InventoryValuationService,
      'applyPurchasePriceVariance' | 'linkCostAdjustmentsJournal'
    > &
      Partial<Pick<InventoryValuationService, 'prefetchPurchasePriceVarianceContext'>> = defaultInventoryValuationService
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
    assertMaxDocumentLines(input.lines);
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new ValidationError('يجب إضافة بند واحد على الأقل في فاتورة المورد');
    }
    const validatedInvoiceDate = assertOptionalCalendarDate(input.invoiceDate, 'تاريخ الفاتورة');
    const validatedDueDate = assertOptionalCalendarDate(input.dueDate, 'تاريخ الاستحقاق');

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

      const seenGrnLineIds = new Set<string>();
      for (const line of input.lines) {
        if (!line.grnLineId || typeof line.grnLineId !== 'string') {
          throw new ValidationError('كافة بنود الفاتورة تتطلب ربطاً ببند سند استلام (grnLineId)');
        }
        const normalizedGrnLineId = line.grnLineId.trim();
        if (seenGrnLineIds.has(normalizedGrnLineId)) {
          throw new ValidationError(
            'لا يمكن تكرار نفس بند سند الاستلام (grnLineId) داخل نفس الفاتورة؛ يرجى إدخال الكمية في سطر واحد'
          );
        }
        seenGrnLineIds.add(normalizedGrnLineId);

        if (typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0) {
          throw new ValidationError('كمية البند يجب أن تكون أكبر من الصفر');
        }
        if (typeof line.unitCost !== 'number' || !Number.isFinite(line.unitCost) || line.unitCost < 0) {
          throw new ValidationError('تكلفة الوحدة يجب أن تكون رقمًا صالحًا غير سالبة');
        }

        const outLine = outstandingMap.get(normalizedGrnLineId);
        if (!outLine) {
          throw new ValidationError('بند استلام البضائع المحدد غير موجود، غير مرحل، أو تم ترفيع فاتورته كاملاً');
        }

        if (toMinorUnits(line.qty, 4) > toMinorUnits(outLine.remainingQty, 4)) {
          throw new ValidationError(
            `كمية البند المطلوبة (${line.qty}) تتجاوز الكمية المتبقية غير المفوترة (${outLine.remainingQty}) للبند`
          );
        }
      }

      const effectiveInvoiceDate = validatedInvoiceDate ?? (await resolveCompanyToday(companyId, tx));

      const created = await this.invoiceRepo.createDraft(
        companyId,
        {
          supplierId: input.supplierId,
          supplierInvoiceNo: input.supplierInvoiceNo.trim(),
          invoiceDate: effectiveInvoiceDate,
          dueDate: validatedDueDate ?? undefined,
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

  private async resolvePpvInventoryAccount(companyId: string, tx: DbExecutor): Promise<string> {
    let inventoryAccountId = '';
    try {
      const grnCfg = await this.glMappingService.resolve(companyId, 'accounting.grn_mapping');
      inventoryAccountId = (grnCfg.accounts.inventory_account_id || '').trim();
    } catch {
      // fallback to company_settings
    }
    if (!inventoryAccountId) {
      const settings = await this.settingsRepo.getByCompanyId(companyId, tx);
      inventoryAccountId = (settings?.inventoryAccountId || '').trim();
    }
    if (!inventoryAccountId) {
      throw new ValidationError(
        'لا يمكن تسوية فرق سعر فاتورة المورد على المخزون قبل ضبط "حساب المخزون" في إعدادات الشركة.'
      );
    }
    const acc = await this.accountRepo.findById(companyId, inventoryAccountId, tx);
    if (!acc || !acc.isActive || !acc.isPostable || acc.accountType !== 'asset') {
      throw new ValidationError('حساب المخزون المحدد غير صالح أو غير قابل للترحيل لتسوية فرق سعر الفاتورة');
    }
    return acc.id;
  }

  private async resolvePpvCogsAccount(companyId: string, tx: DbExecutor): Promise<string> {
    const res = await tx.query<{ cogsAccountId?: string | null }>(
      `SELECT cogs_account_id as "cogsAccountId" FROM company_settings WHERE company_id = $1`,
      [companyId]
    );
    const cogsAccountId = (res.rows[0]?.cogsAccountId || '').trim();
    if (!cogsAccountId) {
      throw new ValidationError(
        'لا يمكن ترحيل فرق سعر فاتورة المورد للكميات المباعة قبل ضبط "حساب تكلفة البضاعة المباعة (COGS)" في إعدادات الشركة.'
      );
    }
    const acc = await this.accountRepo.findById(companyId, cogsAccountId, tx);
    if (!acc || !acc.isActive || !acc.isPostable || acc.accountType !== 'expense') {
      throw new ValidationError(
        'حساب تكلفة البضاعة المباعة المحدد غير صالح أو غير قابل للترحيل أو ليس من نوع مصروف (expense)'
      );
    }
    return acc.id;
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

      // Reject duplicate grnLineId within the invoice lines (defense-in-depth for pre-existing drafts)
      const invoiceGrnLineIds: string[] = [];
      const seenPostGrnLineIds = new Set<string>();
      for (const line of invoice.lines) {
        if (seenPostGrnLineIds.has(line.grnLineId)) {
          throw new ValidationError(
            'لا يمكن ترحيل فاتورة تحتوي على بند سند استلام مكرر (grnLineId) داخل نفس الفاتورة'
          );
        }
        seenPostGrnLineIds.add(line.grnLineId);
        invoiceGrnLineIds.push(line.grnLineId);
      }

      // WP-RACE: Lock target purch_grn_lines rows FOR UPDATE in deterministic order,
      // then recompute cumulative posted + current invoice quantities inside the transaction.
      const lockedGrnMap = await this.invoiceRepo.lockGrnLinesAndGetPostedTotals(
        companyId,
        invoiceGrnLineIds,
        tx
      );

      let totalInvoiceUnits = 0n;
      for (const line of invoice.lines) {
        const grnSummary = lockedGrnMap.get(line.grnLineId);
        if (!grnSummary || grnSummary.grnStatus !== 'posted' || grnSummary.grnSupplierId !== invoice.supplierId) {
          throw new ValidationError('أحد بنود الفاتورة لم يعد لديه بند استلام صالح أو مرحل لهذا المورد');
        }

        const grnUnits = toMinorUnits(grnSummary.grnQty, QTY_SCALE);
        const alreadyPostedUnits = toMinorUnits(grnSummary.postedQty, QTY_SCALE);
        const lineUnits = parseExactUnits(line.qty, QTY_SCALE, 'lineQty');
        const remainingUnits = grnUnits - alreadyPostedUnits;

        if (remainingUnits <= 0n || alreadyPostedUnits + lineUnits > grnUnits) {
          const remainingFormatted = fromMinorUnits(remainingUnits > 0n ? remainingUnits : 0n, QTY_SCALE);
          throw new ValidationError(
            `كمية البند (${line.qty}) تتجاوز الكمية المتبقية غير المفوترة (${remainingFormatted})`
          );
        }

        const lineCostUnits = mulExactUnits(
          lineUnits,
          QTY_SCALE,
          parseExactUnits(line.unitCost, COST_SCALE, 'lineUnitCost'),
          COST_SCALE,
          COST_SCALE
        );
        totalInvoiceUnits += lineCostUnits;
      }

      const totalAmount = unitsToSafeNumber(rescaleUnits(totalInvoiceUnits, COST_SCALE, MONEY_SCALE), MONEY_SCALE);
      if (!(totalAmount > 0)) {
        throw new ValidationError('لا يمكن ترحيل فاتورة بقيمة إجمالية صفر أو سالبة');
      }

      const matchReport = await this.threeWayMatchService.evaluateInvoice(
        companyId,
        invoiceId,
        tx
      );
      if (matchReport.overallStatus === 'variance_exceeded') {
        for (const lineRes of matchReport.lines) {
          const exceedsQty = lineRes.invoiceQty > lineRes.grnQty || (typeof lineRes.poQty === 'number' && lineRes.invoiceQty > lineRes.poQty);
          if (exceedsQty) {
            throw new ValidationError(
              `لا يمكن ترحيل فاتورة المورد: تجاوزت الكمية المفوترة الكمية المتاحة/المستلمة للبند. مخالفات الكمية لا تقبل الاستثناء.`
            );
          }
        }

        const activeExc = await defaultPriceVarianceExceptionRepository.findActiveApprovedByInvoice(companyId, invoiceId, tx);
        if (!activeExc) {
          throw new ValidationError(
            'تتجاوز أسعار بنود الفاتورة الحد المسموح لتسامح السعر (5%) ولا يوجد طلب استثناء تباين معتمد لهذه الفاتورة.'
          );
        }

        const lockedExc = await defaultPriceVarianceExceptionRepository.findByIdForUpdate(companyId, activeExc.id, tx);
        if (!lockedExc || lockedExc.status !== 'approved') {
          throw new ValidationError('استثناء تباين الأسعار لم يعد معتمداً أو تم إلغاؤه.');
        }

        const currentFingerprint = defaultPriceVarianceExceptionRepository.computeFingerprint(
          companyId,
          invoiceId,
          invoice.supplierId,
          invoice.lines.map((l) => {
            const matchLine = matchReport.lines.find((m) => m.grnLineId === l.grnLineId);
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
          })
        );

        if (currentFingerprint !== lockedExc.fingerprint) {
          throw new ValidationError(
            'تغيرت بنود أو أسعار فاتورة المورد بعد اعتماد الاستثناء؛ يلزم طلب اعتماد استثناء جديد.'
          );
        }
      }

      const gl = await this.resolveGlMapping(companyId);
      await this.assertGlAccountsUsable(companyId, gl, tx);

      // Apply Purchase Price Variance (PPV) proportionally between Remaining Inventory & Consumed/COGS
      let totalClearingDebitUnits = 0n;
      let totalApCreditUnits = 0n;
      let totalRemainingInventoryAdjUnits = 0n;
      let totalConsumedCogsAdjUnits = 0n;
      const adjustmentIds: string[] = [];

      const ppvPre = this.valuationService.prefetchPurchasePriceVarianceContext
        ? await this.valuationService.prefetchPurchasePriceVarianceContext(
            companyId,
            invoice.lines.map((l) => l.id),
            invoice.lines.map((l) => lockedGrnMap.get(l.grnLineId)!.itemId),
            tx
          )
        : null;

      for (const line of invoice.lines) {
        const grnSummary = lockedGrnMap.get(line.grnLineId)!;
        const ppv = await this.valuationService.applyPurchasePriceVariance(
          companyId,
          {
            grnId: grnSummary.grnId,
            grnLineId: line.grnLineId,
            invoiceId,
            invoiceLineId: line.id,
            warehouseId: grnSummary.warehouseId,
            itemId: grnSummary.itemId,
            invoicedQty: line.qty,
            grnUnitCost: grnSummary.grnUnitCost,
            invoiceUnitCost: line.unitCost,
            reason: `تسوية فرق سعر فاتورة المورد (${invoice.supplierInvoiceNo})`,
            approvedBy: actorId || null,
            createdBy: actorId || null,
          },
          tx,
          ppvPre
            ? {
                noExistingAdjustment: !ppvPre.withAdjustments.has(line.id),
                costing: ppvPre.costing.get(grnSummary.itemId),
              }
            : undefined
        );

        totalClearingDebitUnits += ppv.grnMoneyUnits;
        totalApCreditUnits += ppv.invoiceMoneyUnits;
        totalRemainingInventoryAdjUnits += ppv.remainingMoneyUnits;
        totalConsumedCogsAdjUnits += ppv.consumedMoneyUnits;
        for (const adj of ppv.adjustments) {
          adjustmentIds.push(adj.id);
        }
      }

      const clearingAmount = unitsToSafeNumber(totalClearingDebitUnits, MONEY_SCALE);
      const apAmount = unitsToSafeNumber(totalApCreditUnits, MONEY_SCALE);

      const jeLines: Array<{ accountId: string; debit: number; credit: number; lineMemo: string }> = [];

      if (clearingAmount > 0) {
        jeLines.push({
          accountId: gl.purchasesClearingAccountId,
          debit: clearingAmount,
          credit: 0,
          lineMemo: `تسوية المشتريات المعلقة بتكلفة الاستلام فاتورة ${invoice.supplierInvoiceNo}`,
        });
      }

      if (totalRemainingInventoryAdjUnits !== 0n) {
        const invAccountId = await this.resolvePpvInventoryAccount(companyId, tx);
        const absInvAmount = unitsToSafeNumber(
          totalRemainingInventoryAdjUnits > 0n ? totalRemainingInventoryAdjUnits : -totalRemainingInventoryAdjUnits,
          MONEY_SCALE
        );
        jeLines.push({
          accountId: invAccountId,
          debit: totalRemainingInventoryAdjUnits > 0n ? absInvAmount : 0,
          credit: totalRemainingInventoryAdjUnits < 0n ? absInvAmount : 0,
          lineMemo: `تسوية فرق سعر المشتريات على المخزون المتبقي (${invoice.supplierInvoiceNo})`,
        });
      }

      if (totalConsumedCogsAdjUnits !== 0n) {
        const cogsAccountId = await this.resolvePpvCogsAccount(companyId, tx);
        const absCogsAmount = unitsToSafeNumber(
          totalConsumedCogsAdjUnits > 0n ? totalConsumedCogsAdjUnits : -totalConsumedCogsAdjUnits,
          MONEY_SCALE
        );
        jeLines.push({
          accountId: cogsAccountId,
          debit: totalConsumedCogsAdjUnits > 0n ? absCogsAmount : 0,
          credit: totalConsumedCogsAdjUnits < 0n ? absCogsAmount : 0,
          lineMemo: `تسوية فرق سعر المشتريات على تكلفة البضاعة المباعة (${invoice.supplierInvoiceNo})`,
        });
      }

      jeLines.push({
        accountId: gl.accountsPayableAccountId,
        debit: 0,
        credit: apAmount > 0 ? apAmount : totalAmount,
        lineMemo: `حساب المورد / الدائنين فاتورة ${invoice.supplierInvoiceNo}`,
      });

      const entryDate = isValidCalendarDate(invoice.invoiceDate)
        ? invoice.invoiceDate
        : await resolveCompanyToday(companyId, tx);
      const invoiceNo = await this.journalRepo.allocateSequenceNumber(companyId, 'purchase_invoice', 'PINV', tx);

      const draftJe = await this.journalService.createDraftEntry(
        companyId,
        {
          entryDate,
          memo: `ترحيل فاتورة مورد رقم ${invoiceNo} (فاتورة رقم: ${invoice.supplierInvoiceNo})`,
          lines: jeLines,
        },
        actorId || '',
        false,
        tx
      );

      const postedJe = await this.journalService.postEntry(companyId, draftJe.id, actorId || '', false, tx);

      if (adjustmentIds.length > 0) {
        await this.valuationService.linkCostAdjustmentsJournal(companyId, adjustmentIds, postedJe.id, tx);
      }

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
            totalAmount: apAmount > 0 ? apAmount : totalAmount,
            clearingClearedAmount: clearingAmount,
            ppvInventoryAdjustment: unitsToSafeNumber(totalRemainingInventoryAdjUnits, MONEY_SCALE),
            ppvCogsAdjustment: unitsToSafeNumber(totalConsumedCogsAdjUnits, MONEY_SCALE),
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

      const hasExceptions = await defaultPriceVarianceExceptionRepository.hasAnyForInvoice(companyId, invoiceId, tx);
      if (hasExceptions) {
        throw new ValidationError('لا يمكن حذف فاتورة المورد لوجود سجل طلبات استثناء تباين أسعار مرتبط بها');
      }

      try {
        await this.invoiceRepo.deleteDraft(companyId, invoiceId, tx);
      } catch (err: any) {
        if (err?.code === '23503') {
          throw new ValidationError('لا يمكن حذف فاتورة المورد لوجود سجلات مرتبطة تمنع الحذف');
        }
        throw err;
      }

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
