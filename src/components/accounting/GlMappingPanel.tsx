import React, { useEffect, useState, useCallback } from 'react';
import {
  Link2,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Save,
  Send,
  ShieldCheck,
  Lock,
  Info,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { AccountOption, usableAccounts, isUsable } from '../../lib/accountRules.js';

interface GlEventField {
  field: string;
  labelAr: string;
  allowedTypes: string[];
  requirePostable: boolean;
}

interface GlEventItem {
  eventKey: string;
  eventCode: string;
  labelAr: string;
  status: 'wired' | 'not_implemented';
  wiringPoint?: string;
  fields: GlEventField[];
}

interface ResolvedGlEvent {
  eventKey: string;
  accounts: Record<string, string>;
  source: 'config_platform' | 'company_settings' | 'none';
  versionNo: number | null;
}

interface GlMappingPanelProps {
  companyId: string;
  userRole?: string;
}

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  asset: 'أصول',
  liability: 'التزامات',
  equity: 'حقوق ملكية',
  revenue: 'إيرادات',
  expense: 'مصروفات',
};

export function GlMappingPanel({ companyId, userRole }: GlMappingPanelProps) {
  const [events, setEvents] = useState<GlEventItem[]>([]);
  const [activeEventKey, setActiveEventKey] = useState<string>('');
  const [loadingEvents, setLoadingEvents] = useState<boolean>(true);

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [resolved, setResolved] = useState<ResolvedGlEvent | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [hasPersistedDraft, setHasPersistedDraft] = useState<boolean>(false);
  const [loadingEventData, setLoadingEventData] = useState<boolean>(false);

  const [changeSummary, setChangeSummary] = useState<string>('');
  const [validating, setValidating] = useState<boolean>(false);
  const [savingDraft, setSavingDraft] = useState<boolean>(false);
  const [publishing, setPublishing] = useState<boolean>(false);

  const [canWrite, setCanWrite] = useState<boolean>(
    userRole === 'platform_admin' || userRole === 'company_admin'
  );

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [validateResult, setValidateResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Resolve effective permissions (COMPANY_SETTINGS_WRITE) from /api/auth/me
  useEffect(() => {
    let cancelled = false;
    async function checkPermissions() {
      try {
        const res = await apiFetch('/api/auth/me');
        if (!res.ok) return;
        const data = await res.json();
        const perms: string[] = Array.isArray(data.permissions) ? data.permissions : [];
        const membership = Array.isArray(data.memberships)
          ? data.memberships.find((m: { companyId?: string; isActive?: boolean; roleCode?: string }) => m.companyId === companyId && m.isActive !== false)
          : null;
        if (!cancelled) {
          const roleWritable =
            userRole === 'platform_admin' ||
            userRole === 'company_admin' ||
            membership?.roleCode === 'company_admin';
          const permWritable = perms.includes('company.settings.write');
          setCanWrite(roleWritable || permWritable);
        }
      } catch {
        // Retain role fallback if /me request fails transiently
      }
    }
    checkPermissions();
    return () => {
      cancelled = true;
    };
  }, [companyId, userRole]);

  // 1. Load GL event catalog first
  const loadCatalog = useCallback(async () => {
    if (!companyId) return;
    setLoadingEvents(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/accounting/gl-events?companyId=${encodeURIComponent(companyId)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || 'تعذر تحميل كتالوج أحداث الربط المحاسبي');
      }
      const data = await res.json();
      const list: GlEventItem[] = Array.isArray(data.events) ? data.events : [];
      setEvents(list);
      const firstWired = list.find((e) => e.status === 'wired');
      if (firstWired) {
        setActiveEventKey((prev) =>
          prev && list.some((e) => e.status === 'wired' && e.eventKey === prev) ? prev : firstWired.eventKey
        );
      } else {
        setActiveEventKey('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في تحميل أحداث الربط المحاسبي');
    } finally {
      setLoadingEvents(false);
    }
  }, [companyId]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const wiredEvents = events.filter((e) => e.status === 'wired');
  const unwiredEvents = events.filter((e) => e.status !== 'wired');
  const activeEvent = wiredEvents.find((e) => e.eventKey === activeEventKey) || null;

  // 2. Load accounts, resolved GL mapping & current draft for active wired event
  const loadActiveEventState = useCallback(async () => {
    if (!companyId || !activeEvent) return;
    setLoadingEventData(true);
    setError(null);
    setValidateResult(null);
    setFieldErrors({});

    try {
      const [accRes, resolveRes, draftRes] = await Promise.all([
        apiFetch(`/api/accounting/accounts?companyId=${encodeURIComponent(companyId)}`),
        apiFetch(`/api/companies/${companyId}/gl-events/${encodeURIComponent(activeEvent.eventKey)}/resolve`),
        apiFetch(`/api/companies/${companyId}/config/draft?key=${encodeURIComponent(activeEvent.eventKey)}`),
      ]);

      if (!accRes.ok) {
        const d = await accRes.json().catch(() => ({}));
        throw new Error(d.message || d.error || 'تعذر تحميل دليل الحسابات');
      }
      const accBody = await accRes.json();
      setAccounts((accBody.accounts || []).filter((a: AccountOption) => a.isActive !== false));

      let resolvedData: ResolvedGlEvent | null = null;
      if (resolveRes.ok) {
        const resBody = await resolveRes.json();
        resolvedData = resBody.resolved || null;
        setResolved(resolvedData);
      } else {
        const d = await resolveRes.json().catch(() => ({}));
        throw new Error(d.message || d.error || 'تعذر قراءة الربط الفعلي للحدث');
      }

      const initialValues: Record<string, string> = {};
      for (const f of activeEvent.fields) {
        initialValues[f.field] = '';
      }

      if (draftRes.ok) {
        const draftBody = await draftRes.json();
        const draftContent = (draftBody.draft?.content || {}) as Record<string, unknown>;
        setHasPersistedDraft(Boolean(draftBody.draft?.id));
        for (const f of activeEvent.fields) {
          const val = draftContent[f.field];
          if (typeof val === 'string' && val.trim() !== '') {
            initialValues[f.field] = val.trim();
          } else if (resolvedData?.accounts?.[f.field]) {
            initialValues[f.field] = resolvedData.accounts[f.field];
          }
        }
      } else if (resolvedData?.accounts) {
        setHasPersistedDraft(false);
        for (const f of activeEvent.fields) {
          initialValues[f.field] = resolvedData.accounts[f.field] || '';
        }
      }

      setFormValues(initialValues);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في تحميل بيانات الربط المحاسبي');
    } finally {
      setLoadingEventData(false);
    }
  }, [companyId, activeEvent]);

  useEffect(() => {
    loadActiveEventState();
  }, [loadActiveEventState]);

  const handleFieldChange = (field: string, value: string) => {
    setFormValues((prev) => ({ ...prev, [field]: value }));
    setValidateResult(null);
    setSuccess(null);
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  // Dry-run validation via POST /api/companies/:companyId/gl-events/:eventKey/validate
  const handleValidate = async () => {
    if (!companyId || !activeEvent) return;
    setValidating(true);
    setValidateResult(null);
    setFieldErrors({});
    setError(null);
    try {
      const res = await apiFetch(
        `/api/companies/${companyId}/gl-events/${encodeURIComponent(activeEvent.eventKey)}/validate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: formValues }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        setValidateResult({ ok: true, message: 'الإعداد صالح — جاهز للحفظ والنشر' });
      } else {
        setValidateResult({ ok: false, message: body.message || body.error || 'الإعداد غير صالح' });
        if (body.field) {
          setFieldErrors({ [body.field]: body.message || body.error });
        }
      }
    } catch {
      setValidateResult({ ok: false, message: 'تعذر تنفيذ التحقق المسبق — تحقق من الاتصال' });
    } finally {
      setValidating(false);
    }
  };

  // Save Draft via shared PUT /api/companies/:companyId/config/draft
  const handleSaveDraft = async () => {
    if (!companyId || !activeEvent || !canWrite) return;
    setSavingDraft(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/companies/${companyId}/config/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: activeEvent.eventKey, content: formValues }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || body.error || 'فشل حفظ المسودة');
      }
      setSuccess('تم حفظ مسودة الربط المحاسبي بنجاح');
      await loadActiveEventState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في حفظ المسودة');
    } finally {
      setSavingDraft(false);
    }
  };

  // Save draft + Publish via shared POST /api/companies/:companyId/config/publish
  const handlePublish = async () => {
    if (!companyId || !activeEvent || !canWrite || !changeSummary.trim()) return;
    setPublishing(true);
    setError(null);
    setSuccess(null);
    try {
      // Ensure latest form values are saved into draft before publishing
      const draftRes = await apiFetch(`/api/companies/${companyId}/config/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: activeEvent.eventKey, content: formValues }),
      });
      const draftBody = await draftRes.json().catch(() => ({}));
      if (!draftRes.ok) {
        throw new Error(draftBody.message || draftBody.error || 'فشل حفظ المسودة قبل النشر');
      }

      const pubRes = await apiFetch(`/api/companies/${companyId}/config/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: activeEvent.eventKey,
          changeSummary: changeSummary.trim(),
        }),
      });
      const pubBody = await pubRes.json().catch(() => ({}));
      if (!pubRes.ok) {
        throw new Error(pubBody.message || pubBody.error || 'فشل نشر الربط المحاسبي');
      }

      setSuccess(`تم نشر الربط المحاسبي (v${pubBody.published?.versionNo}) بنجاح`);
      setChangeSummary('');
      await loadActiveEventState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في نشر الربط المحاسبي');
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="w-full flex flex-col gap-6" dir="rtl">
      {/* Header Card */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl flex flex-col gap-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Link2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">الربط المحاسبي للعمليات (GL Account Mapping)</h3>
              <p className="text-xs text-slate-400">
                تهيئة حسابات الترحيل التلقائي للعمليات الموصولة فعليًا في المحرك المحاسبي
              </p>
            </div>
          </div>

          {!canWrite && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-950/40 border border-amber-800/60 text-amber-300 text-xs">
              <Lock className="w-3.5 h-3.5 shrink-0" />
              <span>للقراءة فقط (يتطلب صلاحية تعديل إعدادات الشركة)</span>
            </div>
          )}
        </div>

        {/* Wired Event Tabs */}
        {loadingEvents ? (
          <div className="py-6 flex items-center justify-center gap-2 text-xs text-slate-400">
            <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
            <span>جاري تحميل كتالوج أحداث الربط المحاسبي...</span>
          </div>
        ) : events.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400 bg-slate-950/60 border border-slate-800 rounded-xl">
            لا توجد أحداث ربط محاسبي مسجلة حاليًا في الكتالوج.
          </div>
        ) : wiredEvents.length === 0 ? (
          <div className="py-8 text-center text-xs text-amber-400 bg-amber-950/20 border border-amber-800/40 rounded-xl">
            لا توجد أحداث ربط موصولة بمسار ترحيل فعلي حاليًا.
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {wiredEvents.map((ev) => (
              <button
                key={ev.eventKey}
                onClick={() => setActiveEventKey(ev.eventKey)}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                  activeEventKey === ev.eventKey
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                    : 'bg-slate-950 text-slate-300 hover:text-white border border-slate-800'
                }`}
              >
                <ShieldCheck className="w-4 h-4" />
                <span>{ev.labelAr}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Status Messages */}
      {error && (
        <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="p-4 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          <span>{success}</span>
        </div>
      )}

      {/* Active Wired Event Card */}
      {activeEvent && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl flex flex-col gap-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-bold text-white">{activeEvent.labelAr}</h4>
                <span className="text-[11px] font-mono text-indigo-300 bg-slate-950 border border-slate-800 px-2 py-0.5 rounded-lg">
                  {activeEvent.eventKey}
                </span>
              </div>
              {activeEvent.wiringPoint && (
                <p className="text-[11px] text-slate-400">
                  نقطة الترحيل الفعلية: <span className="font-mono text-slate-300">{activeEvent.wiringPoint}</span>
                </p>
              )}
            </div>

            {/* Source Badge */}
            <div className="flex flex-wrap items-center gap-2">
              {resolved?.source === 'config_platform' && resolved.versionNo !== null ? (
                <span className="px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold">
                  منشور v{resolved.versionNo}
                </span>
              ) : (
                <span className="px-3 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-bold">
                  القيمة الافتراضية — لم يُضبط بعد
                </span>
              )}
              {hasPersistedDraft && (
                <span className="px-2.5 py-1 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[11px] font-bold">
                  توجد مسودة محفوظة
                </span>
              )}
            </div>
          </div>

          {loadingEventData ? (
            <div className="py-8 flex items-center justify-center gap-2 text-xs text-slate-400">
              <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
              <span>جاري تحميل حسابات الشركة وإعداد الربط...</span>
            </div>
          ) : (
            <>
              {/* Validation Result Banner */}
              {validateResult && (
                <div
                  className={`p-3.5 rounded-xl text-xs flex items-center gap-2 border ${
                    validateResult.ok
                      ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                      : 'bg-amber-950/40 border-amber-800/60 text-amber-300'
                  }`}
                >
                  {validateResult.ok ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                  ) : (
                    <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
                  )}
                  <span>{validateResult.message}</span>
                </div>
              )}

              {/* Dynamic Fields from Event Catalog */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {activeEvent.fields.map((fieldDef) => {
                  const selectedId = formValues[fieldDef.field] || '';
                  const eligible = usableAccounts(accounts, fieldDef);
                  const usableCheck = isUsable(selectedId, accounts, fieldDef);
                  const typeText = fieldDef.allowedTypes
                    .map((t) => ACCOUNT_TYPE_LABELS[t] || t)
                    .join(' / ');

                  return (
                    <div
                      key={fieldDef.field}
                      className="bg-slate-950/70 border border-slate-800 rounded-xl p-4 flex flex-col gap-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <label className="text-xs font-bold text-slate-200">
                          {fieldDef.labelAr}
                        </label>
                        <span className="text-[10px] text-slate-400 font-mono">
                          {fieldDef.field} ({typeText})
                        </span>
                      </div>

                      <select
                        value={selectedId}
                        onChange={(e) => handleFieldChange(fieldDef.field, e.target.value)}
                        disabled={!canWrite || savingDraft || publishing}
                        className="bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2.5 focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                      >
                        <option value="">-- اختر {fieldDef.labelAr} --</option>
                        {eligible.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            {acc.code} - {acc.nameAr}
                          </option>
                        ))}
                      </select>

                      {eligible.length === 0 && (
                        <p className="text-[11px] text-amber-400">
                          لا توجد حسابات فرعية نشطة وقابلة للترحيل من نوع ({typeText}) في دليل هذه الشركة.
                        </p>
                      )}

                      {fieldErrors[fieldDef.field] && (
                        <p className="text-red-400 text-[11px] flex items-center gap-1">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                          <span>{fieldErrors[fieldDef.field]}</span>
                        </p>
                      )}

                      {!usableCheck && (
                        <p className="text-amber-400 text-[11px] flex items-center gap-1">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                          <span>
                            الحساب المختار غير مطابق لشروط الدور ({typeText}
                            {fieldDef.requirePostable ? ' وقابل للترحيل' : ''}) — النشر سيرفضه من الخادم.
                          </span>
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Action Bar: Dry-Run, Save Draft, Publish */}
              <div className="pt-4 border-t border-slate-800 flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={handleValidate}
                    disabled={validating || loadingEventData}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white rounded-xl text-xs font-semibold transition cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${validating ? 'animate-spin' : ''}`} />
                    <span>{validating ? 'جاري التحقق...' : 'تحقق مسبق'}</span>
                  </button>

                  <button
                    onClick={handleSaveDraft}
                    disabled={!canWrite || savingDraft || publishing || loadingEventData}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 disabled:opacity-50 text-white rounded-xl text-xs font-semibold transition cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{savingDraft ? 'جاري الحفظ...' : 'حفظ مسودة'}</span>
                  </button>
                </div>

                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={changeSummary}
                    onChange={(e) => setChangeSummary(e.target.value)}
                    placeholder="ملخص التغيير قبل النشر (مطلوب للتدقيق)..."
                    disabled={!canWrite || publishing}
                    className="flex-1 bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3.5 py-2.5 focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                  />
                  <button
                    onClick={handlePublish}
                    disabled={!canWrite || publishing || savingDraft || !changeSummary.trim()}
                    className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-indigo-600/20 cursor-pointer shrink-0"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>{publishing ? 'جاري النشر...' : 'نشر'}</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Read-only Section for Unwired / Not Implemented Operations (NO inputs) */}
      {!loadingEvents && unwiredEvents.length > 0 && (
        <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 flex flex-col gap-4">
          <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
            <Info className="w-4 h-4 text-slate-400" />
            <h4 className="text-sm font-bold text-slate-200">عمليات لسه غير مربوطة</h4>
            <span className="text-[11px] text-slate-500">
              ({unwiredEvents.length} عمليات معلنة في الكتالوج بانتظار تنفيذ دورة الترحيل الخاصة بها)
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {unwiredEvents.map((ev) => (
              <div
                key={ev.eventKey}
                className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5 flex flex-col gap-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-200">{ev.labelAr}</span>
                  <span className="text-[10px] font-mono text-slate-500">{ev.eventCode}</span>
                </div>
                <p className="text-[11px] text-amber-400/90 leading-relaxed">
                  غير متاح في هذه النسخة — يحتاج تنفيذ دورة الترحيل أولًا
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
