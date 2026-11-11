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
      if (typeof input.inventoryAccountId === 'string') {
        const account = await defaultAccountRepository.findById(companyId, input.inventoryAccountId, tx);
        if (!account) throw new ValidationError('Invalid inventory account');
      }
      if (typeof input.purchasesClearingAccountId === 'string') {
        const account = await defaultAccountRepository.findById(companyId, input.purchasesClearingAccountId, tx);
        if (!account) throw new ValidationError('Invalid purchases clearing account');
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
