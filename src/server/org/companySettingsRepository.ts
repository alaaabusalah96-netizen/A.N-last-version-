import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { CompanySettings, UpsertCompanySettingsInput } from './companySettingsTypes.js';

export class CompanySettingsRepository {

  async getByCompanyId(companyId: string, customExecutor?: DbExecutor): Promise<CompanySettings | null> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        SELECT 
          company_id as "companyId",
          default_currency_code as "defaultCurrencyCode",
          timezone,
          fiscal_year_start_month as "fiscalYearStartMonth",
          fiscal_year_start_day as "fiscalYearStartDay",
          display_name_finance as "displayNameFinance",
          locale,
          inventory_account_id as "inventoryAccountId",
          purchases_clearing_account_id as "purchasesClearingAccountId",
          custody_receivable_account_id as "custodyReceivableAccountId",
          accounts_payable_account_id as "accountsPayableAccountId",
          updated_at as "updatedAt",
          updated_by as "updatedBy"
        FROM company_settings
        WHERE company_id = $1;
      `;
      const res = await executor.query<CompanySettings>(sql, [companyId]);
      return res.rows[0] || null;
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, async (executor) => await run(executor));
  }

  async upsert(companyId: string, input: UpsertCompanySettingsInput, actorId: string, customExecutor?: DbExecutor): Promise<CompanySettings> {
    const run = async (executor: DbExecutor) => {
      const sql = `
        INSERT INTO company_settings (
          company_id, 
          default_currency_code, 
          timezone, 
          fiscal_year_start_month, 
          fiscal_year_start_day, 
          display_name_finance, 
          locale, 
          inventory_account_id,
          purchases_clearing_account_id,
          custody_receivable_account_id,
          accounts_payable_account_id,
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
          $9,
          $10,
          $13,
          $15,
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
          inventory_account_id = CASE WHEN $11 THEN EXCLUDED.inventory_account_id ELSE company_settings.inventory_account_id END,
          purchases_clearing_account_id = CASE WHEN $12 THEN EXCLUDED.purchases_clearing_account_id ELSE company_settings.purchases_clearing_account_id END,
          custody_receivable_account_id = CASE WHEN $14 THEN EXCLUDED.custody_receivable_account_id ELSE company_settings.custody_receivable_account_id END,
          accounts_payable_account_id = CASE WHEN $16 THEN EXCLUDED.accounts_payable_account_id ELSE company_settings.accounts_payable_account_id END,
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
          inventory_account_id as "inventoryAccountId",
          purchases_clearing_account_id as "purchasesClearingAccountId",
          custody_receivable_account_id as "custodyReceivableAccountId",
          accounts_payable_account_id as "accountsPayableAccountId",
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
        actorId,
        input.inventoryAccountId === undefined ? null : input.inventoryAccountId,
        input.purchasesClearingAccountId === undefined ? null : input.purchasesClearingAccountId,
        input.inventoryAccountId !== undefined,
        input.purchasesClearingAccountId !== undefined,
        input.custodyReceivableAccountId === undefined ? null : input.custodyReceivableAccountId,
        input.custodyReceivableAccountId !== undefined,
        input.accountsPayableAccountId === undefined ? null : input.accountsPayableAccountId,
        input.accountsPayableAccountId !== undefined,
      ]);

      return res.rows[0];
    };

    if (customExecutor) return run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultCompanySettingsRepository = new CompanySettingsRepository();
