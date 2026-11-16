import { withTenantTransaction } from '../db/transactionManager.js';
import { BankAccountRepository, defaultBankAccountRepository } from './bankAccountRepository.js';
import { defaultAccountRepository, AccountRepository } from '../accounting/accountRepository.js';
import { defaultCashRegisterRepository, CashRegisterRepository } from '../cash/cashRegisterRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { ValidationError, NotFoundError, ConflictError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { toMinorUnits } from '../lib/numeric.js';
import { BankAccount, CreateBankAccountInput, UpdateBankAccountInput } from './bankingTypes.js';

export class BankAccountService {
  constructor(
    private repo: BankAccountRepository = defaultBankAccountRepository,
    private accountRepo: AccountRepository = defaultAccountRepository,
    private cashRegisterRepo: CashRegisterRepository = defaultCashRegisterRepository,
    private auditService: AuditService = defaultAuditService
  ) {}

  async listAccounts(companyId: string): Promise<BankAccount[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    return await this.repo.listByCompany(companyId);
  }

  async getAccount(companyId: string, id: string): Promise<BankAccount> {
    if (!companyId || !id || !isUuid(id)) {
      throw new ValidationError('معرف الحساب البنكي غير صالح');
    }
    const acc = await this.repo.findById(companyId, id);
    if (!acc) {
      throw new NotFoundError('الحساب البنكي غير موجود');
    }
    return acc;
  }

  async createAccount(
    companyId: string,
    input: CreateBankAccountInput,
    actorId?: string
  ): Promise<BankAccount> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!input.code || typeof input.code !== 'string' || input.code.trim() === '') {
      throw new ValidationError('رمز الحساب البنكي مطلوب');
    }
    if (!input.nameAr || typeof input.nameAr !== 'string' || input.nameAr.trim() === '') {
      throw new ValidationError('اسم الحساب البنكي بالعربية مطلوب');
    }
    if (!input.bankName || typeof input.bankName !== 'string' || input.bankName.trim() === '') {
      throw new ValidationError('اسم البنك مطلوب');
    }
    if (!input.glAccountId || !isUuid(input.glAccountId)) {
      throw new ValidationError('حساب الأستاذ العام المرتبط بالبنك مطلوب');
    }

    if (input.openingBalance !== undefined && input.openingBalance !== null && String(input.openingBalance).trim() !== '') {
      const units = toMinorUnits(input.openingBalance, 2);
      if (units < BigInt(0)) {
        throw new ValidationError('الرصيد الافتتاحي للحساب البنكي لا يمكن أن يكون سالباً');
      }
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const glAcc = await this.accountRepo.findById(companyId, input.glAccountId, tx);
      if (!glAcc) {
        throw new NotFoundError('حساب الأستاذ العام المحدد غير موجود في دليل حسابات الشركة');
      }
      if (!glAcc.isActive) {
        throw new ValidationError('حساب الأستاذ العام المحدد غير نشط');
      }
      if (!glAcc.isPostable) {
        throw new ValidationError('حساب البنك في دليل الحسابات يجب أن يكون حساباً فرعياً قابلاً للترحيل');
      }
      if (glAcc.accountType !== 'asset') {
        throw new ValidationError(`حساب البنك في الدليل المحاسبي يجب أن يكون من نوع الأصول (asset) وليس ${glAcc.accountType}`);
      }

      const existingCode = await this.repo.findByCode(companyId, input.code.trim(), tx);
      if (existingCode) {
        throw new ConflictError(`رمز الحساب البنكي '${input.code.trim()}' مستخدم مسبقاً في هذه الشركة`);
      }

      const existingGl = await this.repo.findByGlAccount(companyId, input.glAccountId, tx);
      if (existingGl) {
        throw new ConflictError(`حساب الأستاذ العام مرتبط مسبقاً بحساب بنكي آخر (${existingGl.nameAr})`);
      }

      const existingRegister = await this.cashRegisterRepo.findByGlAccount(companyId, input.glAccountId, tx);
      if (existingRegister) {
        throw new ConflictError(`حساب الأستاذ العام مرتبط مسبقاً بصندوق نقدي (${existingRegister.nameAr})`);
      }

      const created = await this.repo.create(companyId, input, actorId || null, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'BANK_ACCOUNT_CREATE',
          entityType: 'fin_bank_accounts',
          entityId: created.id,
          metadata: {
            code: created.code,
            nameAr: created.nameAr,
            bankName: created.bankName,
            glAccountId: created.glAccountId,
            openingBalance: created.openingBalance,
          },
        },
        { executor: tx }
      );

      return created;
    });
  }

  async updateAccount(
    companyId: string,
    id: string,
    input: UpdateBankAccountInput,
    actorId?: string
  ): Promise<BankAccount> {
    if (!companyId || !id || !isUuid(id)) {
      throw new ValidationError('معرف الحساب البنكي غير صالح');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const existing = await this.repo.lockForUpdate(companyId, id, tx);
      if (!existing) {
        throw new NotFoundError('الحساب البنكي غير موجود');
      }

      if (input.code && input.code.trim() !== existing.code) {
        const dup = await this.repo.findByCode(companyId, input.code.trim(), tx);
        if (dup && dup.id !== id) {
          throw new ConflictError(`رمز الحساب البنكي '${input.code.trim()}' مستخدم مسبقاً`);
        }
      }

      const updated = await this.repo.update(companyId, id, input, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'BANK_ACCOUNT_UPDATE',
          entityType: 'fin_bank_accounts',
          entityId: id,
          metadata: { patch: input },
        },
        { executor: tx }
      );

      return updated;
    });
  }
}

export const defaultBankAccountService = new BankAccountService();
