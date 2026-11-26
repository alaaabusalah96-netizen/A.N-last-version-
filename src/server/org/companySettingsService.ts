import { withTenantTransaction } from '../db/transactionManager.js';
import { defaultCompanySettingsRepository, CompanySettingsRepository } from './companySettingsRepository.js';
import { UpsertCompanySettingsInput } from './companySettingsTypes.js';
import { defaultAuditService } from '../audit/auditService.js';
import { ValidationError } from '../http/errors.js';
import { defaultAccountRepository } from '../accounting/accountRepository.js';
import { CompanySettings } from './companySettingsTypes.js';

export class CompanySettingsService {
  constructor(private repo: CompanySettingsRepository = defaultCompanySettingsRepository) {}

  async getSettings(companyId: string): Promise<CompanySettings> {
    const settings = await this.repo.getByCompanyId(companyId);
    if (!settings) {
      // Return defaults if not found (fail-safe for new companies or existing without settings row)
      return {
        companyId,
        defaultCurrencyCode: 'EGP',
        timezone: 'Africa/Cairo',
        fiscalYearStartMonth: 1,
        fiscalYearStartDay: 1,
        displayNameFinance: null,
        locale: 'ar-EG',
        updatedAt: new Date().toISOString()
      };
    }
    return settings;
  }

  async upsertSettings(actorId: string, companyId: string, input: UpsertCompanySettingsInput): Promise<CompanySettings> {
    return await withTenantTransaction(companyId, async (tx) => {
      // Basic validation
      if (input.fiscalYearStartMonth !== undefined && (input.fiscalYearStartMonth < 1 || input.fiscalYearStartMonth > 12)) {
        throw new ValidationError('Month must be between 1 and 12');
      }
      if (input.fiscalYearStartDay !== undefined && (input.fiscalYearStartDay < 1 || input.fiscalYearStartDay > 28)) {
        throw new ValidationError('Day must be between 1 and 28');
      }

      // Validate accounts belong to company (only if string ID is provided, allow null to skip)
      // Inventory, purchases clearing and payables: must exist, be active, postable and of the right type.
      // (Header accounts such as 1300 / 2200 can never be posted to, so saving them would break posting later.)
      const strictRules: Array<{ key: 'inventoryAccountId' | 'purchasesClearingAccountId' | 'accountsPayableAccountId'; label: string; types: string[] }> = [
        { key: 'inventoryAccountId', label: 'حساب المخزون', types: ['asset'] },
        { key: 'purchasesClearingAccountId', label: 'حساب المشتريات المعلّقة', types: ['liability'] },
        { key: 'accountsPayableAccountId', label: 'حساب الدائنين (الموردون)', types: ['liability'] },
      ];
      for (const rule of strictRules) {
        const id = input[rule.key];
        if (typeof id === 'string' && id.trim() !== '') {
          const account = await defaultAccountRepository.findById(companyId, id, tx);
          if (!account) throw new ValidationError(`${rule.label} غير موجود في دليل الحسابات`);
          if (!account.isActive) throw new ValidationError(`${rule.label} غير نشط`);
          if (!account.isPostable) throw new ValidationError(`${rule.label} يجب أن يكون حساباً فرعياً قابلاً للترحيل (الحساب ${account.code} حساب رئيسي)`);
          if (!rule.types.includes(account.accountType)) {
            throw new ValidationError(`${rule.label} يجب أن يكون من نوع ${rule.types.join('/')} وليس ${account.accountType}`);
          }
        }
      }

      if (typeof input.custodyReceivableAccountId === 'string' && input.custodyReceivableAccountId.trim() !== '') {
        const account = await defaultAccountRepository.findById(companyId, input.custodyReceivableAccountId, tx);
        if (!account) {
          throw new ValidationError('حساب ذمة عهد الموظفين غير موجود في دليل الحسابات');
        }
        if (!account.isActive) {
          throw new ValidationError('حساب ذمة عهد الموظفين غير نشط');
        }
        if (!account.isPostable) {
          throw new ValidationError('حساب ذمة عهد الموظفين يجب أن يكون حساباً فرعياً قابلاً للترحيل');
        }
        if (account.accountType !== 'asset') {
          throw new ValidationError('حساب ذمة عهد الموظفين يجب أن يكون من نوع الأصول (asset)');
        }
      }

      if (typeof input.inventoryAdjustmentAccountId === 'string' && input.inventoryAdjustmentAccountId.trim() !== '') {
        const account = await defaultAccountRepository.findById(companyId, input.inventoryAdjustmentAccountId, tx);
        if (!account) throw new ValidationError('حساب تسويات المخزون غير موجود في دليل الحسابات');
        if (!account.isActive) throw new ValidationError('حساب تسويات المخزون غير نشط');
        if (!account.isPostable) throw new ValidationError('حساب تسويات المخزون يجب أن يكون حساباً فرعياً قابلاً للترحيل');
      }

      if (typeof input.openingBalanceEquityAccountId === 'string' && input.openingBalanceEquityAccountId.trim() !== '') {
        const account = await defaultAccountRepository.findById(companyId, input.openingBalanceEquityAccountId, tx);
        if (!account) throw new ValidationError('حساب رصيد أول المدة غير موجود في دليل الحسابات');
        if (!account.isActive) throw new ValidationError('حساب رصيد أول المدة غير نشط');
        if (!account.isPostable) throw new ValidationError('حساب رصيد أول المدة يجب أن يكون حساباً فرعياً قابلاً للترحيل');
      }

      const settings = await this.repo.upsert(companyId, input, actorId, tx);

      await defaultAuditService.record({
        actorUserId: actorId,
        companyId,
        action: 'COMPANY_SETTINGS_UPDATE',
        entityType: 'company_settings',
        entityId: companyId,
        metadata: { patch: input }
      }, { executor: tx });

      return settings;
    });
  }
}

export const defaultCompanySettingsService = new CompanySettingsService();
