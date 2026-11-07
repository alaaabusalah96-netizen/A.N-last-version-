import React, { useState, useEffect, useCallback } from 'react';
import { BookOpen, Plus, Sparkles, RefreshCw, AlertCircle, CheckCircle, FolderTree } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

export interface AccountItem {
  id: string;
  companyId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  accountType: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  parentId: string | null;
  isPostable: boolean;
  isActive: boolean;
}

interface AccountsPanelProps {
  companyId: string;
}

const ACCOUNT_TYPE_LABELS: Record<string, { ar: string; bg: string; text: string; border: string }> = {
  asset: { ar: 'أصول', bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/20' },
  liability: { ar: 'خصوم', bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/20' },
  equity: { ar: 'حقوق ملكية', bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/20' },
  revenue: { ar: 'إيرادات', bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20' },
  expense: { ar: 'مصروفات', bg: 'bg-rose-500/10', text: 'text-rose-400', border: 'border-rose-500/20' },
};

export function AccountsPanel({ companyId }: AccountsPanelProps) {
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // New account form state
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [accountType, setAccountType] = useState<'asset' | 'liability' | 'equity' | 'revenue' | 'expense'>('asset');
  const [isPostable, setIsPostable] = useState(true);

  const fetchAccounts = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/accounting/accounts?companyId=${encodeURIComponent(companyId)}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'تعذر تحميل دليل الحسابات');
      }
      const data = await res.json();
      setAccounts(data.accounts || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء جلب الحسابات');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const handleSeedDefault = async () => {
    setSeeding(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiFetch('/api/accounting/accounts/seed-default', {
        method: 'POST',
        body: JSON.stringify({ companyId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'فشل تحميل الدليل الافتراضي');
      }
      const data = await res.json();
      setSuccessMsg(`تم تحميل الدليل الافتراضي بنجاح (${data.createdCount} حسابات رئيسية وفرعية).`);
      await fetchAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تحميل الدليل الافتراضي');
    } finally {
      setSeeding(false);
    }
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiFetch('/api/accounting/accounts', {
        method: 'POST',
        body: JSON.stringify({
          companyId,
          code: code.trim(),
          nameAr: nameAr.trim(),
          nameEn: nameEn.trim() || undefined,
          accountType,
          isPostable,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'فشل إضافة الحساب');
      }

      setSuccessMsg(`تم إضافة الحساب بنجاح (${code})`);
      setShowModal(false);
      setCode('');
      setNameAr('');
      setNameEn('');
      setAccountType('asset');
      setIsPostable(true);
      await fetchAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء إنشاء الحساب');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="w-full flex flex-col gap-5" dir="rtl">
      {/* Action Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
            <BookOpen className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">دليل الحسابات الشجري (Chart of Accounts)</h3>
            <p className="text-xs text-slate-400">إدارة دليل الحسابات المالية ونطاق العزل المعزول للشركة</p>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          {accounts.length === 0 && (
            <button
              onClick={handleSeedDefault}
              disabled={seeding || loading}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/20 border border-indigo-500/30 transition cursor-pointer disabled:opacity-50"
            >
              {seeding ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              <span>تحميل الدليل الافتراضي</span>
            </button>
          )}

          <button
            onClick={() => setShowModal(true)}
            disabled={loading}
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg shadow-emerald-600/20 border border-emerald-500/30 transition cursor-pointer disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>حساب جديد</span>
          </button>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="p-3.5 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-3.5 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle className="w-4 h-4 shrink-0 text-emerald-400" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Accounts List / Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        {loading ? (
          <div className="p-10 flex flex-col items-center gap-3 text-slate-400 text-sm">
            <RefreshCw className="w-6 h-6 animate-spin text-indigo-500" />
            <span>جاري تحميل دليل الحسابات...</span>
          </div>
        ) : accounts.length === 0 ? (
          <div className="p-12 text-center flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-slate-800/80 border border-slate-700/50 flex items-center justify-center text-slate-400">
              <FolderTree className="w-6 h-6 text-slate-500" />
            </div>
            <div>
              <h4 className="text-sm font-bold text-slate-200">دليل الحسابات فارغ حالياً</h4>
              <p className="text-xs text-slate-400 mt-1 max-w-sm">
                يمكنك الضغط على زر &quot;تحميل الدليل الافتراضي&quot; لإنشاء الهيكل القياسي للأنواع الخمسة أو إضافة حساب يدوي.
              </p>
            </div>
            <button
              onClick={handleSeedDefault}
              disabled={seeding}
              className="mt-2 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium cursor-pointer transition shadow-lg shadow-indigo-600/20"
            >
              <Sparkles className="w-4 h-4" />
              <span>تحميل الدليل الافتراضي الآن</span>
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-medium">
                <tr>
                  <th className="py-3 px-4">رمز الحساب (Code)</th>
                  <th className="py-3 px-4">اسم الحساب (عربي)</th>
                  <th className="py-3 px-4">اسم الحساب (English)</th>
                  <th className="py-3 px-4">النوع</th>
                  <th className="py-3 px-4">خاصية الترحيل</th>
                  <th className="py-3 px-4">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {accounts.map((acc) => {
                  const typeBadge = ACCOUNT_TYPE_LABELS[acc.accountType] || {
                    ar: acc.accountType,
                    bg: 'bg-slate-800',
                    text: 'text-slate-300',
                    border: 'border-slate-700',
                  };
                  return (
                    <tr key={acc.id} className="hover:bg-slate-800/40 transition">
                      <td className="py-3 px-4 font-mono font-bold text-indigo-400">{acc.code}</td>
                      <td className="py-3 px-4 font-semibold text-white">{acc.nameAr}</td>
                      <td className="py-3 px-4 text-slate-400">{acc.nameEn || '-'}</td>
                      <td className="py-3 px-4">
                        <span className={`inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold border ${typeBadge.bg} ${typeBadge.text} ${typeBadge.border}`}>
                          {typeBadge.ar}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        {acc.isPostable ? (
                          <span className="text-emerald-400 font-medium">حساب فرعي (مباشر)</span>
                        ) : (
                          <span className="text-amber-400 font-medium">حساب رئيسي (تجميعي)</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                          نشط
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal: Create Account */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4" dir="rtl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Plus className="w-4 h-4 text-emerald-400" />
                إضافة حساب جديد في الدليل
              </h3>
              <button
                onClick={() => setShowModal(false)}
                className="text-slate-400 hover:text-white text-xs cursor-pointer"
              >
                إلغاء
              </button>
            </div>

            <form onSubmit={handleCreateAccount} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">رمز الحساب (Code)</label>
                <input
                  type="text"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="مثال: 1101"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">اسم الحساب (بالعربية)</label>
                <input
                  type="text"
                  required
                  value={nameAr}
                  onChange={(e) => setNameAr(e.target.value)}
                  placeholder="مثال: الصندوق الرئيسي"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">اسم الحساب (English - اختياري)</label>
                <input
                  type="text"
                  value={nameEn}
                  onChange={(e) => setNameEn(e.target.value)}
                  placeholder="e.g. Main Cash Safe"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">نوع الحساب (Account Type)</label>
                <select
                  value={accountType}
                  onChange={(e) => setAccountType(e.target.value as any)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="asset">أصول (Asset)</option>
                  <option value="liability">خصوم / التزامات (Liability)</option>
                  <option value="equity">حقوق ملكية (Equity)</option>
                  <option value="revenue">إيرادات (Revenue)</option>
                  <option value="expense">مصروفات (Expense)</option>
                </select>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="isPostable"
                  checked={isPostable}
                  onChange={(e) => setIsPostable(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-800 text-indigo-600 focus:ring-indigo-500"
                />
                <label htmlFor="isPostable" className="text-xs text-slate-300 font-medium cursor-pointer">
                  حساب فرعي قابل للترحيل المباشر عليه (Postable)
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium cursor-pointer disabled:opacity-50"
                >
                  {saving ? 'جاري الحفظ...' : 'حفظ الحساب'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
