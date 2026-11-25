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
      const cashReturned = sum('settle_return');
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
