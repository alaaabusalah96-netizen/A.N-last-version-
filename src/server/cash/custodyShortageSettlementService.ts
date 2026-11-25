import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { CustodyRepository, defaultCustodyRepository } from './custodyRepository.js';
import { CustodyGlResolver, defaultCustodyGlResolver } from './glResolver.js';
import { defaultAccountRepository, AccountRepository } from '../accounting/accountRepository.js';
import { defaultJournalService, JournalService } from '../accounting/journalService.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { defaultApprovalService, ApprovalService, PermissionChecker } from '../approvals/approvalService.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { toMoney } from '../lib/numeric.js';
import { resolveCompanyToday } from '../lib/calendarDate.js';
import { PERMISSIONS } from '../rbac/permissions.js';

/**
 * C13: shortage treatments beyond cash repayment.
 * - WRITE_OFF: the company absorbs the loss: Dr loss expense / Cr custody receivable.
 * - PAYROLL_DEDUCT: recover from salary: Dr employee payroll receivable / Cr custody receivable.
 * A treatment works only when the company enabled it and mapped its account. Nothing is enabled by default.
 * The manager chooses the treatment per case. Every settlement needs approval through the approval engine
 * (document type custody_shortage_settlement; default one step: custody:approve, never the requester).
 * Counts never post. Cash repayment by the employee is unchanged.
 */
export const SHORTAGE_SETTLEMENT_APPROVAL_TYPE = 'custody_shortage_settlement';
export type SettlementTreatment = 'WRITE_OFF' | 'PAYROLL_DEDUCT';
const TREATMENTS: SettlementTreatment[] = ['WRITE_OFF', 'PAYROLL_DEDUCT'];
const REQUIRED_ACCOUNT_TYPE: Record<SettlementTreatment, string> = { WRITE_OFF: 'expense', PAYROLL_DEDUCT: 'asset' };

export interface SettlementPolicyView {
  id: string;
  treatment: SettlementTreatment;
  version: number;
  enabled: boolean;
  accountId: string;
  ceiling: number | null;
}

export interface ShortageSettlementView {
  id: string;
  claimId: string;
  treatment: SettlementTreatment;
  amount: number;
  reason: string;
  requestedBy: string;
  createdAt: string;
  status: 'pending' | 'rejected' | 'posted';
  journalEntryId: string | null;
}

function parseMoney(value: unknown, label: string): number {
  if (value === undefined || value === null || value === '') throw new ValidationError(`${label} مطلوب`);
  const raw = String(value).trim();
  const num = Number(raw);
  if (!Number.isFinite(num)) throw new ValidationError(`${label} يجب أن يكون رقماً صالحاً`);
  const parts = raw.split('.');
  if (parts.length > 1 && parts[1].length > 2) throw new ValidationError(`${label} لا يمكن أن يحتوي على أكثر من منزلتين عشريتين`);
  const rounded = toMoney(num);
  if (rounded <= 0) throw new ValidationError(`${label} يجب أن يكون أكبر من صفر`);
  return rounded;
}

function assertTreatment(t: unknown): SettlementTreatment {
  if (typeof t !== 'string' || !TREATMENTS.includes(t as SettlementTreatment)) {
    throw new ValidationError('نوع التسوية غير معروف (WRITE_OFF أو PAYROLL_DEDUCT)');
  }
  return t as SettlementTreatment;
}

const REJECTED_SQL = `EXISTS (SELECT 1 FROM approval_requests r JOIN approval_decisions d ON d.request_id = r.id AND d.company_id = r.company_id
   WHERE r.company_id = s.company_id AND r.document_type = '${SHORTAGE_SETTLEMENT_APPROVAL_TYPE}' AND r.document_id = s.id AND d.decision = 'reject')`;

export class CustodyShortageSettlementService {
  constructor(
    private custodyRepo: CustodyRepository = defaultCustodyRepository,
    private accountRepo: AccountRepository = defaultAccountRepository,
    private journalService: Pick<JournalService, 'createDraftEntry' | 'postEntry'> = defaultJournalService,
    private auditService: Pick<AuditService, 'record'> = defaultAuditService,
    private glResolver: Pick<CustodyGlResolver, 'resolveAndAssertUsable'> = defaultCustodyGlResolver,
    private approvals: Pick<ApprovalService, 'requestApproval' | 'requestsForDocument' | 'decide'> = defaultApprovalService
  ) {}

  /** Publish a new policy version for one treatment. Old versions stay. */
  async setPolicy(
    companyId: string,
    treatmentInput: unknown,
    input: { enabled?: unknown; accountId?: unknown; ceiling?: unknown },
    actorId: string
  ): Promise<SettlementPolicyView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    const treatment = assertTreatment(treatmentInput);
    if (typeof input?.enabled !== 'boolean') throw new ValidationError('حقل التفعيل (enabled) مطلوب');
    const accountId = typeof input.accountId === 'string' ? input.accountId : '';
    if (!isUuid(accountId)) throw new ValidationError('الحساب المحاسبي مطلوب');
    const ceiling = input.ceiling === undefined || input.ceiling === null || input.ceiling === '' ? null : parseMoney(input.ceiling, 'الحد الأقصى');
    return await withTenantTransaction(companyId, async (tx) => {
      const acc = await this.accountRepo.findById(companyId, accountId, tx);
      if (!acc) throw new ValidationError('الحساب غير موجود في هذه الشركة');
      if (!acc.isActive || !acc.isPostable) throw new ValidationError(`الحساب (${acc.code}) يجب أن يكون نشطاً وقابلاً للترحيل`);
      if (acc.accountType !== REQUIRED_ACCOUNT_TYPE[treatment]) {
        throw new ValidationError(`الحساب (${acc.code}) يجب أن يكون من نوع ${REQUIRED_ACCOUNT_TYPE[treatment] === 'expense' ? 'المصروفات' : 'الأصول'} لهذه التسوية`);
      }
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`custody_settlement_policy:${companyId}:${treatment}`]);
      const cur = await tx.query<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0)::int AS v FROM custody_settlement_policies WHERE company_id = $1 AND treatment = $2`,
        [companyId, treatment]
      );
      const version = cur.rows[0].v + 1;
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO custody_settlement_policies (company_id, treatment, version, enabled, account_id, ceiling, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [companyId, treatment, version, input.enabled, accountId, ceiling, actorId]
      );
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_SETTLEMENT_POLICY_SET',
          entityType: 'custody_settlement_policies',
          entityId: ins.rows[0].id,
          metadata: { treatment, version, enabled: input.enabled, accountId, ceiling },
        },
        { executor: tx }
      );
      return { id: ins.rows[0].id, treatment, version, enabled: input.enabled as boolean, accountId, ceiling };
    });
  }

  async listPolicies(companyId: string): Promise<SettlementPolicyView[]> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const r = await tx.query<any>(
        `SELECT DISTINCT ON (treatment) id, treatment, version, enabled, account_id AS "accountId", ceiling
           FROM custody_settlement_policies WHERE company_id = $1 ORDER BY treatment, version DESC`,
        [companyId]
      );
      return r.rows.map((x: any) => ({
        id: x.id, treatment: x.treatment, version: Number(x.version), enabled: x.enabled, accountId: x.accountId,
        ceiling: x.ceiling === null ? null : toMoney(Number(x.ceiling)),
      }));
    });
  }

  private async latestPolicy(companyId: string, treatment: SettlementTreatment, tx: DbExecutor): Promise<SettlementPolicyView | null> {
    const r = await tx.query<any>(
      `SELECT id, treatment, version, enabled, account_id AS "accountId", ceiling FROM custody_settlement_policies
        WHERE company_id = $1 AND treatment = $2 ORDER BY version DESC LIMIT 1`,
      [companyId, treatment]
    );
    const x = r.rows[0];
    if (!x) return null;
    return { id: x.id, treatment: x.treatment, version: Number(x.version), enabled: x.enabled, accountId: x.accountId, ceiling: x.ceiling === null ? null : toMoney(Number(x.ceiling)) };
  }

  /** Amount of the claim not yet repaid, posted or reserved by a pending settlement. */
  private async availableOnClaim(companyId: string, claimId: string, tx: DbExecutor): Promise<number> {
    const r = await tx.query<{ amount: string; repaid: string; reserved: string }>(
      `SELECT c.amount::text AS amount,
              COALESCE((SELECT SUM(amount) FROM custody_shortage_repayments WHERE company_id = c.company_id AND claim_id = c.id), 0)::text AS repaid,
              COALESCE((SELECT SUM(s.amount) FROM custody_shortage_settlements s
                         WHERE s.company_id = c.company_id AND s.claim_id = c.id AND NOT ${REJECTED_SQL}), 0)::text AS reserved
         FROM custody_shortage_claims c WHERE c.company_id = $1 AND c.id = $2`,
      [companyId, claimId]
    );
    const x = r.rows[0];
    return toMoney(Number(x.amount) - Number(x.repaid) - Number(x.reserved));
  }

  /** Ask to settle part or all of a claim by write-off or payroll deduction. Posts nothing until approved. */
  async requestSettlement(
    companyId: string,
    claimId: string,
    input: { treatment?: unknown; amount?: unknown; reason?: unknown },
    actorId: string
  ): Promise<ShortageSettlementView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (!claimId || !isUuid(claimId)) throw new ValidationError('معرف المطالبة غير صالح');
    const treatment = assertTreatment(input?.treatment);
    const amount = parseMoney(input?.amount, 'مبلغ التسوية');
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 3) throw new ValidationError('سبب التسوية مطلوب');
    return await withTenantTransaction(companyId, async (tx) => {
      const claimRes = await tx.query<{ custody_id: string }>(
        `SELECT custody_id FROM custody_shortage_claims WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        [companyId, claimId]
      );
      if (!claimRes.rows[0]) throw new NotFoundError('مطالبة العجز غير موجودة');
      const custody = await this.custodyRepo.findByIdForUpdate(companyId, claimRes.rows[0].custody_id, tx);
      if (!custody) throw new NotFoundError('العهدة النقدية غير موجودة');
      if (custody.status !== 'open') throw new ValidationError('التسوية متاحة للعهدة المفتوحة فقط');
      const policy = await this.latestPolicy(companyId, treatment, tx);
      if (!policy || !policy.enabled) throw new ValidationError('هذه التسوية غير مفعّلة لدى الشركة');
      if (policy.ceiling !== null && amount > policy.ceiling) {
        throw new ValidationError(`مبلغ التسوية (${amount.toFixed(2)}) يتجاوز الحد الأقصى المسموح (${policy.ceiling.toFixed(2)})`);
      }
      const available = await this.availableOnClaim(companyId, claimId, tx);
      if (amount > available) {
        throw new ValidationError(`مبلغ التسوية (${amount.toFixed(2)}) أكبر من المتاح على المطالبة (${available.toFixed(2)})`);
      }
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO custody_shortage_settlements (company_id, claim_id, treatment, amount, reason, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [companyId, claimId, treatment, amount, reason, actorId]
      );
      const id = ins.rows[0].id;
      await this.approvals.requestApproval(companyId, SHORTAGE_SETTLEMENT_APPROVAL_TYPE, id, PERMISSIONS.CUSTODY_APPROVE, actorId);
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_SHORTAGE_SETTLE_REQUEST',
          entityType: 'custody_records',
          entityId: custody.id,
          metadata: { custodyNo: custody.custodyNo, claimId, settlementId: id, treatment, amount, reason },
        },
        { executor: tx }
      );
      return (await this.loadSettlements(companyId, claimId, tx)).find((s) => s.id === id)!;
    });
  }

  /** One approval step. When the last step approves, the settlement posts in the same transaction. */
  async approveSettlement(
    companyId: string,
    settlementId: string,
    actorId: string,
    isPlatformAdmin: boolean,
    checkPermission: PermissionChecker
  ): Promise<ShortageSettlementView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (!settlementId || !isUuid(settlementId)) throw new ValidationError('معرف التسوية غير صالح');
    if (!checkPermission) throw new ForbiddenError('مسار الموافقات يتطلب التحقق من صلاحية الخطوة');
    return await withTenantTransaction(companyId, async (tx) => {
      const { settlement, claimId, custodyId } = await this.lockSettlement(companyId, settlementId, tx);
      if (settlement.status !== 'pending') throw new ValidationError('التسوية تم البت فيها مسبقاً');
      const reqs = await this.approvals.requestsForDocument(companyId, SHORTAGE_SETTLEMENT_APPROVAL_TYPE, settlementId);
      const req = reqs[reqs.length - 1];
      if (!req) throw new NotFoundError('طلب الموافقة غير موجود');
      const after = req.status === 'pending'
        ? (await this.approvals.decide(companyId, req.id, 'approve', null, actorId, checkPermission)).status
        : req.status;
      if (after !== 'approved') return (await this.loadSettlements(companyId, claimId, tx)).find((s) => s.id === settlementId)!;

      const custody = await this.custodyRepo.findByIdForUpdate(companyId, custodyId, tx);
      if (!custody) throw new NotFoundError('العهدة النقدية غير موجودة');
      if (custody.status !== 'open') throw new ValidationError('التسوية متاحة للعهدة المفتوحة فقط');
      const policy = await this.latestPolicy(companyId, settlement.treatment, tx);
      if (!policy || !policy.enabled) throw new ValidationError('هذه التسوية لم تعد مفعّلة لدى الشركة');
      const acc = await this.accountRepo.findById(companyId, policy.accountId, tx);
      if (!acc || !acc.isActive || !acc.isPostable) throw new ValidationError('حساب التسوية المربوط غير صالح للترحيل');
      const gl = await this.glResolver.resolveAndAssertUsable(companyId, tx);
      if (gl.custodyReceivableAccountId === policy.accountId) {
        throw new ValidationError('حساب التسوية يطابق حساب ذمة العهد');
      }
      const entryDate = await resolveCompanyToday(companyId, tx);
      const docRef = custody.custodyNo || custodyId;
      const label = settlement.treatment === 'WRITE_OFF' ? 'إعدام عجز عهدة' : 'خصم عجز عهدة من الراتب';
      const draft = await this.journalService.createDraftEntry(
        companyId,
        {
          entryDate,
          memo: `${label} رقم ${docRef}`,
          lines: [
            { accountId: policy.accountId, debit: settlement.amount, credit: 0, lineMemo: `${label} ${docRef}` },
            { accountId: gl.custodyReceivableAccountId, debit: 0, credit: settlement.amount, lineMemo: `${label} ${docRef} - ذمة عهد الموظفين` },
          ],
        },
        actorId,
        isPlatformAdmin,
        tx
      );
      const posted = await this.journalService.postEntry(companyId, draft.id, actorId, isPlatformAdmin, tx);
      await tx.query(
        `INSERT INTO custody_shortage_settlement_postings (company_id, settlement_id, journal_entry_id, posted_by) VALUES ($1,$2,$3,$4)`,
        [companyId, settlementId, posted.id, actorId]
      );
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_SHORTAGE_SETTLE_POST',
          entityType: 'custody_records',
          entityId: custodyId,
          metadata: { custodyNo: custody.custodyNo, claimId, settlementId, treatment: settlement.treatment, amount: settlement.amount, journalEntryId: posted.id },
        },
        { executor: tx }
      );
      return (await this.loadSettlements(companyId, claimId, tx)).find((s) => s.id === settlementId)!;
    });
  }

  async rejectSettlement(
    companyId: string,
    settlementId: string,
    reason: string,
    actorId: string,
    checkPermission: PermissionChecker
  ): Promise<ShortageSettlementView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (!settlementId || !isUuid(settlementId)) throw new ValidationError('معرف التسوية غير صالح');
    const why = (reason || '').trim();
    if (!why) throw new ValidationError('سبب الرفض مطلوب');
    if (!checkPermission) throw new ForbiddenError('مسار الموافقات يتطلب التحقق من صلاحية الخطوة');
    return await withTenantTransaction(companyId, async (tx) => {
      const { settlement, claimId } = await this.lockSettlement(companyId, settlementId, tx);
      if (settlement.status !== 'pending') throw new ValidationError('التسوية تم البت فيها مسبقاً');
      const reqs = await this.approvals.requestsForDocument(companyId, SHORTAGE_SETTLEMENT_APPROVAL_TYPE, settlementId);
      const req = reqs[reqs.length - 1];
      if (!req) throw new NotFoundError('طلب الموافقة غير موجود');
      await this.approvals.decide(companyId, req.id, 'reject', why, actorId, checkPermission);
      return (await this.loadSettlements(companyId, claimId, tx)).find((s) => s.id === settlementId)!;
    });
  }

  async listForClaim(companyId: string, claimId: string): Promise<ShortageSettlementView[]> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (!claimId || !isUuid(claimId)) throw new ValidationError('معرف المطالبة غير صالح');
    return await withTenantTransaction(companyId, async (tx) => this.loadSettlements(companyId, claimId, tx));
  }

  /** Lock the claim first (same order as request and repay), then read the settlement. */
  private async lockSettlement(companyId: string, settlementId: string, tx: DbExecutor) {
    const probe = await tx.query<{ claim_id: string }>(
      `SELECT claim_id FROM custody_shortage_settlements WHERE company_id = $1 AND id = $2`,
      [companyId, settlementId]
    );
    if (!probe.rows[0]) throw new NotFoundError('التسوية غير موجودة');
    const claimId = probe.rows[0].claim_id;
    const claim = await tx.query<{ custody_id: string }>(
      `SELECT custody_id FROM custody_shortage_claims WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, claimId]
    );
    const settlement = (await this.loadSettlements(companyId, claimId, tx)).find((s) => s.id === settlementId)!;
    return { settlement, claimId, custodyId: claim.rows[0].custody_id };
  }

  async loadSettlements(companyId: string, claimId: string, tx: DbExecutor): Promise<ShortageSettlementView[]> {
    const r = await tx.query<any>(
      `SELECT s.id, s.claim_id AS "claimId", s.treatment, s.amount, s.reason, s.requested_by AS "requestedBy", s.created_at AS "createdAt",
              p.journal_entry_id AS "journalEntryId", ${REJECTED_SQL} AS rejected
         FROM custody_shortage_settlements s
         LEFT JOIN custody_shortage_settlement_postings p ON p.settlement_id = s.id AND p.company_id = s.company_id
        WHERE s.company_id = $1 AND s.claim_id = $2 ORDER BY s.created_at, s.id`,
      [companyId, claimId]
    );
    return r.rows.map((x: any) => ({
      id: x.id,
      claimId: x.claimId,
      treatment: x.treatment,
      amount: toMoney(Number(x.amount)),
      reason: x.reason,
      requestedBy: x.requestedBy,
      createdAt: x.createdAt instanceof Date ? x.createdAt.toISOString() : x.createdAt,
      status: x.journalEntryId ? 'posted' : x.rejected ? 'rejected' : 'pending',
      journalEntryId: x.journalEntryId ?? null,
    }));
  }
}

export const defaultCustodyShortageSettlementService = new CustodyShortageSettlementService();
