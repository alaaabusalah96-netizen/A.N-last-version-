import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { defaultAuditService, AuditService } from '../audit/auditService.js';
import { ValidationError } from '../http/errors.js';
import { isUuid } from '../http/validators.js';
import { toMoney } from '../lib/numeric.js';

export interface CustodyLimitPolicyView {
  id: string; employeeUserId: string | null; version: number; enabled: boolean; limitAmount: number | null; reason: string | null;
}

/** Pure rule. exposure = custody already held (pending + approved + open, net of settlements). */
export function evaluateCustodyLimit(limit: number | null, exposure: number, requested: number): { allowed: boolean; headroom: number | null } {
  if (limit === null) return { allowed: true, headroom: null };
  const headroom = toMoney(limit - exposure);
  return { allowed: toMoney(exposure + requested) <= limit, headroom };
}

/** Latest effective policy for an employee: their own scope first, else the company default. */
export async function resolveEffectiveLimit(companyId: string, employeeUserId: string, tx: DbExecutor): Promise<{ limit: number | null; scope: 'employee' | 'company' | 'none' }> {
  const r = await tx.query<{ employee_user_id: string | null; enabled: boolean; limit_amount: string | null }>(
    `SELECT DISTINCT ON (employee_user_id) employee_user_id, enabled, limit_amount
       FROM custody_limit_policies
      WHERE company_id = $1 AND (employee_user_id = $2 OR employee_user_id IS NULL)
      ORDER BY employee_user_id NULLS LAST, version DESC`,
    [companyId, employeeUserId]
  );
  const own = r.rows.find((x) => x.employee_user_id === employeeUserId);
  const def = r.rows.find((x) => x.employee_user_id === null);
  const pick = own ?? def;
  if (!pick || !pick.enabled || pick.limit_amount === null) return { limit: null, scope: own ? 'employee' : 'none' };
  return { limit: toMoney(Number(pick.limit_amount)), scope: own ? 'employee' : 'company' };
}

export async function custodyExposure(companyId: string, employeeUserId: string, tx: DbExecutor): Promise<number> {
  const r = await tx.query<{ exposure: string }>(
    `SELECT COALESCE(SUM(c.amount - COALESCE(m.settled, 0)), 0) AS exposure
       FROM custody_records c
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(amount) FILTER (WHERE movement_type IN ('settle_expense','settle_return','shortage_repay')), 0)
              - COALESCE(SUM(amount) FILTER (WHERE movement_type = 'reverse'), 0) AS settled
           FROM custody_movements WHERE company_id = c.company_id AND custody_id = c.id
       ) m ON TRUE
      WHERE c.company_id = $1 AND c.employee_user_id = $2 AND c.status IN ('pending','approved','open')`,
    [companyId, employeeUserId]
  );
  return toMoney(Number(r.rows[0]?.exposure ?? 0));
}

/** Throws a clear Arabic error when the new amount would push the employee above the ceiling. */
export async function assertWithinCustodyLimit(companyId: string, employeeUserId: string, requested: number, tx: DbExecutor): Promise<void> {
  const { limit, scope } = await resolveEffectiveLimit(companyId, employeeUserId, tx);
  if (limit === null) return;
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`custody_limit:${companyId}:${employeeUserId}`]);
  const exposure = await custodyExposure(companyId, employeeUserId, tx);
  const ev = evaluateCustodyLimit(limit, exposure, requested);
  if (!ev.allowed) {
    throw new ValidationError(
      `سقف العهدة للموظف (${scope === 'employee' ? 'خاص' : 'افتراضي الشركة'}) ${limit.toFixed(2)}، والمحجوز عليه ${exposure.toFixed(2)}، والمتاح ${Math.max(0, ev.headroom ?? 0).toFixed(2)}، والمطلوب ${requested.toFixed(2)}. لزيادة السقف انشر سياسة جديدة بصلاحية إعدادات الشركة.`
    );
  }
}

export class CustodyLimitService {
  constructor(private auditService: Pick<AuditService, 'record'> = defaultAuditService) {}

  async setPolicy(companyId: string, input: { employeeUserId?: unknown; enabled?: unknown; limitAmount?: unknown; reason?: unknown }, actorId: string): Promise<CustodyLimitPolicyView> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    if (typeof input?.enabled !== 'boolean') throw new ValidationError('حقل التفعيل (enabled) مطلوب');
    const emp = input.employeeUserId === undefined || input.employeeUserId === null || input.employeeUserId === '' ? null : String(input.employeeUserId);
    if (emp !== null && !isUuid(emp)) throw new ValidationError('معرف الموظف غير صالح');
    let limit: number | null = null;
    if (input.limitAmount !== undefined && input.limitAmount !== null && input.limitAmount !== '') {
      const n = Number(input.limitAmount);
      if (!Number.isFinite(n) || n <= 0 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw new ValidationError('سقف العهدة يجب أن يكون رقما موجبا بحد أقصى خانتين عشريتين');
      limit = toMoney(n);
    }
    if (input.enabled && limit === null) throw new ValidationError('السقف مطلوب عند التفعيل');
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : null;
    return await withTenantTransaction(companyId, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`custody_limit_policy:${companyId}:${emp ?? 'default'}`]);
      const cur = await tx.query<{ v: number }>(
        `SELECT COALESCE(MAX(version),0)::int AS v FROM custody_limit_policies WHERE company_id = $1 AND employee_user_id IS NOT DISTINCT FROM $2`,
        [companyId, emp]
      );
      const version = cur.rows[0].v + 1;
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO custody_limit_policies (company_id, employee_user_id, version, enabled, limit_amount, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [companyId, emp, version, input.enabled, limit, reason, actorId]
      );
      await this.auditService.record(
        { actorUserId: actorId || null, companyId, action: 'CUSTODY_LIMIT_POLICY_SET', entityType: 'custody_limit_policies', entityId: ins.rows[0].id,
          metadata: { employeeUserId: emp, version, enabled: input.enabled, limitAmount: limit, reason } },
        { executor: tx }
      );
      return { id: ins.rows[0].id, employeeUserId: emp, version, enabled: input.enabled as boolean, limitAmount: limit, reason };
    });
  }

  async listPolicies(companyId: string): Promise<CustodyLimitPolicyView[]> {
    if (!companyId || !isUuid(companyId)) throw new ValidationError('معرف الشركة غير صالح');
    return await withTenantTransaction(companyId, async (tx) => {
      const r = await tx.query<any>(
        `SELECT DISTINCT ON (COALESCE(employee_user_id,'00000000-0000-0000-0000-000000000000'::uuid))
                id, employee_user_id AS "employeeUserId", version, enabled, limit_amount AS "limitAmount", reason
           FROM custody_limit_policies WHERE company_id = $1
          ORDER BY COALESCE(employee_user_id,'00000000-0000-0000-0000-000000000000'::uuid), version DESC`,
        [companyId]
      );
      return r.rows.map((x: any) => ({ id: x.id, employeeUserId: x.employeeUserId, version: Number(x.version), enabled: x.enabled,
        limitAmount: x.limitAmount === null ? null : toMoney(Number(x.limitAmount)), reason: x.reason }));
    });
  }
}
export const defaultCustodyLimitService = new CustodyLimitService();
