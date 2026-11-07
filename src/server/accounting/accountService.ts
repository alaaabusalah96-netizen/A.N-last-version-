import { defaultAccountRepository, AccountRepository } from './accountRepository.js';
import { Account, AccountType, CreateAccountInput } from './accountTypes.js';
import { ConflictError, ValidationError } from '../http/errors.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';

export const DEFAULT_ARABIC_COA: Array<{
  code: string;
  nameAr: string;
  nameEn: string;
  accountType: AccountType;
  isPostable: boolean;
}> = [
  { code: '1000', nameAr: 'الأصول', nameEn: 'Assets', accountType: 'asset', isPostable: false },
  { code: '1100', nameAr: 'النقدية وما في حكمها', nameEn: 'Cash & Cash Equivalents', accountType: 'asset', isPostable: true },
  { code: '1200', nameAr: 'العملاء / الذمم المدينة', nameEn: 'Accounts Receivable', accountType: 'asset', isPostable: true },
  { code: '2000', nameAr: 'الخصوم / الالتزامات', nameEn: 'Liabilities', accountType: 'liability', isPostable: false },
  { code: '2100', nameAr: 'الموردون / الذمم الدائنة', nameEn: 'Accounts Payable', accountType: 'liability', isPostable: true },
  { code: '3000', nameAr: 'حقوق الملكية', nameEn: 'Equity', accountType: 'equity', isPostable: false },
  { code: '3100', nameAr: 'رأس المال', nameEn: 'Capital', accountType: 'equity', isPostable: true },
  { code: '4000', nameAr: 'الإيرادات', nameEn: 'Revenue', accountType: 'revenue', isPostable: false },
  { code: '4100', nameAr: 'إيراد المبيعات والخدمات', nameEn: 'Sales & Services Revenue', accountType: 'revenue', isPostable: true },
  { code: '5000', nameAr: 'المصروفات', nameEn: 'Expenses', accountType: 'expense', isPostable: false },
  { code: '5100', nameAr: 'المصروفات العمومية والإدارية', nameEn: 'General & Administrative Expenses', accountType: 'expense', isPostable: true },
];

export class AccountService {
  constructor(private repo: AccountRepository = defaultAccountRepository) {}

  async listAccounts(companyId: string): Promise<Account[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('Company ID is required');
    }
    return await this.repo.listAccountsByCompany(companyId);
  }

  async createAccount(companyId: string, input: Omit<CreateAccountInput, 'companyId'>, _actorUserId?: string): Promise<Account> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('Company ID is required');
    }
    if (!input.code || typeof input.code !== 'string' || input.code.trim() === '') {
      throw new ValidationError('Account code is required');
    }
    if (!input.nameAr || typeof input.nameAr !== 'string' || input.nameAr.trim() === '') {
      throw new ValidationError('Arabic account name is required');
    }
    const validTypes: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];
    if (!input.accountType || !validTypes.includes(input.accountType)) {
      throw new ValidationError('Valid account type is required (asset, liability, equity, revenue, expense)');
    }

    const existing = await this.repo.findByCode(companyId, input.code.trim());
    if (existing) {
      throw new ConflictError(`Account code '${input.code.trim()}' already exists for this company`);
    }

    return await this.repo.createAccount({
      companyId,
      code: input.code.trim(),
      nameAr: input.nameAr.trim(),
      nameEn: input.nameEn ? input.nameEn.trim() : null,
      accountType: input.accountType,
      parentId: input.parentId || null,
      isPostable: input.isPostable !== undefined ? input.isPostable : true,
    });
  }

  async seedDefaultCoa(companyId: string): Promise<{ createdCount: number; accounts: Account[] }> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('Company ID is required');
    }

    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const count = await this.repo.countAccountsByCompany(companyId, tx);
      if (count > 0) {
        const existingList = await this.repo.listAccountsByCompany(companyId, tx);
        return { createdCount: 0, accounts: existingList };
      }

      const createdAccounts: Account[] = [];
      for (const item of DEFAULT_ARABIC_COA) {
        const created = await this.repo.createAccount(
          {
            companyId,
            code: item.code,
            nameAr: item.nameAr,
            nameEn: item.nameEn,
            accountType: item.accountType,
            isPostable: item.isPostable,
          },
          tx
        );
        createdAccounts.push(created);
      }

      return { createdCount: createdAccounts.length, accounts: createdAccounts };
    });
  }
}

export const defaultAccountService = new AccountService();
