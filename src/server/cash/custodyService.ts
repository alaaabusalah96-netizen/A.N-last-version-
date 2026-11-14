import { withTenantTransaction } from '../db/transactionManager.js';
import { CustodyRepository, defaultCustodyRepository } from './custodyRepository.js';
import { CashRegisterRepository, defaultCashRegisterRepository } from './cashRegisterRepository.js';
import { CustodyGlResolver, defaultCustodyGlResolver } from './glResolver.js';
import { defaultAccountRepository, AccountRepository } from '../accounting/accountRepository.js';
import { defaultJournalRepository, JournalRepository } from '../accounting/journalRepository.js';
import { defaultJournalService, JournalService } from '../accounting/journalService.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { defaultMembershipStore, MembershipStore } from '../org/membershipStore.js';
import { defaultUserRepository, UserRepository } from '../auth/userRepository.js';
import {
  CreateCustodyInput,
  CustodyEmployeeOption,
  CustodyListFilters,
  CustodyMovement,
  CustodyRecord,
  CustodyStatus,
  OpenCustodyEmployeeSummary,
  SettleCustodyInput,
} from './cashTypes.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { toMoney } from '../lib/numeric.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const ALLOWED_TRANSITIONS: Record<CustodyStatus, readonly CustodyStatus[]> = {
  pending: ['approved', 'rejected', 'cancelled'],
  approved: ['open', 'cancelled'],
  open: ['settled'],
  settled: [],
  rejected: [],
  cancelled: [],
};

const STATUS_LABELS_AR: Record<CustodyStatus, string> = {
  pending: 'قيد الانتظار (pending)',
  approved: 'معتمدة (approved)',
  rejected: 'مرفوضة (rejected)',
  open: 'مفتوحة / مصروفة (open)',
  settled: 'مسوّاة / مغلقة (settled)',
  cancelled: 'ملغاة (cancelled)',
};

function assertValidMoney(value: unknown, fieldLabel: string, allowZero: boolean = false): number {
  if (value === undefined || value === null || value === '') {
    throw new ValidationError(`${fieldLabel} مطلوب`);
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new ValidationError(`${fieldLabel} يجب أن يكون رقماً صالحاً`);
  }
  const raw = String(value).trim();
  const parts = raw.split('.');
  if (parts.length > 1 && parts[1].length > 2) {
    throw new ValidationError(`${fieldLabel} لا يمكن أن يحتوي على أكثر من منزلتين عشريتين`);
  }
  const rounded = toMoney(num);
  if (rounded !== num) {
    throw new ValidationError(`${fieldLabel} لا يمكن أن يتجاوز منزلتين عشريتين`);
  }
  if (allowZero ? rounded < 0 : rounded <= 0) {
    throw new ValidationError(
      allowZero ? `${fieldLabel} يجب أن يكون صفراً أو أكبر` : `${fieldLabel} يجب أن يكون أكبر من صفر`
    );
  }
  return rounded;
}

function resolveEntryDate(candidate?: string | null): string {
  if (candidate && ISO_DATE.test(candidate.slice(0, 10))) {
    return candidate.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

export class CustodyService {
  constructor(
    private custodyRepo: CustodyRepository = defaultCustodyRepository,
    private registerRepo: CashRegisterRepository = defaultCashRegisterRepository,
    private accountRepo: AccountRepository = defaultAccountRepository,
    private journalRepo: JournalRepository = defaultJournalRepository,
    private journalService: Pick<JournalService, 'createDraftEntry' | 'postEntry'> = defaultJournalService,
    private auditService: Pick<AuditService, 'record'> = defaultAuditService,
    private membershipStore: Pick<MembershipStore, 'getMembership' | 'listByCompany'> = defaultMembershipStore,
    private userRepo: Pick<UserRepository, 'findById'> = defaultUserRepository,
    private glResolver: Pick<CustodyGlResolver, 'resolveAndAssertUsable'> = defaultCustodyGlResolver
  ) {}

  private assertTransition(current: CustodyStatus, target: CustodyStatus): void {
    const allowed = ALLOWED_TRANSITIONS[current] || [];
    if (!allowed.includes(target)) {
      throw new ValidationError(
        `انتقال حالة العهدة غير مسموح: الحالة الحالية «${STATUS_LABELS_AR[current]}» لا تقبل الانتقال إلى «${STATUS_LABELS_AR[target]}»`
      );
    }
  }

  async listCustodies(companyId: string, filters: CustodyListFilters = {}): Promise<CustodyRecord[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    return await this.custodyRepo.listByCompany(companyId, filters);
  }

  async getCustody(companyId: string, id: string): Promise<CustodyRecord> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }
    const custody = await this.custodyRepo.findById(companyId, id);
    if (!custody) {
      throw new NotFoundError('العهدة النقدية غير موجودة');
    }
    return custody;
  }

  async listCustodyMovements(companyId: string, custodyId: string): Promise<CustodyMovement[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!custodyId || !isUuid(custodyId)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }
    const custody = await this.custodyRepo.findById(companyId, custodyId);
    if (!custody) {
      throw new NotFoundError('العهدة النقدية غير موجودة');
    }
    return await this.custodyRepo.listMovements(companyId, { custodyId });
  }

  async listEligibleEmployees(companyId: string): Promise<CustodyEmployeeOption[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    return await withTenantTransaction(companyId, async (tx) => {
      const memberships = await this.membershipStore.listByCompany(companyId, tx);
      const activeMemberships = memberships.filter((m) => m.isActive !== false);
      const employees: CustodyEmployeeOption[] = [];
      for (const m of activeMemberships) {
        const user = await this.userRepo.findById(m.userId, tx);
        if (user && user.isActive !== false) {
          employees.push({
            userId: user.id,
            username: user.username,
            role: m.role,
            roleId: m.roleId ?? null,
          });
        }
      }
      return employees;
    });
  }

  async requestCustody(companyId: string, input: CreateCustodyInput, actorId: string): Promise<CustodyRecord> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!input.employeeUserId || !isUuid(input.employeeUserId)) {
      throw new ValidationError('معرف الموظف المستلم للعهدة مطلوب وبصيغة صحيحة');
    }
    if (!input.registerId || !isUuid(input.registerId)) {
      throw new ValidationError('معرف الصندوق / الخزينة مطلوب وبصيغة صحيحة');
    }
    const amount = assertValidMoney(input.amount, 'مبلغ العهدة', false);
    const purpose = typeof input.purpose === 'string' ? input.purpose.trim() : '';
    if (purpose.length < 3) {
      throw new ValidationError('الغرض من العهدة إلزامي ويجب أن لا يقل عن 3 أحرف');
    }
    if (input.requestDate !== undefined && input.requestDate !== null && input.requestDate !== '') {
      if (!ISO_DATE.test(String(input.requestDate))) {
        throw new ValidationError('تاريخ الطلب يجب أن يكون بصيغة YYYY-MM-DD');
      }
    }
    const requestDate = resolveEntryDate(input.requestDate || null);

    return await withTenantTransaction(companyId, async (tx) => {
      const employee = await this.userRepo.findById(input.employeeUserId, tx);
      if (!employee) {
        throw new ValidationError('الموظف المحدد غير موجود');
      }
      if (!employee.isActive) {
        throw new ValidationError('حساب الموظف المحدد غير نشط');
      }

      const membership = await this.membershipStore.getMembership(input.employeeUserId, companyId, tx);
      if (!membership || membership.isActive === false) {
        throw new ValidationError('الموظف المحدد ليس عضواً نشطاً في هذه الشركة');
      }

      const register = await this.registerRepo.findById(companyId, input.registerId, tx);
      if (!register) {
        throw new NotFoundError('الصندوق / الخزينة المحددة غير موجودة في هذه الشركة');
      }
      if (!register.isActive) {
        throw new ValidationError(`الصندوق (${register.nameAr}) معطّل ولا يمكن طلب عهدة عليه`);
      }

      const custodyNo = await this.journalRepo.allocateSequenceNumber(companyId, 'custody', 'CUS', tx);
      const created = await this.custodyRepo.create(
        companyId,
        {
          custodyNo,
          employeeUserId: input.employeeUserId,
          registerId: input.registerId,
          amount,
          purpose,
          requestDate,
          requestedBy: actorId || null,
          memo: input.memo?.trim() || null,
        },
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_REQUEST',
          entityType: 'custody_records',
          entityId: created.id,
          metadata: {
            custodyNo,
            employeeUserId: input.employeeUserId,
            registerId: input.registerId,
            amount,
            purpose,
          },
        },
        { executor: tx }
      );

      const full = await this.custodyRepo.findById(companyId, created.id, tx);
      return full || created;
    });
  }

  async approveCustody(
    companyId: string,
    id: string,
    actorId: string,
    isPlatformAdmin: boolean = false
  ): Promise<CustodyRecord> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const custody = await this.custodyRepo.findByIdForUpdate(companyId, id, tx);
      if (!custody) {
        throw new NotFoundError('العهدة النقدية غير موجودة');
      }

      this.assertTransition(custody.status, 'approved');

      if (!isPlatformAdmin && custody.requestedBy && custody.requestedBy === actorId) {
        throw new ForbiddenError('فصل المهام: لا يمكن لمقدّم طلب العهدة اعتماد طلبه بنفسه');
      }

      await this.custodyRepo.setStatus(
        companyId,
        id,
        {
          status: 'approved',
          approvedBy: actorId || null,
          approvedAt: true,
        },
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_APPROVE',
          entityType: 'custody_records',
          entityId: id,
          metadata: {
            custodyNo: custody.custodyNo,
            amount: custody.amount,
            employeeUserId: custody.employeeUserId,
          },
        },
        { executor: tx }
      );

      const updated = await this.custodyRepo.findById(companyId, id, tx);
      return updated!;
    });
  }

  async rejectCustody(companyId: string, id: string, actorId: string, reason: string): Promise<CustodyRecord> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }
    const cleanReason = typeof reason === 'string' ? reason.trim() : '';
    if (cleanReason.length < 5) {
      throw new ValidationError('سبب الرفض إلزامي ويجب أن لا يقل عن 5 أحرف');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const custody = await this.custodyRepo.findByIdForUpdate(companyId, id, tx);
      if (!custody) {
        throw new NotFoundError('العهدة النقدية غير موجودة');
      }

      this.assertTransition(custody.status, 'rejected');

      await this.custodyRepo.markRejected(companyId, id, actorId, cleanReason, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_REJECT',
          entityType: 'custody_records',
          entityId: id,
          metadata: {
            custodyNo: custody.custodyNo,
            reason: cleanReason,
          },
        },
        { executor: tx }
      );

      const updated = await this.custodyRepo.findById(companyId, id, tx);
      return updated!;
    });
  }

  async disburseCustody(
    companyId: string,
    id: string,
    actorId: string,
    isPlatformAdmin: boolean = false
  ): Promise<CustodyRecord> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const custody = await this.custodyRepo.findByIdForUpdate(companyId, id, tx);
      if (!custody) {
        throw new NotFoundError('العهدة النقدية غير موجودة');
      }

      if (custody.status === 'open' || custody.status === 'settled') {
        throw new ValidationError('تم صرف هذه العهدة مسبقاً ولا يمكن تكرار الصرف');
      }
      this.assertTransition(custody.status, 'open');

      const register = await this.registerRepo.lockForUpdate(companyId, custody.registerId, tx);
      if (!register) {
        throw new NotFoundError('الصندوق المرتبط بالعهدة غير موجود');
      }
      if (!register.isActive) {
        throw new ValidationError(`الصندوق (${register.nameAr}) معطّل ولا يمكن الصرف منه`);
      }

      // الرصيد المتاح = الرصيد الافتتاحي + صافي الحركات (المصدر الوحيد في هذه المرحلة)
      const { netMovement } = await this.registerRepo.sumMovements(companyId, register.id, tx);
      const availableBalance = toMoney(register.openingBalance + netMovement);
      if (toMoney(availableBalance - custody.amount) < 0) {
        throw new ValidationError(
          `رصيد الصندوق (${register.nameAr}) غير كافٍ للصرف: الرصيد المتاح ${availableBalance.toFixed(2)}، والمطلوب ${custody.amount.toFixed(2)}`
        );
      }

      const gl = await this.glResolver.resolveAndAssertUsable(companyId, tx);
      if (gl.custodyReceivableAccountId === register.glAccountId) {
        throw new ValidationError('لا يمكن الصرف لأن حساب ذمة العهد يطابق حساب النقدية المرتبط بالصندوق');
      }

      const entryDate = resolveEntryDate(custody.requestDate);
      const docRef = custody.custodyNo || id;

      const draft = await this.journalService.createDraftEntry(
        companyId,
        {
          entryDate,
          memo: `صرف عهدة نقدية رقم ${docRef}`,
          lines: [
            {
              accountId: gl.custodyReceivableAccountId,
              debit: custody.amount,
              credit: 0,
              lineMemo: `صرف عهدة ${docRef} - ذمة عهد الموظفين`,
            },
            {
              accountId: register.glAccountId,
              debit: 0,
              credit: custody.amount,
              lineMemo: `صرف عهدة ${docRef} من صندوق ${register.code}`,
            },
          ],
        },
        actorId,
        isPlatformAdmin,
        tx
      );

      const posted = await this.journalService.postEntry(companyId, draft.id, actorId, isPlatformAdmin, tx);

      await this.custodyRepo.insertMovement(
        companyId,
        {
          custodyId: id,
          registerId: register.id,
          movementType: 'disburse',
          direction: 'out',
          amount: custody.amount,
          expenseAccountId: null,
          journalEntryId: posted.id,
          memo: `صرف عهدة نقدية رقم ${docRef}`,
          createdBy: actorId || null,
        },
        tx
      );

      await this.custodyRepo.markDisbursed(companyId, id, actorId, posted.id, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_DISBURSE',
          entityType: 'custody_records',
          entityId: id,
          metadata: {
            custodyNo: custody.custodyNo,
            amount: custody.amount,
            registerId: register.id,
            journalEntryId: posted.id,
            glSource: gl.source,
            glVersionNo: gl.versionNo,
          },
        },
        { executor: tx }
      );

      const updated = await this.custodyRepo.findById(companyId, id, tx);
      return updated!;
    });
  }

  async settleCustody(
    companyId: string,
    id: string,
    input: SettleCustodyInput,
    actorId: string,
    isPlatformAdmin: boolean = false
  ): Promise<CustodyRecord> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }
    if (!input || !Array.isArray(input.lines)) {
      throw new ValidationError('قائمة بنود التسوية (lines) مطلوبة');
    }

    const cashReturn = assertValidMoney(input.cashReturn ?? 0, 'المرتجع النقدي', true);
    const validatedLines: Array<{ expenseAccountId: string; amount: number; memo: string | null }> = [];
    let expenseTotalRaw = 0;

    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i];
      if (!line || !line.expenseAccountId || typeof line.expenseAccountId !== 'string') {
        throw new ValidationError(`البند رقم ${i + 1}: حساب المصروف مطلوب`);
      }
      const lineAmount = assertValidMoney(line.amount, `مبلغ البند رقم ${i + 1}`, false);
      expenseTotalRaw += lineAmount;
      validatedLines.push({
        expenseAccountId: line.expenseAccountId,
        amount: lineAmount,
        memo: line.memo?.trim() || null,
      });
    }

    const expenseTotal = toMoney(expenseTotalRaw);
    const settledTotal = toMoney(expenseTotal + cashReturn);

    return await withTenantTransaction(companyId, async (tx) => {
      const custody = await this.custodyRepo.findByIdForUpdate(companyId, id, tx);
      if (!custody) {
        throw new NotFoundError('العهدة النقدية غير موجودة');
      }

      if (custody.status === 'settled') {
        throw new ValidationError('تمت تسوية هذه العهدة مسبقاً ولا يمكن تكرار التسوية');
      }
      this.assertTransition(custody.status, 'settled');

      const diff = toMoney(settledTotal - custody.amount);
      if (diff !== 0) {
        throw new ValidationError(
          `مجموع المصروفات (${expenseTotal.toFixed(2)}) والمرتجع النقدي (${cashReturn.toFixed(2)}) = ${settledTotal.toFixed(2)} لا يساوي مبلغ العهدة (${custody.amount.toFixed(2)}) — الفرق (${diff.toFixed(2)})`
        );
      }

      for (let i = 0; i < validatedLines.length; i++) {
        const line = validatedLines[i];
        const acc = await this.accountRepo.findById(companyId, line.expenseAccountId, tx);
        if (!acc) {
          throw new ValidationError(`البند رقم ${i + 1}: حساب المصروف المشار إليه غير موجود في الشركة`);
        }
        if (!acc.isActive) {
          throw new ValidationError(`البند رقم ${i + 1}: حساب المصروف (${acc.code} - ${acc.nameAr}) غير نشط`);
        }
        if (!acc.isPostable) {
          throw new ValidationError(
            `البند رقم ${i + 1}: حساب المصروف (${acc.code} - ${acc.nameAr}) حساب رئيسي غير قابل للترحيل`
          );
        }
        if (acc.accountType !== 'expense') {
          throw new ValidationError(
            `البند رقم ${i + 1}: الحساب (${acc.code} - ${acc.nameAr}) نوعه ${acc.accountType} ويجب أن يكون من نوع المصروفات (expense)`
          );
        }
      }

      const register = await this.registerRepo.findById(companyId, custody.registerId, tx);
      if (!register) {
        throw new NotFoundError('الصندوق المرتبط بالعهدة غير موجود');
      }
      if (!register.isActive) {
        throw new ValidationError(`الصندوق (${register.nameAr}) معطّل ولا يمكن إتمام التسوية عليه`);
      }

      const gl = await this.glResolver.resolveAndAssertUsable(companyId, tx);
      const entryDate = resolveEntryDate(new Date().toISOString().slice(0, 10));
      const docRef = custody.custodyNo || id;

      const jeLines: Array<{ accountId: string; debit: number; credit: number; lineMemo: string }> =
        validatedLines.map((l) => ({
          accountId: l.expenseAccountId,
          debit: l.amount,
          credit: 0,
          lineMemo: l.memo || `مصروف تسوية عهدة ${docRef}`,
        }));

      if (cashReturn > 0) {
        jeLines.push({
          accountId: register.glAccountId,
          debit: cashReturn,
          credit: 0,
          lineMemo: `مرتجع نقدي لتسوية عهدة ${docRef} إلى صندوق ${register.code}`,
        });
      }

      jeLines.push({
        accountId: gl.custodyReceivableAccountId,
        debit: 0,
        credit: custody.amount,
        lineMemo: `إقفال ذمة عهدة رقم ${docRef}`,
      });

      const draft = await this.journalService.createDraftEntry(
        companyId,
        {
          entryDate,
          memo: `تسوية عهدة نقدية رقم ${docRef}`,
          lines: jeLines,
        },
        actorId,
        isPlatformAdmin,
        tx
      );

      const posted = await this.journalService.postEntry(companyId, draft.id, actorId, isPlatformAdmin, tx);

      // ملاحظة محاسبية: direction='none' في سطور المصروف مقصودة — لا تُحرّك نقدية
      // الصندوق لأن النقدية خرجت بالفعل في خطوة الصرف؛ التحريك فقط للمرتجع النقدي.
      for (const line of validatedLines) {
        await this.custodyRepo.insertMovement(
          companyId,
          {
            custodyId: id,
            registerId: register.id,
            movementType: 'settle_expense',
            direction: 'none',
            amount: line.amount,
            expenseAccountId: line.expenseAccountId,
            journalEntryId: posted.id,
            memo: line.memo || `مصروف تسوية عهدة ${docRef}`,
            createdBy: actorId || null,
          },
          tx
        );
      }

      if (cashReturn > 0) {
        await this.custodyRepo.insertMovement(
          companyId,
          {
            custodyId: id,
            registerId: register.id,
            movementType: 'settle_return',
            direction: 'in',
            amount: cashReturn,
            expenseAccountId: null,
            journalEntryId: posted.id,
            memo: `مرتجع نقدي لعهدة رقم ${docRef}`,
            createdBy: actorId || null,
          },
          tx
        );
      }

      await this.custodyRepo.markSettled(
        companyId,
        id,
        actorId,
        posted.id,
        expenseTotal,
        cashReturn,
        input.memo?.trim() || null,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_SETTLE',
          entityType: 'custody_records',
          entityId: id,
          metadata: {
            custodyNo: custody.custodyNo,
            expenseTotal,
            cashReturn,
            lineCount: validatedLines.length,
            journalEntryId: posted.id,
          },
        },
        { executor: tx }
      );

      const updated = await this.custodyRepo.findById(companyId, id, tx);
      return updated!;
    });
  }

  async cancelCustody(
    companyId: string,
    id: string,
    actorId: string,
    reason?: string | null,
    options?: { canCancelApproved?: boolean }
  ): Promise<CustodyRecord> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف العهدة غير صالح');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const custody = await this.custodyRepo.findByIdForUpdate(companyId, id, tx);
      if (!custody) {
        throw new NotFoundError('العهدة النقدية غير موجودة');
      }

      if (custody.status === 'open') {
        throw new ValidationError(
          'لا يمكن إلغاء عهدة مصروفة مفتوحة لوجود أثر محاسبي قائم — يرجى تسوية العهدة أو عكس القيد بالمسار المحاسبي (reverseEntry)'
        );
      }

      this.assertTransition(custody.status, 'cancelled');

      if (custody.status === 'approved' && options?.canCancelApproved === false) {
        throw new ForbiddenError('إلغاء عهدة معتمدة يتطلب صلاحية اعتماد العهد (custody:approve)');
      }

      const cleanReason = typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null;
      await this.custodyRepo.markCancelled(companyId, id, cleanReason, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_CANCEL',
          entityType: 'custody_records',
          entityId: id,
          metadata: {
            custodyNo: custody.custodyNo,
            previousStatus: custody.status,
            reason: cleanReason,
          },
        },
        { executor: tx }
      );

      const updated = await this.custodyRepo.findById(companyId, id, tx);
      return updated!;
    });
  }

  async getOpenBalancesByEmployee(
    companyId: string,
    employeeUserId?: string
  ): Promise<OpenCustodyEmployeeSummary[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    return await this.custodyRepo.listOpenByEmployee(companyId, employeeUserId);
  }
}

export const defaultCustodyService = new CustodyService();
