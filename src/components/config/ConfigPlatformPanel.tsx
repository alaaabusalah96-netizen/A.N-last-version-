import React, { useState, useEffect } from 'react';
import { SlidersHorizontal, Building2, RefreshCw, AlertCircle, Save, CheckCircle2, History, RotateCcw } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface Company {
  id: string;
  code: string;
  nameAr: string;
}

interface ConfigDefinition {
  id: string;
  key: string;
  description: string | null;
}

interface ConfigVersion {
  id: string;
  versionNo: number;
  isActive: boolean;
  changeSummary: string;
  publishedAt: string;
}

interface ConfigPlatformPanelProps {
  userRole?: string;
}

export function ConfigPlatformPanel({ userRole }: ConfigPlatformPanelProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [loadingCompanies, setLoadingCompanies] = useState(true);

  const [definitions, setDefinitions] = useState<ConfigDefinition[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [loadingDefinitions, setLoadingDefinitions] = useState(false);

  const [draftContent, setDraftContent] = useState<string>('{}');
  const [draftStatus, setDraftStatus] = useState<string>('');
  const [versions, setVersions] = useState<ConfigVersion[]>([]);
  
  const [changeSummary, setChangeSummary] = useState<string>('');
  const [rollbackVersionNo, setRollbackVersionNo] = useState<number | ''>('');
  const [rollbackSummary, setRollbackSummary] = useState<string>('');

  const [loadingConfig, setLoadingConfig] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const canWrite = userRole === 'platform_admin' || userRole === 'company_admin';

  // Load companies
  useEffect(() => {
    async function loadCompanies() {
      setLoadingCompanies(true);
      setError(null);
      try {
        const res = await apiFetch('/api/companies');
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.message || data.error || 'تعذر تحميل الشركات');
        }
        const data = await res.json();
        const list: Company[] = data.companies || [];
        setCompanies(list);
        if (list.length > 0) {
          setSelectedCompanyId(list[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'خطأ في جلب الشركات');
      } finally {
        setLoadingCompanies(false);
      }
    }
    loadCompanies();
  }, []);

  // Load definitions
  useEffect(() => {
    async function loadDefinitions() {
      setLoadingDefinitions(true);
      try {
        const res = await apiFetch('/api/config/definitions');
        if (res.ok) {
          const data = await res.json();
          const list: ConfigDefinition[] = data.definitions || [];
          setDefinitions(list);
          if (list.length > 0 && !selectedKey) {
            setSelectedKey(list[0].key);
          }
        }
      } catch {
        // ignore error
      } finally {
        setLoadingDefinitions(false);
      }
    }
    loadDefinitions();
  }, []);

  // Load key config (draft + versions)
  const loadKeyConfig = async () => {
    if (!selectedCompanyId || !selectedKey) return;
    setLoadingConfig(true);
    setError(null);
    try {
      // 1) Load draft
      const draftRes = await apiFetch(`/api/companies/${selectedCompanyId}/config/draft?key=${encodeURIComponent(selectedKey)}`);
      if (draftRes.ok) {
        const draftBody = await draftRes.json();
        if (draftBody.draft) {
          setDraftContent(JSON.stringify(draftBody.draft.content, null, 2));
          setDraftStatus(draftBody.draft.status || 'draft');
        }
      }

      // 2) Load versions
      const verRes = await apiFetch(`/api/companies/${selectedCompanyId}/config/versions?key=${encodeURIComponent(selectedKey)}`);
      if (verRes.ok) {
        const verBody = await verRes.json();
        setVersions(verBody.versions || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في جلب بيانات الإعداد');
    } finally {
      setLoadingConfig(false);
    }
  };

  useEffect(() => {
    loadKeyConfig();
  }, [selectedCompanyId, selectedKey]);

  // Save Draft
  const handleSaveDraft = async () => {
    if (!selectedCompanyId || !selectedKey || !canWrite) return;
    setSavingDraft(true);
    setError(null);
    setSuccess(null);
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(draftContent);
      } catch {
        throw new Error('محتوى المسودة غير مطابق لصيغة JSON الصحيحة');
      }

      const res = await apiFetch(`/api/companies/${selectedCompanyId}/config/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: selectedKey, content: parsed }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.message || body.error || 'فشل حفظ المسودة');
      }

      setSuccess('تم حفظ المسودة بنجاح');
      loadKeyConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في حفظ المسودة');
    } finally {
      setSavingDraft(false);
    }
  };

  // Publish Draft
  const handlePublish = async () => {
    if (!selectedCompanyId || !selectedKey || !canWrite || !changeSummary.trim()) return;
    setPublishing(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/config/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: selectedKey, changeSummary: changeSummary.trim() }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.message || body.error || 'فشل نشر الإعداد');
      }

      setSuccess(`تم نشر الإصدار v${body.published?.versionNo} بنجاح`);
      setChangeSummary('');
      loadKeyConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في النشر');
    } finally {
      setPublishing(false);
    }
  };

  // Rollback
  const handleRollback = async () => {
    if (!selectedCompanyId || !selectedKey || !canWrite || !rollbackVersionNo || !rollbackSummary.trim()) return;
    setRollingBack(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/config/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: selectedKey,
          targetVersionNo: Number(rollbackVersionNo),
          changeSummary: rollbackSummary.trim(),
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.message || body.error || 'فشل التراجع للإصدار المكتوب');
      }

      setSuccess(`تم التراجع للإصدار v${rollbackVersionNo} بنجاح (تم إنشاء v${body.published?.versionNo})`);
      setRollbackVersionNo('');
      setRollbackSummary('');
      loadKeyConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في عملية التراجع');
    } finally {
      setRollingBack(false);
    }
  };

  return (
    <div className="w-full flex flex-col gap-6" dir="rtl">
      {/* Header & Company / Definition Bar */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl backdrop-blur-md flex flex-col gap-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <SlidersHorizontal className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">منصة الإعدادات المركزية (Configuration Platform)</h3>
              <p className="text-xs text-slate-400">إدارة مسودات وإصدارات التكييفات وتوزيعها على المستأجرين مع سجل تدقيق حتمي</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5 shrink-0">
              <Building2 className="w-4 h-4 text-indigo-400" />
              الشركة:
            </label>
            {loadingCompanies ? (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>جاري التحميل...</span>
              </div>
            ) : (
              <select
                value={selectedCompanyId}
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3.5 py-2 focus:outline-none focus:border-indigo-500"
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} - {c.nameAr}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Definition Key Selector */}
        <div className="flex flex-col md:flex-row md:items-center gap-4">
          <label className="text-xs font-semibold text-slate-300 shrink-0">مفتاح الإعداد (Config Definition):</label>
          {loadingDefinitions ? (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>جاري تحميل التعاريف...</span>
            </div>
          ) : (
            <select
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value)}
              className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3.5 py-2 focus:outline-none focus:border-indigo-500 flex-1"
            >
              {definitions.map((d) => (
                <option key={d.id} value={d.key}>
                  {d.key} {d.description ? `(${d.description})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
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

      {/* Main Workspace (Draft Editor + Version History) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Draft Editor & Publish */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl flex flex-col gap-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h4 className="text-sm font-bold text-white flex items-center gap-2">
              <span>محرر المسودة (Draft Editor)</span>
              {draftStatus && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-normal">
                  الحالة: {draftStatus}
                </span>
              )}
            </h4>
            <button
              onClick={handleSaveDraft}
              disabled={!canWrite || savingDraft || loadingConfig}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white rounded-xl text-xs font-semibold transition cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{savingDraft ? 'جاري الحفظ...' : 'حفظ المسودة'}</span>
            </button>
          </div>

          <textarea
            value={draftContent}
            onChange={(e) => setDraftContent(e.target.value)}
            disabled={!canWrite || loadingConfig}
            rows={12}
            className="w-full bg-slate-950 border border-slate-800 text-emerald-400 font-mono text-xs rounded-xl p-3.5 focus:outline-none focus:border-indigo-500 resize-none leading-relaxed"
            placeholder="{}"
          />

          {/* Publish Action Box */}
          <div className="pt-4 border-t border-slate-800 flex flex-col gap-3">
            <label className="text-xs font-semibold text-slate-300">ملخص التغيير قبل النشر (مطلوب):</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={changeSummary}
                onChange={(e) => setChangeSummary(e.target.value)}
                placeholder="أدخل سبب النشر لتدقيق التغييرات..."
                disabled={!canWrite || publishing}
                className="flex-1 bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={handlePublish}
                disabled={!canWrite || publishing || !changeSummary.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-indigo-600/20 cursor-pointer shrink-0"
              >
                <span>{publishing ? 'جاري النشر...' : 'نشر المسودة'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Version History & Rollback */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl flex flex-col gap-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h4 className="text-sm font-bold text-white flex items-center gap-2">
              <History className="w-4 h-4 text-indigo-400" />
              <span>سجل الإصدارات المنشورة (Versions History)</span>
            </h4>
          </div>

          {/* Versions Table */}
          <div className="overflow-x-auto flex-1 max-h-[300px]">
            {versions.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">لا توجد إصدارات منشورة لهذا الإعداد حتى الآن</div>
            ) : (
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                    <th className="py-2 px-2">الإصدار</th>
                    <th className="py-2 px-2">الحالة</th>
                    <th className="py-2 px-2">سبب النشر</th>
                    <th className="py-2 px-2">تاريخ النشر</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {versions.map((ver) => (
                    <tr key={ver.id} className="hover:bg-slate-800/30">
                      <td className="py-2.5 px-2 font-mono text-indigo-300 font-bold">v{ver.versionNo}</td>
                      <td className="py-2.5 px-2">
                        {ver.isActive ? (
                          <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-bold border border-emerald-500/30">
                            نشط (Active)
                          </span>
                        ) : (
                          <span className="text-slate-500 text-[10px]">سابق</span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-slate-200">{ver.changeSummary}</td>
                      <td className="py-2.5 px-2 text-slate-400 font-mono text-[11px]">
                        {ver.publishedAt ? ver.publishedAt.slice(0, 10) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Rollback Box */}
          <div className="pt-4 border-t border-slate-800 flex flex-col gap-3">
            <h5 className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
              <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
              <span>التراجع إلى إصدار سابق (Rollback)</span>
            </h5>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="number"
                value={rollbackVersionNo}
                onChange={(e) => setRollbackVersionNo(e.target.value ? Number(e.target.value) : '')}
                placeholder="رقم الإصدار (مثلاً 1)"
                disabled={!canWrite || rollingBack}
                className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500"
              />
              <input
                type="text"
                value={rollbackSummary}
                onChange={(e) => setRollbackSummary(e.target.value)}
                placeholder="سبب التراجع..."
                disabled={!canWrite || rollingBack}
                className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={handleRollback}
                disabled={!canWrite || rollingBack || !rollbackVersionNo || !rollbackSummary.trim()}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-amber-600/20 cursor-pointer"
              >
                <span>{rollingBack ? 'جاري التراجع...' : 'تراجع للإصدار'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
