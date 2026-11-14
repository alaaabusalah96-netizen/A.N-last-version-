export interface CompanySettings {
  companyId: string;
  defaultCurrencyCode: string;
  timezone: string;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
  displayNameFinance?: string | null;
  locale?: string | null;
  inventoryAccountId?: string | null;
  purchasesClearingAccountId?: string | null;
  custodyReceivableAccountId?: string | null;
  accountsPayableAccountId?: string | null;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface UpsertCompanySettingsInput {
  defaultCurrencyCode?: string;
  timezone?: string;
  fiscalYearStartMonth?: number;
  fiscalYearStartDay?: number;
  displayNameFinance?: string | null;
  locale?: string | null;
  inventoryAccountId?: string | null;
  purchasesClearingAccountId?: string | null;
  custodyReceivableAccountId?: string | null;
  accountsPayableAccountId?: string | null;
}
