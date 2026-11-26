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
          inventory_adjustment_account_id as "inventoryAdjustmentAccountId",
          opening_balance_equity_account_id as "openingBalanceEquityAccountId",
          enforce_custody_separation as "enforceCustodySeparation",
          vat_enabled as "vatEnabled",
          default_vat_rate::float8 as "defaultVatRate",
          prices_include_vat as "pricesIncludeVat",
          vat_input_recoverable as "vatInputRecoverable",
          vat_rounding_mode as "vatRoundingMode",
          vat_payable_account_id as "vatPayableAccountId",
          vat_input_account_id as "vatInputAccountId",
          cogs_account_id as "cogsAccountId",
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
          inventory_adjustment_account_id,
          opening_balance_equity_account_id,
          enforce_custody_separation,
          vat_enabled, default_vat_rate, prices_include_vat, vat_input_recoverable, vat_rounding_mode,
          vat_payable_account_id, vat_input_account_id, cogs_account_id,
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
          $17,
          $19,
          COALESCE($21, TRUE),
          COALESCE($22::boolean, FALSE), COALESCE($23::numeric, 0), COALESCE($24::boolean, FALSE), COALESCE($25::boolean, TRUE), COALESCE($26::text, 'line'),
          $28::uuid, $30::uuid, $32::uuid,
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
          inventory_adjustment_account_id = CASE WHEN $18 THEN EXCLUDED.inventory_adjustment_account_id ELSE company_settings.inventory_adjustment_account_id END,
          opening_balance_equity_account_id = CASE WHEN $20 THEN EXCLUDED.opening_balance_equity_account_id ELSE company_settings.opening_balance_equity_account_id END,
          enforce_custody_separation = CASE WHEN $21::boolean IS NOT NULL THEN EXCLUDED.enforce_custody_separation ELSE company_settings.enforce_custody_separation END,
          vat_enabled = CASE WHEN $22::boolean IS NOT NULL THEN EXCLUDED.vat_enabled ELSE company_settings.vat_enabled END,
          default_vat_rate = CASE WHEN $23::numeric IS NOT NULL THEN EXCLUDED.default_vat_rate ELSE company_settings.default_vat_rate END,
          prices_include_vat = CASE WHEN $24::boolean IS NOT NULL THEN EXCLUDED.prices_include_vat ELSE company_settings.prices_include_vat END,
          vat_input_recoverable = CASE WHEN $25::boolean IS NOT NULL THEN EXCLUDED.vat_input_recoverable ELSE company_settings.vat_input_recoverable END,
          vat_rounding_mode = CASE WHEN $26::text IS NOT NULL THEN EXCLUDED.vat_rounding_mode ELSE company_settings.vat_rounding_mode END,
          vat_payable_account_id = CASE WHEN $27::boolean THEN EXCLUDED.vat_payable_account_id ELSE company_settings.vat_payable_account_id END,
          vat_input_account_id = CASE WHEN $29::boolean THEN EXCLUDED.vat_input_account_id ELSE company_settings.vat_input_account_id END,
          cogs_account_id = CASE WHEN $31::boolean THEN EXCLUDED.cogs_account_id ELSE company_settings.cogs_account_id END,
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
          inventory_adjustment_account_id as "inventoryAdjustmentAccountId",
          opening_balance_equity_account_id as "openingBalanceEquityAccountId",
          enforce_custody_separation as "enforceCustodySeparation",
          vat_enabled as "vatEnabled",
          default_vat_rate::float8 as "defaultVatRate",
          prices_include_vat as "pricesIncludeVat",
          vat_input_recoverable as "vatInputRecoverable",
          vat_rounding_mode as "vatRoundingMode",
          vat_payable_account_id as "vatPayableAccountId",
          vat_input_account_id as "vatInputAccountId",
          cogs_account_id as "cogsAccountId",
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
        input.inventoryAdjustmentAccountId === undefined ? null : input.inventoryAdjustmentAccountId,
        input.inventoryAdjustmentAccountId !== undefined,
        input.openingBalanceEquityAccountId === undefined ? null : input.openingBalanceEquityAccountId,
        input.openingBalanceEquityAccountId !== undefined,
        typeof input.enforceCustodySeparation === 'boolean' ? input.enforceCustodySeparation : null,
        typeof input.vatEnabled === 'boolean' ? input.vatEnabled : null,
        typeof input.defaultVatRate === 'number' ? input.defaultVatRate : null,
        typeof input.pricesIncludeVat === 'boolean' ? input.pricesIncludeVat : null,
        typeof input.vatInputRecoverable === 'boolean' ? input.vatInputRecoverable : null,
        typeof input.vatRoundingMode === 'string' ? input.vatRoundingMode : null,
        input.vatPayableAccountId !== undefined,
        input.vatPayableAccountId === undefined ? null : input.vatPayableAccountId,
        input.vatInputAccountId !== undefined,
        input.vatInputAccountId === undefined ? null : input.vatInputAccountId,
        input.cogsAccountId !== undefined,
        input.cogsAccountId === undefined ? null : input.cogsAccountId,
      ]);

      return res.rows[0];
    };

    if (customExecutor) return run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }
}

export const defaultCompanySettingsRepository = new CompanySettingsRepository();
