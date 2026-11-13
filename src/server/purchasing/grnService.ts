import { defaultGrnRepository, GrnRepository } from './grnRepository.js';
import { defaultSupplierRepository, SupplierRepository } from './supplierRepository.js';
import { defaultWarehouseRepository, WarehouseRepository } from '../inventory/warehouseRepository.js';
import { defaultItemRepository, ItemRepository } from '../inventory/itemRepository.js';
import { defaultStockRepository, StockRepository } from '../inventory/stockRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { defaultJournalRepository, JournalRepository } from '../accounting/journalRepository.js';
import { defaultJournalService } from '../accounting/journalService.js';
import { defaultCompanySettingsRepository, CompanySettingsRepository } from '../org/companySettingsRepository.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { GrnHeader, CreateGrnInput } from './purchasingTypes.js';
import { toDecimal, toMoney } from '../lib/numeric.js';
import { CompanySettings } from '../org/companySettingsTypes.js';
import { defaultConfigService, ConfigService } from '../config-platform/configService.js';
import { defaultAccountRepository, AccountRepository } from '../accounting/accountRepository.js';
import { findGlEvent } from '../accounting/glEventCatalog.js';
import { GlMappingService } from '../accounting/glMappingService.js';
import { DbExecutor } from '../db/types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class GrnService {
  private glMappingService: GlMappingService;

  constructor(
    private grnRepo: GrnRepository = defaultGrnRepository,
    private supplierRepo: SupplierRepository = defaultSupplierRepository,
    private warehouseRepo: WarehouseRepository = defaultWarehouseRepository,
    private itemRepo: ItemRepository = defaultItemRepository,
    private stockRepo: StockRepository = defaultStockRepository,
    private auditService: AuditService = defaultAuditService,
    private journalRepo: JournalRepository = defaultJournalRepository,
    private settingsRepo: CompanySettingsRepository = defaultCompanySettingsRepository,
    private configService: Pick<ConfigService, 'resolveConfig'> = defaultConfigService,
    private accountRepo: AccountRepository = defaultAccountRepository
  ) {
    this.glMappingService = new GlMappingService(this.configService, this.accountRepo);
  }

  async listGrns(companyId: string): Promise<GrnHeader[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.grnRepo.listByCompany(companyId);
  }

  async getGrn(companyId: string, grnId: string): Promise<GrnHeader> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!grnId || typeof grnId !== 'string') {
      throw new ValidationError('grnId is required');
    }
    const grn = await this.grnRepo.findById(companyId, grnId);
    if (!grn) {
      throw new NotFoundError('سند استلام البضائع (GRN) غير موجود');
    }
    return grn;
  }

  async createGrn(
    companyId: string,
    input: CreateGrnInput,
    actorId?: string
  ): Promise<GrnHeader> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    if (!input.supplierId || typeof input.supplierId !== 'string') {
      throw new ValidationError('المورد مطلوب');
    }

    if (!input.warehouseId || typeof input.warehouseId !== 'string') {
      throw new ValidationError('مستودع الاستلام مطلوب');
    }

    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new ValidationError('يجب إضافة صنف واحد على الأقل في سند الاستلام');
    }

    const extendedInput = input as any;
    const poId = extendedInput.poId && typeof extendedInput.poId === 'string' ? extendedInput.poId.trim() : null;

    return await withTenantTransaction(companyId, async (tx) => {
      const supplier = await this.supplierRepo.findById(companyId, input.supplierId, tx);
      if (!supplier) {
        throw new NotFoundError('المورد المحدد غير موجود');
      }
      if (!supplier.isActive) {
        throw new ValidationError('المورد المحدد غير نشط');
      }

      const warehouse = await this.warehouseRepo.findById(companyId, input.warehouseId, tx);
      if (!warehouse) {
        throw new NotFoundError('المستودع المحدد غير موجود');
      }
      if (!warehouse.isActive) {
        throw new ValidationError('المستودع المحدد غير نشط');
      }

      if (poId) {
        const poCheck = await tx.query<{ id: string; status: string; supplierId: string }>(
          `SELECT id, status, supplier_id as "supplierId" FROM purch_purchase_orders WHERE id = $1 AND company_id = $2`,
          [poId, companyId]
        );
        const po = poCheck.rows[0];
        if (!po) {
          throw new NotFoundError('أمر الشراء المرتبط غير موجود');
        }
        if (po.status !== 'approved') {
          throw new ValidationError('لا يمكن إنشاء سند استلام من أمر شراء غير معتمد');
        }
        if (po.supplierId !== input.supplierId) {
          throw new ValidationError('المورد في سند الاستلام لا يطابق مورد أمر الشراء');
        }
      }

      for (const line of input.lines) {
        const lineExt = line as any;
        if (!line.itemId || typeof line.itemId !== 'string') {
          throw new ValidationError('كافة بنود السند تتطلب صنفاً محدداً');
        }
        if (typeof line.qty !== 'number' || isNaN(line.qty) || line.qty <= 0) {
          throw new ValidationError('كمية البند يجب أن تكون عدداً أكبر من الصفر');
        }
        if (poId && (!lineExt.poLineId || typeof lineExt.poLineId !== 'string')) {
          throw new ValidationError('كافة بنود سند الاستلام المرتبط بأمر شراء تتطلب تحديد بند أمر الشراء (poLineId)');
        }
        if (poId && lineExt.poLineId) {
          const poLineQuery = await tx.query<{ poId: string; itemId: string }>(
            `SELECT po_id as "poId", item_id as "itemId" FROM purch_po_lines WHERE id = $1 AND company_id = $2`,
            [lineExt.poLineId, companyId]
          );
          const poLine = poLineQuery.rows[0];
          if (!poLine) {
            throw new ValidationError('بند أمر الشراء المختار غير موجود');
          }
          if (poLine.poId !== poId) {
            throw new ValidationError('بند أمر الشراء لا يتبع أمر الشراء المحدد في السند (خطأ ربط عرضي)');
          }
          if (poLine.itemId !== line.itemId) {
            throw new ValidationError('الصنف في بند سند الاستلام لا يطابق الصنف في بند أمر الشراء');
          }
        }
        if (line.unitCost !== undefined && line.unitCost !== null) {
          const rawCost = typeof line.unitCost === 'number' ? line.unitCost : Number(line.unitCost);
          if (!Number.isFinite(rawCost)) {
            throw new ValidationError('تكلفة الوحدة في البند يجب أن تكون رقماً صالحاً');
          }
          if (toDecimal(line.unitCost, 4) < 0) {
            throw new ValidationError('تكلفة الوحدة في البند لا يمكن أن تكون بالسالب');
          }
        }
        const item = await this.itemRepo.findById(companyId, line.itemId, tx);
        if (!item) {
          throw new NotFoundError('أحد الأصناف المحددة في البنود غير موجود');
        }
        if (!item.isActive) {
          throw new ValidationError(`الصنف (${item.code} - ${item.nameAr}) غير نشط`);
        }
      }

      const grn = await this.grnRepo.createDraft(companyId, input, actorId, tx);

      if (poId) {
        await tx.query(
          `UPDATE purch_grn SET po_id = $1 WHERE id = $2 AND company_id = $3`,
          [poId, grn.id, companyId]
        );
        for (let i = 0; i < input.lines.length; i++) {
          const lExt = input.lines[i] as any;
          if (lExt.poLineId && grn.lines && grn.lines[i]) {
            await tx.query(
              `UPDATE purch_grn_lines SET po_line_id = $1 WHERE id = $2 AND company_id = $3`,
              [lExt.poLineId, grn.lines[i].id, companyId]
            );
          }
        }
      }

      await this.auditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'GRN_CREATE_DRAFT',
        entityType: 'purch_grn',
        entityId: grn.id,
        metadata: { supplierId: input.supplierId, warehouseId: input.warehouseId, lineCount: input.lines.length, poId: poId || null },
      }, { executor: tx });

      const finalGrn = await this.grnRepo.findById(companyId, grn.id, tx);
      return finalGrn || grn;
    });
  }

  private resolveEntryDate(grn: GrnHeader): string {
    const candidate = typeof grn.createdAt === 'string' ? grn.createdAt.slice(0, 10) : '';
    if (ISO_DATE.test(candidate)) return candidate;
    return new Date().toISOString().slice(0, 10);
  }

  private requireGlAccounts(settings: CompanySettings | null): {
    inventoryAccountId: string;
    purchasesClearingAccountId: string;
  } {
    if (!settings || !settings.inventoryAccountId || !settings.purchasesClearingAccountId) {
      throw new ValidationError(
        'لا يمكن ترحيل سند الاستلام محاسبياً قبل ضبط "حساب المخزون" و"حساب المشتريات المعلّقة" في إعدادات الشركة (الإعدادات ← الحسابات المحاسبية).'
      );
    }
    return {
      inventoryAccountId: settings.inventoryAccountId,
      purchasesClearingAccountId: settings.purchasesClearingAccountId,
    };
  }

  private async resolveGlMapping(
    companyId: string
  ): Promise<{
    inventoryAccountId: string;
    purchasesClearingAccountId: string;
    source: 'config_platform' | 'company_settings';
    versionNo: number | null;
  }> {
    try {
      const resolved = await this.glMappingService.resolve(companyId, 'accounting.grn_mapping');
      const inv = (resolved.accounts.inventory_account_id || '').trim();
      const clr = (resolved.accounts.purchases_clearing_account_id || '').trim();
      if (inv !== '' && clr !== '') {
        return {
          inventoryAccountId: inv,
          purchasesClearingAccountId: clr,
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
    gl: { inventoryAccountId: string; purchasesClearingAccountId: string },
    tx: DbExecutor
  ): Promise<void> {
    const def = findGlEvent('accounting.grn_mapping');
    if (!def) {
      throw new ValidationError('تعريف حدث الربط المحاسبي accounting.grn_mapping مفقود من الكتالوج');
    }
    await this.glMappingService.assertUsable(
      companyId,
      def,
      {
        inventory_account_id: gl.inventoryAccountId,
        purchases_clearing_account_id: gl.purchasesClearingAccountId,
      },
      tx
    );
  }

  /**
   * Confirm & Post Goods Receipt Note (ترحيل سند استلام البضائع إلى المخزون)
   * Atomic stock increase across all GRN lines in a single tenant transaction.
   */
  async postGrn(companyId: string, grnId: string, actorId?: string): Promise<GrnHeader> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    if (!grnId || typeof grnId !== 'string') {
      throw new ValidationError('grnId is required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      // 1. Lock GRN row for update
      const grnLock = await this.grnRepo.findByIdForUpdate(companyId, grnId, tx);
      if (!grnLock) {
        throw new NotFoundError('سند استلام البضائع غير موجود');
      }

      if (grnLock.status === 'posted') {
        throw new ValidationError('سند استلام البضائع مرحل مسبقاً ولا يمكن تكرار ترحيله');
      }

      // 2. Fetch full GRN header + lines
      const grn = await this.grnRepo.findById(companyId, grnId, tx);
      if (!grn || !grn.lines || grn.lines.length === 0) {
        throw new ValidationError('سند استلام البضائع لا يحتوي على بنود لترحيلها');
      }

      const warehouse = await this.warehouseRepo.findById(companyId, grn.warehouseId, tx);
      if (!warehouse || !warehouse.isActive) {
        throw new ValidationError('مستودع الاستلام غير موجود أو غير نشط');
      }

      // Check if GRN is linked to a Purchase Order
      const poQuery = await tx.query<{ poId: string | null }>(
        `SELECT po_id as "poId" FROM purch_grn WHERE id = $1 AND company_id = $2`,
        [grnId, companyId]
      );
      const poId = poQuery.rows[0]?.poId || null;

      if (poId) {
        const poCheck = await tx.query<{ status: string; supplierId: string }>(
          `SELECT status, supplier_id as "supplierId" FROM purch_purchase_orders WHERE id = $1 AND company_id = $2`,
          [poId, companyId]
        );
        const po = poCheck.rows[0];
        if (!po || po.status !== 'approved') {
          throw new ValidationError('أمر الشراء المرتبط غير موجود أو ليس في حالة معتمد');
        }
        if (po.supplierId !== grn.supplierId) {
          throw new ValidationError('المورد في سند الاستلام لا يطابق المورد في أمر الشراء');
        }

        // Verify and atomically increment received_qty on PO lines
        for (const line of grn.lines) {
          const lExt = line as any;
          const poLineId = lExt.poLineId;
          if (!poLineId) {
            // Fallback fetch from purch_grn_lines table if not on line object
            const lineDb = await tx.query<{ poLineId: string | null }>(
              `SELECT po_line_id as "poLineId" FROM purch_grn_lines WHERE id = $1 AND company_id = $2`,
              [line.id, companyId]
            );
            const resolvedPoLineId = lineDb.rows[0]?.poLineId;
            if (!resolvedPoLineId) {
              throw new ValidationError('بند سند الاستلام غير مربوط ببند أمر شراء صالح');
            }
            lExt.poLineId = resolvedPoLineId;
          }

          const updatePoLineRes = await tx.query(
            `UPDATE purch_po_lines
             SET received_qty = received_qty + $1
             WHERE id = $2 AND company_id = $3 AND received_qty + $1 <= qty`,
            [line.qty, lExt.poLineId, companyId]
          );

          if ((updatePoLineRes.rowCount ?? 0) === 0) {
            throw new ValidationError('تجاوز الكمية المستلمة الكمية المطلوبة في أمر الشراء للبند المحدد');
          }
        }
      }

      // READ-ONLY validation — no stock/GL writes yet
      for (const line of grn.lines) {
        const item = await this.itemRepo.findById(companyId, line.itemId, tx);
        if (!item || !item.isActive) {
          throw new ValidationError(`الصنف بـ ID (${line.itemId}) غير موجود أو غير نشط`);
        }
      }

      const gl = await this.resolveGlMapping(companyId);

      // فحص تكلفة كل بند منفرداً — الإجمالي الموجب لا يكفي
      for (const line of grn.lines) {
        const lineCost = toDecimal(line.unitCost ?? 0, 4);
        if (!(lineCost > 0)) {
          throw new ValidationError(
            `البند رقم ${line.lineNo}: تكلفة الوحدة يجب أن تكون أكبر من صفر قبل الترحيل المحاسبي.`
          );
        }
      }

      let totalAmount = 0;
      for (const line of grn.lines) {
        totalAmount += toDecimal(line.qty) * toDecimal(line.unitCost || 0);
      }
      totalAmount = toMoney(totalAmount);
      if (!(totalAmount > 0)) {
        throw new ValidationError(
          'لا يمكن الترحيل المحاسبي: إجمالي قيمة السند صفر. يجب إدخال تكلفة وحدة أكبر من صفر لكل بند قبل الترحيل.'
        );
      }

      await this.assertGlAccountsUsable(companyId, gl, tx);

      const entryDate = this.resolveEntryDate(grn);
      const grnNo = await this.journalRepo.allocateSequenceNumber(companyId, 'goods_receipt', 'GRN', tx);

      // WRITE phase — stock then GL (same tx)
      for (const line of grn.lines) {
        await this.stockRepo.incrementBalance(companyId, grn.warehouseId, line.itemId, toDecimal(line.qty), tx);
        await this.stockRepo.createMovement(
          companyId, grn.warehouseId, line.itemId, 'receive', toDecimal(line.qty),
          `استلام مشتريات (سند رقم ${grnNo})`, actorId, undefined, tx
        );
      }

      const journalEntry = await defaultJournalService.createDraftEntry(
        companyId,
        {
          entryDate,
          memo: `ترحيل سند استلام بضائع رقم ${grnNo}`,
          lines: [
            { accountId: gl.inventoryAccountId, debit: totalAmount, credit: 0, lineMemo: `استلام مخزون سند ${grnNo}` },
            { accountId: gl.purchasesClearingAccountId, debit: 0, credit: totalAmount, lineMemo: `مقابل استلام مخزون سند ${grnNo}` }
          ]
        },
        actorId,
        false,
        tx
      );

      const postedJournal = await defaultJournalService.postEntry(companyId, journalEntry.id, actorId || '', false, tx);
      await this.grnRepo.markPosted(companyId, grnId, grnNo, actorId || '', postedJournal.id, tx);

      // If linked to PO, check if all PO lines are fully received -> auto close PO
      if (poId) {
        const unreceivedRes = await tx.query<{ cnt: number }>(
          `SELECT COUNT(*)::int as cnt FROM purch_po_lines WHERE po_id = $1 AND company_id = $2 AND received_qty < qty`,
          [poId, companyId]
        );
        if ((unreceivedRes.rows[0]?.cnt ?? 0) === 0) {
          await tx.query(
            `UPDATE purch_purchase_orders
             SET status = 'closed', closed_at = NOW(), closed_by = $1
             WHERE id = $2 AND company_id = $3 AND status = 'approved'`,
            [actorId || null, poId, companyId]
          );
        }
      }

      await this.auditService.record({
        actorUserId: actorId || '',
        companyId,
        action: 'GRN_POST',
        entityType: 'purch_grn',
        entityId: grnId,
        metadata: {
          grnNo,
          warehouseId: grn.warehouseId,
          lineCount: grn.lines.length,
          totalAmount,
          entryDate,
          journalEntryId: postedJournal.id,
          glSource: gl.source,
          glEventKey: 'accounting.grn_mapping',
          glVersionNo: gl.versionNo,
          poId: poId || null,
        },
      }, { executor: tx });

      const updatedGrn = await this.grnRepo.findById(companyId, grnId, tx);
      return updatedGrn!;
    });
  }

}

export const defaultGrnService = new GrnService();
