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
  inventoryAdjustmentAccountId?: string | null;
  openingBalanceEquityAccountId?: string | null;
  enforceCustodySeparation?: boolean;
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
  inventoryAdjustmentAccountId?: string | null;
  openingBalanceEquityAccountId?: string | null;
  enforceCustodySeparation?: boolean;
}
