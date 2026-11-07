export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface Account {
  id: string;
  companyId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  accountType: AccountType;
  parentId: string | null;
  isPostable: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAccountInput {
  companyId: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  accountType: AccountType;
  parentId?: string | null;
  isPostable?: boolean;
}
