import React, { useState, useEffect } from 'react';
import { SlidersHorizontal, Building2, RefreshCw, AlertCircle, Save, CheckCircle2, History, RotateCcw, Eye, Layers } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { AccountOption, usableAccounts, isUsable } from '../../lib/accountRules.js';

interface Company {
  id: string;
  code: string;
  nameAr: string;
}

interface ConfigDefinition {
  id: string;
  key: string;
  domain?: string;
  labelAr?: string | null;
  defaultValue?: Record<string, unknown>;
  description: string | null;
}

const DOMAIN_LABELS: Record<string, string> = {
  system: 'النظام (system)',
  accounting: 'المحاسبة (accounting)',
  inventory: 'المستودعات (inventory)',
  purchasing: 'المشتريات (purchasing)',
  general: 'عام (general)',
};

interface ConfigVersion {
  id: string;
  versionNo: number;
  isActive: boolean;
  changeSummary: string;
  publishedAt: string;
}

interface ResolvedConfig {
  key: string;
  definitionId: string;
  source: 'company_published' | 'platform_default';
  versionNo: number | null;
  content: Record<string, unknown>;
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

  // Accounts for accounting.grn_mapping form
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [inventoryAccountId, setInventoryAccountId] = useState<string>('');
  const [purchasesClearingAccountId, setPurchasesClearingAccountId] = useState<string>('');
  const [custodyReceivableAccountId, setCustodyReceivableAccountId] = useState<string>('');

  // Resolve Preview State
  const [resolvedConfig, setResolvedConfig] = useState<ResolvedConfig | null>(null);
  const [loadingResolve, setLoadingResolve] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Draft & Version state
  const [draftContent, setDraftContent] = useState<string>('{}');
  const [draftStatus, setDraftStatus] = useState<string>('');
  const [hasPersistedDraft, setHasPersistedDraft] = useState<boolean>(false);
  const [versions, setVersions] = useState<ConfigVersion[]>([]);
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Dry-run validation state
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [validateResult, setValidateResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [validating, setValidating] = useState(false);

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

  const STRUCTURED_KEYS = ['accounting.grn_mapping', 'accounting.custody_mapping'];

  // Load COA accounts when structured accounting keys are selected
  useEffect(() => {
    async function loadAccounts() {
      if (!selectedCompanyId || !STRUCTURED_KEYS.includes(selectedKey)) return;
      try {
        const res = await apiFetch(`/api/accounting/accounts?companyId=${selectedCompanyId}`);
        if (res.ok) {
          const body = await res.json();
          const list: AccountOption[] = (body.accounts || []).filter((a: any) => a.isActive !== false);
          setAccounts(list);
        }
      } catch {
        // ignore error
      }
    }
    loadAccounts();
  }, [selectedCompanyId, selectedKey]);

  // Fetch Resolve Preview
  const fetchResolvePreview = async () => {
    if (!selectedCompanyId || !selectedKey) return;
    setLoadingResolve(true);
    setResolveError(null);
    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/config/resolve?key=${encodeURIComponent(selectedKey)}`);
      if (res.ok) {
        const body = await res.json();
        setResolvedConfig(body.resolved || null);
      } else {
        const errBody = await res.json();
        setResolveError(errBody.message || 'تعذر حل قيمة الإعداد الفعالة');
      }
    } catch {
      setResolveError('خطأ في الاتصال أثناء حل الإعداد الفعال');
    } finally {
      setLoadingResolve(false);
    }
  };

  // Load key config (draft + versions + resolve preview)
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
          const content = draftBody.draft.content || {};
          setDraftContent(JSON.stringify(content, null, 2));
          setDraftStatus(draftBody.draft.status || 'draft');
          setHasPersistedDraft(Boolean(draftBody.draft.id));
          setJsonError(null);

          if (selectedKey === 'accounting.grn_mapping') {
            setInventoryAccountId(typeof content.inventory_account_id === 'string' ? content.inventory_account_id : '');
            setPurchasesClearingAccountId(typeof content.purchases_clearing_account_id === 'string' ? content.purchases_clearing_account_id : '');
          } else if (selectedKey === 'accounting.custody_mapping') {
            setCustodyReceivableAccountId(typeof content.custody_receivable_account_id === 'string' ? content.custody_receivable_account_id : '');
          }
        }
      }

      // 2) Load versions
      const verRes = await apiFetch(`/api/companies/${selectedCompanyId}/config/versions?key=${encodeURIComponent(selectedKey)}`);
      if (verRes.ok) {
        const verBody = await verRes.json();
        setVersions(verBody.versions || []);
      }

      // 3) Load Resolve Preview
      await fetchResolvePreview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في جلب بيانات الإعداد');
    } finally {
      setLoadingConfig(false);
    }
  };

  useEffect(() => {
    loadKeyConfig();
  }, [selectedCompanyId, selectedKey]);

  // Handle Form Change for inventory_account_id
  const handleInventoryAccountChange = (invId: string) => {
    setInventoryAccountId(invId);
    const obj = {
      inventory_account_id: invId,
      purchases_clearing_account_id: purchasesClearingAccountId,
    };
    setDraftContent(JSON.stringify(obj, null, 2));
    setJsonError(null);
  };

  // Handle Form Change for purchases_clearing_account_id
  const handlePurchasesClearingAccountChange = (clrId: string) => {
    setPurchasesClearingAccountId(clrId);
    const obj = {
      inventory_account_id: inventoryAccountId,
      purchases_clearing_account_id: clrId,
    };
    setDraftContent(JSON.stringify(obj, null, 2));
    setJsonError(null);
  };

  // Handle Form Change for custody_receivable_account_id
  const handleCustodyReceivableAccountChange = (acctId: string) => {
    setCustodyReceivableAccountId(acctId);
    const obj = {
      custody_receivable_account_id: acctId,
    };
    setDraftContent(JSON.stringify(obj, null, 2));
    setJsonError(null);
  };

  // Handle Textarea JSON Change (Form <-> JSON Sync)
  const handleJsonTextareaChange = (raw: string) => {
    setDraftContent(raw);
    try {
      const parsed = JSON.parse(raw);
      setJsonError(null);
      if (selectedKey === 'accounting.grn_mapping' && typeof parsed === 'object' && parsed !== null) {
        setInventoryAccountId(typeof parsed.inventory_account_id === 'string' ? parsed.inventory_account_id : '');
        setPurchasesClearingAccountId(typeof parsed.purchases_clearing_account_id === 'string' ? parsed.purchases_clearing_account_id : '');
      } else if (selectedKey === 'accounting.custody_mapping' && typeof parsed === 'object' && parsed !== null) {
        setCustodyReceivableAccountId(typeof parsed.custody_receivable_account_id === 'string' ? parsed.custody_receivable_account_id : '');
      }
    } catch {
      setJsonError('محتوى المسودة غير مطابق لصيغة JSON الصحيحة');
    }
  };

  const parseDraftContent = (): Record<string, unknown> => {
    if (selectedKey === 'accounting.grn_mapping') {
      return {
        inventory_account_id: inventoryAccountId,
        purchases_clearing_account_id: purchasesClearingAccountId,
      };
    }
    if (selectedKey === 'accounting.custody_mapping') {
      return {
        custody_receivable_account_id: custodyReceivableAccountId,
      };
    }
    try {
      return JSON.parse(draftContent);
    } catch {
      return {};
    }
  };

  const handleDryRun = async () => {
    if (!selectedCompanyId || !selectedKey) return;
    setValidating(true);
    setValidateResult(null);
    setFieldErrors({});
    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/config/validate?key=${encodeURIComponent(selectedKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: parseDraftContent() }),
      });
      const body = await res.json();
      if (res.ok && body.ok) {
        setValidateResult({ ok: true, message: 'الإعداد صالح — جاهز للنشر' });
      } else {
        setValidateResult({ ok: false, message: body.message || 'الإعداد غير صالح' });
        if (body.field) {
          setFieldErrors({ [body.field]: body.message });
        }
      }
    } catch {
      setValidateResult({ ok: false, message: 'تعذر تنفيذ التحقق المسبق — تحقق من الاتصال' });
    } finally {
      setValidating(false);
    }
  };

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

      if (selectedKey === 'accounting.grn_mapping') {
        parsed = {
          inventory_account_id: inventoryAccountId,
          purchases_clearing_account_id: purchasesClearingAccountId,
        };
      } else if (selectedKey === 'accounting.custody_mapping') {
        parsed = {
          custody_receivable_account_id: custodyReceivableAccountId,
        };
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
      await loadKeyConfig();
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
      await loadKeyConfig();
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
      await loadKeyConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في عملية التراجع');
    } finally {
      setRollingBack(false);
    }
  };

  const currentCompany = companies.find((c) => c.id === selectedCompanyId);

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
          ) : definitions.length === 0 ? (
            <div className="text-xs text-amber-400 bg-amber-950/30 border border-amber-800/50 rounded-xl px-3.5 py-2 flex-1">
              لا توجد تعريفات إعدادات مسجلة حالياً في الكتالوج.
            </div>
          ) : (
            <select
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value)}
              className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3.5 py-2 focus:outline-none focus:border-indigo-500 flex-1"
            >
              {Object.entries(
                definitions.reduce<Record<string, ConfigDefinition[]>>((acc, d) => {
                  const dom = d.domain || 'general';
                  if (!acc[dom]) acc[dom] = [];
                  acc[dom].push(d);
                  return acc;
                }, {})
              ).map(([domain, defs]) => (
                <optgroup key={domain} label={DOMAIN_LABELS[domain] || domain}>
                  {defs.map((d) => (
                    <option key={d.id} value={d.key}>
                      {d.labelAr ? `${d.labelAr} (${d.key})` : d.key}
                      {d.description ? ` — ${d.description}` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Resolve Preview Card */}
      <div className="bg-slate-900/90 border border-indigo-500/30 rounded-2xl p-5 shadow-2xl flex flex-col gap-3">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-indigo-400" />
            <h4 className="text-xs font-bold text-white">معاينة الحل النهائي والنوع الفعال (Resolved Config Preview)</h4>
          </div>
          {loadingResolve && (
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <RefreshCw className="w-3 h-3 animate-spin" />
              <span>جاري الحل...</span>
            </div>
          )}
        </div>

        {resolveError ? (
          <div className="text-xs text-amber-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{resolveError}</span>
          </div>
        ) : resolvedConfig ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs">
            <div>
              <span className="text-slate-400">الشركة: </span>
              <span className="text-white font-semibold">{currentCompany?.nameAr || selectedCompanyId}</span>
            </div>
            <div>
              <span className="text-slate-400">المفتاح: </span>
              <span className="text-indigo-300 font-mono font-semibold">{resolvedConfig.key}</span>
            </div>
            <div>
              <span className="text-slate-400">المصدر الفعال: </span>
              {resolvedConfig.source === 'company_published' ? (
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-bold border border-emerald-500/30">
                  شركة منشور (company_published)
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-bold border border-amber-500/30">
                  افتراضي المنصة (platform_default)
                </span>
              )}
            </div>
            <div>
              <span className="text-slate-400">رقم الإصدار: </span>
              <span className="text-white font-mono font-bold">
                {resolvedConfig.versionNo !== null ? `v${resolvedConfig.versionNo}` : '—'}
              </span>
            </div>
            <div className="sm:col-span-2 md:col-span-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex flex-col gap-1">
                <span className="text-slate-400 text-[11px]">المحتوى الفعال الناتِج (Effective / Published Content):</span>
                <div className="text-emerald-400 font-mono text-xs overflow-x-auto">
                  {selectedKey === 'accounting.grn_mapping' ? (
                    <div className="flex flex-col sm:flex-row gap-4 text-xs font-sans">
                      <div>
                        <span className="text-slate-400">حساب المخزون: </span>
                        <span className="text-white font-semibold font-mono">
                          {String(resolvedConfig.content?.inventory_account_id || 'غير محدد')}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400">حساب المشتريات المعلّقة: </span>
                        <span className="text-white font-semibold font-mono">
                          {String(resolvedConfig.content?.purchases_clearing_account_id || 'غير محدد')}
                        </span>
                      </div>
                    </div>
                  ) : selectedKey === 'accounting.custody_mapping' ? (
                    <div className="flex flex-col sm:flex-row gap-4 text-xs font-sans">
                      <div>
                        <span className="text-slate-400">حساب ذمة عهد الموظفين: </span>
                        <span className="text-white font-semibold font-mono">
                          {String(resolvedConfig.content?.custody_receivable_account_id || 'غير محدد')}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <pre className="whitespace-pre-wrap">{JSON.stringify(resolvedConfig.content, null, 2)}</pre>
                  )}
                </div>
              </div>

              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex flex-col gap-1">
                <span className="text-slate-400 text-[11px]">القيمة الافتراضية للمنصة (Platform Default):</span>
                <div className="text-slate-300 font-mono text-xs overflow-x-auto">
                  <pre className="whitespace-pre-wrap">
                    {JSON.stringify(definitions.find((d) => d.key === selectedKey)?.defaultValue ?? {}, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        ) : null}
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
          {/* Status Bar above Draft Card */}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl bg-slate-950/80 border border-slate-800/80 text-[11px]">
            {resolvedConfig?.source === 'company_published' && resolvedConfig.versionNo !== null ? (
              <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold">
                منشور v{resolvedConfig.versionNo}
              </span>
            ) : (
              <span className="px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold">
                لم يُنشر بعد — القيمة الافتراضية
              </span>
            )}
            {hasPersistedDraft && (
              <span className="px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-bold">
                مسودة غير منشورة
              </span>
            )}
          </div>

          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h4 className="text-sm font-bold text-white flex items-center gap-2">
              <span>محرر المسودة (Draft Editor)</span>
              {draftStatus && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-normal">
                  الحالة: {draftStatus}
                </span>
              )}
            </h4>
            <div className="flex items-center gap-2">
              <button
                onClick={handleDryRun}
                disabled={!canWrite || validating || loadingConfig}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold transition cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${validating ? 'animate-spin' : ''}`} />
                <span>{validating ? 'جاري التحقق...' : 'تحقق مسبق'}</span>
              </button>
              <button
                onClick={handleSaveDraft}
                disabled={!canWrite || savingDraft || loadingConfig || !!jsonError}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white rounded-xl text-xs font-semibold transition cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{savingDraft ? 'جاري الحفظ...' : 'حفظ المسودة'}</span>
              </button>
            </div>
          </div>

          {/* Validation Result Banner */}
          {validateResult && (
            <div className={`p-3 rounded-xl text-xs flex items-center gap-2 border ${
              validateResult.ok
                ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                : 'bg-amber-950/40 border-amber-800/60 text-amber-300'
            }`}>
              {validateResult.ok ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
              )}
              <span>{validateResult.message}</span>
            </div>
          )}

          {/* Dedicated Structured Form for accounting.grn_mapping */}
          {selectedKey === 'accounting.grn_mapping' && (
            <div className="bg-slate-950 border border-indigo-500/20 rounded-xl p-4 flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg bg-indigo-950/30 border border-indigo-500/20 text-[11px] text-indigo-200">
                <span>هذا الإعداد متاح أيضًا في شاشة الربط المحاسبي</span>
                <a
                  href="#/accounting/mapping"
                  onClick={(e) => {
                    e.preventDefault();
                    if (typeof window !== 'undefined') {
                      window.location.hash = '#/accounting/mapping';
                      const sidebarButtons = Array.from(document.querySelectorAll('aside button'));
                      const acctBtn = sidebarButtons.find((b) => b.textContent?.includes('المحاسبة'));
                      if (acctBtn instanceof HTMLButtonElement) acctBtn.click();
                    }
                  }}
                  className="font-bold text-indigo-400 hover:text-indigo-300 underline cursor-pointer"
                >
                  فتح شاشة الربط المحاسبي (المحاسبة ← الربط المحاسبي)
                </a>
              </div>

              <h5 className="text-xs font-bold text-indigo-300 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" />
                <span>إعداد ربط استلام البضائع بالدليل المحاسبي (GRN Mapping Form)</span>
              </h5>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">حساب المخزون (inventory_account_id):</label>
                <select
                  value={inventoryAccountId}
                  onChange={(e) => handleInventoryAccountChange(e.target.value)}
                  disabled={!canWrite || loadingConfig}
                  className="bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">-- اختر حساب المخزون --</option>
                  {usableAccounts(accounts, 'inventory_account_id').map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.code} - {acc.nameAr}
                    </option>
                  ))}
                </select>
                {fieldErrors['inventory_account_id'] && (
                  <p className="text-red-400 text-[11px] flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{fieldErrors['inventory_account_id']}</span>
                  </p>
                )}
                {!isUsable(inventoryAccountId, accounts, 'inventory_account_id') && (
                  <p className="text-amber-400 text-[11px] flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      الحساب المختار غير صالح لدور حساب المخزون (لازم يكون حساباً فرعياً من نوع أصول وقابلاً للترحيل).
                      النشر هيرفضه من الخادم.
                    </span>
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">حساب المشتريات المعلّقة (purchases_clearing_account_id):</label>
                <select
                  value={purchasesClearingAccountId}
                  onChange={(e) => handlePurchasesClearingAccountChange(e.target.value)}
                  disabled={!canWrite || loadingConfig}
                  className="bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">-- اختر حساب المشتريات المعلّقة --</option>
                  {usableAccounts(accounts, 'purchases_clearing_account_id').map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.code} - {acc.nameAr}
                    </option>
                  ))}
                </select>
                {fieldErrors['purchases_clearing_account_id'] && (
                  <p className="text-red-400 text-[11px] flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{fieldErrors['purchases_clearing_account_id']}</span>
                  </p>
                )}
                {!isUsable(purchasesClearingAccountId, accounts, 'purchases_clearing_account_id') && (
                  <p className="text-amber-400 text-[11px] flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      الحساب المختار غير صالح لدور حساب المشتريات المعلّقة (لازم يكون حساباً فرعياً من نوع التزامات وقابلاً للترحيل).
                      النشر هيرفضه من الخادم.
                    </span>
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Dedicated Structured Form for accounting.custody_mapping */}
          {selectedKey === 'accounting.custody_mapping' && (
            <div className="bg-slate-950 border border-indigo-500/20 rounded-xl p-4 flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg bg-indigo-950/30 border border-indigo-500/20 text-[11px] text-indigo-200">
                <span>هذا الإعداد متاح أيضًا في إعدادات الشركة (القسم المالي)</span>
                <a
                  href="#/companies"
                  onClick={(e) => {
                    e.preventDefault();
                    if (typeof window !== 'undefined') {
                      window.location.hash = '#/companies';
                      const sidebarButtons = Array.from(document.querySelectorAll('aside button'));
                      const compBtn = sidebarButtons.find((b) => b.textContent?.includes('الشركات'));
                      if (compBtn instanceof HTMLButtonElement) compBtn.click();
                    }
                  }}
                  className="font-bold text-indigo-400 hover:text-indigo-300 underline cursor-pointer"
                >
                  فتح شاشة إعدادات الشركة
                </a>
              </div>

              <h5 className="text-xs font-bold text-indigo-300 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" />
                <span>إعداد ربط عهد الموظفين بالدليل المحاسبي (Custody Mapping Form)</span>
              </h5>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">حساب ذمة عهد الموظفين (custody_receivable_account_id):</label>
                <select
                  value={custodyReceivableAccountId}
                  onChange={(e) => handleCustodyReceivableAccountChange(e.target.value)}
                  disabled={!canWrite || loadingConfig}
                  className="bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">-- اختر حساب ذمة عهد الموظفين --</option>
                  {usableAccounts(accounts, 'custody_receivable_account_id').map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.code} - {acc.nameAr}
                    </option>
                  ))}
                </select>
                {fieldErrors['custody_receivable_account_id'] && (
                  <p className="text-red-400 text-[11px] flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{fieldErrors['custody_receivable_account_id']}</span>
                  </p>
                )}
                {!isUsable(custodyReceivableAccountId, accounts, 'custody_receivable_account_id') && (
                  <p className="text-amber-400 text-[11px] flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      الحساب المختار غير صالح لدور حساب ذمة عهد الموظفين (لازم يكون حساباً فرعياً من نوع أصول وقابلاً للترحيل).
                      النشر هيرفضه من الخادم.
                    </span>
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Advanced JSON Editor in Collapsible Details */}
          <details className="group border border-slate-800 rounded-xl bg-slate-950 p-3" open={selectedKey !== 'accounting.grn_mapping' && selectedKey !== 'accounting.custody_mapping'}>
            <summary className="text-xs font-bold text-slate-300 cursor-pointer flex items-center justify-between select-none">
              <span>تحرير JSON متقدم (Advanced JSON)</span>
              <span className="text-[10px] text-slate-500 group-open:rotate-180 transition-transform">▼</span>
            </summary>

            <div className="mt-3 flex flex-col gap-2">
              <textarea
                value={draftContent}
                onChange={(e) => handleJsonTextareaChange(e.target.value)}
                disabled={!canWrite || loadingConfig}
                rows={10}
                className="w-full bg-slate-900 border border-slate-800 text-emerald-400 font-mono text-xs rounded-xl p-3.5 focus:outline-none focus:border-indigo-500 resize-none leading-relaxed"
                placeholder="{}"
              />
              {jsonError && (
                <p className="text-red-400 text-[11px] flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>{jsonError}</span>
                </p>
              )}
            </div>
          </details>

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
