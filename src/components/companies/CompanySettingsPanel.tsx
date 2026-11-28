import { canWriteCompanySettings } from '../../lib/navAccess.js';
import React, { useState, useEffect, useCallback } from 'react';
import { Settings, Save, RefreshCw, AlertCircle, CheckCircle, Globe, DollarSign, Clock, Calendar } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { usableAccounts } from '../../lib/accountRules.js';
import { StandardsPanel } from './StandardsPanel.js';

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
  accountsPayableAccountId: string | null;
  inventoryAdjustmentAccountId: string | null;
  openingBalanceEquityAccountId: string | null;
  enforceCustodySeparation?: boolean;
  vatEnabled?: boolean;
  defaultVatRate?: number;
  pricesIncludeVat?: boolean;
  vatInputRecoverable?: boolean;
  vatRoundingMode?: 'line' | 'document';
  vatPayableAccountId?: string | null;
  vatInputAccountId?: string | null;
}

interface CompanySettingsPanelProps {
  userRole: string;
  permissions?: string[];
}

export function CompanySettingsPanel({ userRole, permissions = [] }: CompanySettingsPanelProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const isReadOnly = !canWriteCompanySettings(userRole, permissions);

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
            {isReadOnly && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
                عرض فقط: ليست لديك صلاحية تعديل إعدادات الشركة (company:settings:write). اطلبها من مدير الشركة.
              </div>
            )}
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
                  {usableAccounts(accounts, 'inventory_account_id').map((a) => (
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
                  {usableAccounts(accounts, 'purchases_clearing_account_id').map((a) => (
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
              {/* Accounts Payable Account */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  <Settings className="w-3.5 h-3.5 text-indigo-400" />
                  حساب الدائنين (الموردون)
                </label>
                <select
                  value={settings.accountsPayableAccountId || ''}
                  onChange={(e) => updateField('accountsPayableAccountId', e.target.value || null)}
                  disabled={isReadOnly}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                >
                  <option value="">— غير محدد —</option>
                  {usableAccounts(accounts, 'accounts_payable_account_id').map((a) => (
                    <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>
                  ))}
                </select>
              </div>

              {/* Inventory Adjustment Account */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  <Settings className="w-3.5 h-3.5 text-indigo-400" />
                  حساب تسويات وفروق المخزون (التسويات/التلف)
                </label>
                <select
                  value={settings.inventoryAdjustmentAccountId || ''}
                  onChange={(e) => updateField('inventoryAdjustmentAccountId', e.target.value || null)}
                  disabled={isReadOnly}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                >
                  <option value="">— غير محدد —</option>
                  {usableAccounts(accounts, 'inventory_adjustment_account_id').map((a) => (
                    <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>
                  ))}
                </select>
              </div>

              {/* Opening Balance Equity Account */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
                  <Settings className="w-3.5 h-3.5 text-indigo-400" />
                  حساب رصيد أول المدة للمخزون
                </label>
                <select
                  value={settings.openingBalanceEquityAccountId || ''}
                  onChange={(e) => updateField('openingBalanceEquityAccountId', e.target.value || null)}
                  disabled={isReadOnly}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                >
                  <option value="">— غير محدد —</option>
                  {usableAccounts(accounts, 'opening_balance_equity_account_id').map((a) => (
                    <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Custody separation of duties */}
            <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
              <label className="flex items-center gap-3 text-sm font-bold text-slate-200">
                <input
                  type="checkbox"
                  checked={settings.enforceCustodySeparation !== false}
                  onChange={(e) => updateField('enforceCustodySeparation', e.target.checked)}
                  disabled={isReadOnly}
                />
                فصل المهام في العهد النقدية (مفعّل افتراضياً)
              </label>
              <p className="text-xs text-slate-400">
                عند التفعيل لا يجوز لمقدّم طلب العهدة اعتمادها أو صرفها بنفسه، ويسري ذلك حتى على مدير المنصة. تعطيله قرار صريح من الشركة ويُسجَّل في سجل التدقيق.
              </p>
            </div>

            {/* VAT configuration */}
            <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
              <label className="flex items-center gap-3 text-sm font-bold text-slate-200">
                <input
                  type="checkbox"
                  checked={settings.vatEnabled === true}
                  onChange={(e) => updateField('vatEnabled', e.target.checked)}
                  disabled={isReadOnly}
                />
                تفعيل ضريبة القيمة المضافة (معطّلة افتراضياً)
              </label>
              <p className="text-xs text-slate-400">
                عند التعطيل لا تُحتسب أي ضريبة في المبيعات أو المشتريات. التفعيل يتطلب تحديد حساب ضريبة المخرجات. النسب والمعالجة قابلة للضبط حسب قوانين بلد الشركة.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-400">النسبة الافتراضية للضريبة (%)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    value={settings.defaultVatRate ?? 0}
                    onChange={(e) => updateField('defaultVatRate', e.target.value === '' ? 0 : Number(e.target.value))}
                    disabled={isReadOnly}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-400">طريقة تقريب الضريبة</label>
                  <select
                    value={settings.vatRoundingMode || 'line'}
                    onChange={(e) => updateField('vatRoundingMode', e.target.value)}
                    disabled={isReadOnly}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  >
                    <option value="line">على مستوى كل بند</option>
                    <option value="document">على مستوى المستند</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-400">حساب ضريبة المخرجات (التزام)</label>
                  <select
                    value={settings.vatPayableAccountId || ''}
                    onChange={(e) => updateField('vatPayableAccountId', e.target.value || null)}
                    disabled={isReadOnly}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  >
                    <option value="">— غير محدد —</option>
                    {usableAccounts(accounts, { allowedTypes: ['liability'], requirePostable: true }).map((a) => (
                      <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-400">حساب ضريبة المدخلات (أصل)</label>
                  <select
                    value={settings.vatInputAccountId || ''}
                    onChange={(e) => updateField('vatInputAccountId', e.target.value || null)}
                    disabled={isReadOnly}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  >
                    <option value="">— غير محدد —</option>
                    {usableAccounts(accounts, { allowedTypes: ['asset'], requirePostable: true }).map((a) => (
                      <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>
                    ))}
                  </select>
                </div>
              </div>
              <label className="flex items-center gap-3 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={settings.pricesIncludeVat === true}
                  onChange={(e) => updateField('pricesIncludeVat', e.target.checked)}
                  disabled={isReadOnly}
                />
                الأسعار شاملة الضريبة
              </label>
              <label className="flex items-center gap-3 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={settings.vatInputRecoverable !== false}
                  onChange={(e) => updateField('vatInputRecoverable', e.target.checked)}
                  disabled={isReadOnly}
                />
                ضريبة المدخلات قابلة للاسترداد (عند التعطيل تُضاف إلى تكلفة المشتريات)
              </label>
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
      {selectedCompanyId && <StandardsPanel companyId={selectedCompanyId} canWrite={!isReadOnly} isPlatformAdmin={userRole === 'platform_admin'} />}
    </div>
  );
}
