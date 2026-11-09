import { withTenantTransaction } from '../db/transactionManager.js';
import { CompanySettings, UpsertCompanySettingsInput } from './companySettingsTypes.js';

export class CompanySettingsRepository {

  async getByCompanyId(companyId: string): Promise<CompanySettings | null> {
    return await withTenantTransaction(companyId, async (executor) => {
      const sql = `
        SELECT 
          company_id as "companyId",
          default_currency_code as "defaultCurrencyCode",
          timezone,
          fiscal_year_start_month as "fiscalYearStartMonth",
          fiscal_year_start_day as "fiscalYearStartDay",
          display_name_finance as "displayNameFinance",
          locale,
          updated_at as "updatedAt",
          updated_by as "updatedBy"
        FROM company_settings
        WHERE company_id = $1;
      `;
      const res = await executor.query<CompanySettings>(sql, [companyId]);
      return res.rows[0] || null;
    });
  }

  async upsert(companyId: string, input: UpsertCompanySettingsInput, actorId: string): Promise<CompanySettings> {
    return await withTenantTransaction(companyId, async (executor) => {
      const sql = `
        INSERT INTO company_settings (
          company_id, 
          default_currency_code, 
          timezone, 
          fiscal_year_start_month, 
          fiscal_year_start_day, 
          display_name_finance, 
          locale, 
          updated_at, 
          updated_by
        )
        VALUES (
          $1, 
          COALESCE($2, 'EGP'), 
          COALESCE($3, 'Africa/Cairo'), 
          COALESCE($4, 1), 
          COALESCE($5, 1), 
          $6, 
          COALESCE($7, 'ar-EG'), 
          NOW(), 
          $8
        )
        ON CONFLICT (company_id) DO UPDATE SET
          default_currency_code = COALESCE(EXCLUDED.default_currency_code, company_settings.default_currency_code),
          timezone = COALESCE(EXCLUDED.timezone, company_settings.timezone),
          fiscal_year_start_month = COALESCE(EXCLUDED.fiscal_year_start_month, company_settings.fiscal_year_start_month),
          fiscal_year_start_day = COALESCE(EXCLUDED.fiscal_year_start_day, company_settings.fiscal_year_start_day),
          display_name_finance = COALESCE(EXCLUDED.display_name_finance, company_settings.display_name_finance),
          locale = COALESCE(EXCLUDED.locale, company_settings.locale),
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by
        RETURNING 
          company_id as "companyId",
          default_currency_code as "defaultCurrencyCode",
          timezone,
          fiscal_year_start_month as "fiscalYearStartMonth",
          fiscal_year_start_day as "fiscalYearStartDay",
          display_name_finance as "displayNameFinance",
          locale,
          updated_at as "updatedAt",
          updated_by as "updatedBy";
      `;

      const res = await executor.query<CompanySettings>(sql, [
        companyId,
        input.defaultCurrencyCode || null,
        input.timezone || null,
        input.fiscalYearStartMonth || null,
        input.fiscalYearStartDay || null,
        input.displayNameFinance || null,
        input.locale || null,
        actorId
      ]);

      return res.rows[0];
    });
  }
}

export const defaultCompanySettingsRepository = new CompanySettingsRepository();
