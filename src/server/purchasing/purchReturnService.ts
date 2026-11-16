import { defaultPurchReturnRepository, PurchReturnRepository, PurchReturnHeader, CreatePurchReturnInput } from './purchReturnRepository.js';
import { defaultSupplierRepository, SupplierRepository } from './supplierRepository.js';
import { defaultCompanySettingsRepository, CompanySettingsRepository } from '../org/companySettingsRepository.js';
import { defaultJournalRepository, JournalRepository } from '../accounting/journalRepository.js';
import { defaultJournalService, JournalService } from '../accounting/journalService.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { defaultConfigService, ConfigService } from '../config-platform/configService.js';
import { defaultAccountRepository, AccountRepository } from '../accounting/accountRepository.js';
import { defaultStockRepository, StockRepository } from '../inventory/stockRepository.js';
import { GlMappingService } from '../accounting/glMappingService.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { toDecimal, toMinorUnits, toMoney } from '../lib/numeric.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class PurchReturnService {
  private glMappingService: GlMappingService;

  constructor(
    private returnRepo: PurchReturnRepository = defaultPurchReturnRepository,
    private supplierRepo: SupplierRepository = defaultSupplierRepository,
    private settingsRepo: CompanySettingsRepository = defaultCompanySettingsRepository,
    private journalRepo: JournalRepository = defaultJournalRepository,
    private journalService: Pick<JournalService, 'createDraftEntry' | 'postEntry'> = defaultJournalService,
    private auditService: AuditService = defaultAuditService,
    private configService: Pick<ConfigService, 'resolveConfig'> = defaultConfigService,
    private accountRepo: AccountRepository = defaultAccountRepository,
    private stockRepo: StockRepository = defaultStockRepository
  ) {
    this.glMappingService = new GlMappingService(this.configService, this.accountRepo);
  }

  async listReturns(companyId: string): Promise<PurchReturnHeader[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.returnRepo.listByCompany(companyId);
  }

  async getReturn(companyId: string, returnId: string): Promise<PurchReturnHeader> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!returnId || typeof returnId !== 'string') {
      throw new ValidationError('returnId is required');
    }
    const ret = await this.returnRepo.findById(companyId, returnId);
    if (!ret) {
      throw new NotFoundError('مرتجع المشتريات غير موجود');
    }
    return ret;
  }

  async listReturnableLines(companyId: string, supplierId?: string) {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.returnRepo.listReturnableGrnLines(companyId, supplierId);
  }

  async createReturn(
    companyId: string,
    input: CreatePurchReturnInput,
    actorId?: string
  ): Promise<PurchReturnHeader> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!input.supplierId || typeof input.supplierId !== 'string') {
      throw new ValidationError('المورد مطلوب');
    }
    if (!input.warehouseId || typeof input.warehouseId !== 'string') {
      throw new ValidationError('المستودع مطلوب');
    }
    if (!input.grnId || typeof input.grnId !== 'string') {
      throw new ValidationError('سند الاستلام (GRN) مطلوب');
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new ValidationError('يجب إضافة بند واحد على الأقل في المرتجع');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const supplier = await this.supplierRepo.findById(companyId, input.supplierId, tx);
      if (!supplier || !supplier.isActive) {
        throw new ValidationError('المورد غير موجود أو غير نشط');
      }

      const grnRes = await tx.query<any>(
        `SELECT id, status, supplier_id, warehouse_id FROM purch_grn WHERE company_id = $1 AND id = $2`,
        [companyId, input.grnId]
      );
      if (grnRes.rows.length === 0) {
        throw new NotFoundError('سند الاستلام المحدد غير موجود');
      }
      const grn = grnRes.rows[0];
      if (grn.status !== 'posted') {
        throw new ValidationError('لا يمكن إرجاع بضاعة من سند استلام غير مرحل');
      }
      if (grn.supplier_id !== input.supplierId) {
        throw new ValidationError('المورد في المرتجع لا يطابق مورد سند الاستلام');
      }

      const whRes = await tx.query<any>(
        `SELECT id, is_active FROM inv_warehouses WHERE company_id = $1 AND id = $2`,
        [companyId, input.warehouseId]
      );
      if (whRes.rows.length === 0 || !whRes.rows[0].is_active) {
        throw new ValidationError('المستودع المحدد غير موجود أو غير نشط');
      }

      if (input.invoiceId) {
        const invRes = await tx.query<any>(
          `SELECT id, status, supplier_id FROM purch_supplier_invoices WHERE company_id = $1 AND id = $2`,
          [companyId, input.invoiceId]
        );
        if (invRes.rows.length === 0) {
          throw new NotFoundError('فاتورة المورد المرتبطة غير موجودة');
        }
        const inv = invRes.rows[0];
        if (inv.status !== 'posted') {
          throw new ValidationError('لا يمكن ربط مرتجع مشتريات بفاتورة مورد غير مرحلة');
        }
        if (inv.supplier_id !== input.supplierId) {
          throw new ValidationError('فاتورة المورد لا تتبع نفس المورد في المرتجع');
        }
      }

      const returnableLines = await this.returnRepo.listReturnableGrnLines(companyId, input.supplierId, tx);
      const returnableMap = new Map<string, any>();
      for (const rl of returnableLines) {
        returnableMap.set(rl.grnLineId, rl);
      }

      const seenGrnLineIds = new Set<string>();
      for (const line of input.lines) {
        if (!line.grnLineId || typeof line.grnLineId !== 'string') {
          throw new ValidationError('كافة بنود المرتجع تتطلب ربطاً ببند سند استلام (grnLineId)');
        }
        const normalized = line.grnLineId.trim();
        if (seenGrnLineIds.has(normalized)) {
          throw new ValidationError('لا يمكن تكرار نفس بند سند الاستلام في نفس المرتجع');
        }
        seenGrnLineIds.add(normalized);

        if (typeof line.qty !== 'number' || !Number.isFinite(line.qty) || line.qty <= 0) {
          throw new ValidationError('كمية المرتجع يجب أن تكون أكبر من الصفر');
        }
        if (typeof line.unitCost !== 'number' || !Number.isFinite(line.unitCost) || line.unitCost < 0) {
          throw new ValidationError('تكلفة الوحدة غير صالحة');
        }

        const out = returnableMap.get(normalized);
        if (!out) {
          throw new ValidationError('بند سند الاستلام المحدد غير متاح للإرجاع أو تم إرجاعه كاملاً');
        }
        if (out.grnId !== input.grnId) {
          throw new ValidationError('بند سند الاستلام المحدد لا يتبع سند الاستلام المختار في المرتجع');
        }

        if (toMinorUnits(line.qty, 4) > toMinorUnits(out.returnableQty, 4)) {
          throw new ValidationError(
            `كمية المرتجع (${line.qty}) تتجاوز الكمية القابلة للإرجاع (${out.returnableQty})`
          );
        }
      }

      const created = await this.returnRepo.createDraft(
        companyId,
        {
          supplierId: input.supplierId,
          warehouseId: input.warehouseId,
          grnId: input.grnId,
          invoiceId: input.invoiceId,
          returnDate: input.returnDate,
          reason: input.reason,
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
          action: 'PURCHASE_RETURN_CREATE',
          entityType: 'purch_returns',
          entityId: created.id,
          metadata: { grnId: input.grnId, lineCount: input.lines.length },
        },
        { executor: tx }
      );

      const full = await this.returnRepo.findById(companyId, created.id, tx);
      return full || created;
    });
  }

  private async resolveGlMapping(companyId: string, tx?: any): Promise<{
    inventoryAccountId: string;
    purchasesClearingAccountId: string;
    accountsPayableAccountId: string;
  }> {
    let invFromConfig = '';
    let clrFromConfig = '';
    let apFromConfig = '';

    try {
      const grnCfg = await this.glMappingService.resolve(companyId, 'accounting.grn_mapping');
      invFromConfig = (grnCfg.accounts.inventory_account_id || '').trim();
      clrFromConfig = (grnCfg.accounts.purchases_clearing_account_id || '').trim();
    } catch {
      // fallback to company_settings
    }

    try {
      const invCfg = await this.glMappingService.resolve(companyId, 'accounting.purchase_invoice_mapping');
      if (!clrFromConfig) {
        clrFromConfig = (invCfg.accounts.purchases_clearing_account_id || '').trim();
      }
      apFromConfig = (invCfg.accounts.accounts_payable_account_id || '').trim();
    } catch {
      // fallback to company_settings
    }

    const settings = await this.settingsRepo.getByCompanyId(companyId, tx);
    const inventoryAccountId = invFromConfig || settings?.inventoryAccountId || '';
    const purchasesClearingAccountId = clrFromConfig || settings?.purchasesClearingAccountId || '';
    const accountsPayableAccountId =
      apFromConfig || settings?.accountsPayableAccountId || purchasesClearingAccountId;

    if (!inventoryAccountId || !purchasesClearingAccountId) {
      throw new ValidationError(
        'يرجى ضبط حساب المخزون وحساب المشتريات المعلقة في إعدادات الشركة قبل ترحيل مرتجعات المشتريات.'
      );
    }

    return {
      inventoryAccountId,
      purchasesClearingAccountId,
      accountsPayableAccountId,
    };
  }

  async postReturn(companyId: string, returnId: string, actorId?: string): Promise<PurchReturnHeader> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!returnId || typeof returnId !== 'string') {
      throw new ValidationError('returnId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const locked = await this.returnRepo.findByIdForUpdate(companyId, returnId, tx);
      if (!locked) {
        throw new NotFoundError('مرتجع المشتريات غير موجود');
      }
      if (locked.status === 'posted') {
        throw new ValidationError('مرتجع المشتريات مرحل مسبقاً');
      }
      if (locked.status === 'cancelled') {
        throw new ValidationError('لا يمكن ترحيل مرتجع ملغى');
      }

      const ret = await this.returnRepo.findById(companyId, returnId, tx);
      if (!ret || !ret.lines || ret.lines.length === 0) {
        throw new ValidationError('مرتجع المشتريات لا يحتوي على بنود لترحيلها');
      }

      if (ret.invoiceId) {
        const invRes = await tx.query<any>(
          `SELECT id, status, supplier_id FROM purch_supplier_invoices WHERE company_id = $1 AND id = $2`,
          [companyId, ret.invoiceId]
        );
        if (invRes.rows.length === 0) {
          throw new ValidationError('فاتورة المورد المرتبطة بالمرتجع غير موجودة');
        }
        if (invRes.rows[0].status !== 'posted' || invRes.rows[0].supplier_id !== ret.supplierId) {
          throw new ValidationError('فاتورة المورد المرتبطة بالمرتجع غير مرحلة أو لا تتبع نفس المورد');
        }
      }

      const whRes = await tx.query<any>(`SELECT id, is_active FROM inv_warehouses WHERE company_id = $1 AND id = $2 FOR UPDATE`, [
        companyId,
        ret.warehouseId,
      ]);
      if (whRes.rows.length === 0 || !whRes.rows[0].is_active) {
        throw new ValidationError('المستودع المحدد غير موجود أو غير نشط');
      }

      let totalAmount = 0;
      const grnLineIds = ret.lines.map((l) => l.grnLineId).sort();

      const grnLinesRes = await tx.query<any>(
        `SELECT id, grn_id as "grnId", qty::text FROM purch_grn_lines WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id ASC FOR UPDATE`,
        [companyId, grnLineIds]
      );
      const grnLineMap = new Map<string, { grnId: string; qty: number }>();
      for (const gl of grnLinesRes.rows) {
        grnLineMap.set(gl.id, { grnId: gl.grnId, qty: toDecimal(gl.qty, 4) });
      }

      for (const line of ret.lines) {
        const glInfo = grnLineMap.get(line.grnLineId);
        if (!glInfo || glInfo.grnId !== ret.grnId) {
          throw new ValidationError('أحد بنود سند الاستلام المرتبطة بالمرتجع غير موجود أو لا يتبع سند الاستلام');
        }
        const gQty = glInfo.qty;

        const prevRetRes = await tx.query<any>(
          `SELECT COALESCE(SUM(prl.qty), 0)::text as total
           FROM purch_return_lines prl
           INNER JOIN purch_returns pr ON pr.id = prl.return_id AND pr.company_id = prl.company_id
           WHERE prl.company_id = $1 AND prl.grn_line_id = $2 AND pr.status = 'posted' AND pr.id <> $3`,
          [companyId, line.grnLineId, ret.id]
        );
        const alreadyReturned = toDecimal(prevRetRes.rows[0]?.total || '0', 4);
        if (toMinorUnits(alreadyReturned, 4) + toMinorUnits(line.qty, 4) > toMinorUnits(gQty, 4)) {
          throw new ValidationError(
            `كمية المرتجع للبند تتجاوز الكمية المتبقية القابلة للإرجاع من سند الاستلام`
          );
        }

        totalAmount += toDecimal(line.qty, 4) * toDecimal(line.unitCost, 4);

        const updatedBalance = await this.stockRepo.decrementBalance(companyId, ret.warehouseId, line.itemId, line.qty, tx);
        if (!updatedBalance) {
          throw new ValidationError('رصيد المخزون المتاح في المستودع غير كافٍ لإتمام مرتجع المشتريات');
        }
        await this.stockRepo.createMovement(
          companyId,
          ret.warehouseId,
          line.itemId,
          'purchase_return',
          -line.qty,
          `مرتجع مشتريات رقم ${ret.returnNo || ret.id.slice(0, 8)}`,
          actorId,
          undefined,
          tx
        );
      }

      totalAmount = toMoney(totalAmount);
      if (!(totalAmount > 0)) {
        throw new ValidationError('قيمة المرتجع الإجمالية يجب أن تكون أكبر من الصفر');
      }

      const glAccounts = await this.resolveGlMapping(companyId, tx);

      const entryDate = ISO_DATE.test(ret.returnDate) ? ret.returnDate : new Date().toISOString().slice(0, 10);
      const returnNo = await this.journalRepo.allocateSequenceNumber(companyId, 'purchase_return', 'PRTN', tx);

      const liabilityAccountId = ret.invoiceId
        ? glAccounts.accountsPayableAccountId
        : glAccounts.purchasesClearingAccountId;

      const draftJe = await this.journalService.createDraftEntry(
        companyId,
        {
          entryDate,
          memo: `ترحيل مرتجع مشتريات رقم ${returnNo} (مورد: ${ret.supplierNameAr || ret.supplierId})`,
          lines: [
            {
              accountId: liabilityAccountId,
              debit: totalAmount,
              credit: 0,
              lineMemo: `تخفيض المديونية / التسوية للمورد مرتجع ${returnNo}`,
            },
            {
              accountId: glAccounts.inventoryAccountId,
              debit: 0,
              credit: totalAmount,
              lineMemo: `إخراج المخزون مقابل مرتجع مشتريات ${returnNo}`,
            },
          ],
        },
        actorId || '',
        false,
        tx
      );

      const postedJe = await this.journalService.postEntry(companyId, draftJe.id, actorId || '', false, tx);

      await this.returnRepo.markPosted(companyId, returnId, returnNo, postedJe.id, actorId || '', tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'PURCHASE_RETURN_POST',
          entityType: 'purch_returns',
          entityId: returnId,
          metadata: {
            returnNo,
            totalAmount,
            journalEntryId: postedJe.id,
          },
        },
        { executor: tx }
      );

      const updated = await this.returnRepo.findById(companyId, returnId, tx);
      return updated!;
    });
  }

  async deleteReturn(companyId: string, returnId: string, actorId?: string): Promise<void> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!returnId || typeof returnId !== 'string') {
      throw new ValidationError('returnId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const locked = await this.returnRepo.findByIdForUpdate(companyId, returnId, tx);
      if (!locked) {
        throw new NotFoundError('مرتجع المشتريات غير موجود');
      }
      if (locked.status === 'posted') {
        throw new ValidationError('لا يمكن حذف مرتجع مشتريات مرحل');
      }

      await this.returnRepo.deleteDraft(companyId, returnId, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'PURCHASE_RETURN_DELETE',
          entityType: 'purch_returns',
          entityId: returnId,
          metadata: {},
        },
        { executor: tx }
      );
    });
  }
}

export const defaultPurchReturnService = new PurchReturnService();
