import { withTenantTransaction } from '../db/transactionManager.js';
import { BankAccountRepository, defaultBankAccountRepository } from './bankAccountRepository.js';
import { BankReconcileRepository, defaultBankReconcileRepository } from './bankReconcileRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { ValidationError, NotFoundError, ConflictError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { toMinorUnits, fromMinorUnits } from '../lib/numeric.js';
import {
  BankStatementLine,
  CreateBankStatementLineInput,
  BankReconciliationWorkspace,
  BankReconciliation,
} from './bankingTypes.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(val: string, label: string): string {
  if (!val || typeof val !== 'string' || !DATE_RE.test(val.trim())) {
    throw new ValidationError(`${label}: صيغة التاريخ غير صحيحة (المتوقع YYYY-MM-DD)`);
  }
  return val.trim();
}

export class BankReconcileService {
  constructor(
    private accountRepo: BankAccountRepository = defaultBankAccountRepository,
    private reconRepo: BankReconcileRepository = defaultBankReconcileRepository,
    private auditService: AuditService = defaultAuditService
  ) {}

  async getWorkspace(
    companyId: string,
    bankAccountId: string,
    asOfDate?: string
  ): Promise<BankReconciliationWorkspace> {
    if (!companyId || !bankAccountId || !isUuid(bankAccountId)) {
      throw new ValidationError('معرف الحساب البنكي غير صالح');
    }
    const targetDate = asOfDate
      ? assertDate(asOfDate, 'asOfDate')
      : new Date().toISOString().slice(0, 10);

    return await withTenantTransaction(companyId, async (tx) => {
      const bankAccount = await this.accountRepo.findById(companyId, bankAccountId, tx);
      if (!bankAccount) {
        throw new NotFoundError('الحساب البنكي غير موجود');
      }

      const [statementLines, bookMovements, reconciliations] = await Promise.all([
        this.reconRepo.listStatementLines(companyId, bankAccountId, targetDate, tx),
        this.reconRepo.listPostedGlMovements(
          companyId,
          bankAccount.glAccountId,
          bankAccountId,
          targetDate,
          tx
        ),
        this.reconRepo.listReconciliations(companyId, bankAccountId, tx),
      ]);

      let bookUnits = toMinorUnits(bankAccount.openingBalance, 2);
      let unmatchedBookUnits = BigInt(0);
      let unmatchedBookCount = 0;

      for (const m of bookMovements) {
        const net = toMinorUnits(m.debit, 2) - toMinorUnits(m.credit, 2);
        bookUnits += net;
        if (!m.isMatched) {
          unmatchedBookUnits += net;
          unmatchedBookCount++;
        }
      }

      let unmatchedStmtUnits = BigInt(0);
      let matchedCount = 0;
      let unmatchedStatementCount = 0;

      for (const sl of statementLines) {
        const net = toMinorUnits(sl.creditAmount, 2) - toMinorUnits(sl.debitAmount, 2);
        if (sl.status === 'matched') {
          matchedCount++;
        } else {
          unmatchedStmtUnits += net;
          unmatchedStatementCount++;
        }
      }

      return {
        bankAccount,
        asOfDate: targetDate,
        bookBalance: fromMinorUnits(bookUnits, 2),
        statementLines,
        bookMovements,
        unmatchedStatementNet: fromMinorUnits(unmatchedStmtUnits, 2),
        unmatchedBookNet: fromMinorUnits(unmatchedBookUnits, 2),
        matchedCount,
        unmatchedStatementCount,
        unmatchedBookCount,
        reconciliations,
      };
    });
  }

  async addStatementLines(
    companyId: string,
    bankAccountId: string,
    lines: CreateBankStatementLineInput[],
    actorId?: string
  ): Promise<BankStatementLine[]> {
    if (!companyId || !bankAccountId || !isUuid(bankAccountId)) {
      throw new ValidationError('معرف الحساب البنكي غير صالح');
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new ValidationError('يجب إدخال سطر واحد على الأقل من كشف الحساب البنكي');
    }

    const sanitized: CreateBankStatementLineInput[] = lines.map((line, idx) => {
      const statementDate = assertDate(line.statementDate, `السطر ${idx + 1} - تاريخ الكشف`);
      const valueDate = line.valueDate ? assertDate(line.valueDate, `السطر ${idx + 1} - تاريخ القيمة`) : null;
      if (!line.description || typeof line.description !== 'string' || line.description.trim() === '') {
        throw new ValidationError(`السطر ${idx + 1}: البيان مطلوب`);
      }
      const debitUnits = toMinorUnits(line.debitAmount ?? 0, 2);
      const creditUnits = toMinorUnits(line.creditAmount ?? 0, 2);
      if (debitUnits < BigInt(0) || creditUnits < BigInt(0)) {
        throw new ValidationError(`السطر ${idx + 1}: المبالغ لا يمكن أن تكون سالبة`);
      }
      if ((debitUnits > BigInt(0) && creditUnits > BigInt(0)) || (debitUnits === BigInt(0) && creditUnits === BigInt(0))) {
        throw new ValidationError(`السطر ${idx + 1}: يجب إدخال قيمة في السحب (المدين) أو الإيداع (الدائن) فقط`);
      }
      return {
        statementDate,
        valueDate,
        reference: line.reference ?? null,
        description: line.description.trim(),
        debitAmount: fromMinorUnits(debitUnits, 2),
        creditAmount: fromMinorUnits(creditUnits, 2),
      };
    });

    return await withTenantTransaction(companyId, async (tx) => {
      const bankAccount = await this.accountRepo.findById(companyId, bankAccountId, tx);
      if (!bankAccount) {
        throw new NotFoundError('الحساب البنكي غير موجود');
      }
      if (!bankAccount.isActive) {
        throw new ValidationError('لا يمكن إضافة حركات كشف لحساب بنكي غير نشط');
      }

      const created = await this.reconRepo.insertStatementLines(
        companyId,
        bankAccountId,
        sanitized,
        actorId || null,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'BANK_STATEMENT_IMPORT',
          entityType: 'fin_bank_accounts',
          entityId: bankAccountId,
          metadata: {
            linesCount: created.length,
          },
        },
        { executor: tx }
      );

      return created;
    });
  }

  async matchStatementLine(
    companyId: string,
    bankAccountId: string,
    statementLineId: string,
    journalLineId: string,
    actorId?: string
  ): Promise<BankStatementLine> {
    if (!companyId || !isUuid(bankAccountId) || !isUuid(statementLineId) || !isUuid(journalLineId)) {
      throw new ValidationError('المعرفات المرسلة للمطابقة غير صالحة');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const bankAccount = await this.accountRepo.findById(companyId, bankAccountId, tx);
      if (!bankAccount) {
        throw new NotFoundError('الحساب البنكي غير موجود');
      }

      const stmtLine = await this.reconRepo.findStatementLineForUpdate(companyId, statementLineId, tx);
      if (!stmtLine || stmtLine.bankAccountId !== bankAccountId) {
        throw new NotFoundError('سطر كشف الحساب غير موجود ضمن هذا الحساب البنكي');
      }
      if (stmtLine.reconciliationId) {
        throw new ValidationError('لا يمكن تعديل مطابقة سطر مرتبط بتسوية معتمدة مسبقاً');
      }
      if (stmtLine.status === 'matched') {
        throw new ConflictError('سطر كشف الحساب مطابق مسبقاً');
      }

      const glLine = await this.reconRepo.findPostedGlLineForBank(
        companyId,
        bankAccount.glAccountId,
        journalLineId,
        tx
      );
      if (!glLine) {
        throw new NotFoundError('سطر القيد المحاسبي المرحل غير موجود أو لا يخص حساب الأستاذ الخاص بهذا البنك');
      }

      const alreadyMatched = await this.reconRepo.findMatchedByJournalLine(companyId, journalLineId, tx);
      if (alreadyMatched) {
        throw new ConflictError('سطر القيد المحاسبي مطابق مسبقاً مع حركة بنكية أخرى');
      }

      // Statement credit (deposit) -> GL debit (inflow). Statement debit (withdrawal) -> GL credit (outflow).
      const stmtNet = toMinorUnits(stmtLine.creditAmount, 2) - toMinorUnits(stmtLine.debitAmount, 2);
      const glNet = toMinorUnits(glLine.debit, 2) - toMinorUnits(glLine.credit, 2);

      if (stmtNet !== glNet) {
        throw new ValidationError(
          `تعارض في القيمة أو الاتجاه بين سطر الكشف (${fromMinorUnits(stmtNet, 2)}) وحركة الدفتر (${fromMinorUnits(glNet, 2)}).`
        );
      }

      const updated = await this.reconRepo.setStatementLineMatch(
        companyId,
        statementLineId,
        journalLineId,
        actorId || null,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'BANK_STATEMENT_MATCH',
          entityType: 'fin_bank_statement_lines',
          entityId: statementLineId,
          metadata: {
            bankAccountId,
            journalLineId,
            amount: fromMinorUnits(stmtNet < BigInt(0) ? -stmtNet : stmtNet, 2),
          },
        },
        { executor: tx }
      );

      return updated;
    });
  }

  async unmatchStatementLine(
    companyId: string,
    bankAccountId: string,
    statementLineId: string,
    actorId?: string
  ): Promise<BankStatementLine> {
    if (!companyId || !isUuid(bankAccountId) || !isUuid(statementLineId)) {
      throw new ValidationError('المعرفات المرسلة غير صالحة');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const stmtLine = await this.reconRepo.findStatementLineForUpdate(companyId, statementLineId, tx);
      if (!stmtLine || stmtLine.bankAccountId !== bankAccountId) {
        throw new NotFoundError('سطر كشف الحساب غير موجود ضمن هذا الحساب البنكي');
      }
      if (stmtLine.reconciliationId) {
        throw new ValidationError('لا يمكن فك مطابقة سطر مغلق ضمن تسوية معتمدة');
      }
      if (stmtLine.status === 'unmatched') {
        throw new ValidationError('سطر كشف الحساب غير مطابق بالفعل');
      }

      const updated = await this.reconRepo.setStatementLineMatch(
        companyId,
        statementLineId,
        null,
        actorId || null,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'BANK_STATEMENT_UNMATCH',
          entityType: 'fin_bank_statement_lines',
          entityId: statementLineId,
          metadata: { bankAccountId },
        },
        { executor: tx }
      );

      return updated;
    });
  }

  async completeReconciliation(
    companyId: string,
    bankAccountId: string,
    input: { statementEndDate: string; statementEndingBalance: string | number; memo?: string | null },
    actorId?: string
  ): Promise<BankReconciliation> {
    if (!companyId || !isUuid(bankAccountId)) {
      throw new ValidationError('معرف الحساب البنكي غير صالح');
    }
    const endDate = assertDate(input.statementEndDate, 'تاريخ نهاية كشف الحساب');
    if (input.statementEndingBalance === undefined || input.statementEndingBalance === null || String(input.statementEndingBalance).trim() === '') {
      throw new ValidationError('الرصيد الختامي بكشف البنك مطلوب');
    }
    const stmtEndUnits = toMinorUnits(input.statementEndingBalance, 2);

    return await withTenantTransaction(companyId, async (tx) => {
      const bankAccount = await this.accountRepo.lockForUpdate(companyId, bankAccountId, tx);
      if (!bankAccount) {
        throw new NotFoundError('الحساب البنكي غير موجود');
      }

      const [statementLines, bookMovements] = await Promise.all([
        this.reconRepo.listStatementLines(companyId, bankAccountId, endDate, tx),
        this.reconRepo.listPostedGlMovements(companyId, bankAccount.glAccountId, bankAccountId, endDate, tx),
      ]);

      let bookUnits = toMinorUnits(bankAccount.openingBalance, 2);
      let unmatchedBookUnits = BigInt(0);
      for (const m of bookMovements) {
        const net = toMinorUnits(m.debit, 2) - toMinorUnits(m.credit, 2);
        bookUnits += net;
        if (!m.isMatched) {
          unmatchedBookUnits += net;
        }
      }

      let unmatchedStmtUnits = BigInt(0);
      for (const sl of statementLines) {
        if (sl.status !== 'matched') {
          unmatchedStmtUnits += toMinorUnits(sl.creditAmount, 2) - toMinorUnits(sl.debitAmount, 2);
        }
      }

      // Adjusted Bank = statementEndingBalance + unmatchedBookUnits (deposits in transit - outstanding checks)
      // Adjusted Book = bookUnits + unmatchedStmtUnits (bank credits/fees not yet in book)
      const adjustedBank = stmtEndUnits + unmatchedBookUnits;
      const adjustedBook = bookUnits + unmatchedStmtUnits;
      const differenceUnits = adjustedBank - adjustedBook;

      if (differenceUnits !== BigInt(0)) {
        throw new ValidationError(
          `لا يمكن اعتماد التسوية لوجود فرق قدره (${fromMinorUnits(differenceUnits, 2)}) بين الرصيد البنكي المعدّل (${fromMinorUnits(adjustedBank, 2)}) والرصيد الدفتري المعدّل (${fromMinorUnits(adjustedBook, 2)}).`
        );
      }

      const recon = await this.reconRepo.createCompletedReconciliation(
        companyId,
        {
          bankAccountId,
          statementEndDate: endDate,
          statementEndingBalance: fromMinorUnits(stmtEndUnits, 2),
          bookBalance: fromMinorUnits(bookUnits, 2),
          unmatchedStatementNet: fromMinorUnits(unmatchedStmtUnits, 2),
          unmatchedBookNet: fromMinorUnits(unmatchedBookUnits, 2),
          differenceAmount: '0.00',
          memo: input.memo?.trim() || null,
          actorId: actorId || null,
        },
        tx
      );

      const linkedCount = await this.reconRepo.linkMatchedLinesToReconciliation(
        companyId,
        bankAccountId,
        endDate,
        recon.id,
        tx
      );

      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'BANK_RECONCILIATION_COMPLETE',
          entityType: 'fin_bank_reconciliations',
          entityId: recon.id,
          metadata: {
            bankAccountId,
            statementEndDate: endDate,
            statementEndingBalance: recon.statementEndingBalance,
            bookBalance: recon.bookBalance,
            linkedLinesCount: linkedCount,
          },
        },
        { executor: tx }
      );

      return recon;
    });
  }
}

export const defaultBankReconcileService = new BankReconcileService();
