import { SalesReturnRepository, defaultSalesReturnRepository, PersistSalesReturnLineData } from './salesReturnRepository.js';
import { CustomerRepository, defaultCustomerRepository } from './customerRepository.js';
import { JournalRepository, defaultJournalRepository } from '../accounting/journalRepository.js';
import { JournalService, defaultJournalService } from '../accounting/journalService.js';
import { AuditService, defaultAuditService } from '../audit/auditService.js';
import { StockRepository, defaultStockRepository } from '../inventory/stockRepository.js';
import { defaultInventoryValuationService, InventoryValuationService } from '../inventory/inventoryValuationService.js';
import { SalesReturn, CreateSalesReturnInput } from './salesTypes.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import {
  COST_SCALE,
  MONEY_SCALE,
  QTY_SCALE,
  divExactUnits,
  fromMinorUnits,
  parseExactUnits,
  rescaleUnits,
  toDecimal,
  toMinorUnits,
  toMoney,
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

export class SalesReturnService {
  constructor(
    private returnRepo: SalesReturnRepository = defaultSalesReturnRepository,
    private customerRepo: CustomerRepository = defaultCustomerRepository,
    private stockRepo: StockRepository = defaultStockRepository,
    private valuationService: Pick<
      InventoryValuationService,
      'getItemCostingMethod' | 'restoreSalesReturnInventory' | 'linkValuationMovementJournal'
    > = defaultInventoryValuationService,
    private journalRepo: JournalRepository = defaultJournalRepository,
    private journalService: Pick<JournalService, 'createDraftEntry' | 'postEntry'> = defaultJournalService,
    private auditService: AuditService = defaultAuditService
  ) {}

  async listReturns(companyId: string): Promise<SalesReturn[]> {
    if (!companyId) throw new ValidationError('companyId is required');
    return await this.returnRepo.list(companyId);
  }

  async getReturn(companyId: string, id: string): Promise<SalesReturn> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');
    const ret = await this.returnRepo.findById(companyId, id);
    if (!ret) throw new NotFoundError('مرتجع المبيعات غير موجود');
    return ret;
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

    throw new ValidationError('يرجى ضبط حساب العملاء / الذمم المدينة (AR) في إعدادات الشركة قبل ترحيل مرتجعات المبيعات');
  }

  private async resolveRevenueAccount(companyId: string, executor: DbExecutor): Promise<string> {
    const settingsRes = await executor.query<any>(
      `SELECT sales_revenue_account_id as "revAccountId" FROM company_settings WHERE company_id = $1`,
      [companyId]
    );
    if (settingsRes.rows[0]?.revAccountId) {
      return settingsRes.rows[0].revAccountId;
    }

    const res = await executor.query<any>(
      `SELECT id FROM accounts WHERE company_id = $1 AND is_active = true AND is_postable = true AND (code = '4100' OR account_type = 'revenue') ORDER BY code ASC LIMIT 1`,
      [companyId]
    );
    if (res.rows.length > 0) return res.rows[0].id;

    throw new ValidationError('يرجى ضبط حساب إيراد المبيعات في إعدادات الشركة قبل ترحيل مرتجعات المبيعات');
  }

  private async resolveVatPayableAccount(companyId: string, executor: DbExecutor): Promise<string> {
    const settingsRes = await executor.query<{ vatAccountId?: string | null }>(
      `SELECT vat_payable_account_id as "vatAccountId" FROM company_settings WHERE company_id = $1`,
      [companyId]
    );
    const vatAccountId = settingsRes.rows[0]?.vatAccountId?.trim() || '';
    if (!vatAccountId) {
      throw new ValidationError(
        'لا يمكن ترحيل مرتجع مبيعات خاضع للضريبة قبل ضبط "حساب ضريبة القيمة المضافة المستحقة" (vat_payable_account_id) في إعدادات الشركة.'
      );
    }

    const accRes = await executor.query<AccountRow>(
      `SELECT id, code, name_ar as "nameAr", account_type as "accountType", is_active as "isActive", is_postable as "isPostable"
       FROM accounts WHERE company_id = $1 AND id = $2`,
      [companyId, vatAccountId]
    );
    const acc = accRes.rows[0];
    if (!acc || !acc.isActive || !acc.isPostable || acc.accountType !== 'liability') {
      throw new ValidationError('حساب ضريبة القيمة المضافة المحدد في إعدادات الشركة غير صالح أو غير نشط');
    }
    return vatAccountId;
  }

  private async resolveCogsAndInventoryAccounts(
    companyId: string,
    executor: DbExecutor
  ): Promise<{ cogsAccountId: string; inventoryAccountId: string }> {
    const settingsRes = await executor.query<{
      cogsAccountId?: string | null;
      inventoryAccountId?: string | null;
    }>(
      `SELECT cogs_account_id as "cogsAccountId", inventory_account_id as "inventoryAccountId"
       FROM company_settings WHERE company_id = $1`,
      [companyId]
    );

    const cogsAccountId = settingsRes.rows[0]?.cogsAccountId?.trim() || '';
    const inventoryAccountId = settingsRes.rows[0]?.inventoryAccountId?.trim() || '';

    if (!cogsAccountId || !inventoryAccountId || cogsAccountId === inventoryAccountId) {
      throw new ValidationError(
        'يرجى ضبط "حساب تكلفة البضاعة المباعة (COGS)" و"حساب المخزون" المستقلين في إعدادات الشركة قبل ترحيل مرتجعات المبيعات.'
      );
    }

    const accRes = await executor.query<AccountRow>(
      `SELECT id, code, name_ar as "nameAr", account_type as "accountType", is_active as "isActive", is_postable as "isPostable"
       FROM accounts WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [companyId, [cogsAccountId, inventoryAccountId]]
    );
    const byId = new Map<string, AccountRow>(accRes.rows.map((r) => [r.id, r]));
    const cogsAcc = byId.get(cogsAccountId);
    const invAcc = byId.get(inventoryAccountId);

    if (!cogsAcc || !cogsAcc.isActive || !cogsAcc.isPostable || cogsAcc.accountType !== 'expense') {
      throw new ValidationError('حساب تكلفة البضاعة المباعة في إعدادات الشركة غير صالح');
    }
    if (!invAcc || !invAcc.isActive || !invAcc.isPostable || invAcc.accountType !== 'asset') {
      throw new ValidationError('حساب المخزون في إعدادات الشركة غير صالح');
    }

    return { cogsAccountId, inventoryAccountId };
  }

  private computeReturnLineAmounts(
    origQtyUnits: bigint,
    origTaxUnits: bigint,
    origTotalUnits: bigint,
    alreadyReturnedQtyUnits: bigint,
    alreadyReturnedTaxUnits: bigint,
    alreadyReturnedTotalUnits: bigint,
    returnQtyUnits: bigint
  ): { netUnits: bigint; taxUnits: bigint; totalUnits: bigint } {
    const cumulativeQtyUnits = alreadyReturnedQtyUnits + returnQtyUnits;
    let targetTotalUnits: bigint;
    let targetTaxUnits: bigint;

    if (cumulativeQtyUnits >= origQtyUnits || origQtyUnits === 0n) {
      targetTotalUnits = origTotalUnits;
      targetTaxUnits = origTaxUnits;
    } else {
      targetTotalUnits = divExactUnits(
        origTotalUnits * cumulativeQtyUnits,
        MONEY_SCALE + QTY_SCALE,
        origQtyUnits,
        QTY_SCALE,
        MONEY_SCALE
      );
      targetTaxUnits = divExactUnits(
        origTaxUnits * cumulativeQtyUnits,
        MONEY_SCALE + QTY_SCALE,
        origQtyUnits,
        QTY_SCALE,
        MONEY_SCALE
      );
    }

    const totalUnits = targetTotalUnits > alreadyReturnedTotalUnits ? targetTotalUnits - alreadyReturnedTotalUnits : 0n;
    let taxUnits = targetTaxUnits > alreadyReturnedTaxUnits ? targetTaxUnits - alreadyReturnedTaxUnits : 0n;
    if (taxUnits > totalUnits) {
      taxUnits = totalUnits;
    }
    const netUnits = totalUnits - taxUnits;
    return { netUnits, taxUnits, totalUnits };
  }

  async createReturn(companyId: string, input: CreateSalesReturnInput, actorUserId?: string): Promise<SalesReturn> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!input.customerId) throw new ValidationError('العميل مطلوب');
    if (!input.invoiceId) throw new ValidationError('فاتورة المبيعات مطلوبة');
    if (!input.warehouseId) throw new ValidationError('المستودع مطلوب');
    assertMaxDocumentLines(input.lines);
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new ValidationError('يجب إضافة بند واحد على الأقل في مرتجع المبيعات');
    }
    const validatedReturnDate = assertOptionalCalendarDate(input.returnDate, 'تاريخ المرتجع');

    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const customer = await this.customerRepo.findById(companyId, input.customerId, tx);
      if (!customer || !customer.isActive) {
        throw new ValidationError('العميل غير موجود أو غير نشط');
      }

      const whRes = await tx.query<any>(
        `SELECT id, is_active FROM inv_warehouses WHERE company_id = $1 AND id = $2`,
        [companyId, input.warehouseId]
      );
      if (whRes.rows.length === 0 || !whRes.rows[0].is_active) {
        throw new ValidationError('المستودع المحدد غير موجود أو غير نشط');
      }

      const invRes = await tx.query<any>(
        `SELECT id, status, customer_id FROM sales_invoices WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        [companyId, input.invoiceId]
      );
      if (invRes.rows.length === 0) {
        throw new NotFoundError('فاتورة المبيعات المحددة غير موجودة');
      }
      if (invRes.rows[0].status !== 'posted') {
        throw new ValidationError('لا يمكن إنشاء مرتجع مبيعات على فاتورة غير مرحلة أو ملغاة');
      }
      if (invRes.rows[0].customer_id !== input.customerId) {
        throw new ValidationError('العميل في المرتجع لا يطابق عميل فاتورة المبيعات');
      }

      const invLinesRes = await tx.query<any>(
        `SELECT id, item_id, delivery_line_id, qty::text, unit_price::text, tax_rate::text, tax_amount::text, line_total::text
         FROM sales_invoice_lines
         WHERE company_id = $1 AND invoice_id = $2
         ORDER BY line_no ASC
         FOR UPDATE`,
        [companyId, input.invoiceId]
      );
      const invLineMap = new Map<string, any>(invLinesRes.rows.map((r) => [r.id, r]));

      const invLineIds = invLinesRes.rows.map((r) => r.id);
      const priorRetRes = invLineIds.length
        ? await tx.query<any>(
            `SELECT srl.invoice_line_id,
                    COALESCE(SUM(srl.qty), 0)::text as returned_qty,
                    COALESCE(SUM(srl.tax_amount), 0)::text as returned_tax,
                    COALESCE(SUM(srl.line_total), 0)::text as returned_total
             FROM sales_return_lines srl
             INNER JOIN sales_returns sr ON sr.id = srl.return_id AND sr.company_id = srl.company_id
             WHERE srl.company_id = $1 AND srl.invoice_line_id = ANY($2::uuid[]) AND sr.status = 'posted'
             GROUP BY srl.invoice_line_id`,
            [companyId, invLineIds]
          )
        : { rows: [] };
      const priorMap = new Map<string, { qtyU: bigint; taxU: bigint; totalU: bigint }>();
      for (const pr of priorRetRes.rows) {
        priorMap.set(pr.invoice_line_id, {
          qtyU: toMinorUnits(pr.returned_qty ?? '0', QTY_SCALE),
          taxU: toMinorUnits(pr.returned_tax ?? '0', MONEY_SCALE),
          totalU: toMinorUnits(pr.returned_total ?? '0', MONEY_SCALE),
        });
      }

      const seenInvLineIds = new Set<string>();
      const draftLines: PersistSalesReturnLineData[] = [];
      let subtotalUnits = 0n;
      let taxAmountUnits = 0n;
      let totalAmountUnits = 0n;

      for (let idx = 0; idx < input.lines.length; idx++) {
        const line = input.lines[idx];
        if (!line.invoiceLineId || typeof line.invoiceLineId !== 'string') {
          throw new ValidationError('معرف بند الفاتورة (invoiceLineId) مطلوب في جميع بنود المرتجع');
        }
        const invLineId = line.invoiceLineId.trim();
        if (seenInvLineIds.has(invLineId)) {
          throw new ValidationError('لا يمكن تكرار نفس بند الفاتورة في نفس المرتجع');
        }
        seenInvLineIds.add(invLineId);

        if (typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0) {
          throw new ValidationError('كمية المرتجع يجب أن تكون أكبر من الصفر');
        }

        const invLine = invLineMap.get(invLineId);
        if (!invLine) {
          throw new ValidationError('أحد بنود المرتجع لا ينتمي إلى فاتورة المبيعات المحددة');
        }

        const origQtyU = parseExactUnits(invLine.qty, QTY_SCALE, 'origQty');
        const origTaxU = parseExactUnits(invLine.tax_amount, MONEY_SCALE, 'origTax');
        const origTotalU = parseExactUnits(invLine.line_total, MONEY_SCALE, 'origTotal');
        const prev = priorMap.get(invLineId) || { qtyU: 0n, taxU: 0n, totalU: 0n };
        const reqQtyU = toMinorUnits(line.qty, QTY_SCALE);
        const remainingQtyU = origQtyU > prev.qtyU ? origQtyU - prev.qtyU : 0n;

        if (reqQtyU > remainingQtyU) {
          throw new ValidationError(
            `كمية مرتجع المبيعات (${line.qty}) تتجاوز الكمية المتبقية القابلة للإرجاع من بند الفاتورة (${fromMinorUnits(remainingQtyU, QTY_SCALE)})`
          );
        }

        const computed = this.computeReturnLineAmounts(
          origQtyU,
          origTaxU,
          origTotalU,
          prev.qtyU,
          prev.taxU,
          prev.totalU,
          reqQtyU
        );

        subtotalUnits += computed.netUnits;
        taxAmountUnits += computed.taxUnits;
        totalAmountUnits += computed.totalUnits;

        draftLines.push({
          invoiceLineId: invLineId,
          deliveryLineId: invLine.delivery_line_id || null,
          itemId: invLine.item_id,
          qty: fromMinorUnits(reqQtyU, QTY_SCALE),
          unitPrice: fromMinorUnits(parseExactUnits(invLine.unit_price, COST_SCALE, 'unitPrice'), COST_SCALE),
          taxRate: fromMinorUnits(parseExactUnits(invLine.tax_rate ?? '0', 2, 'taxRate'), 2),
          taxAmount: fromMinorUnits(computed.taxUnits, MONEY_SCALE),
          lineTotal: fromMinorUnits(computed.totalUnits, MONEY_SCALE),
          lineNo: idx + 1,
        });
      }

      const effectiveReturnDate = validatedReturnDate ?? (await resolveCompanyToday(companyId, tx));

      const created = await this.returnRepo.createDraft(
        companyId,
        {
          customerId: input.customerId,
          invoiceId: input.invoiceId,
          warehouseId: input.warehouseId,
          returnDate: effectiveReturnDate,
          reason: input.reason,
          memo: input.memo,
          subtotal: fromMinorUnits(subtotalUnits, MONEY_SCALE),
          taxAmount: fromMinorUnits(taxAmountUnits, MONEY_SCALE),
          totalAmount: fromMinorUnits(totalAmountUnits, MONEY_SCALE),
          lines: draftLines,
        },
        actorUserId,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorUserId || null,
          companyId,
          action: 'SALES_RETURN_CREATE',
          entityType: 'sales_returns',
          entityId: created.id,
          metadata: {
            invoiceId: input.invoiceId,
            customerId: input.customerId,
            warehouseId: input.warehouseId,
            totalAmount: created.totalAmount,
            linesCount: draftLines.length,
          },
        },
        { executor: tx }
      );

      return created;
    });
  }

  async postReturn(companyId: string, id: string, actorUserId?: string): Promise<SalesReturn> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');

    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const locked = await this.returnRepo.findByIdForUpdate(companyId, id, tx);
      if (!locked) {
        throw new NotFoundError('مرتجع المبيعات غير موجود');
      }
      if (locked.status === 'posted') {
        throw new ValidationError('مرتجع المبيعات مرحل مسبقاً');
      }
      if (locked.status === 'cancelled') {
        throw new ValidationError('لا يمكن ترحيل مرتجع مبيعات ملغى');
      }

      const ret = await this.returnRepo.findById(companyId, id, tx);
      if (!ret || !ret.lines || ret.lines.length === 0) {
        throw new ValidationError('مرتجع المبيعات لا يحتوي على بنود لترحيلها');
      }

      const whRes = await tx.query<any>(
        `SELECT id, is_active FROM inv_warehouses WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        [companyId, ret.warehouseId]
      );
      if (whRes.rows.length === 0 || !whRes.rows[0].is_active) {
        throw new ValidationError('المستودع المحدد غير موجود أو غير نشط');
      }

      const invRes = await tx.query<any>(
        `SELECT id, status, customer_id, invoice_no FROM sales_invoices WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        [companyId, ret.invoiceId]
      );
      if (invRes.rows.length === 0 || invRes.rows[0].status !== 'posted') {
        throw new ValidationError('فاتورة المبيعات المرتبطة بالمرتجع غير موجودة أو غير مرحلة');
      }
      if (invRes.rows[0].customer_id !== ret.customerId) {
        throw new ValidationError('العميل في المرتجع لا يطابق عميل الفاتورة');
      }

      const invLinesRes = await tx.query<any>(
        `SELECT id, item_id, delivery_line_id, qty::text, tax_amount::text, line_total::text
         FROM sales_invoice_lines
         WHERE company_id = $1 AND invoice_id = $2
         ORDER BY line_no ASC
         FOR UPDATE`,
        [companyId, ret.invoiceId]
      );
      const invLineMap = new Map<string, any>(invLinesRes.rows.map((r) => [r.id, r]));

      // Validate costing profiles for all lines with linked delivery lines upfront
      for (const line of ret.lines) {
        if (line.deliveryLineId) {
          await this.valuationService.getItemCostingMethod(companyId, line.itemId, tx);
        }
      }

      // One grouped query for previously returned amounts instead of one per line.
      const prevRes = await tx.query<any>(
        `SELECT srl.invoice_line_id,
                COALESCE(SUM(srl.qty), 0)::text as returned_qty,
                COALESCE(SUM(srl.tax_amount), 0)::text as returned_tax,
                COALESCE(SUM(srl.line_total), 0)::text as returned_total
         FROM sales_return_lines srl
         INNER JOIN sales_returns sr ON sr.id = srl.return_id AND sr.company_id = srl.company_id
         WHERE srl.company_id = $1 AND srl.invoice_line_id = ANY($2::uuid[]) AND sr.status = 'posted' AND sr.id <> $3
         GROUP BY srl.invoice_line_id`,
        [companyId, ret.lines.map((l: any) => l.invoiceLineId), id]
      );
      const prevMap = new Map<string, any>(prevRes.rows.map((r: any) => [r.invoice_line_id, r]));
      const lineUpdates: Array<{ lineId: string; taxAmount: string; lineTotal: string; cogsCost: string; valuationMovementId: string | null }> = [];

      let subtotalUnits = 0n;
      let taxAmountUnits = 0n;
      let totalAmountUnits = 0n;
      let totalCogsMoneyUnits = 0n;
      const valuationMovementIds: string[] = [];

      for (const line of ret.lines) {
        const invLine = invLineMap.get(line.invoiceLineId);
        if (!invLine || invLine.item_id !== line.itemId) {
          throw new ValidationError('بيانات بند الفاتورة المرتبطة ببند المرتجع غير متطابقة');
        }

        const prev = prevMap.get(line.invoiceLineId);
        const origQtyU = parseExactUnits(invLine.qty, QTY_SCALE, 'origQty');
        const origTaxU = parseExactUnits(invLine.tax_amount, MONEY_SCALE, 'origTax');
        const origTotalU = parseExactUnits(invLine.line_total, MONEY_SCALE, 'origTotal');
        const prevQtyU = toMinorUnits(prev?.returned_qty ?? '0', QTY_SCALE);
        const prevTaxU = toMinorUnits(prev?.returned_tax ?? '0', MONEY_SCALE);
        const prevTotalU = toMinorUnits(prev?.returned_total ?? '0', MONEY_SCALE);
        const lineQtyU = toMinorUnits(line.qty, QTY_SCALE);
        const remainingQtyU = origQtyU > prevQtyU ? origQtyU - prevQtyU : 0n;

        if (lineQtyU > remainingQtyU) {
          throw new ValidationError(
            `كمية مرتجع المبيعات (${line.qty}) تتجاوز الكمية المتبقية القابلة للإرجاع من بند الفاتورة (${fromMinorUnits(remainingQtyU, QTY_SCALE)})`
          );
        }

        const computed = this.computeReturnLineAmounts(
          origQtyU,
          origTaxU,
          origTotalU,
          prevQtyU,
          prevTaxU,
          prevTotalU,
          lineQtyU
        );
        subtotalUnits += computed.netUnits;
        taxAmountUnits += computed.taxUnits;
        totalAmountUnits += computed.totalUnits;

        let lineCogsMoneyUnits = 0n;
        let lineValMovId: string | null = null;

        const deliveryLineId = line.deliveryLineId || invLine.delivery_line_id || null;
        if (deliveryLineId) {
          const dlRes = await tx.query<any>(
            `SELECT dl.id, dl.item_id, dl.qty::text, dl.frozen_total_cost::text, dl.valuation_movement_id, dn.status as dn_status
             FROM sales_delivery_lines dl
             INNER JOIN sales_delivery_notes dn ON dn.id = dl.delivery_id AND dn.company_id = dl.company_id
             WHERE dl.company_id = $1 AND dl.id = $2
             FOR UPDATE OF dl`,
            [companyId, deliveryLineId]
          );
          if (dlRes.rows.length === 0 || dlRes.rows[0].dn_status !== 'posted') {
            throw new ValidationError('بند إذن التسليم المرتبط غير موجود أو غير مرحل');
          }
          const dlRow = dlRes.rows[0];
          if (dlRow.item_id !== line.itemId) {
            throw new ValidationError('الصنف في بند المرتجع لا يطابق الصنف في إذن التسليم');
          }

          const preStock = await this.stockRepo.getBalanceForUpdate(companyId, ret.warehouseId, line.itemId, tx);
          const preStockUnits = toMinorUnits(preStock?.qty ?? 0, QTY_SCALE);

          const updatedStock = await this.stockRepo.incrementBalance(
            companyId,
            ret.warehouseId,
            line.itemId,
            line.qty,
            tx
          );

          await this.stockRepo.createMovement(
            companyId,
            ret.warehouseId,
            line.itemId,
            'sales_return',
            line.qty,
            ret.reason || `مرتجع مبيعات فاتورة ${ret.invoiceNo || ret.invoiceId}`,
            actorUserId,
            undefined,
            tx
          );

          const restored = await this.valuationService.restoreSalesReturnInventory(
            companyId,
            {
              warehouseId: ret.warehouseId,
              itemId: line.itemId,
              qty: line.qty,
              returnId: id,
              returnLineId: line.id,
              deliveryLineId: dlRow.id,
              deliveryValuationMovementId: dlRow.valuation_movement_id || null,
              deliveryQty: dlRow.qty,
              deliveryFrozenTotalCost: dlRow.frozen_total_cost,
              reason: ret.reason || `مرتجع مبيعات فاتورة ${ret.invoiceNo || ret.invoiceId}`,
              stockSyncMode: 'external_verified',
              expectedPreStockQty: fromMinorUnits(preStockUnits, QTY_SCALE),
              expectedPostStockQty: fromMinorUnits(toMinorUnits(updatedStock.qty, QTY_SCALE), QTY_SCALE),
            },
            actorUserId,
            tx
          );

          const restoredCostUnits = parseExactUnits(restored.movement.totalCost, COST_SCALE, 'restoredCost');
          lineCogsMoneyUnits = rescaleUnits(restoredCostUnits, COST_SCALE, MONEY_SCALE);
          lineValMovId = restored.movement.id;
          valuationMovementIds.push(restored.movement.id);
        }

        totalCogsMoneyUnits += lineCogsMoneyUnits;
        lineUpdates.push({
          lineId: line.id,
          taxAmount: fromMinorUnits(computed.taxUnits, MONEY_SCALE),
          lineTotal: fromMinorUnits(computed.totalUnits, MONEY_SCALE),
          cogsCost: fromMinorUnits(lineCogsMoneyUnits, MONEY_SCALE),
          valuationMovementId: lineValMovId,
        });
      }

      await this.returnRepo.updateLinesComputedValues(companyId, lineUpdates, tx);

      if (!(totalAmountUnits > 0n)) {
        throw new ValidationError('قيمة مرتجع المبيعات الإجمالية يجب أن تكون أكبر من الصفر لترحيله');
      }

      const arAccountId = await this.resolveArAccount(companyId, tx);
      const revAccountId = await this.resolveRevenueAccount(companyId, tx);

      let vatAccountId: string | null = null;
      if (taxAmountUnits > 0n) {
        vatAccountId = await this.resolveVatPayableAccount(companyId, tx);
        if (vatAccountId === revAccountId || vatAccountId === arAccountId) {
          throw new ValidationError('حساب ضريبة المبيعات يجب أن يكون حساباً مستقلاً عن حساب الإيراد وحساب العملاء');
        }
      }

      let cogsAccounts: { cogsAccountId: string; inventoryAccountId: string } | null = null;
      if (totalCogsMoneyUnits > 0n) {
        cogsAccounts = await this.resolveCogsAndInventoryAccounts(companyId, tx);
      }

      const returnNo = await this.journalRepo.allocateSequenceNumber(companyId, 'sales_return', 'SRTN', tx);
      const entryDate = isValidCalendarDate(ret.returnDate)
        ? ret.returnDate
        : await resolveCompanyToday(companyId, tx);

      const netAmount = toMoney(fromMinorUnits(subtotalUnits, MONEY_SCALE));
      const taxAmount = toMoney(fromMinorUnits(taxAmountUnits, MONEY_SCALE));
      const grossAmount = toMoney(fromMinorUnits(totalAmountUnits, MONEY_SCALE));
      const cogsAmount = toMoney(fromMinorUnits(totalCogsMoneyUnits, MONEY_SCALE));

      const jeLines: Array<{ accountId: string; debit: number; credit: number; lineMemo: string }> = [];

      if (subtotalUnits > 0n) {
        jeLines.push({
          accountId: revAccountId,
          debit: netAmount,
          credit: 0,
          lineMemo: `تخفيض / عكس إيراد المبيعات لمرتجع رقم ${returnNo}`,
        });
      }

      if (taxAmountUnits > 0n && vatAccountId) {
        jeLines.push({
          accountId: vatAccountId,
          debit: taxAmount,
          credit: 0,
          lineMemo: `عكس ضريبة القيمة المضافة المستحقة لمرتجع رقم ${returnNo}`,
        });
      }

      jeLines.push({
        accountId: arAccountId,
        debit: 0,
        credit: grossAmount,
        lineMemo: `تخفيض ذمة العميل ${ret.customerNameAr || ''} مرتجع مبيعات ${returnNo}`,
      });

      if (totalCogsMoneyUnits > 0n && cogsAccounts) {
        jeLines.push(
          {
            accountId: cogsAccounts.inventoryAccountId,
            debit: cogsAmount,
            credit: 0,
            lineMemo: `إعادة تكلفة المخزون لمرتجع مبيعات رقم ${returnNo}`,
          },
          {
            accountId: cogsAccounts.cogsAccountId,
            debit: 0,
            credit: cogsAmount,
            lineMemo: `عكس تكلفة البضاعة المباعة (COGS) لمرتجع رقم ${returnNo}`,
          }
        );
      }

      const draftJe = await this.journalService.createDraftEntry(
        companyId,
        {
          entryDate,
          memo: `ترحيل مرتجع مبيعات رقم ${returnNo} للعميل ${ret.customerNameAr || ret.customerId} (فاتورة ${ret.invoiceNo || ret.invoiceId})`,
          lines: jeLines,
        },
        actorUserId || '',
        false,
        tx
      );

      const postedJe = await this.journalService.postEntry(companyId, draftJe.id, actorUserId || '', false, tx);

      for (const valMovId of valuationMovementIds) {
        await this.valuationService.linkValuationMovementJournal(companyId, valMovId, postedJe.id, tx);
      }

      await this.returnRepo.markPosted(
        companyId,
        id,
        returnNo,
        postedJe.id,
        fromMinorUnits(subtotalUnits, MONEY_SCALE),
        fromMinorUnits(taxAmountUnits, MONEY_SCALE),
        fromMinorUnits(totalAmountUnits, MONEY_SCALE),
        fromMinorUnits(totalCogsMoneyUnits, MONEY_SCALE),
        actorUserId,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorUserId || null,
          companyId,
          action: 'SALES_RETURN_POST',
          entityType: 'sales_returns',
          entityId: id,
          metadata: {
            returnNo,
            invoiceId: ret.invoiceId,
            subtotal: netAmount,
            taxAmount,
            totalAmount: grossAmount,
            cogsAmount,
            journalEntryId: postedJe.id,
          },
        },
        { executor: tx }
      );

      const posted = await this.returnRepo.findById(companyId, id, tx);
      return posted!;
    });
  }

  async deleteReturn(companyId: string, id: string, actorUserId?: string): Promise<boolean> {
    if (!companyId) throw new ValidationError('companyId is required');
    if (!id) throw new ValidationError('id is required');

    const success = await this.returnRepo.delete(companyId, id);
    if (!success) {
      throw new NotFoundError('مرتجع المبيعات غير موجود أو تم ترحيله مسبقاً ولا يمكن حذفه');
    }

    await this.auditService.record({
      actorUserId: actorUserId || null,
      companyId,
      action: 'SALES_RETURN_DELETE',
      entityType: 'sales_returns',
      entityId: id,
    });

    return true;
  }
}

export const defaultSalesReturnService = new SalesReturnService();
