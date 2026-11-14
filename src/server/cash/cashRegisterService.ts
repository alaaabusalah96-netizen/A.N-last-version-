import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { CashRegisterRepository, defaultCashRegisterRepository } from './cashRegisterRepository.js';
import { CashRegister, CashRegisterBalance, CreateCashRegisterInput, UpdateCashRegisterInput, CustodyMovement } from './cashTypes.js';
import { defaultAccountRepository } from '../accounting/accountRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { toMoney } from '../lib/numeric.js';

export class CashRegisterService {
  constructor(
    private repo: CashRegisterRepository = defaultCashRegisterRepository,
    private auditService: AuditService = defaultAuditService
  ) {}

  async createRegister(companyId: string, input: CreateCashRegisterInput, actorId?: string): Promise<CashRegister> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!input.code || typeof input.code !== 'string' || input.code.trim() === '') {
      throw new ValidationError('رمز الصندوق مطلوب');
    }
    if (!input.nameAr || typeof input.nameAr !== 'string' || input.nameAr.trim() === '') {
      throw new ValidationError('اسم الصندوق بالعربية مطلوب');
    }
    if (!input.glAccountId || typeof input.glAccountId !== 'string' || !isUuid(input.glAccountId)) {
      throw new ValidationError('حساب الأستاذ العام المرتبط بالصندوق مطلوب');
    }

    if (input.openingBalance !== undefined && input.openingBalance !== null) {
      const raw = String(input.openingBalance).trim();
      const parts = raw.split('.');
      if (parts.length > 1 && parts[1].length > 2) {
        throw new ValidationError('الرصيد الافتتاحي لا يمكن أن يحتوي على أكثر من منزلتين عشريتين');
      }
      const num = Number(input.openingBalance);
      if (isNaN(num) || num < 0) {
        throw new ValidationError('الرصيد الافتتاحي يجب أن يكون رقماً موجباً');
      }
    }

    return await withTenantTransaction(companyId, async (tx) => {
      // 1. Verify GL Account exists, is active, postable, and of type 'asset'
      const account = await defaultAccountRepository.findById(companyId, input.glAccountId, tx);
      if (!account) {
        throw new NotFoundError('حساب النقدية المحدد غير موجود في دليل حسابات الشركة');
      }
      if (!account.isActive) {
        throw new ValidationError('حساب النقدية المحدد غير نشط');
      }
      if (!account.isPostable) {
        throw new ValidationError('حساب الصندوق يجب أن يكون حساباً فرعياً قابلاً للترحيل');
      }
      if (account.accountType !== 'asset') {
        throw new ValidationError(`حساب الصندوق يجب أن يكون من نوع الأصول (asset) وليس ${account.accountType}`);
      }

      // 2. Verify code uniqueness in company
      const existingCode = await this.repo.findByCode(companyId, input.code.trim(), tx);
      if (existingCode) {
        throw new ValidationError(`رمز الصندوق '${input.code.trim()}' مسجل مسبقاً في هذه الشركة`);
      }

      // 3. Verify 1-to-1 rule: only one register per GL account
      const existingWithGl = await this.repo.findByGlAccount(companyId, input.glAccountId, tx);
      if (existingWithGl) {
        throw new ValidationError(`يوجد صندوق مسجل مسبقاً مرتبط بهذا الحساب النقدي (${existingWithGl.nameAr})`);
      }

      const register = await this.repo.create(companyId, input, actorId || null, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || '',
          companyId,
          action: 'CASH_REGISTER_CREATE',
          entityType: 'cash_registers',
          entityId: register.id,
          metadata: {
            code: register.code,
            nameAr: register.nameAr,
            glAccountId: register.glAccountId,
            openingBalance: register.openingBalance,
          },
        },
        { executor: tx }
      );

      return register;
    });
  }

  async updateRegister(
    companyId: string,
    id: string,
    input: UpdateCashRegisterInput,
    actorId?: string
  ): Promise<CashRegister> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف الصندوق غير صالح');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const register = await this.repo.lockForUpdate(companyId, id, tx);
      if (!register) {
        throw new NotFoundError('الصندوق غير موجود');
      }

      if (input.code && input.code.trim() !== register.code) {
        const existingCode = await this.repo.findByCode(companyId, input.code.trim(), tx);
        if (existingCode && existingCode.id !== id) {
          throw new ValidationError(`رمز الصندوق '${input.code.trim()}' مسجل مسبقاً`);
        }
      }

      const updated = await this.repo.update(companyId, id, input, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || '',
          companyId,
          action: 'CASH_REGISTER_UPDATE',
          entityType: 'cash_registers',
          entityId: id,
          metadata: { patch: input },
        },
        { executor: tx }
      );

      return updated;
    });
  }

  async deactivateRegister(companyId: string, id: string, actorId?: string): Promise<CashRegister> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف الصندوق غير صالح');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const register = await this.repo.lockForUpdate(companyId, id, tx);
      if (!register) {
        throw new NotFoundError('الصندوق غير موجود');
      }
      if (!register.isActive) {
        throw new ValidationError('الصندوق معطل مسبقاً');
      }

      // Check open custody records
      const openCustodyRes = await tx.query<{ id: string; custodyNo: string | null }>(
        `SELECT id, custody_no as "custodyNo" FROM custody_records WHERE company_id = $1 AND register_id = $2 AND status = 'open' LIMIT 1`,
        [companyId, id]
      );
      if (openCustodyRes.rows.length > 0) {
        const openC = openCustodyRes.rows[0];
        throw new ValidationError(`لا يمكن تعطيل الصندوق لوجود عهدة نقدية مفتوحة مرتبطة به (رقم العهدة: ${openC.custodyNo || openC.id})`);
      }

      // Check register balance
      const balance = await this.getBalance(companyId, id, tx);
      if (balance.currentBalance !== 0) {
        throw new ValidationError(`لا يمكن تعطيل الصندوق لأن رصيده الحالي (${balance.currentBalance}) لا يساوي صفراً`);
      }

      const deactivated = await this.repo.deactivate(companyId, id, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || '',
          companyId,
          action: 'CASH_REGISTER_DEACTIVATE',
          entityType: 'cash_registers',
          entityId: id,
          metadata: { code: register.code, nameAr: register.nameAr },
        },
        { executor: tx }
      );

      return deactivated;
    });
  }

  async getBalance(companyId: string, id: string, customExecutor?: DbExecutor): Promise<CashRegisterBalance> {
    const run = async (executor: DbExecutor) => {
      const register = await this.repo.findById(companyId, id, executor);
      if (!register) {
        throw new NotFoundError('الصندوق غير موجود');
      }
      const { totalIn, totalOut, netMovement } = await this.repo.sumMovements(companyId, id, executor);
      const currentBalance = toMoney(register.openingBalance + netMovement);
      return {
        registerId: id,
        openingBalance: register.openingBalance,
        totalIn,
        totalOut,
        currentBalance,
      };
    };
    if (customExecutor) return await run(customExecutor);
    return await withTenantTransaction(companyId, run);
  }

  async getRegister(companyId: string, id: string): Promise<CashRegister & { balance: CashRegisterBalance }> {
    const register = await this.repo.findById(companyId, id);
    if (!register) {
      throw new NotFoundError('الصندوق غير موجود');
    }
    const balance = await this.getBalance(companyId, id);
    return { ...register, balance };
  }

  async listRegisters(companyId: string): Promise<Array<CashRegister & { balance: CashRegisterBalance }>> {
    const registers = await this.repo.listByCompany(companyId);
    return Promise.all(
      registers.map(async (r) => {
        const balance = await this.getBalance(companyId, r.id);
        return { ...r, balance };
      })
    );
  }

  async listMovements(companyId: string, id: string): Promise<CustodyMovement[]> {
    const register = await this.repo.findById(companyId, id);
    if (!register) {
      throw new NotFoundError('الصندوق غير موجود');
    }
    return await this.repo.listMovements(companyId, id);
  }
}

export const defaultCashRegisterService = new CashRegisterService();
