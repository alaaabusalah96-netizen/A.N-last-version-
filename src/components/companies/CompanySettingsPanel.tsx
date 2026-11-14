import React, { useState, useEffect, useCallback } from 'react';
import { Settings, Save, RefreshCw, AlertCircle, CheckCircle, Globe, DollarSign, Clock, Calendar } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { usableAccounts } from '../../lib/accountRules.js';

interface Company {
  id: string;
  code: string;
  nameAr: string;
}

interface CompanySettings {
  defaultCurrencyCode: string;
  timezone: string;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
  displayNameFinance: string | null;
  locale: string | null;
  inventoryAccountId: string | null;
  purchasesClearingAccountId: string | null;
  custodyReceivableAccountId: string | null;
}

interface CompanySettingsPanelProps {
  userRole: string;
}

export function CompanySettingsPanel({ userRole }: CompanySettingsPanelProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const isReadOnly = userRole === 'company_user';

  const fetchCompanies = useCallback(async () => {
    try {
      const res = await apiFetch('/api/companies');
      if (!res.ok) throw new Error('تعذر جلب الشركات');
      const data = await res.json();
      const list = data.companies || [];
      setCompanies(list);
      if (list.length > 0 && !selectedCompanyId) {
        setSelectedCompanyId(list[0].id);
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, [selectedCompanyId]);

  const fetchSettings = useCallback(async (companyId: string) => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const [settingsRes, accountsRes] = await Promise.all([
        apiFetch(`/api/companies/${companyId}/settings`),
        apiFetch(`/api/accounting/accounts?companyId=${companyId}`)
      ]);
      if (!settingsRes.ok) throw new Error('تعذر جلب إعدادات الشركة');
      if (!accountsRes.ok) throw new Error('تعذر جلب الحسابات');
      
      const settingsData = await settingsRes.json();
      const accountsData = await accountsRes.json();
      
      setSettings(settingsData.settings);
      setAccounts(accountsData.accounts || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCompanies();
  }, [fetchCompanies]);

  useEffect(() => {
    if (selectedCompanyId) {
      fetchSettings(selectedCompanyId);
    }
  }, [selectedCompanyId, fetchSettings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly || !selectedCompanyId || !settings) return;

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/settings`, {
        method: 'PUT',
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'فشل حفظ الإعدادات');
      }
      setSuccess('تم حفظ الإعدادات بنجاح');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const updateField = (field: keyof CompanySettings, value: any) => {
    if (settings) {
      setSettings({ ...settings, [field]: value });
    }
  };

  return (
    <div className="w-full flex flex-col gap-6" dir="rtl">
      {/* Header & Selector */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <Settings className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white">إعدادات الشركة التشغيلية</h3>
            <p className="text-xs text-slate-400">تخصيص العملة، المنطقة الزمنية، والسنة المالية</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-xs font-bold text-slate-400">الشركة:</label>
          <select
            value={selectedCompanyId}
            onChange={(e) => setSelectedCompanyId(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 min-w-[200px]"
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nameAr} ({c.code})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Form Content */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-8 shadow-2xl">
        {loading ? (
          <div className="py-20 text-center flex flex-col items-center gap-3 text-slate-400">
            <RefreshCw className="w-8 h-8 animate-spin text-indigo-500" />
            <span>جاري تحميل الإعدادات...</span>
          </div>
        ) : settings ? (
          <form onSubmit={handleSave} className="space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {/* Currency */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  <DollarSign className="w-3.5 h-3.5 text-indigo-400" />
                  العملة الافتراضية (رمز ISO)
                </label>
                <input
                  type="text"
                  value={settings.defaultCurrencyCode}
                  onChange={(e) => updateField('defaultCurrencyCode', e.target.value.toUpperCase())}
                  disabled={isReadOnly}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  placeholder="EGP"
                />
              </div>

              {/* Timezone */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  <Clock className="w-3.5 h-3.5 text-indigo-400" />
                  المنطقة الزمنية (IANA)
                </label>
                <input
                  type="text"
                  value={settings.timezone}
                  onChange={(e) => updateField('timezone', e.target.value)}
                  disabled={isReadOnly}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  placeholder="Africa/Cairo"
                />
              </div>

              {/* Fiscal Year Month */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  <Calendar className="w-3.5 h-3.5 text-indigo-400" />
                  شهر بداية السنة المالية
                </label>
                <select
                  value={settings.fiscalYearStartMonth}
                  onChange={(e) => updateField('fiscalYearStartMonth', parseInt(e.target.value))}
                  disabled={isReadOnly}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>

              {/* Fiscal Year Day */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  <Calendar className="w-3.5 h-3.5 text-indigo-400" />
                  يوم بداية السنة المالية
                </label>
                <select
                  value={settings.fiscalYearStartDay}
                  onChange={(e) => updateField('fiscalYearStartDay', parseInt(e.target.value))}
                  disabled={isReadOnly}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                >
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>

              {/* Locale */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  <Globe className="w-3.5 h-3.5 text-indigo-400" />
                  اللغة والمنطقة (Locale)
                </label>
                <input
                  type="text"
                  value={settings.locale || ''}
                  onChange={(e) => updateField('locale', e.target.value)}
                  disabled={isReadOnly}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  placeholder="ar-EG"
                />
              </div>

              {/* Finance Label */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  <Settings className="w-3.5 h-3.5 text-indigo-400" />
                  الاسم المالي للعرض (Finance Label)
                </label>
                <input
                  type="text"
                  value={settings.displayNameFinance || ''}
                  onChange={(e) => updateField('displayNameFinance', e.target.value)}
                  disabled={isReadOnly}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  placeholder="مثلاً: الإدارة المالية"
                />
              </div>

              {/* Inventory Account */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  <Settings className="w-3.5 h-3.5 text-indigo-400" />
                  حساب المخزون
                </label>
                <select
                  value={settings.inventoryAccountId || ''}
                  onChange={(e) => updateField('inventoryAccountId', e.target.value || null)}
                  disabled={isReadOnly}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                >
                  <option value="">— غير محدد —</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>
                  ))}
                </select>
              </div>

              {/* Purchases Clearing Account */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  <Settings className="w-3.5 h-3.5 text-indigo-400" />
                  حساب مقاصة المشتريات
                </label>
                <select
                  value={settings.purchasesClearingAccountId || ''}
                  onChange={(e) => updateField('purchasesClearingAccountId', e.target.value || null)}
                  disabled={isReadOnly}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                >
                  <option value="">— غير محدد —</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>
                  ))}
                </select>
              </div>

              {/* Custody Receivable Account */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  <Settings className="w-3.5 h-3.5 text-indigo-400" />
                  حساب ذمة عهد الموظفين
                </label>
                <select
                  value={settings.custodyReceivableAccountId || ''}
                  onChange={(e) => updateField('custodyReceivableAccountId', e.target.value || null)}
                  disabled={isReadOnly}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                >
                  <option value="">— غير محدد —</option>
                  {usableAccounts(accounts, 'custody_receivable_account_id').map((a) => (
                    <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Notifications */}
            {error && (
              <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                <span>{error}</span>
              </div>
            )}
            {success && (
              <div className="p-4 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
                <CheckCircle className="w-4 h-4 shrink-0 text-emerald-400" />
                <span>{success}</span>
              </div>
            )}

            {!isReadOnly && (
              <div className="flex justify-end border-t border-slate-800 pt-6">
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition shadow-lg shadow-indigo-600/20 disabled:opacity-50"
                >
                  {saving ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  <span>حفظ التغييرات</span>
                </button>
              </div>
            )}
          </form>
        ) : (
          <div className="py-20 text-center text-slate-400">يرجى اختيار شركة لعرض إعداداتها</div>
        )}
      </div>
    </div>
  );
}
