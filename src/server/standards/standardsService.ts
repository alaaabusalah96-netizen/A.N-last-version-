import { getDefaultExecutor } from '../db/index.js';
import { withTenantTransaction } from '../db/transactionManager.js';
import { DbExecutor } from '../db/types.js';
import { ValidationError, ForbiddenError } from '../http/errors.js';
import { defaultAuditService } from '../audit/auditService.js';

export interface Framework { code: string; nameAr: string; nameEn: string; kind: 'international' | 'country'; countryCode: string | null; isActive: boolean }
export interface CompanyProfile { id: string; frameworkCode: string; countryCode: string; validFrom: string; note: string | null; createdAt: string }
export type PolicyStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'RETIRED';
export interface Policy {
  id: string; policyKey: string; frameworkCode: string; countryCode: string | null; standardRef: string; version: number;
  validFrom: string | null; validTo: string | null; value: Record<string, unknown>; status: PolicyStatus;
  sourceReference: string | null; sourceVerified: boolean; createdAt: string;
}
export type ResolveResult =
  | { status: 'RESOLVED'; policy: Policy; frameworkCode: string; countryCode: string }
  | { status: 'NO_PROFILE' }
  | { status: 'NONE'; frameworkCode: string; countryCode: string; draftExists: boolean };

export interface PolicyInput {
  policyKey: string; frameworkCode: string; countryCode?: string | null; standardRef: string; validFrom: string | null;
  value?: Record<string, unknown>; status?: PolicyStatus; sourceReference?: string | null; sourceVerified?: boolean;
}

export interface DatasetRow { id: string; title?: string; framework: string; jurisdiction?: string; version_or_amendment?: string; effective_from?: string | null; effective_to_or_superseded_by?: string; scope_one_line?: string; source_url?: string; source_authority?: string; verification_status?: string; note?: string; legal_in_force_date?: string | null; legal_in_force_source?: string | null }
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[a-z][a-z0-9_.]{1,79}$/;
export const isIsoDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const dayBefore = (s: string) => new Date(new Date(s + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);

const POLICY_COLS = `id, policy_key as "policyKey", framework_code as "frameworkCode", country_code as "countryCode", standard_ref as "standardRef",
  version, to_char(valid_from,'YYYY-MM-DD') as "validFrom", to_char(valid_to,'YYYY-MM-DD') as "validTo", value, status,
  source_reference as "sourceReference", source_verified as "sourceVerified", created_at as "createdAt"`;

/**
 * Accounting standards engine, step A+B. Decision data only: nothing here posts or changes a journal.
 * Policies are platform-level and append-only. Only ACTIVE policies with a verified source resolve; a DRAFT never drives anything.
 */
export class StandardsService {
  private async exec(): Promise<DbExecutor> {
    const e = await getDefaultExecutor();
    if (!e) throw new Error('DB_UNAVAILABLE: Database executor required for standards');
    return e;
  }

  async listFrameworks(): Promise<Framework[]> {
    const e = await this.exec();
    const r = await e.query<Framework>(`SELECT code, name_ar as "nameAr", name_en as "nameEn", kind, country_code as "countryCode", is_active as "isActive" FROM accounting_frameworks ORDER BY code`);
    return r.rows;
  }

  async getProfileOn(companyId: string, date: string, ex?: DbExecutor): Promise<CompanyProfile | null> {
    if (!isIsoDate(date)) throw new ValidationError('التاريخ يجب أن يكون بصيغة YYYY-MM-DD');
    const run = async (x: DbExecutor) => {
      const r = await x.query<CompanyProfile>(
        `SELECT id, framework_code as "frameworkCode", country_code as "countryCode", to_char(valid_from,'YYYY-MM-DD') as "validFrom", note, created_at as "createdAt"
         FROM company_accounting_profiles WHERE company_id = $1 AND valid_from <= $2::date ORDER BY valid_from DESC LIMIT 1`, [companyId, date]);
      return r.rows[0] || null;
    };
    return ex ? run(ex) : withTenantTransaction(companyId, run);
  }

  async listProfileHistory(companyId: string): Promise<CompanyProfile[]> {
    return withTenantTransaction(companyId, async (ex) => (await ex.query<CompanyProfile>(
      `SELECT id, framework_code as "frameworkCode", country_code as "countryCode", to_char(valid_from,'YYYY-MM-DD') as "validFrom", note, created_at as "createdAt"
       FROM company_accounting_profiles WHERE company_id = $1 ORDER BY valid_from DESC`, [companyId])).rows);
  }

  /** Append a new profile effective from a date. History is never edited. */
  async setProfile(companyId: string, input: { frameworkCode: string; countryCode: string; validFrom: string; note?: string }, actorId: string): Promise<CompanyProfile> {
    const countryCode = (input.countryCode || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) throw new ValidationError('رمز الدولة يجب أن يكون حرفين (مثل EG)');
    if (!isIsoDate(input.validFrom)) throw new ValidationError('تاريخ البدء يجب أن يكون بصيغة YYYY-MM-DD');
    return withTenantTransaction(companyId, async (tx) => {
      const fw = (await tx.query<any>(`SELECT code, kind, country_code as "countryCode", is_active as "isActive" FROM accounting_frameworks WHERE code = $1`, [input.frameworkCode])).rows[0];
      if (!fw || !fw.isActive) throw new ValidationError('الإطار المحاسبي غير معرّف أو غير نشط');
      if (fw.kind === 'country' && fw.countryCode !== countryCode) throw new ValidationError('الإطار المحاسبي خاص بدولة أخرى غير دولة الشركة');
      const dup = await tx.query(`SELECT 1 FROM company_accounting_profiles WHERE company_id = $1 AND valid_from = $2::date`, [companyId, input.validFrom]);
      if (dup.rows.length) throw new ValidationError('يوجد إعداد إطار محاسبي بنفس تاريخ البدء. السجل لا يُعدَّل، اختر تاريخًا لاحقًا');
      const r = await tx.query<CompanyProfile>(
        `INSERT INTO company_accounting_profiles (company_id, framework_code, country_code, valid_from, note, created_by)
         VALUES ($1,$2,$3,$4::date,$5,$6)
         RETURNING id, framework_code as "frameworkCode", country_code as "countryCode", to_char(valid_from,'YYYY-MM-DD') as "validFrom", note, created_at as "createdAt"`,
        [companyId, input.frameworkCode, countryCode, input.validFrom, input.note?.trim() || null, actorId]);
      await defaultAuditService.record(
        { actorUserId: actorId, companyId, action: 'ACCOUNTING_PROFILE_SET', entityType: 'company_accounting_profiles', entityId: r.rows[0].id, metadata: { frameworkCode: input.frameworkCode, countryCode, validFrom: input.validFrom } },
        { executor: tx });
      return r.rows[0];
    });
  }

  async listPolicies(filter: { policyKey?: string; frameworkCode?: string } = {}): Promise<Policy[]> {
    const e = await this.exec();
    const w: string[] = []; const p: any[] = [];
    if (filter.policyKey) { p.push(filter.policyKey); w.push(`policy_key = $${p.length}`); }
    if (filter.frameworkCode) { p.push(filter.frameworkCode); w.push(`framework_code = $${p.length}`); }
    const r = await e.query<Policy>(`SELECT ${POLICY_COLS} FROM accounting_policies ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY policy_key, framework_code, country_code NULLS FIRST, version DESC`, p);
    return r.rows;
  }

  /** Append a new policy version (platform admin only). The previous open version of the same key/framework/country is closed the day before. */
  async createPolicyVersion(actor: { id: string; role: string }, input: PolicyInput): Promise<Policy> {
    if (actor.role !== 'platform_admin') throw new ForbiddenError('إدارة السياسات المحاسبية متاحة لمدير المنصة فقط');
    const key = (input.policyKey || '').trim();
    if (!KEY.test(key)) throw new ValidationError('مفتاح السياسة: حروف إنجليزية صغيرة وأرقام و _ و . (حتى 80)');
    const hasDate = input.validFrom != null && input.validFrom !== '';
    if (hasDate && !isIsoDate(input.validFrom)) throw new ValidationError('تاريخ السريان يجب أن يكون بصيغة YYYY-MM-DD');
    if (!hasDate && (input.status || 'DRAFT') !== 'DRAFT') throw new ValidationError('السياسة بدون تاريخ سريان موثق تبقى مسودة');
    const standardRef = (input.standardRef || '').trim();
    if (!standardRef) throw new ValidationError('مرجع المعيار مطلوب (مثل IAS 2)');
    const country = input.countryCode ? input.countryCode.trim().toUpperCase() : null;
    if (country && !/^[A-Z]{2}$/.test(country)) throw new ValidationError('رمز الدولة يجب أن يكون حرفين');
    const status: PolicyStatus = input.status || 'DRAFT';
    if (!['DRAFT', 'ACTIVE'].includes(status)) throw new ValidationError('الحالة عند الإنشاء DRAFT أو ACTIVE فقط');
    const src = (input.sourceReference || '').trim();
    if (status === 'ACTIVE' && !(input.sourceVerified === true && src)) throw new ValidationError('السياسة النشطة تحتاج مرجع مصدر رسمي ومراجعة المصدر (sourceVerified)');
    const value = input.value && typeof input.value === 'object' && !Array.isArray(input.value) ? input.value : {};
    const e = await this.exec();
    return e.withTransaction(async (tx: DbExecutor) => {
      const fw = (await tx.query<any>(`SELECT kind, country_code as "countryCode" FROM accounting_frameworks WHERE code = $1 AND is_active`, [input.frameworkCode])).rows[0];
      if (!fw) throw new ValidationError('الإطار المحاسبي غير معرّف أو غير نشط');
      if (fw.kind === 'country' && country && country !== fw.countryCode) throw new ValidationError('الدولة لا تطابق الإطار المحاسبي');
      const cur = (await tx.query<any>(
        `SELECT id, version, to_char(valid_from,'YYYY-MM-DD') as "validFrom", valid_to as "validTo", status FROM accounting_policies
         WHERE policy_key = $1 AND framework_code = $2 AND country_code IS NOT DISTINCT FROM $3 ORDER BY version DESC FOR UPDATE`, [key, input.frameworkCode, country])).rows;
      const latest = cur[0];
      // A verified correction of the same effective date is allowed (new version supersedes the old one); anything else must start later.
      const sameDateCorrection = !!(latest && hasDate && latest.validFrom === input.validFrom && status === 'ACTIVE');
      if (latest && hasDate && latest.validFrom && input.validFrom! <= latest.validFrom && !sameDateCorrection) throw new ValidationError('تاريخ السريان يجب أن يكون بعد تاريخ آخر إصدار لنفس السياسة. السجل لا يُعدَّل بأثر رجعي');
      const version = latest ? latest.version + 1 : 1;
      const r = await tx.query<Policy>(
        `INSERT INTO accounting_policies (policy_key, framework_code, country_code, standard_ref, version, valid_from, value, status, source_reference, source_verified, created_by)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7::jsonb,$8,$9,$10,$11) RETURNING ${POLICY_COLS}`,
        [key, input.frameworkCode, country, standardRef, version, hasDate ? input.validFrom : null, JSON.stringify(value), status, src || null, input.sourceVerified === true, actor.id]);
      for (const c of cur) {
        if (sameDateCorrection && c.id === latest.id && c.status !== 'DRAFT') {
          await tx.query(`UPDATE accounting_policies SET status = 'SUPERSEDED' WHERE id = $1`, [c.id]);
        } else if (c.validTo == null && c.status !== 'DRAFT' && hasDate && !sameDateCorrection) {
          await tx.query(`UPDATE accounting_policies SET valid_to = $2::date, status = 'SUPERSEDED' WHERE id = $1`, [c.id, dayBefore(input.validFrom!)]);
        }
      }
      await defaultAuditService.record(
        { actorUserId: actor.id, companyId: null, action: 'ACCOUNTING_POLICY_VERSION_CREATED', entityType: 'accounting_policies', entityId: r.rows[0].id, metadata: { policyKey: key, frameworkCode: input.frameworkCode, countryCode: country, version, validFrom: input.validFrom ?? null, status } },
        { executor: tx });
      return r.rows[0];
    });
  }

  /**
   * Load an official-standards dataset (rows: id, title, framework, jurisdiction, version_or_amendment, effective_from, source_url,
   * source_authority, verification_status, note, ...). A row becomes ACTIVE only when verification_status is OPENED, the effective date is an
   * exact YYYY-MM-DD and the source is an http(s) URL. Every other row is stored as DRAFT with its source and status kept, and its date left empty
   * unless it is an exact date. Reloading is additive: a row identical to the latest stored version is skipped; a changed row becomes a new version.
   */
  async loadDataset(actor: { id: string; role: string }, rows: DatasetRow[], meta?: { datasetVersion?: string; note?: string }): Promise<{ active: number; draft: number; unchanged: number; rejected: Array<{ index: number; id: string; reason: string }> }> {
    if (actor.role !== 'platform_admin') throw new ForbiddenError('تحميل بيانات المعايير متاح لمدير المنصة فقط');
    const out = { active: 0, draft: 0, unchanged: 0, rejected: [] as Array<{ index: number; id: string; reason: string }> };
    const e = await this.exec();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || ({} as DatasetRow);
      try {
        const id = String(r.id || '').trim();
        const slug = id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (!slug || !/^[a-z]/.test(slug)) throw new ValidationError('معرّف الصف غير صالح');
        const framework = String(r.framework || '').trim();
        const country = r.jurisdiction && /^[A-Za-z]{2}$/.test(String(r.jurisdiction)) ? String(r.jurisdiction).toUpperCase() : null;
        const url = String(r.source_url || '').trim();
        const okUrl = /^https?:\/\//i.test(url);
        const dateRaw = String(r.effective_from ?? '').trim();
        const m = /^(\d{4}-\d{2}-\d{2})(?:\s*\(day after publication\))?$/i.exec(dateRaw);
        const exact = m && isIsoDate(m[1]) ? m[1] : null; // a conditional date (partial scope, early option) is not an exact date
        const verified = r.verification_status === 'OPENED' && okUrl && exact != null;
        const value = {
          title: r.title ?? null, versionOrAmendment: r.version_or_amendment ?? null, effectiveFromRaw: dateRaw || null,
          effectiveToOrSupersededBy: r.effective_to_or_superseded_by ?? null, scope: r.scope_one_line ?? null,
          sourceAuthority: r.source_authority ?? null, verificationStatus: r.verification_status ?? 'NOT_VERIFIED', note: r.note ?? null,
          // The date a decree brought the text into legal force. It is NOT the date the standard applies to reporting periods.
          ...(r.legal_in_force_date && isIsoDate(r.legal_in_force_date) ? { legalInForceDate: r.legal_in_force_date, legalInForceSource: r.legal_in_force_source ?? null } : {}),
        };
        const key = `standard.${slug}`;
        const latest = (await e.query<any>(`SELECT value, source_reference as "sr", to_char(valid_from,'YYYY-MM-DD') as vf, status FROM accounting_policies
          WHERE policy_key = $1 AND framework_code = $2 AND country_code IS NOT DISTINCT FROM $3 ORDER BY version DESC LIMIT 1`, [key, framework, country])).rows[0];
        const status: PolicyStatus = verified ? 'ACTIVE' : 'DRAFT';
        if (latest && stable(latest.value) === stable(value) && (latest.sr || '') === url && (latest.vf || null) === exact && latest.status === status) { out.unchanged++; continue; }
        if (latest && latest.status === 'SUPERSEDED') { out.unchanged++; continue; }
        const p = await this.createPolicyVersion(actor, { policyKey: key, frameworkCode: framework, countryCode: country, standardRef: id, validFrom: exact, value, status, sourceReference: url || null, sourceVerified: verified });
        if (p.status === 'ACTIVE') out.active++; else out.draft++;
      } catch (err: any) { out.rejected.push({ index: i, id: String(r?.id ?? ''), reason: String(err?.message || err) }); }
    }
    try {
      await defaultAuditService.record(
        { actorUserId: actor.id, companyId: null, action: 'ACCOUNTING_DATASET_LOADED', entityType: 'accounting_policies', entityId: undefined,
          metadata: { datasetVersion: meta?.datasetVersion ?? null, note: (meta?.note ?? '').slice(0, 4000), rows: rows.length, active: out.active, draft: out.draft, unchanged: out.unchanged, rejected: out.rejected.length } },
        { mode: 'best_effort' });
    } catch { /* audit is best effort for dataset loads */ }
    return out;
  }

  /**
   * The policy that applies to a company on a date: company profile on that date -> framework + country,
   * then the ACTIVE verified version effective on the date. A country-specific policy beats a framework-wide one.
   * Draft or unverified policies never resolve.
   */
  async resolvePolicy(companyId: string, policyKey: string, date: string): Promise<ResolveResult> {
    const prof = await this.getProfileOn(companyId, date);
    if (!prof) return { status: 'NO_PROFILE' };
    const e = await this.exec();
    const rows = (await e.query<Policy>(
      `SELECT ${POLICY_COLS} FROM accounting_policies
       WHERE policy_key = $1 AND framework_code = $2 AND (country_code IS NULL OR country_code = $3)
         AND valid_from <= $4::date AND (valid_to IS NULL OR valid_to >= $4::date) AND status IN ('ACTIVE','SUPERSEDED')
         AND source_verified AND COALESCE(TRIM(source_reference),'') <> ''
       ORDER BY (country_code IS NOT NULL) DESC, version DESC`, [policyKey, prof.frameworkCode, prof.countryCode, date])).rows;
    if (rows.length) return { status: 'RESOLVED', policy: rows[0], frameworkCode: prof.frameworkCode, countryCode: prof.countryCode };
    const d = await e.query(`SELECT 1 FROM accounting_policies WHERE policy_key = $1 AND framework_code = $2 AND status = 'DRAFT' LIMIT 1`, [policyKey, prof.frameworkCode]);
    return { status: 'NONE', frameworkCode: prof.frameworkCode, countryCode: prof.countryCode, draftExists: d.rows.length > 0 };
  }
}

export const defaultStandardsService = new StandardsService();
