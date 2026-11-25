import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { CustodyRepository, defaultCustodyRepository } from './custodyRepository.js';
import { CashRegisterRepository, defaultCashRegisterRepository } from './cashRegisterRepository.js';
import { CustodyGlResolver, defaultCustodyGlResolver } from './glResolver.js';
import { defaultAccountRepository, AccountRepository } from '../accounting/accountRepository.js';
import { defaultJournalService, JournalService } from '../accounting/journalService.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { toMoney } from '../lib/numeric.js';
import { resolveCompanyToday } from '../lib/calendarDate.js';
import { defaultApprovalService, ApprovalService, PermissionChecker } from '../approvals/approvalService.js';
import { PERMISSIONS } from '../rbac/permissions.js';

/** Approval-engine document type for custody vouchers (C1-c). */
export const CUSTODY_VOUCHER_APPROVAL_TYPE = 'custody_voucher';

export interface CustodyVoucherLine {
  lineNo: number;
  expenseAccountId: string;
  amount: number;
  memo: string | null;
}

export interface CustodyVoucher {
  id: string;
  companyId: string;
  custodyId: string;
  voucherSeq: number;
  voucherNo: string;
  status: 'submitted' | 'approved' | 'rejected' | 'reversed';
  totalAmount: number;
  memo: string | null;
  submittedBy: string;
  submittedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  rejectReason: string | null;
  journalEntryId: string | null;
  reversedBy: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  reversalJournalEntryId: string | null;
  lines: CustodyVoucherLine[];
}

export interface SubmitCustodyVoucherInput {
  lines: Array<{ expenseAccountId: string; amount: number | string; memo?: string | null }>;
  memo?: string | null;
}

/** Sum of expense and cash-return movements already settled against a custody. */
export async function getCustodySettledTotals(
  companyId: string,
  custodyId: string,
  tx: DbExecutor
): Promise<{ expense: number; cashReturn: number }> {
  const res = await tx.query<{ expense: string; cash_return: string }>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE movement_type = 'settle_expense'), 0)
         - COALESCE(SUM(amount) FILTER (WHERE movement_type = 'reverse'), 0) AS expense,
       COALESCE(SUM(amount) FILTER (WHERE movement_type IN ('settle_return','shortage_repay')), 0) AS cash_return
     FROM custody_movements
     WHERE company_id = $1 AND custody_id = $2`,
    [companyId, custodyId]
  );
  const row = res.rows[0];
  return { expense: toMoney(Number(row?.expense ?? 0)), cashReturn: toMoney(Number(row?.cash_return ?? 0)) };
}

export async function countPendingCustodyVouchers(
  companyId: string,
  custodyId: string,
  tx: DbExecutor
): Promise<number> {
  const res = await tx.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM custody_vouchers
     WHERE company_id = $1 AND custody_id = $2 AND status = 'submitted'`,
    [companyId, custodyId]
  );
  return Number(res.rows[0]?.n ?? 0);
}

function parseMoney(value: unknown, label: string): number {
  if (value === undefined || value === null || value === '') throw new ValidationError(`${label} مطلوب`);
  const raw = String(value).trim();
  const num = Number(raw);
  if (!Number.isFinite(num)) throw new ValidationError(`${label} يجب أن يكون رقماً صالحاً`);
  const parts = raw.split('.');
  if (parts.length > 1 && parts[1].length > 2) {
    throw new ValidationError(`${label} لا يمكن أن يحتوي على أكثر من منزلتين عشريتين`);
  }
  const rounded = toMoney(num);
  if (rounded <= 0) throw new ValidationError(`${label} يجب أن يكون أكبر من صفر`);
  return rounded;
}

const VOUCHER_SELECT = `
  SELECT id, company_id AS "companyId", custody_id AS "custodyId", voucher_seq AS "voucherSeq",
         voucher_no AS "voucherNo", status, total_amount AS "totalAmount", memo,
         submitted_by AS "submittedBy", submitted_at AS "submittedAt", decided_by AS "decidedBy",
         decided_at AS "decidedAt", reject_reason AS "rejectReason", journal_entry_id AS "journalEntryId",
         reversed_by AS "reversedBy", reversed_at AS "reversedAt", reversal_reason AS "reversalReason",
         reversal_journal_entry_id AS "reversalJournalEntryId"
  FROM custody_vouchers`;

async function loadLines(companyId: string, voucherId: string, tx: DbExecutor): Promise<CustodyVoucherLine[]> {
  const res = await tx.query<{ lineNo: number; expenseAccountId: string; amount: string; memo: string | null }>(
    `SELECT line_no AS "lineNo", expense_account_id AS "expenseAccountId", amount, memo
     FROM custody_voucher_lines WHERE company_id = $1 AND voucher_id = $2 ORDER BY line_no`,
    [companyId, voucherId]
  );
  return res.rows.map((r) => ({
    lineNo: Number(r.lineNo),
    expenseAccountId: r.expenseAccountId,
    amount: toMoney(Number(r.amount)),
    memo: r.memo,
  }));
}

function mapVoucher(row: any, lines: CustodyVoucherLine[]): CustodyVoucher {
  return {
    ...row,
    voucherSeq: Number(row.voucherSeq),
    totalAmount: toMoney(Number(row.totalAmount)),
    submittedAt: row.submittedAt instanceof Date ? row.submittedAt.toISOString() : row.submittedAt,
    decidedAt: row.decidedAt instanceof Date ? row.decidedAt.toISOString() : row.decidedAt,
    reversedAt: row.reversedAt instanceof Date ? row.reversedAt.toISOString() : row.reversedAt,
    lines,
  };
}

export class CustodyVoucherService {
  constructor(
    private custodyRepo: CustodyRepository = defaultCustodyRepository,
    private registerRepo: CashRegisterRepository = defaultCashRegisterRepository,
    private accountRepo: AccountRepository = defaultAccountRepository,
    private journalService: Pick<JournalService, 'createDraftEntry' | 'postEntry' | 'reverseEntry'> = defaultJournalService,
    private auditService: Pick<AuditService, 'record'> = defaultAuditService,
    private glResolver: Pick<CustodyGlResolver, 'resolveAndAssertUsable'> = defaultCustodyGlResolver,
    private approvals: Pick<ApprovalService, 'hasPolicy' | 'requestApproval' | 'requestsForDocument' | 'decide'> = defaultApprovalService
  ) {}

  /**
   * C1-c. When the company published an approval policy for custody vouchers, the decision goes
   * through the engine. Without a policy nothing changes: one CUSTODY_APPROVE gate, no engine records.
   * Returns the engine request, creating it for a voucher submitted before the policy existed
   * (requester = the voucher's submitter, so separation of duties still holds).
   */
  private async ensureApprovalRequest(companyId: string, v: { id: string; submittedBy: string }) {
    const existing = await this.approvals.requestsForDocument(companyId, CUSTODY_VOUCHER_APPROVAL_TYPE, v.id);
    const last = existing[existing.length - 1];
    if (last) return last;
    return await this.approvals.requestApproval(
      companyId, CUSTODY_VOUCHER_APPROVAL_TYPE, v.id, PERMISSIONS.CUSTODY_APPROVE, v.submittedBy, { requirePolicy: true }
    );
  }

  private async assertExpenseAccount(companyId: string, accountId: string, idx: number, tx: DbExecutor) {
    const acc = await this.accountRepo.findById(companyId, accountId, tx);
    if (!acc) throw new ValidationError(`البند رقم ${idx + 1}: حساب المصروف غير موجود في الشركة`);
    if (!acc.isActive) throw new ValidationError(`البند رقم ${idx + 1}: حساب المصروف (${acc.code}) غير نشط`);
    if (!acc.isPostable) throw new ValidationError(`البند رقم ${idx + 1}: حساب المصروف (${acc.code}) غير قابل للترحيل`);
    if (acc.accountType !== 'expense') {
      throw new ValidationError(`البند رقم ${idx + 1}: الحساب (${acc.code}) يجب أن يكون من نوع المصروفات`);
    }
  }

  async submitVoucher(
    companyId: string,
    custodyId: string,
    input: SubmitCustodyVoucherInput,
    actorId: string
  ): Promise<CustodyVoucher> {
    if (!companyId) throw new ValidationError('معرف الشركة مطلوب');
    if (!custodyId || !isUuid(custodyId)) throw new ValidationError('معرف العهدة غير صالح');
    if (!input || !Array.isArray(input.lines) || input.lines.length === 0) {
      throw new ValidationError('بنود الحافظة مطلوبة');
    }
    const lines = input.lines.map((l, i) => {
      if (!l || typeof l.expenseAccountId !== 'string' || !isUuid(l.expenseAccountId)) {
        throw new ValidationError(`البند رقم ${i + 1}: حساب المصروف مطلوب`);
      }
      return {
        expenseAccountId: l.expenseAccountId,
        amount: parseMoney(l.amount, `مبلغ البند رقم ${i + 1}`),
        memo: l.memo?.trim() || null,
      };
    });
    const total = toMoney(lines.reduce((s, l) => s + l.amount, 0));

    return await withTenantTransaction(companyId, async (tx) => {
      const custody = await this.custodyRepo.findByIdForUpdate(companyId, custodyId, tx);
      if (!custody) throw new NotFoundError('العهدة النقدية غير موجودة');
      if (custody.status !== 'open') {
        throw new ValidationError('لا يمكن تقديم حافظة إلا على عهدة مفتوحة (مصروفة وغير مسوّاة)');
      }
      const done = await getCustodySettledTotals(companyId, custodyId, tx);
      const remaining = toMoney(custody.amount - done.expense - done.cashReturn);
      if (total > remaining) {
        throw new ValidationError(
          `إجمالي الحافظة (${total.toFixed(2)}) يتجاوز الرصيد المتبقي من العهدة (${remaining.toFixed(2)})`
        );
      }
      for (let i = 0; i < lines.length; i++) {
        await this.assertExpenseAccount(companyId, lines[i].expenseAccountId, i, tx);
      }
      const seqRes = await tx.query<{ n: string }>(
        `SELECT COALESCE(MAX(voucher_seq), 0) + 1 AS n FROM custody_vouchers WHERE company_id = $1 AND custody_id = $2`,
        [companyId, custodyId]
      );
      const seq = Number(seqRes.rows[0].n);
      const voucherNo = `${custody.custodyNo || custodyId.slice(0, 8)}-V${String(seq).padStart(2, '0')}`;
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO custody_vouchers (company_id, custody_id, voucher_seq, voucher_no, total_amount, memo, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [companyId, custodyId, seq, voucherNo, total, input.memo?.trim() || null, actorId]
      );
      const voucherId = ins.rows[0].id;
      for (let i = 0; i < lines.length; i++) {
        await tx.query(
          `INSERT INTO custody_voucher_lines (company_id, voucher_id, line_no, expense_account_id, amount, memo)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [companyId, voucherId, i + 1, lines[i].expenseAccountId, lines[i].amount, lines[i].memo]
        );
      }
      if (await this.approvals.hasPolicy(companyId, CUSTODY_VOUCHER_APPROVAL_TYPE)) {
        await this.approvals.requestApproval(
          companyId, CUSTODY_VOUCHER_APPROVAL_TYPE, voucherId, PERMISSIONS.CUSTODY_APPROVE, actorId, { requirePolicy: true }
        );
      }
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_VOUCHER_SUBMIT',
          entityType: 'custody_vouchers',
          entityId: voucherId,
          metadata: { custodyId, voucherNo, total, lineCount: lines.length },
        },
        { executor: tx }
      );
      return (await this.loadVoucher(companyId, voucherId, tx))!;
    });
  }

  private async loadVoucher(companyId: string, id: string, tx: DbExecutor, forUpdate = false) {
    const res = await tx.query(`${VOUCHER_SELECT} WHERE company_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`, [
      companyId,
      id,
    ]);
    if (res.rows.length === 0) return null;
    return mapVoucher(res.rows[0], await loadLines(companyId, id, tx));
  }

  async listVouchers(companyId: string, custodyId: string): Promise<CustodyVoucher[]> {
    if (!companyId) throw new ValidationError('معرف الشركة مطلوب');
    if (!custodyId || !isUuid(custodyId)) throw new ValidationError('معرف العهدة غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const res = await tx.query(`${VOUCHER_SELECT} WHERE company_id = $1 AND custody_id = $2 ORDER BY voucher_seq`, [
        companyId,
        custodyId,
      ]);
      const out: CustodyVoucher[] = [];
      for (const row of res.rows) out.push(mapVoucher(row, await loadLines(companyId, (row as any).id, tx)));
      return out;
    });
  }

  async rejectVoucher(
    companyId: string,
    voucherId: string,
    reason: string,
    actorId: string,
    checkPermission?: PermissionChecker
  ): Promise<CustodyVoucher> {
    if (!voucherId || !isUuid(voucherId)) throw new ValidationError('معرف الحافظة غير صالح');
    const why = (reason || '').trim();
    if (!why) throw new ValidationError('سبب الرفض مطلوب');
    return await withTenantTransaction(companyId, async (tx) => {
      const v = await this.loadVoucher(companyId, voucherId, tx, true);
      if (!v) throw new NotFoundError('الحافظة غير موجودة');
      if (v.status !== 'submitted') throw new ValidationError('لا يمكن رفض حافظة تم البت فيها مسبقاً');
      if (await this.approvals.hasPolicy(companyId, CUSTODY_VOUCHER_APPROVAL_TYPE)) {
        if (!checkPermission) throw new ForbiddenError('مسار الموافقات يتطلب التحقق من صلاحية الخطوة');
        const req = await this.ensureApprovalRequest(companyId, v);
        if (req.status === 'pending') {
          await this.approvals.decide(companyId, req.id, 'reject', why, actorId, checkPermission);
        }
      }
      await tx.query(
        `UPDATE custody_vouchers SET status='rejected', decided_by=$3, decided_at=NOW(), reject_reason=$4, updated_at=NOW()
         WHERE company_id=$1 AND id=$2`,
        [companyId, voucherId, actorId, why]
      );
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_VOUCHER_REJECT',
          entityType: 'custody_vouchers',
          entityId: voucherId,
          metadata: { custodyId: v.custodyId, voucherNo: v.voucherNo },
        },
        { executor: tx }
      );
      return (await this.loadVoucher(companyId, voucherId, tx))!;
    });
  }

  async reverseVoucher(
    companyId: string,
    voucherId: string,
    reason: string,
    actorId: string,
    isPlatformAdmin = false
  ): Promise<CustodyVoucher> {
    if (!voucherId || !isUuid(voucherId)) throw new ValidationError('معرف الحافظة غير صالح');
    const why = (reason || '').trim();
    if (!why) throw new ValidationError('سبب العكس مطلوب');
    return await withTenantTransaction(companyId, async (tx) => {
      const probe = await this.loadVoucher(companyId, voucherId, tx);
      if (!probe) throw new NotFoundError('الحافظة غير موجودة');
      const custody = await this.custodyRepo.findByIdForUpdate(companyId, probe.custodyId, tx);
      if (!custody) throw new NotFoundError('العهدة النقدية غير موجودة');
      const v = (await this.loadVoucher(companyId, voucherId, tx, true))!;
      if (v.status !== 'approved') throw new ValidationError('لا يمكن عكس إلا حافظة معتمدة');
      if (custody.status !== 'open') {
        throw new ValidationError('لا يمكن عكس حافظة بعد تسوية العهدة نهائياً');
      }
      const register = await this.registerRepo.findById(companyId, custody.registerId, tx);
      if (!register) throw new NotFoundError('الصندوق المرتبط بالعهدة غير موجود');

      const reversal = await this.journalService.reverseEntry(
        companyId,
        v.journalEntryId!,
        actorId,
        `عكس حافظة عهدة ${v.voucherNo}: ${why}`,
        isPlatformAdmin,
        tx
      );
      for (const l of v.lines) {
        await this.custodyRepo.insertMovement(
          companyId,
          {
            custodyId: custody.id,
            registerId: register.id,
            movementType: 'reverse',
            direction: 'none',
            amount: l.amount,
            expenseAccountId: l.expenseAccountId,
            journalEntryId: reversal.id,
            memo: `عكس حافظة ${v.voucherNo}`,
            createdBy: actorId || null,
          },
          tx
        );
      }
      await tx.query(
        `UPDATE custody_vouchers SET status='reversed', reversed_by=$3, reversed_at=NOW(), reversal_reason=$4,
           reversal_journal_entry_id=$5, updated_at=NOW() WHERE company_id=$1 AND id=$2`,
        [companyId, voucherId, actorId, why, reversal.id]
      );
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_VOUCHER_REVERSE',
          entityType: 'custody_vouchers',
          entityId: voucherId,
          metadata: {
            custodyId: custody.id,
            voucherNo: v.voucherNo,
            total: v.totalAmount,
            reversalJournalEntryId: reversal.id,
          },
        },
        { executor: tx }
      );
      return (await this.loadVoucher(companyId, voucherId, tx))!;
    });
  }

  async approveVoucher(
    companyId: string,
    voucherId: string,
    actorId: string,
    isPlatformAdmin = false,
    checkPermission?: PermissionChecker
  ): Promise<CustodyVoucher> {
    if (!voucherId || !isUuid(voucherId)) throw new ValidationError('معرف الحافظة غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const probe = await this.loadVoucher(companyId, voucherId, tx);
      if (!probe) throw new NotFoundError('الحافظة غير موجودة');
      // Lock order: custody first, then voucher (same as submit).
      const custody = await this.custodyRepo.findByIdForUpdate(companyId, probe.custodyId, tx);
      if (!custody) throw new NotFoundError('العهدة النقدية غير موجودة');
      const v = (await this.loadVoucher(companyId, voucherId, tx, true))!;
      if (v.status !== 'submitted') throw new ValidationError('لا يمكن اعتماد حافظة تم البت فيها مسبقاً');
      if (!isPlatformAdmin && v.submittedBy === actorId) {
        throw new ForbiddenError('فصل المهام: لا يمكن لمقدّم الحافظة اعتمادها بنفسه');
      }
      if (custody.status !== 'open') throw new ValidationError('العهدة ليست مفتوحة');

      // C1-c: with a published policy, every step is recorded in the engine; the voucher is
      // posted only when the last step approves. A middle step leaves the voucher 'submitted'.
      if (await this.approvals.hasPolicy(companyId, CUSTODY_VOUCHER_APPROVAL_TYPE)) {
        if (!checkPermission) throw new ForbiddenError('مسار الموافقات يتطلب التحقق من صلاحية الخطوة');
        const req = await this.ensureApprovalRequest(companyId, v);
        let state = req.status;
        if (state === 'pending') {
          state = (await this.approvals.decide(companyId, req.id, 'approve', null, actorId, checkPermission)).status;
        }
        if (state !== 'approved') return (await this.loadVoucher(companyId, voucherId, tx))!;
      }

      const done = await getCustodySettledTotals(companyId, custody.id, tx);
      const remaining = toMoney(custody.amount - done.expense - done.cashReturn);
      if (v.totalAmount > remaining) {
        throw new ValidationError(
          `إجمالي الحافظة (${v.totalAmount.toFixed(2)}) يتجاوز الرصيد المتبقي من العهدة (${remaining.toFixed(2)})`
        );
      }
      for (let i = 0; i < v.lines.length; i++) {
        await this.assertExpenseAccount(companyId, v.lines[i].expenseAccountId, i, tx);
      }
      const register = await this.registerRepo.findById(companyId, custody.registerId, tx);
      if (!register) throw new NotFoundError('الصندوق المرتبط بالعهدة غير موجود');

      const gl = await this.glResolver.resolveAndAssertUsable(companyId, tx);
      const entryDate = await resolveCompanyToday(companyId, tx);
      const jeLines = v.lines.map((l) => ({
        accountId: l.expenseAccountId,
        debit: l.amount,
        credit: 0,
        lineMemo: l.memo || `مصروف حافظة ${v.voucherNo}`,
      }));
      jeLines.push({
        accountId: gl.custodyReceivableAccountId,
        debit: 0,
        credit: v.totalAmount,
        lineMemo: `تخفيض ذمة العهدة بحافظة ${v.voucherNo}`,
      });
      const draft = await this.journalService.createDraftEntry(
        companyId,
        { entryDate, memo: `حافظة عهدة ${v.voucherNo}`, lines: jeLines },
        actorId,
        isPlatformAdmin,
        tx
      );
      const posted = await this.journalService.postEntry(companyId, draft.id, actorId, isPlatformAdmin, tx);

      for (const l of v.lines) {
        await this.custodyRepo.insertMovement(
          companyId,
          {
            custodyId: custody.id,
            registerId: register.id,
            movementType: 'settle_expense',
            direction: 'none',
            amount: l.amount,
            expenseAccountId: l.expenseAccountId,
            journalEntryId: posted.id,
            memo: l.memo || `مصروف حافظة ${v.voucherNo}`,
            createdBy: actorId || null,
          },
          tx
        );
      }
      await tx.query(
        `UPDATE custody_vouchers SET status='approved', decided_by=$3, decided_at=NOW(), journal_entry_id=$4, updated_at=NOW()
         WHERE company_id=$1 AND id=$2`,
        [companyId, voucherId, actorId, posted.id]
      );

      const newRemaining = toMoney(remaining - v.totalAmount);
      let autoSettled = false;
      if (newRemaining === 0) {
        await this.custodyRepo.markSettled(
          companyId,
          custody.id,
          actorId,
          posted.id,
          toMoney(done.expense + v.totalAmount),
          done.cashReturn,
          null,
          tx
        );
        autoSettled = true;
      }
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_VOUCHER_APPROVE',
          entityType: 'custody_vouchers',
          entityId: voucherId,
          metadata: {
            custodyId: custody.id,
            voucherNo: v.voucherNo,
            total: v.totalAmount,
            remainingAfter: newRemaining,
            autoSettled,
            journalEntryId: posted.id,
          },
        },
        { executor: tx }
      );
      return (await this.loadVoucher(companyId, voucherId, tx))!;
    });
  }
}

export const defaultCustodyVoucherService = new CustodyVoucherService();
