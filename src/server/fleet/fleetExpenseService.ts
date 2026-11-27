import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { defaultOrgUnitRepository, OrgUnitRepository } from '../org/orgUnitRepository.js';
import { defaultAccountRepository, AccountRepository } from '../accounting/accountRepository.js';
import { defaultJournalService, JournalService } from '../accounting/journalService.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { defaultCustodyVoucherService } from '../cash/custodyVoucherService.js';
import { isUuid } from '../http/validators.js';

export const EXPENSE_STATUSES = ['draft', 'approved', 'rejected', 'posted', 'reversed'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/** Pure rule: allowed status moves. Posted can only be reversed; reversed, rejected are final. */
export const EXPENSE_TRANSITIONS: Record<ExpenseStatus, ExpenseStatus[]> = {
  draft: ['approved', 'rejected'],
  approved: ['posted', 'rejected'],
  posted: ['reversed'],
  rejected: [], reversed: [],
};
export const canExpenseMove = (from: ExpenseStatus, to: ExpenseStatus): boolean => EXPENSE_TRANSITIONS[from]?.includes(to) ?? false;

/** Pure rule: amount in currency units with at most 2 decimals, greater than zero. */
export function parseAmount(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new ValidationError('المبلغ يجب أن يكون أكبر من صفر');
  const cents = Math.round(n * 100);
  if (Math.abs(cents - n * 100) > 1e-6) throw new ValidationError('المبلغ لا يقبل أكثر من خانتين عشريتين');
  if (cents > 99999999999999) throw new ValidationError('المبلغ أكبر من الحد المسموح');
  return cents / 100;
}

export interface ExpenseCategoryView { id: string; companyId: string; code: string; nameAr: string; expenseAccountId: string; isActive: boolean }
export interface ExpenseView {
  id: string; companyId: string; seq: number; expenseNo: string; orgUnitId: string | null; vehicleId: string; tripId: string | null; categoryId: string;
  expenseDate: string; amount: number; description: string; referenceNo: string | null; odometerKm: number | null; status: ExpenseStatus; custodyVoucherId: string | null;
  createdBy: string; approvedBy: string | null; approvedAt: string | null; rejectReason: string | null; postedBy: string | null; postedAt: string | null;
  counterAccountId: string | null; journalEntryId: string | null; reversalEntryId: string | null; reverseReason: string | null;
}

const CCOLS = `id, company_id AS "companyId", code, name_ar AS "nameAr", expense_account_id AS "expenseAccountId", is_active AS "isActive"`;
const ECOLS = `id, company_id AS "companyId", seq, expense_no AS "expenseNo", org_unit_id AS "orgUnitId", vehicle_id AS "vehicleId", trip_id AS "tripId",
  category_id AS "categoryId", to_char(expense_date,'YYYY-MM-DD') AS "expenseDate", amount, description, reference_no AS "referenceNo", odometer_km AS "odometerKm",
  status, created_by AS "createdBy", approved_by AS "approvedBy", approved_at AS "approvedAt", reject_reason AS "rejectReason", posted_by AS "postedBy",
  posted_at AS "postedAt", counter_account_id AS "counterAccountId", journal_entry_id AS "journalEntryId", reversal_entry_id AS "reversalEntryId", reverse_reason AS "reverseReason", custody_voucher_id AS "custodyVoucherId"`;
const iso = (v: any) => (v === null || v === undefined ? null : new Date(v).toISOString());
const toExpense = (r: any): ExpenseView => ({ ...r, amount: Number(r.amount), odometerKm: r.odometerKm === null ? null : Number(r.odometerKm),
  approvedAt: iso(r.approvedAt), postedAt: iso(r.postedAt) });

const text = (v: unknown, max: number, label: string, required = false): string | null => {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) { if (required) throw new ValidationError(`${label} مطلوب`); return null; }
  if (typeof v !== 'string') throw new ValidationError(`${label} غير صالح`);
  const t = v.trim();
  if (t.length > max) throw new ValidationError(`${label} أطول من ${max} حرفا`);
  return t;
};
const day = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ValidationError(`${label} يجب أن يكون بصيغة YYYY-MM-DD`);
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new ValidationError(`${label} غير صالح`);
  return v;
};

export class FleetExpenseService {
  constructor(
    private auditService: Pick<AuditService, 'record'> = defaultAuditService,
    private orgUnitRepo: Pick<OrgUnitRepository, 'findById'> = defaultOrgUnitRepository,
    private accountRepo: Pick<AccountRepository, 'findById'> = defaultAccountRepository,
    private journalService: Pick<JournalService, 'createDraftEntry' | 'postEntry' | 'reverseEntry'> = defaultJournalService
  ) {}

  private cid(companyId: string) { if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح'); }
  private async audit(companyId: string, actorId: string, action: string, entityType: string, id: string, metadata: Record<string, unknown>, tx: DbExecutor) {
    await this.auditService.record({ actorUserId: actorId || null, companyId, action, entityType, entityId: id, metadata }, { executor: tx });
  }

  private async assertAccount(companyId: string, accountId: unknown, label: string, types: string[], tx: DbExecutor) {
    if (typeof accountId !== 'string' || !isUuid(accountId)) throw new ValidationError(`${label} مطلوب`);
    const a = await this.accountRepo.findById(companyId, accountId, tx);
    if (!a) throw new NotFoundError(`${label} غير موجود في هذه الشركة`);
    if (!a.isActive) throw new ValidationError(`${label} (${a.code}) غير نشط`);
    if (!a.isPostable) throw new ValidationError(`${label} (${a.code}) حساب رئيسي وغير قابل للترحيل`);
    if (!types.includes(a.accountType)) throw new ValidationError(`${label} (${a.code}) نوعه ${a.accountType} ولازم يكون (${types.join(' / ')})`);
    return a;
  }

  // ---------- categories ----------
  async listCategories(companyId: string): Promise<ExpenseCategoryView[]> {
    this.cid(companyId);
    return await withTenantTransaction(companyId, async (tx) =>
      (await tx.query<any>(`SELECT ${CCOLS} FROM fleet_expense_categories WHERE company_id=$1 ORDER BY code`, [companyId])).rows);
  }
  async createCategory(companyId: string, input: Record<string, unknown>, actorId: string): Promise<ExpenseCategoryView> {
    this.cid(companyId);
    const code = text(input.code, 30, 'كود الفئة', true)!.toUpperCase();
    const nameAr = text(input.nameAr, 100, 'اسم الفئة', true)!;
    return await withTenantTransaction(companyId, async (tx) => {
      await this.assertAccount(companyId, input.expenseAccountId, 'حساب المصروف', ['expense'], tx);
      const dup = (await tx.query<any>(`SELECT 1 FROM fleet_expense_categories WHERE company_id=$1 AND code=$2`, [companyId, code])).rows[0];
      if (dup) throw new ConflictError('كود الفئة مستخدم بالفعل في هذه الشركة');
      const row = (await tx.query<any>(
        `INSERT INTO fleet_expense_categories (company_id, code, name_ar, expense_account_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING ${CCOLS}`,
        [companyId, code, nameAr, input.expenseAccountId, actorId])).rows[0];
      await this.audit(companyId, actorId, 'FLEET_EXPENSE_CATEGORY_CREATED', 'fleet_expense_categories', row.id, { code, expenseAccountId: input.expenseAccountId }, tx);
      return row;
    });
  }
  async updateCategory(companyId: string, id: string, input: Record<string, unknown>, actorId: string): Promise<ExpenseCategoryView> {
    this.cid(companyId);
    if (!id || !isUuid(id)) throw new ValidationError('معرف الفئة غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const cur = (await tx.query<any>(`SELECT ${CCOLS} FROM fleet_expense_categories WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId, id])).rows[0];
      if (!cur) throw new NotFoundError('الفئة غير موجودة');
      const nameAr = input.nameAr === undefined ? cur.nameAr : text(input.nameAr, 100, 'اسم الفئة', true)!;
      let accountId = cur.expenseAccountId;
      if (input.expenseAccountId !== undefined && input.expenseAccountId !== cur.expenseAccountId) {
        await this.assertAccount(companyId, input.expenseAccountId, 'حساب المصروف', ['expense'], tx);
        accountId = input.expenseAccountId;
      }
      if (input.isActive !== undefined && typeof input.isActive !== 'boolean') throw new ValidationError('حالة الفئة غير صالحة');
      const isActive = input.isActive === undefined ? cur.isActive : (input.isActive as boolean);
      const row = (await tx.query<any>(
        `UPDATE fleet_expense_categories SET name_ar=$3, expense_account_id=$4, is_active=$5, updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING ${CCOLS}`,
        [companyId, id, nameAr, accountId, isActive])).rows[0];
      await this.audit(companyId, actorId, 'FLEET_EXPENSE_CATEGORY_UPDATED', 'fleet_expense_categories', id, { from: cur, to: row }, tx);
      return row;
    });
  }

  // ---------- expenses ----------
  private async lock(companyId: string, id: string, tx: DbExecutor): Promise<any> {
    if (!id || !isUuid(id)) throw new ValidationError('معرف المصروف غير صالح');
    const e = (await tx.query<any>(`SELECT ${ECOLS} FROM fleet_expenses WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId, id])).rows[0];
    if (!e) throw new NotFoundError('المصروف غير موجود');
    return e;
  }
  private move(e: any, to: ExpenseStatus) {
    if (!canExpenseMove(e.status, to)) throw new ConflictError(`لا يمكن نقل المصروف من حالة «${e.status}» إلى «${to}»`);
  }
  private async reload(companyId: string, id: string, tx: DbExecutor): Promise<ExpenseView> {
    return toExpense((await tx.query<any>(`SELECT ${ECOLS} FROM fleet_expenses WHERE company_id=$1 AND id=$2`, [companyId, id])).rows[0]);
  }

  async listExpenses(companyId: string, filter: { status?: string; vehicleId?: string; tripId?: string } = {}): Promise<ExpenseView[]> {
    this.cid(companyId);
    if (filter.status && !(EXPENSE_STATUSES as readonly string[]).includes(filter.status)) throw new ValidationError('حالة غير صالحة');
    for (const k of ['vehicleId', 'tripId'] as const) if (filter[k] && !isUuid(filter[k]!)) throw new ValidationError('معرف غير صالح');
    return await withTenantTransaction(companyId, async (tx) => (await tx.query<any>(
      `SELECT ${ECOLS} FROM fleet_expenses WHERE company_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::uuid IS NULL OR vehicle_id=$3) AND ($4::uuid IS NULL OR trip_id=$4)
        ORDER BY seq DESC LIMIT 500`, [companyId, filter.status || null, filter.vehicleId || null, filter.tripId || null])).rows.map(toExpense));
  }
  async getExpense(companyId: string, id: string): Promise<ExpenseView> {
    this.cid(companyId);
    if (!id || !isUuid(id)) throw new ValidationError('معرف المصروف غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const r = (await tx.query<any>(`SELECT ${ECOLS} FROM fleet_expenses WHERE company_id=$1 AND id=$2`, [companyId, id])).rows[0];
      if (!r) throw new NotFoundError('المصروف غير موجود');
      return toExpense(r);
    });
  }

  async createExpense(companyId: string, input: Record<string, unknown>, actorId: string): Promise<ExpenseView> {
    this.cid(companyId);
    if (typeof input.vehicleId !== 'string' || !isUuid(input.vehicleId)) throw new ValidationError('المركبة مطلوبة');
    if (typeof input.categoryId !== 'string' || !isUuid(input.categoryId)) throw new ValidationError('فئة المصروف مطلوبة');
    if (input.tripId !== undefined && input.tripId !== null && input.tripId !== '' && (typeof input.tripId !== 'string' || !isUuid(input.tripId))) throw new ValidationError('معرف الرحلة غير صالح');
    const tripId = (input.tripId as string) || null;
    const expenseDate = day(input.expenseDate, 'تاريخ المصروف');
    const amount = parseAmount(input.amount);
    const description = text(input.description, 300, 'وصف المصروف', true)!;
    const referenceNo = text(input.referenceNo, 60, 'رقم المرجع');
    let odometerKm: number | null = null;
    if (input.odometerKm !== undefined && input.odometerKm !== null && input.odometerKm !== '') {
      odometerKm = Number(input.odometerKm);
      if (!Number.isFinite(odometerKm) || odometerKm < 0) throw new ValidationError('قراءة العداد يجب أن تكون صفرا أو أكثر');
    }
    return await withTenantTransaction(companyId, async (tx) => {
      const v = (await tx.query<any>(`SELECT org_unit_id AS "orgUnitId" FROM fleet_vehicles WHERE company_id=$1 AND id=$2`, [companyId, input.vehicleId])).rows[0];
      if (!v) throw new NotFoundError('المركبة غير موجودة في هذه الشركة');
      const cat = (await tx.query<any>(`SELECT is_active AS "isActive" FROM fleet_expense_categories WHERE company_id=$1 AND id=$2`, [companyId, input.categoryId])).rows[0];
      if (!cat) throw new NotFoundError('فئة المصروف غير موجودة');
      if (!cat.isActive) throw new ValidationError('فئة المصروف معطّلة');
      if (tripId) {
        const t = (await tx.query<any>(`SELECT vehicle_id AS "vehicleId" FROM fleet_trips WHERE company_id=$1 AND id=$2`, [companyId, tripId])).rows[0];
        if (!t) throw new NotFoundError('الرحلة غير موجودة في هذه الشركة');
        if (t.vehicleId !== input.vehicleId) throw new ValidationError('الرحلة ليست لنفس المركبة');
      }
      let orgUnitId: string | null = v.orgUnitId || null;
      if (input.orgUnitId !== undefined && input.orgUnitId !== null && input.orgUnitId !== '') {
        if (typeof input.orgUnitId !== 'string' || !isUuid(input.orgUnitId)) throw new ValidationError('معرف الوحدة التنظيمية غير صالح');
        const u = await this.orgUnitRepo.findById(companyId, input.orgUnitId, tx);
        if (!u) throw new NotFoundError('الوحدة التنظيمية غير موجودة في هذه الشركة');
        if (!u.isActive) throw new ValidationError('الوحدة التنظيمية معطّلة');
        orgUnitId = u.id;
      }
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['fleet_expense_seq:' + companyId]);
      const seq = Number((await tx.query<any>(`SELECT COALESCE(MAX(seq),0)+1 AS n FROM fleet_expenses WHERE company_id=$1`, [companyId])).rows[0].n);
      const expenseNo = 'FEX-' + String(seq).padStart(5, '0');
      const row = (await tx.query<any>(
        `INSERT INTO fleet_expenses (company_id, seq, expense_no, org_unit_id, vehicle_id, trip_id, category_id, expense_date, amount, description, reference_no, odometer_km, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [companyId, seq, expenseNo, orgUnitId, input.vehicleId, tripId, input.categoryId, expenseDate, amount, description, referenceNo, odometerKm, actorId])).rows[0];
      await this.audit(companyId, actorId, 'FLEET_EXPENSE_CREATED', 'fleet_expenses', row.id, { expenseNo, vehicleId: input.vehicleId, categoryId: input.categoryId, amount, expenseDate }, tx);
      return await this.reload(companyId, row.id, tx);
    });
  }

  async approveExpense(companyId: string, id: string, actorId: string): Promise<ExpenseView> {
    this.cid(companyId);
    return await withTenantTransaction(companyId, async (tx) => {
      const e = await this.lock(companyId, id, tx);
      this.move(e, 'approved');
      if (e.createdBy === actorId) throw new ForbiddenError('منشئ المصروف لا يمكنه اعتماده بنفسه');
      await tx.query(`UPDATE fleet_expenses SET status='approved', approved_by=$3, approved_at=now(), updated_at=now() WHERE company_id=$1 AND id=$2`, [companyId, id, actorId]);
      await this.audit(companyId, actorId, 'FLEET_EXPENSE_APPROVED', 'fleet_expenses', id, { expenseNo: e.expenseNo, amount: Number(e.amount) }, tx);
      return await this.reload(companyId, id, tx);
    });
  }

  async rejectExpense(companyId: string, id: string, reason: unknown, actorId: string): Promise<ExpenseView> {
    this.cid(companyId);
    const why = text(reason, 300, 'سبب الرفض', true)!;
    return await withTenantTransaction(companyId, async (tx) => {
      const e = await this.lock(companyId, id, tx);
      this.move(e, 'rejected');
      if (e.custodyVoucherId) throw new ConflictError('للمصروف حافظة عهدة قيد الاعتماد؛ ارفض الحافظة من شاشة العهدة أولا');
      await tx.query(`UPDATE fleet_expenses SET status='rejected', rejected_by=$3, rejected_at=now(), reject_reason=$4, updated_at=now() WHERE company_id=$1 AND id=$2`, [companyId, id, actorId, why]);
      await this.audit(companyId, actorId, 'FLEET_EXPENSE_REJECTED', 'fleet_expenses', id, { expenseNo: e.expenseNo, reason: why }, tx);
      return await this.reload(companyId, id, tx);
    });
  }

  /** Posts the accounting entry: debit the category expense account, credit the counter account chosen by the poster. A failure rolls everything back. */
  async postExpense(companyId: string, id: string, counterAccountId: unknown, actorId: string, isPlatformAdmin = false): Promise<ExpenseView> {
    this.cid(companyId);
    return await withTenantTransaction(companyId, async (tx) => {
      const e = await this.lock(companyId, id, tx);
      this.move(e, 'posted');
      if (e.custodyVoucherId) throw new ConflictError('المصروف مرتبط بحافظة عهدة؛ يُرحّل باعتماد الحافظة من شاشة العهدة');
      const cat = (await tx.query<any>(`SELECT ${CCOLS} FROM fleet_expense_categories WHERE company_id=$1 AND id=$2`, [companyId, e.categoryId])).rows[0];
      const expAcc = await this.assertAccount(companyId, cat.expenseAccountId, 'حساب مصروف الفئة', ['expense'], tx);
      const counter = await this.assertAccount(companyId, counterAccountId, 'حساب الطرف المقابل', ['asset', 'liability'], tx);
      if (counter.id === expAcc.id) throw new ValidationError('الحساب المقابل يطابق حساب المصروف');
      const amount = Number(e.amount);
      const draft = await this.journalService.createDraftEntry(companyId, {
        entryDate: e.expenseDate,
        memo: `مصروف أسطول ${e.expenseNo}: ${e.description}`,
        orgUnitId: e.orgUnitId,
        lines: [
          { accountId: expAcc.id, debit: amount, credit: 0, lineMemo: `${e.expenseNo} - ${cat.nameAr}` },
          { accountId: counter.id, debit: 0, credit: amount, lineMemo: `${e.expenseNo} - ${counter.code}` },
        ],
      }, actorId, isPlatformAdmin, tx);
      const posted = await this.journalService.postEntry(companyId, draft.id, actorId, isPlatformAdmin, tx);
      await tx.query(
        `UPDATE fleet_expenses SET status='posted', posted_by=$3, posted_at=now(), counter_account_id=$4, journal_entry_id=$5, updated_at=now() WHERE company_id=$1 AND id=$2`,
        [companyId, id, actorId, counter.id, posted.id]);
      await this.audit(companyId, actorId, 'FLEET_EXPENSE_POSTED', 'fleet_expenses', id, { expenseNo: e.expenseNo, amount, journalEntryId: posted.id, debit: expAcc.code, credit: counter.code }, tx);
      return await this.reload(companyId, id, tx);
    });
  }

  /** Pays an approved expense from an open custody: submits a one-line custody voucher (debit = category expense account on approval, credit = custody receivable).
   *  The voucher approver (a different person, enforced by the custody module) posts it. Only the custody holder (or an admin) may spend from a custody. */
  async payFromCustody(companyId: string, id: string, custodyId: unknown, actorId: string, isAdmin = false): Promise<ExpenseView> {
    this.cid(companyId);
    if (typeof custodyId !== 'string' || !isUuid(custodyId)) throw new ValidationError('معرف العهدة غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const e = await this.lock(companyId, id, tx);
      if (e.status !== 'approved') throw new ConflictError('الدفع من العهدة متاح للمصروف المعتمد فقط');
      if (e.custodyVoucherId) throw new ConflictError('المصروف مرتبط بحافظة عهدة بالفعل');
      const cu = (await tx.query<any>(`SELECT employee_user_id AS "employeeUserId", status FROM custody_records WHERE company_id=$1 AND id=$2`, [companyId, custodyId])).rows[0];
      if (!cu) throw new NotFoundError('العهدة غير موجودة');
      if (cu.status !== 'open') throw new ValidationError('العهدة ليست مفتوحة (مصروفة وغير مسوّاة)');
      if (!isAdmin && cu.employeeUserId !== actorId) throw new ForbiddenError('لا يمكن الصرف إلا من عهدتك الشخصية');
      const cat = (await tx.query<any>(`SELECT ${CCOLS} FROM fleet_expense_categories WHERE company_id=$1 AND id=$2`, [companyId, e.categoryId])).rows[0];
      const v = await defaultCustodyVoucherService.submitVoucher(companyId, custodyId, {
        lines: [{ expenseAccountId: cat.expenseAccountId, amount: Number(e.amount), memo: `${e.expenseNo} - ${cat.nameAr}: ${e.description}`.slice(0, 300) }],
        memo: `مصروف أسطول ${e.expenseNo}`,
      }, actorId);
      await tx.query(`UPDATE fleet_expenses SET custody_voucher_id=$3, updated_at=now() WHERE company_id=$1 AND id=$2`, [companyId, id, v.id]);
      await this.audit(companyId, actorId, 'FLEET_EXPENSE_CUSTODY_SUBMITTED', 'fleet_expenses', id, { expenseNo: e.expenseNo, custodyId, voucherId: v.id, voucherNo: v.voucherNo }, tx);
      return await this.reload(companyId, id, tx);
    });
  }

  /** A posted expense is never edited: it is cancelled by a reversing journal entry. */
  async reverseExpense(companyId: string, id: string, reason: unknown, actorId: string, isPlatformAdmin = false): Promise<ExpenseView> {
    this.cid(companyId);
    const why = text(reason, 300, 'سبب العكس', true)!;
    return await withTenantTransaction(companyId, async (tx) => {
      const e = await this.lock(companyId, id, tx);
      this.move(e, 'reversed');
      if (e.custodyVoucherId) throw new ConflictError('المصروف مدفوع من العهدة؛ اعكس الحافظة من شاشة العهدة وسينعكس المصروف تلقائيا');
      const rev = await this.journalService.reverseEntry(companyId, e.journalEntryId, actorId, `عكس مصروف أسطول ${e.expenseNo}: ${why}`, isPlatformAdmin, tx);
      await tx.query(
        `UPDATE fleet_expenses SET status='reversed', reversed_by=$3, reversed_at=now(), reverse_reason=$4, reversal_entry_id=$5, updated_at=now() WHERE company_id=$1 AND id=$2`,
        [companyId, id, actorId, why, rev.id]);
      await this.audit(companyId, actorId, 'FLEET_EXPENSE_REVERSED', 'fleet_expenses', id, { expenseNo: e.expenseNo, reason: why, reversalEntryId: rev.id }, tx);
      return await this.reload(companyId, id, tx);
    });
  }
}

export const defaultFleetExpenseService = new FleetExpenseService();
