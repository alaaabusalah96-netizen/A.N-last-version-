import React, { useState, useEffect } from 'react';
import { Scale, RefreshCw, AlertCircle, CheckCircle2, Calendar, Building2 } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface TrialBalanceAccountRow {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  accountType: string;
  totalDebit: number;
  totalCredit: number;
  netBalance: number;
}

interface TrialBalanceData {
  companyId: string;
  asOfDate?: string;
  orgUnitId?: string;
  accounts: TrialBalanceAccountRow[];
  grandTotalDebit: number;
  grandTotalCredit: number;
  isBalanced: boolean;
}

interface OrgUnit {
  id: string;
  code: string;
  nameAr: string;
  isActive: boolean;
}

interface TrialBalancePanelProps {
  companyId: string;
}

export function TrialBalancePanel({ companyId }: TrialBalancePanelProps) {
  const [data, setData] = useState<TrialBalanceData | null>(null);
  const [orgUnits, setOrgUnits] = useState<OrgUnit[]>([]);
  const [asOfDate, setAsOfDate] = useState<string>('');
  const [orgUnitId, setOrgUnitId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOrgUnits = async () => {
    try {
      const res = await apiFetch(`/api/companies/${companyId}/org-units`);
      if (res.ok) {
        const body = await res.json();
        setOrgUnits((body.orgUnits || []).filter((u: OrgUnit) => u.isActive));
      }
    } catch {
      // ignore org unit fetch error
    }
  };

  const loadTrialBalance = async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      let url = `/api/accounting/trial-balance?companyId=${companyId}`;
      if (asOfDate) url += `&asOfDate=${encodeURIComponent(asOfDate)}`;
      if (orgUnitId) url += `&orgUnitId=${encodeURIComponent(orgUnitId)}`;

      const res = await apiFetch(url);
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || errData.error || 'فشل في تحميل ميزان المراجعة');
      }
      const tbData = await res.json();
      setData(tbData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تحميل ميزان المراجعة');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrgUnits();
  }, [companyId]);

  useEffect(() => {
    loadTrialBalance();
  }, [companyId, asOfDate, orgUnitId]);

  const accountTypeLabels: Record<string, string> = {
    asset: 'أصول',
    liability: 'التزامات',
    equity: 'حقوق ملكية',
    revenue: 'إيرادات',
    expense: 'مصروفات',
  };

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      {/* Header & Controls */}
      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <Scale className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">ميزان المراجعة (Trial Balance)</h3>
            <p className="text-xs text-slate-400">
              تجميع أرصدة الحسابات القابلة للترحيل من القيود المرحّلة فقط حسب التاريخ والوحدة التنظيمية
            </p>
          </div>
        </div>

        {/* Filter Controls */}
        <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
          <div className="flex items-center gap-2 bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800 text-xs">
            <Calendar className="w-4 h-4 text-slate-400" />
            <span className="text-slate-400">حتى تاريخ:</span>
            <input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="bg-transparent text-slate-200 focus:outline-none text-xs cursor-pointer"
            />
          </div>

          {orgUnits.length > 0 && (
            <div className="flex items-center gap-2 bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800 text-xs">
              <Building2 className="w-4 h-4 text-slate-400" />
              <span className="text-slate-400">الوحدة التنظيمية:</span>
              <select
                value={orgUnitId}
                onChange={(e) => setOrgUnitId(e.target.value)}
                className="bg-transparent text-slate-200 focus:outline-none text-xs cursor-pointer"
              >
                <option value="" className="bg-slate-900 text-slate-200">الشركة ككل (الكل)</option>
                {orgUnits.map((ou) => (
                  <option key={ou.id} value={ou.id} className="bg-slate-900 text-slate-200">
                    {ou.code} — {ou.nameAr}
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            onClick={loadTrialBalance}
            disabled={loading}
            className="p-2.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer"
            title="تحديث ميزان المراجعة"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      {/* Status Summary Banner */}
      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
            <div>
              <span className="text-slate-400 text-xs block">إجمالي إشارات المدين</span>
              <span className="text-lg font-bold font-mono text-emerald-400">
                {data.grandTotalDebit.toFixed(2)}
              </span>
            </div>
          </div>
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
            <div>
              <span className="text-slate-400 text-xs block">إجمالي إشارات الدائن</span>
              <span className="text-lg font-bold font-mono text-rose-400">
                {data.grandTotalCredit.toFixed(2)}
              </span>
            </div>
          </div>
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
            <div>
              <span className="text-slate-400 text-xs block">توازن الميزان</span>
              <div className="mt-1">
                {data.isBalanced ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-400 bg-emerald-950/60 px-3 py-1 rounded-full border border-emerald-800/80">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>ميزان المراجعة متوازن</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-400 bg-amber-950/60 px-3 py-1 rounded-full border border-amber-800/80">
                    <AlertCircle className="w-4 h-4" />
                    <span>غير متوازن (الفارق: {Math.abs(data.grandTotalDebit - data.grandTotalCredit).toFixed(2)})</span>
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Trial Balance Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">كود الحساب</th>
                <th className="py-3.5 px-4">اسم الحساب</th>
                <th className="py-3.5 px-4">نوع الحساب</th>
                <th className="py-3.5 px-4 text-left">إجمالي المدين</th>
                <th className="py-3.5 px-4 text-left">إجمالي الدائن</th>
                <th className="py-3.5 px-4 text-left">الرصيد الصافي</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    <div className="flex items-center justify-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                      <span>جاري تجميع وحساب ميزان المراجعة...</span>
                    </div>
                  </td>
                </tr>
              ) : !data || data.accounts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    لا توجد حسابات مفعالة ومرحلة في دليل الحسابات
                  </td>
                </tr>
              ) : (
                data.accounts.map((row) => (
                  <tr key={row.accountId} className="hover:bg-slate-800/30 transition">
                    <td className="py-3 px-4 font-mono font-semibold text-indigo-300">
                      {row.code}
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-200">
                      {row.nameAr}
                    </td>
                    <td className="py-3 px-4 text-slate-400">
                      {accountTypeLabels[row.accountType] || row.accountType}
                    </td>
                    <td className="py-3 px-4 text-left font-mono font-semibold text-emerald-400">
                      {row.totalDebit > 0 ? row.totalDebit.toFixed(2) : '0.00'}
                    </td>
                    <td className="py-3 px-4 text-left font-mono font-semibold text-rose-400">
                      {row.totalCredit > 0 ? row.totalCredit.toFixed(2) : '0.00'}
                    </td>
                    <td className="py-3 px-4 text-left font-mono font-bold">
                      <span className={row.netBalance >= 0 ? 'text-indigo-300' : 'text-amber-400'}>
                        {row.netBalance.toFixed(2)}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {data && data.accounts.length > 0 && (
              <tfoot>
                <tr className="bg-slate-950 font-bold border-t border-slate-800 text-xs">
                  <td colSpan={3} className="py-4 px-4 text-right text-slate-300">
                    الإجمالي العام لميزان المراجعة:
                  </td>
                  <td className="py-4 px-4 text-left font-mono text-emerald-400 text-sm">
                    {data.grandTotalDebit.toFixed(2)}
                  </td>
                  <td className="py-4 px-4 text-left font-mono text-rose-400 text-sm">
                    {data.grandTotalCredit.toFixed(2)}
                  </td>
                  <td className="py-4 px-4 text-left font-mono text-slate-300 text-sm">
                    {(data.grandTotalDebit - data.grandTotalCredit).toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
