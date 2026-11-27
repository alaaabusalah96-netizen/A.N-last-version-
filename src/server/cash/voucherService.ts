import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { VoucherRepository, defaultVoucherRepository } from './voucherRepository.js';
import { CashRegisterRepository, defaultCashRegisterRepository } from './cashRegisterRepository.js';
import { CashRegisterService, defaultCashRegisterService } from './cashRegisterService.js';
import { AccountRepository, defaultAccountRepository } from '../accounting/accountRepository.js';
import { JournalRepository, defaultJournalRepository } from '../accounting/journalRepository.js';
import { JournalService, defaultJournalService } from '../accounting/journalService.js';
import { AuditService, defaultAuditService } from '../audit/auditService.js';
import {
  CashVoucher,
  CreateVoucherInput,
  EmployeeCustodyMovementRow,
  RegisterMovementReport,
  VoucherKind,
  VoucherListFilters,
} from './voucherTypes.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { assertMaxDocumentLines } from '../http/documentLimits.js';
import { toMoney } from '../lib/numeric.js';
import {
  assertOptionalCalendarDate,
  isValidCalendarDate,
  resolveCompanyToday,
} from '../lib/calendarDate.js';

function assertValidVoucherMoney(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    throw new ValidationError('مبلغ السند مطلوب');
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new ValidationError('مبلغ السند يجب أن يكون رقماً صالحاً');
  }
  const raw = String(value).trim();
  const parts = raw.split('.');
  if (parts.length > 1 && parts[1].length > 2) {
    throw new ValidationError('مبلغ السند لا يمكن أن يحتوي على أكثر من منزلتين عشريتين');
  }
  const rounded = toMoney(num);
  if (rounded !== num || rounded <= 0) {
    throw new ValidationError('مبلغ السند يجب أن يكون أكبر من صفر وبحد أقصى منزلتين عشريتين');
  }
  return rounded;
}

export class VoucherService {
  constructor(
    private voucherRepo: VoucherRepository = defaultVoucherRepository,
    private registerRepo: CashRegisterRepository = defaultCashRegisterRepository,
    private cashRegisterService: Pick<CashRegisterService, 'getBalance'> = defaultCashRegisterService,
    private accountRepo: AccountRepository = defaultAccountRepository,
    private journalRepo: JournalRepository = defaultJournalRepository,
    private journalService: Pick<JournalService, 'createDraftEntry' | 'postEntry'> = defaultJournalService,
    private auditService: Pick<AuditService, 'record'> = defaultAuditService
  ) {}

  private async validateContraAccount(
    companyId: string,
    contraAccountId: string,
    registerGlAccountId: string,
    tx: DbExecutor
  ) {
    const account = await this.accountRepo.findById(companyId, contraAccountId, tx);
    if (!account) {
      throw new ValidationError('الحساب الطرف المحدد غير موجود في دليل حسابات الشركة');
    }
    if (!account.isActive) {
      throw new ValidationError(`الحساب الطرف (${account.code} - ${account.nameAr}) غير نشط ولا يمكن الترحيل عليه`);
    }
    if (!account.isPostable) {
      throw new ValidationError(`الحساب الطرف (${account.code} - ${account.nameAr}) حساب رئيسي غير قابل للترحيل`);
    }
    if (account.id === registerGlAccountId) {
      throw new ValidationError('الحساب الطرف لا يمكن أن يساوي حساب النقدية المرتبط بالصندوق نفسه');
    }
    return account;
  }

  async createVoucher(
    kind: VoucherKind,
    companyId: string,
    input: CreateVoucherInput,
    actorId: string
  ): Promise<CashVoucher> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!input.registerId || !isUuid(input.registerId)) {
      throw new ValidationError('معرف الصندوق / الخزينة مطلوب وبصيغة صحيحة');
    }
    let rawLines: Array<{ accountId: string; amount: number | string; memo?: string | null }>;
    if (Array.isArray(input.lines) && input.lines.length > 0) {
      assertMaxDocumentLines(input.lines);
      rawLines = input.lines;
    } else {
      if (!input.contraAccountId || !isUuid(input.contraAccountId)) {
        throw new ValidationError('الحساب الطرف مطلوب وبصيغة صحيحة');
      }
      rawLines = [{ accountId: input.contraAccountId, amount: input.amount as number }];
    }
    const normLines = rawLines.map((l, i) => {
      if (!l || !l.accountId || !isUuid(l.accountId)) {
        throw new ValidationError(`السطر ${i + 1}: الحساب مطلوب وبصيغة صحيحة`);
      }
      return { accountId: l.accountId, amount: assertValidVoucherMoney(l.amount), memo: l.memo?.toString().trim() || null };
    });
    const amount = toMoney(normLines.reduce((a, l) => a + l.amount, 0));
    const requestedVoucherDate = assertOptionalCalendarDate(input.voucherDate, 'تاريخ السند');

    return await withTenantTransaction(companyId, async (tx) => {
      const register = await this.registerRepo.findById(companyId, input.registerId, tx);
      if (!register) {
        throw new NotFoundError('الصندوق / الخزينة المحددة غير موجودة في هذه الشركة');
      }
      if (!register.isActive) {
        throw new ValidationError(`الصندوق (${register.nameAr}) معطّل ولا يمكن إصدار سندات عليه`);
      }

      for (const l of normLines) {
        await this.validateContraAccount(companyId, l.accountId, register.glAccountId, tx);
      }
      const voucherDate = requestedVoucherDate ?? (await resolveCompanyToday(companyId, tx));

      const created = await this.voucherRepo.createDraft(
        kind,
        companyId,
        {
          registerId: input.registerId,
          voucherDate,
          amount,
          contraAccountId: normLines[0].accountId,
          memo: input.memo?.trim() || null,
          reference: input.reference?.trim() || null,
          createdBy: actorId || null,
        },
        tx
      );
      await this.voucherRepo.insertLines(kind, companyId, created.id, normLines, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: kind === 'receipt' ? 'CASH_RECEIPT_CREATE' : 'CASH_PAYMENT_CREATE',
          entityType: kind === 'receipt' ? 'cash_receipt_vouchers' : 'cash_payment_vouchers',
          entityId: created.id,
          metadata: {
            kind,
            registerId: input.registerId,
            contraAccountId: normLines[0].accountId,
            linesCount: normLines.length,
            amount,
            voucherDate,
          },
        },
        { executor: tx }
      );

      const full = await this.voucherRepo.findById(kind, companyId, created.id, tx);
      return full || created;
    });
  }

  async createReceiptVoucher(companyId: string, input: CreateVoucherInput, actorId: string): Promise<CashVoucher> {
    return this.createVoucher('receipt', companyId, input, actorId);
  }

  async createPaymentVoucher(companyId: string, input: CreateVoucherInput, actorId: string): Promise<CashVoucher> {
    return this.createVoucher('payment', companyId, input, actorId);
  }

  async listVouchers(
    kind: VoucherKind,
    companyId: string,
    filters: VoucherListFilters = {}
  ): Promise<CashVoucher[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (filters.from && !isValidCalendarDate(filters.from)) {
      throw new ValidationError('صيغة تاريخ البداية غير صالحة (YYYY-MM-DD)');
    }
    if (filters.to && !isValidCalendarDate(filters.to)) {
      throw new ValidationError('صيغة تاريخ النهاية غير صالحة (YYYY-MM-DD)');
    }
    return await this.voucherRepo.listByCompany(kind, companyId, filters);
  }

  async getVoucher(kind: VoucherKind, companyId: string, id: string): Promise<CashVoucher> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف السند غير صالح');
    }
    const voucher = await this.voucherRepo.findById(kind, companyId, id);
    if (!voucher) {
      throw new NotFoundError(kind === 'receipt' ? 'سند القبض غير موجود' : 'سند الصرف غير موجود');
    }
    return voucher;
  }

  async postReceiptVoucher(
    companyId: string,
    id: string,
    actorId: string,
    isPlatformAdmin: boolean = false
  ): Promise<CashVoucher> {
    return this.postVoucher('receipt', companyId, id, actorId, isPlatformAdmin);
  }

  async postPaymentVoucher(
    companyId: string,
    id: string,
    actorId: string,
    isPlatformAdmin: boolean = false
  ): Promise<CashVoucher> {
    return this.postVoucher('payment', companyId, id, actorId, isPlatformAdmin);
  }

  private async postVoucher(
    kind: VoucherKind,
    companyId: string,
    id: string,
    actorId: string,
    isPlatformAdmin: boolean
  ): Promise<CashVoucher> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف السند غير صالح');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const voucher = await this.voucherRepo.findByIdForUpdate(kind, companyId, id, tx);
      if (!voucher) {
        throw new NotFoundError(kind === 'receipt' ? 'سند القبض غير موجود' : 'سند الصرف غير موجود');
      }

      if (voucher.status === 'posted') {
        throw new ValidationError('تم ترحيل هذا السند مسبقاً ولا يمكن تكرار الترحيل');
      }
      if (voucher.status === 'cancelled') {
        throw new ValidationError('لا يمكن ترحيل سند ملغى');
      }

      const register = await this.registerRepo.lockForUpdate(companyId, voucher.registerId, tx);
      if (!register) {
        throw new NotFoundError('الصندوق المرتبط بالسند غير موجود');
      }
      if (!register.isActive) {
        throw new ValidationError(`الصندوق (${register.nameAr}) معطّل ولا يمكن الترحيل عليه`);
      }

      const storedLines = await this.voucherRepo.listLines(kind, companyId, id, tx);
      const postingLines = storedLines.length > 0
        ? storedLines.map((l) => ({ accountId: l.accountId, amount: l.amount, memo: l.memo }))
        : [{ accountId: voucher.contraAccountId, amount: voucher.amount, memo: null as string | null }];
      const lineAccounts: Array<{ id: string; code: string; nameAr: string; amount: number; memo: string | null }> = [];
      for (const l of postingLines) {
        const acc = await this.validateContraAccount(companyId, l.accountId, register.glAccountId, tx);
        lineAccounts.push({ id: acc.id, code: acc.code, nameAr: acc.nameAr, amount: l.amount, memo: l.memo });
      }
      const contraAccount = lineAccounts[0];

      // فحص كفاية رصيد الصندوق عبر المصدر الموحّد cashRegisterService.getBalance لسندات الصرف
      if (kind === 'payment') {
        const balance = await this.cashRegisterService.getBalance(companyId, register.id, tx);
        if (toMoney(balance.currentBalance - voucher.amount) < 0) {
          throw new ValidationError(
            `رصيد الصندوق (${register.nameAr}) غير كافٍ للصرف: الرصيد المتاح ${balance.currentBalance.toFixed(2)}، والمطلوب ${voucher.amount.toFixed(2)}`
          );
        }
      }

      const seqDocType = kind === 'receipt' ? 'cash_receipt' : 'cash_payment';
      const seqPrefix = kind === 'receipt' ? 'CRV' : 'CPV';
      const voucherNo = voucher.voucherNo || (await this.journalRepo.allocateSequenceNumber(companyId, seqDocType, seqPrefix, tx));

      const cashLabel = `${kind === 'receipt' ? 'سند قبض' : 'سند صرف'} ${voucherNo} - صندوق ${register.code}`;
      const contraJeLines = lineAccounts.map((l) => ({
        accountId: l.id,
        debit: kind === 'receipt' ? 0 : l.amount,
        credit: kind === 'receipt' ? l.amount : 0,
        lineMemo: l.memo || `${kind === 'receipt' ? 'سند قبض' : 'سند صرف'} ${voucherNo} - ${l.code} ${l.nameAr}`,
      }));
      const registerJeLine = {
        accountId: register.glAccountId,
        debit: kind === 'receipt' ? voucher.amount : 0,
        credit: kind === 'receipt' ? 0 : voucher.amount,
        lineMemo: cashLabel,
      };
      const jeLines = kind === 'receipt' ? [registerJeLine, ...contraJeLines] : [...contraJeLines, registerJeLine];

      const draftJe = await this.journalService.createDraftEntry(
        companyId,
        {
          entryDate: voucher.voucherDate,
          memo: voucher.memo || `${kind === 'receipt' ? 'سند قبض نقدي' : 'سند صرف نقدي'} رقم ${voucherNo}`,
          lines: jeLines,
        },
        actorId,
        isPlatformAdmin,
        tx
      );

      const postedJe = await this.journalService.postEntry(companyId, draftJe.id, actorId, isPlatformAdmin, tx);

      await this.voucherRepo.markPosted(kind, companyId, id, voucherNo, postedJe.id, actorId, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: kind === 'receipt' ? 'CASH_RECEIPT_POST' : 'CASH_PAYMENT_POST',
          entityType: kind === 'receipt' ? 'cash_receipt_vouchers' : 'cash_payment_vouchers',
          entityId: id,
          metadata: {
            voucherNo,
            kind,
            amount: voucher.amount,
            registerId: register.id,
            contraAccountId: contraAccount.id,
            linesCount: lineAccounts.length,
            journalEntryId: postedJe.id,
          },
        },
        { executor: tx }
      );

      const updated = await this.voucherRepo.findById(kind, companyId, id, tx);
      return updated!;
    });
  }

  async cancelVoucher(
    kind: VoucherKind,
    companyId: string,
    id: string,
    actorId: string,
    reason?: string | null
  ): Promise<CashVoucher> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!id || !isUuid(id)) {
      throw new ValidationError('معرف السند غير صالح');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const voucher = await this.voucherRepo.findByIdForUpdate(kind, companyId, id, tx);
      if (!voucher) {
        throw new NotFoundError(kind === 'receipt' ? 'سند القبض غير موجود' : 'سند الصرف غير موجود');
      }

      if (voucher.status === 'posted') {
        throw new ValidationError(
          'لا يمكن إلغاء سند مرحّل لوجود قيد محاسبي مرتبط به — يرجى استخدام العكس المحاسبي المعتمد (JournalService.reverseEntry)'
        );
      }

      if (voucher.status === 'cancelled') {
        throw new ValidationError('السند ملغى مسبقاً');
      }

      const cleanReason = typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null;
      await this.voucherRepo.markCancelled(kind, companyId, id, cleanReason, tx);

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: kind === 'receipt' ? 'CASH_RECEIPT_CANCEL' : 'CASH_PAYMENT_CANCEL',
          entityType: kind === 'receipt' ? 'cash_receipt_vouchers' : 'cash_payment_vouchers',
          entityId: id,
          metadata: { kind, reason: cleanReason },
        },
        { executor: tx }
      );

      const updated = await this.voucherRepo.findById(kind, companyId, id, tx);
      return updated!;
    });
  }

  async getRegisterMovementsReport(
    companyId: string,
    filters: { registerId: string; from?: string; to?: string }
  ): Promise<RegisterMovementReport> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!filters.registerId || !isUuid(filters.registerId)) {
      throw new ValidationError('معرف الصندوق / الخزينة مطلوب وبصيغة صحيحة');
    }
    if (filters.from && !isValidCalendarDate(filters.from)) {
      throw new ValidationError('صيغة تاريخ البداية غير صالحة (YYYY-MM-DD)');
    }
    if (filters.to && !isValidCalendarDate(filters.to)) {
      throw new ValidationError('صيغة تاريخ النهاية غير صالحة (YYYY-MM-DD)');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const register = await this.registerRepo.findById(companyId, filters.registerId, tx);
      if (!register) {
        throw new NotFoundError('الصندوق / الخزينة غير موجودة');
      }

      const rows = await this.voucherRepo.listRegisterMovementRows(companyId, filters, tx);
      const totals = await this.voucherRepo.listRegisterPeriodTotals(
        companyId,
        filters.registerId,
        filters.from,
        filters.to,
        tx
      );

      const openingBalance = toMoney(register.openingBalance + totals.openingNetBefore);
      const totalIn = toMoney(totals.totalIn);
      const totalOut = toMoney(totals.totalOut);
      const closingBalance = toMoney(openingBalance + totalIn - totalOut);

      return {
        registerId: register.id,
        registerCode: register.code,
        registerNameAr: register.nameAr,
        openingBalance,
        totalIn,
        totalOut,
        closingBalance,
        rows,
      };
    });
  }

  async getEmployeeCustodyMovements(
    companyId: string,
    employeeUserId: string
  ): Promise<EmployeeCustodyMovementRow[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('معرف الشركة مطلوب');
    }
    if (!employeeUserId || !isUuid(employeeUserId)) {
      throw new ValidationError('معرف الموظف مطلوب وبصيغة صحيحة');
    }
    return await this.voucherRepo.listEmployeeCustodyMovements(companyId, employeeUserId);
  }
}

export const defaultVoucherService = new VoucherService();
