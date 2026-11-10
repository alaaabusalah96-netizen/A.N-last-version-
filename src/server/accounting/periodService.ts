import { defaultPeriodRepository, PeriodRepository } from './periodRepository.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { ValidationError, NotFoundError } from '../http/errors.js';
import { AccountingPeriod, CreatePeriodInput } from './periodTypes.js';

export class PeriodService {
  constructor(
    private periodRepo: PeriodRepository = defaultPeriodRepository,
    private auditService: AuditService = defaultAuditService
  ) {}

  /**
   * List all accounting periods for a given company.
   */
  async listPeriods(companyId: string): Promise<AccountingPeriod[]> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }
    return await this.periodRepo.listByCompany(companyId);
  }

  /**
   * Create a new accounting period.
   * Validates non-empty code, valid start/end dates, start <= end, and no overlapping dates for the company.
   */
  async createPeriod(
    companyId: string,
    input: CreatePeriodInput,
    actorId?: string
  ): Promise<AccountingPeriod> {
    if (!companyId || typeof companyId !== 'string') {
      throw new ValidationError('companyId is required');
    }

    if (!input.code || typeof input.code !== 'string' || input.code.trim().length === 0) {
      throw new ValidationError('رمز الفترة المحاسبية مطلوب (كود الفترة)');
    }

    if (!input.startDate || typeof input.startDate !== 'string') {
      throw new ValidationError('تاريخ بداية الفترة مطلوب بصيغة YYYY-MM-DD');
    }

    if (!input.endDate || typeof input.endDate !== 'string') {
      throw new ValidationError('تاريخ نهاية الفترة مطلوب بصيغة YYYY-MM-DD');
    }

    if (input.startDate > input.endDate) {
      throw new ValidationError('تاريخ بداية الفترة يجب أن يكون قبل أو يساوي تاريخ نهاية الفترة');
    }

    // Check for existing code in this company
    const existing = await this.periodRepo.findByCode(companyId, input.code);
    if (existing) {
      throw new ValidationError(`رمز الفترة (${input.code.trim()}) مستخدم مسبقاً لهذه الشركة`);
    }

    // A. Overlap check: Reject when date range overlaps an existing period for the same company_id
    const overlapping = await this.periodRepo.findOverlapping(
      companyId,
      input.startDate,
      input.endDate
    );
    if (overlapping) {
      throw new ValidationError(
        `تتعارض تواريخ الفترة الجديدة (${input.startDate} إلى ${input.endDate}) مع فترة محاسبية قائمة (${overlapping.code}: من ${overlapping.startDate} إلى ${overlapping.endDate}). لا يمكن تداخل الفترات المالية لنفس الشركة.`
      );
    }

    const period = await this.periodRepo.create(companyId, {
      code: input.code.trim(),
      startDate: input.startDate,
      endDate: input.endDate,
    });

    await this.auditService.record({
      actorUserId: actorId || null,
      companyId,
      action: 'PERIOD_CREATE',
      entityType: 'accounting_period',
      entityId: period.id,
      metadata: {
        code: period.code,
        startDate: period.startDate,
        endDate: period.endDate,
      },
    });

    return period;
  }

  /**
   * Close an open accounting period.
   * Locks target period row (FOR UPDATE) inside tenant transaction so close and post cannot race.
   */
  async closePeriod(
    companyId: string,
    periodId: string,
    actorId?: string
  ): Promise<AccountingPeriod> {
    if (!companyId || !periodId) {
      throw new ValidationError('companyId and periodId are required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const existing = await this.periodRepo.findByIdForUpdate(companyId, periodId, tx);
      if (!existing) {
        throw new NotFoundError('الفترة المحاسبية غير موجودة');
      }

      if (existing.isClosed) {
        throw new ValidationError(`الفترة المحاسبية (${existing.code}) مغلقة بالفعل`);
      }

      const updated = await this.periodRepo.setClosed(companyId, periodId, true, actorId, tx);
      if (!updated) {
        throw new NotFoundError('تعذر إغلاق الفترة المحاسبية');
      }

      await this.auditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'PERIOD_CLOSE',
        entityType: 'accounting_period',
        entityId: updated.id,
        metadata: {
          code: updated.code,
        },
      });

      return updated;
    });
  }

  /**
   * Reopen a closed accounting period.
   * Locks target period row (FOR UPDATE) inside tenant transaction.
   */
  async reopenPeriod(
    companyId: string,
    periodId: string,
    actorId?: string
  ): Promise<AccountingPeriod> {
    if (!companyId || !periodId) {
      throw new ValidationError('companyId and periodId are required');
    }

    return await withTenantTransaction(companyId, async (tx) => {
      const existing = await this.periodRepo.findByIdForUpdate(companyId, periodId, tx);
      if (!existing) {
        throw new NotFoundError('الفترة المحاسبية غير موجودة');
      }

      if (!existing.isClosed) {
        throw new ValidationError(`الفترة المحاسبية (${existing.code}) مفتوحة بالفعل`);
      }

      const updated = await this.periodRepo.setClosed(companyId, periodId, false, actorId, tx);
      if (!updated) {
        throw new NotFoundError('تعذر إعادة فتح الفترة المحاسبية');
      }

      await this.auditService.record({
        actorUserId: actorId || null,
        companyId,
        action: 'PERIOD_REOPEN',
        entityType: 'accounting_period',
        entityId: updated.id,
        metadata: {
          code: updated.code,
        },
      });

      return updated;
    });
  }
}

export const defaultPeriodService = new PeriodService();
