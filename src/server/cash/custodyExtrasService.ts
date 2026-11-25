import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { CustodyRepository, defaultCustodyRepository } from './custodyRepository.js';
import { CashRegisterRepository, defaultCashRegisterRepository } from './cashRegisterRepository.js';
import { CustodyGlResolver, defaultCustodyGlResolver } from './glResolver.js';
import { defaultJournalService, JournalService } from '../accounting/journalService.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { toMoney } from '../lib/numeric.js';
import { resolveCompanyToday } from '../lib/calendarDate.js';
import { getCustodySettledTotals, CustodyVoucherService, CustodyVoucher } from './custodyVoucherService.js';
import { CustodyMovement, CustodyRecord } from './cashTypes.js';
import { defaultCustodyShortageSettlementService, ShortageSettlementView } from './custodyShortageSettlementService.js';

export interface CustodyCashCount {
  id: string;
  custodyId: string;
  countedAmount: number;
  expectedAmount: number;
  variance: number;
  memo: string | null;
  countedBy: string;
  countedAt: string;
}

export interface ShortageRepayment {
  id: string;
  amount: number;
  journalEntryId: string;
  memo: string | null;
  createdBy: string;
  createdAt: string;
}

export interface CustodyShortageClaim {
  id: string;
  custodyId: string;
  cashCountId: string;
  amount: number;
  repaid: number;
  outstanding: number;
  /** Settled by write-off or payroll deduction (posted only). Counted in `outstanding`. */
  settled: number;
  /** Reserved by settlements still waiting for approval. Not yet in `outstanding`, but not available for repayment. */
  pendingSettlement: number;
  status: 'open' | 'partly_repaid' | 'repaid' | 'settled';
  memo: string | null;
  createdBy: string;
  createdAt: string;
  repayments: ShortageRepayment[];
  settlements: ShortageSettlementView[];
}

export interface CustodyStatement {
  custody: CustodyRecord;
  totals: {
    disbursed: number;
    topUps: number;
    approvedExpenses: number;
    reversedExpenses: number;
    cashReturned: number;
    remaining: number;
    pendingVouchers: number;
  };
  movements: CustodyMovement[];
  vouchers: CustodyVoucher[];
  cashCounts: CustodyCashCount[];
  shortageClaims: CustodyShortageClaim[];
}

function parseMoney(value: unknown, label: string, allowZero = false): number {
  if (value === undefined || value === null || value === '') throw new ValidationError(`${label} مطلوب`);
  const raw = String(value).trim();
  const num = Number(raw);
  if (!Number.isFinite(num)) throw new ValidationError(`${label} يجب أن يكون رقماً صالحاً`);
  const parts = raw.split('.');
  if (parts.length > 1 && parts[1].length > 2) {
    throw new ValidationError(`${label} لا يمكن أن يحتوي على أكثر من منزلتين عشريتين`);
  }
  const rounded = toMoney(num);
  if (allowZero ? rounded < 0 : rounded <= 0) {
    throw new ValidationError(allowZero ? `${label} يجب أن يكون صفراً أو أكبر` : `${label} يجب أن يكون أكبر من صفر`);
  }
  return rounded;
}

export class CustodyExtrasService {
  constructor(
    private custodyRepo: CustodyRepository = defaultCustodyRepository,
    private registerRepo: CashRegisterRepository = defaultCashRegisterRepository,
    private journalService: Pick<JournalService, 'createDraftEntry' | 'postEntry'> = defaultJournalService,
    private auditService: Pick<AuditService, 'record'> = defaultAuditService,
    private glResolver: Pick<CustodyGlResolver, 'resolveAndAssertUsable'> = defaultCustodyGlResolver,
    private voucherService: Pick<CustodyVoucherService, 'listVouchers'> = new CustodyVoucherService()
  ) {}

  /** Extra cash given to an open custody. Same accounting as the first disbursement. */
  async topUpCustody(
    companyId: string,
    custodyId: string,
    input: { amount: unknown; memo?: string | null },
    actorId: string,
    isPlatformAdmin = false
  ): Promise<CustodyRecord> {
    if (!companyId) throw new ValidationError('معرف الشركة مطلوب');
    if (!custodyId || !isUuid(custodyId)) throw new ValidationError('معرف العهدة غير صالح');
    const amount = parseMoney(input?.amount, 'مبلغ التعزيز');
    const memo = input?.memo?.trim() || null;

    return await withTenantTransaction(companyId, async (tx) => {
      const custody = await this.custodyRepo.findByIdForUpdate(companyId, custodyId, tx);
      if (!custody) throw new NotFoundError('العهدة النقدية غير موجودة');
      if (custody.status !== 'open') throw new ValidationError('لا يمكن تعزيز إلا عهدة مفتوحة (مصروفة وغير مسوّاة)');

      const register = await this.registerRepo.lockForUpdate(companyId, custody.registerId, tx);
      if (!register) throw new NotFoundError('الصندوق المرتبط بالعهدة غير موجود');
      if (!register.isActive) throw new ValidationError(`الصندوق (${register.nameAr}) معطّل ولا يمكن الصرف منه`);
      const { netMovement } = await this.registerRepo.sumMovements(companyId, register.id, tx);
      const available = toMoney(register.openingBalance + netMovement);
      if (toMoney(available - amount) < 0) {
        throw new ValidationError(
          `رصيد الصندوق (${register.nameAr}) غير كافٍ للتعزيز: المتاح ${available.toFixed(2)}، المطلوب ${amount.toFixed(2)}`
        );
      }
      const gl = await this.glResolver.resolveAndAssertUsable(companyId, tx);
      if (gl.custodyReceivableAccountId === register.glAccountId) {
        throw new ValidationError('لا يمكن الصرف لأن حساب ذمة العهد يطابق حساب النقدية المرتبط بالصندوق');
      }
      const entryDate = await resolveCompanyToday(companyId, tx);
      const docRef = custody.custodyNo || custodyId;
      const draft = await this.journalService.createDraftEntry(
        companyId,
        {
          entryDate,
          memo: `تعزيز عهدة نقدية رقم ${docRef}`,
          lines: [
            { accountId: gl.custodyReceivableAccountId, debit: amount, credit: 0, lineMemo: `تعزيز عهدة ${docRef} - ذمة عهد الموظفين` },
            { accountId: register.glAccountId, debit: 0, credit: amount, lineMemo: `تعزيز عهدة ${docRef} من صندوق ${register.code}` },
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
          custodyId,
          registerId: register.id,
          movementType: 'topup',
          direction: 'out',
          amount,
          expenseAccountId: null,
          journalEntryId: posted.id,
          memo: memo || `تعزيز عهدة نقدية رقم ${docRef}`,
          createdBy: actorId || null,
        },
        tx
      );
      await tx.query(`UPDATE custody_records SET amount = amount + $3, updated_at = NOW() WHERE company_id = $1 AND id = $2`, [
        companyId,
        custodyId,
        amount,
      ]);
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_TOPUP',
          entityType: 'custody_records',
          entityId: custodyId,
          metadata: { custodyNo: custody.custodyNo, amount, newAmount: toMoney(custody.amount + amount), journalEntryId: posted.id },
        },
        { executor: tx }
      );
      return (await this.custodyRepo.findById(companyId, custodyId, tx))!;
    });
  }

  /** Records a physical count. The variance is stored for review; nothing is posted to the ledger. */
  async recordCashCount(
    companyId: string,
    custodyId: string,
    input: { countedAmount: unknown; memo?: string | null },
    actorId: string
  ): Promise<CustodyCashCount> {
    if (!companyId) throw new ValidationError('معرف الشركة مطلوب');
    if (!custodyId || !isUuid(custodyId)) throw new ValidationError('معرف العهدة غير صالح');
    const counted = parseMoney(input?.countedAmount, 'المبلغ المعدود', true);
    return await withTenantTransaction(companyId, async (tx) => {
      const custody = await this.custodyRepo.findByIdForUpdate(companyId, custodyId, tx);
      if (!custody) throw new NotFoundError('العهدة النقدية غير موجودة');
      if (custody.status !== 'open') throw new ValidationError('الجرد متاح للعهدة المفتوحة فقط');
      const done = await getCustodySettledTotals(companyId, custodyId, tx);
      const expected = toMoney(custody.amount - done.expense - done.cashReturn);
      const variance = toMoney(counted - expected);
      const res = await tx.query<any>(
        `INSERT INTO custody_cash_counts (company_id, custody_id, counted_amount, expected_amount, variance, memo, counted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, custody_id AS "custodyId", counted_amount AS "countedAmount", expected_amount AS "expectedAmount",
                   variance, memo, counted_by AS "countedBy", counted_at AS "countedAt"`,
        [companyId, custodyId, counted, expected, variance, input?.memo?.trim() || null, actorId]
      );
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_CASH_COUNT',
          entityType: 'custody_records',
          entityId: custodyId,
          metadata: { custodyNo: custody.custodyNo, counted, expected, variance },
        },
        { executor: tx }
      );
      return mapCount(res.rows[0]);
    });
  }

  /**
   * Turns a count shortage into a claim owed by the employee. Nothing is posted:
   * the custody receivable already shows the employee owes the cash.
   */
  async createShortageClaim(
    companyId: string,
    custodyId: string,
    countId: string,
    input: { memo?: string | null },
    actorId: string
  ): Promise<CustodyShortageClaim> {
    if (!companyId) throw new ValidationError('معرف الشركة مطلوب');
    if (!custodyId || !isUuid(custodyId)) throw new ValidationError('معرف العهدة غير صالح');
    if (!countId || !isUuid(countId)) throw new ValidationError('معرف الجرد غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const custody = await this.custodyRepo.findByIdForUpdate(companyId, custodyId, tx);
      if (!custody) throw new NotFoundError('العهدة النقدية غير موجودة');
      if (custody.status !== 'open') throw new ValidationError('مطالبة العجز متاحة للعهدة المفتوحة فقط');
      const cnt = await tx.query<{ variance: string }>(
        `SELECT variance FROM custody_cash_counts WHERE company_id = $1 AND custody_id = $2 AND id = $3`,
        [companyId, custodyId, countId]
      );
      if (!cnt.rows[0]) throw new NotFoundError('الجرد غير موجود لهذه العهدة');
      const variance = toMoney(Number(cnt.rows[0].variance));
      if (variance >= 0) throw new ValidationError('لا يوجد عجز في هذا الجرد');
      const dup = await tx.query(`SELECT 1 FROM custody_shortage_claims WHERE company_id = $1 AND cash_count_id = $2`, [
        companyId,
        countId,
      ]);
      if (dup.rows.length > 0) throw new ValidationError('تم تسجيل مطالبة عجز لهذا الجرد من قبل');
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO custody_shortage_claims (company_id, custody_id, cash_count_id, amount, memo, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [companyId, custodyId, countId, toMoney(-variance), input?.memo?.trim() || null, actorId]
      );
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_SHORTAGE_CLAIM',
          entityType: 'custody_records',
          entityId: custodyId,
          metadata: { custodyNo: custody.custodyNo, countId, amount: toMoney(-variance) },
        },
        { executor: tx }
      );
      return (await this.loadClaims(companyId, custodyId, tx)).find((c) => c.id === ins.rows[0].id)!;
    });
  }

  /** Employee repays part or all of a shortage in cash: Dr cash / Cr custody receivable. */
  async repayShortage(
    companyId: string,
    claimId: string,
    input: { amount: unknown; memo?: string | null },
    actorId: string,
    isPlatformAdmin = false
  ): Promise<CustodyShortageClaim> {
    if (!companyId) throw new ValidationError('معرف الشركة مطلوب');
    if (!claimId || !isUuid(claimId)) throw new ValidationError('معرف المطالبة غير صالح');
    const amount = parseMoney(input?.amount, 'مبلغ السداد');
    return await withTenantTransaction(companyId, async (tx) => {
      const claimRes = await tx.query<{ custody_id: string }>(
        `SELECT custody_id FROM custody_shortage_claims WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        [companyId, claimId]
      );
      if (!claimRes.rows[0]) throw new NotFoundError('مطالبة العجز غير موجودة');
      const custodyId = claimRes.rows[0].custody_id;
      const custody = await this.custodyRepo.findByIdForUpdate(companyId, custodyId, tx);
      if (!custody) throw new NotFoundError('العهدة النقدية غير موجودة');
      if (custody.status !== 'open') throw new ValidationError('السداد متاح للعهدة المفتوحة فقط');
      const claim = (await this.loadClaims(companyId, custodyId, tx)).find((c) => c.id === claimId)!;
      const repayable = toMoney(claim.outstanding - claim.pendingSettlement);
      if (amount > repayable) {
        throw new ValidationError(`مبلغ السداد (${amount.toFixed(2)}) أكبر من المتبقي على المطالبة (${repayable.toFixed(2)})`);
      }
      const register = await this.registerRepo.lockForUpdate(companyId, custody.registerId, tx);
      if (!register) throw new NotFoundError('الصندوق المرتبط بالعهدة غير موجود');
      if (!register.isActive) throw new ValidationError(`الصندوق (${register.nameAr}) معطّل`);
      const gl = await this.glResolver.resolveAndAssertUsable(companyId, tx);
      if (gl.custodyReceivableAccountId === register.glAccountId) {
        throw new ValidationError('حساب ذمة العهد يطابق حساب النقدية المرتبط بالصندوق');
      }
      const entryDate = await resolveCompanyToday(companyId, tx);
      const docRef = custody.custodyNo || custodyId;
      const draft = await this.journalService.createDraftEntry(
        companyId,
        {
          entryDate,
          memo: `سداد عجز عهدة رقم ${docRef}`,
          lines: [
            { accountId: register.glAccountId, debit: amount, credit: 0, lineMemo: `سداد عجز عهدة ${docRef} إلى صندوق ${register.code}` },
            { accountId: gl.custodyReceivableAccountId, debit: 0, credit: amount, lineMemo: `سداد عجز عهدة ${docRef} - ذمة عهد الموظفين` },
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
          custodyId,
          registerId: register.id,
          movementType: 'shortage_repay',
          direction: 'in',
          amount,
          expenseAccountId: null,
          journalEntryId: posted.id,
          memo: input?.memo?.trim() || `سداد عجز عهدة رقم ${docRef}`,
          createdBy: actorId || null,
        },
        tx
      );
      await tx.query(
        `INSERT INTO custody_shortage_repayments (company_id, claim_id, amount, journal_entry_id, memo, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [companyId, claimId, amount, posted.id, input?.memo?.trim() || null, actorId]
      );
      await this.auditService.record(
        {
          actorUserId: actorId || null,
          companyId,
          action: 'CUSTODY_SHORTAGE_REPAY',
          entityType: 'custody_records',
          entityId: custodyId,
          metadata: { custodyNo: custody.custodyNo, claimId, amount, journalEntryId: posted.id },
        },
        { executor: tx }
      );
      return (await this.loadClaims(companyId, custodyId, tx)).find((c) => c.id === claimId)!;
    });
  }

  private async loadClaims(companyId: string, custodyId: string, tx: DbExecutor): Promise<CustodyShortageClaim[]> {
    const claims = await tx.query<any>(
      `SELECT id, custody_id AS "custodyId", cash_count_id AS "cashCountId", amount, memo,
              created_by AS "createdBy", created_at AS "createdAt"
       FROM custody_shortage_claims WHERE company_id = $1 AND custody_id = $2 ORDER BY created_at, id`,
      [companyId, custodyId]
    );
    const reps = await tx.query<any>(
      `SELECT r.id, r.claim_id AS "claimId", r.amount, r.journal_entry_id AS "journalEntryId", r.memo,
              r.created_by AS "createdBy", r.created_at AS "createdAt"
       FROM custody_shortage_repayments r
       JOIN custody_shortage_claims c ON c.id = r.claim_id AND c.company_id = r.company_id
       WHERE r.company_id = $1 AND c.custody_id = $2 ORDER BY r.created_at, r.id`,
      [companyId, custodyId]
    );
    const iso = (d: any) => (d instanceof Date ? d.toISOString() : d);
    const out: CustodyShortageClaim[] = [];
    for (const c of claims.rows as any[]) {
      const repayments: ShortageRepayment[] = reps.rows
        .filter((r: any) => r.claimId === c.id)
        .map((r: any) => ({
          id: r.id,
          amount: toMoney(Number(r.amount)),
          journalEntryId: r.journalEntryId,
          memo: r.memo,
          createdBy: r.createdBy,
          createdAt: iso(r.createdAt),
        }));
      const settlements = await defaultCustodyShortageSettlementService.loadSettlements(companyId, c.id, tx);
      const amount = toMoney(Number(c.amount));
      const repaid = toMoney(repayments.reduce((s, r) => s + r.amount, 0));
      const settled = toMoney(settlements.filter((x) => x.status === 'posted').reduce((s, x) => s + x.amount, 0));
      const pendingSettlement = toMoney(settlements.filter((x) => x.status === 'pending').reduce((s, x) => s + x.amount, 0));
      const outstanding = toMoney(amount - repaid - settled);
      out.push({
        id: c.id,
        custodyId: c.custodyId,
        cashCountId: c.cashCountId,
        amount,
        repaid,
        outstanding,
        settled,
        pendingSettlement,
        status: outstanding <= 0 ? (settled > 0 ? 'settled' : 'repaid') : repaid > 0 || settled > 0 ? 'partly_repaid' : 'open',
        memo: c.memo,
        createdBy: c.createdBy,
        createdAt: iso(c.createdAt),
        repayments,
        settlements,
      });
    }
    return out;
  }

  async getStatement(companyId: string, custodyId: string): Promise<CustodyStatement> {
    if (!companyId) throw new ValidationError('معرف الشركة مطلوب');
    if (!custodyId || !isUuid(custodyId)) throw new ValidationError('معرف العهدة غير صالح');
    const vouchers = await this.voucherService.listVouchers(companyId, custodyId);
    return await withTenantTransaction(companyId, async (tx: DbExecutor) => {
      const custody = await this.custodyRepo.findById(companyId, custodyId, tx);
      if (!custody) throw new NotFoundError('العهدة النقدية غير موجودة');
      const movements = await this.custodyRepo.listMovements(companyId, { custodyId }, tx);
      const sum = (type: string) =>
        toMoney(movements.filter((m) => m.movementType === type).reduce((s, m) => s + m.amount, 0));
      const approved = sum('settle_expense');
      const reversed = sum('reverse');
      const cashReturned = toMoney(sum('settle_return') + sum('shortage_repay'));
      const topUps = sum('topup');
      const countsRes = await tx.query<any>(
        `SELECT id, custody_id AS "custodyId", counted_amount AS "countedAmount", expected_amount AS "expectedAmount",
                variance, memo, counted_by AS "countedBy", counted_at AS "countedAt"
         FROM custody_cash_counts WHERE company_id = $1 AND custody_id = $2 ORDER BY counted_at, id`,
        [companyId, custodyId]
      );
      return {
        custody,
        totals: {
          disbursed: toMoney(custody.amount - topUps),
          topUps,
          approvedExpenses: toMoney(approved - reversed),
          reversedExpenses: reversed,
          cashReturned,
          remaining: toMoney(custody.amount - (approved - reversed) - cashReturned),
          pendingVouchers: vouchers.filter((v) => v.status === 'submitted').length,
        },
        movements,
        vouchers,
        cashCounts: countsRes.rows.map(mapCount),
        shortageClaims: await this.loadClaims(companyId, custodyId, tx),
      };
    });
  }
}

function mapCount(r: any): CustodyCashCount {
  return {
    id: r.id,
    custodyId: r.custodyId,
    countedAmount: toMoney(Number(r.countedAmount)),
    expectedAmount: toMoney(Number(r.expectedAmount)),
    variance: toMoney(Number(r.variance)),
    memo: r.memo,
    countedBy: r.countedBy,
    countedAt: r.countedAt instanceof Date ? r.countedAt.toISOString() : r.countedAt,
  };
}

export const defaultCustodyExtrasService = new CustodyExtrasService();
