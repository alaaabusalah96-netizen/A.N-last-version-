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
import { findRoleRule, GRN_MAPPING_KEY } from '../config-platform/configAccountRoles.js';
import { DbExecutor } from '../db/types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class GrnService {
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
  ) {}

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

      for (const line of input.lines) {
        if (!line.itemId || typeof line.itemId !== 'string') {
          throw new ValidationError('كافة بنود السند تتطلب صنفاً محدداً');
        }
        if (typeof line.qty !== 'number' || isNaN(line.qty) || line.qty <= 0) {
          throw new ValidationError('كمية البند يجب أن تكون عدداً أكبر من الصفر');
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

      await this.auditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'GRN_CREATE_DRAFT',
        entityType: 'purch_grn',
        entityId: grn.id,
        metadata: { supplierId: input.supplierId, warehouseId: input.warehouseId, lineCount: input.lines.length },
      }, { executor: tx });

      return grn;
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

  /**
   * مصدر حسابات الترحيل: منصة الإعدادات أولاً (accounting.grn_mapping)،
   * ثم إعدادات الشركة القديمة كـfallback متوافق.
   * لا يوجد أي مسار بيفشل بصمت: لو الاتنين فاضيين -> ValidationError.
   */
  private async resolveGlMapping(
    companyId: string
  ): Promise<{
    inventoryAccountId: string;
    purchasesClearingAccountId: string;
    source: 'config_platform' | 'company_settings';
  }> {
    try {
      const resolved = await this.configService.resolveConfig(companyId, 'accounting.grn_mapping');
      const c = (resolved && resolved.content) ? resolved.content as Record<string, unknown> : {};
      const inv = typeof c.inventory_account_id === 'string' ? c.inventory_account_id.trim() : '';
      const clr = typeof c.purchases_clearing_account_id === 'string' ? c.purchases_clearing_account_id.trim() : '';
      if (inv !== '' && clr !== '') {
        return {
          inventoryAccountId: inv,
          purchasesClearingAccountId: clr,
          source: 'config_platform',
        };
      }
    } catch (err) {
      // تعريف مفقود أو محتوى غير متاح = السبب المتوقع للـfallback المتوافق.
      // أي خطأ تاني (عطل قاعدة/صلاحيات) لازم يظهر، مش يتحوّل بصمت.
      if (!(err instanceof NotFoundError) && !(err instanceof Error && /not found|غير موجود/i.test(err.message))) {
        throw err;
      }
    }

    const settings = await this.settingsRepo.getByCompanyId(companyId);
    const gl = this.requireGlAccounts(settings);
    return { ...gl, source: 'company_settings' };
  }

  /**
   * قيد محاسبي على مسار الترحيل نفسه، مش على مسار النشر بس.
   * بيشتغل مهما كان مصدر الحسابات (منصة الإعدادات أو إعدادات الشركة القديمة)،
   * عشان أي إعداد اتحفظ قبل التشديد ما يعديش في الترحيل.
   * لازم يتنفّذ **قبل** أي كتابة على المخزون.
   */
  private async assertGlAccountsUsable(
    companyId: string,
    gl: { inventoryAccountId: string; purchasesClearingAccountId: string },
    tx: DbExecutor
  ): Promise<void> {
    const targets: Array<{ field: string; accountId: string }> = [
      { field: 'inventory_account_id', accountId: gl.inventoryAccountId },
      { field: 'purchases_clearing_account_id', accountId: gl.purchasesClearingAccountId },
    ];

    for (const target of targets) {
      const account = await this.accountRepo.findById(companyId, target.accountId, tx);
      if (!account) {
        throw new ValidationError(
          `لا يمكن الترحيل: الحقل ${target.field} بيشير لحساب غير موجود في دليل الشركة (id=${target.accountId})`
        );
      }
      if (!account.isActive) {
        throw new ValidationError(`لا يمكن الترحيل: الحساب ${account.code} (${account.nameAr}) غير نشط`);
      }

      const rule = findRoleRule(GRN_MAPPING_KEY, target.field);
      if (!rule) continue;

      if (rule.requirePostable && !account.isPostable) {
        throw new ValidationError(
          `لا يمكن الترحيل: ${rule.labelAr} (${account.code}) حساب رئيسي/تجميعي وغير قابل للترحيل`
        );
      }
      if (!rule.allowedTypes.includes(account.accountType)) {
        throw new ValidationError(
          `لا يمكن الترحيل: ${rule.labelAr} (${account.code}) نوعه ${account.accountType} `
          + `ولازم يكون من نوع (${rule.allowedTypes.join(' / ')})`
        );
      }
    }
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
        },
      }, { executor: tx });

      const updatedGrn = await this.grnRepo.findById(companyId, grnId, tx);
      return updatedGrn!;
    });
  }

}

export const defaultGrnService = new GrnService();

