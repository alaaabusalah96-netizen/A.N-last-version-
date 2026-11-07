import { defaultCompanySettingsRepository, CompanySettingsRepository } from './companySettingsRepository.js';
import { CompanySettings, UpsertCompanySettingsInput } from './companySettingsTypes.js';
import { defaultAuditService } from '../audit/auditService.js';
import { ValidationError } from '../http/errors.js';

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
    // Basic validation
    if (input.fiscalYearStartMonth !== undefined && (input.fiscalYearStartMonth < 1 || input.fiscalYearStartMonth > 12)) {
      throw new ValidationError('Month must be between 1 and 12');
    }
    if (input.fiscalYearStartDay !== undefined && (input.fiscalYearStartDay < 1 || input.fiscalYearStartDay > 28)) {
      throw new ValidationError('Day must be between 1 and 28');
    }

    const settings = await this.repo.upsert(companyId, input, actorId);

    await defaultAuditService.record({
      actorUserId: actorId,
      companyId,
      action: 'COMPANY_SETTINGS_UPDATE',
      entityType: 'company_settings',
      entityId: companyId,
      metadata: { patch: input }
    });

    return settings;
  }
}

export const defaultCompanySettingsService = new CompanySettingsService();
