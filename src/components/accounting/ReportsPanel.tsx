import React, { useState, useEffect } from 'react';
import { FileText, RefreshCw, AlertCircle, Calendar, ArrowLeftRight, PieChart, Landmark, Download } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import {
  buildGeneralLedgerCsv,
  buildIncomeStatementCsv,
  buildBalanceSheetCsv,
  withBom,
} from '../../lib/csvExport.js';

interface AccountOption {
  id: string;
  code: string;
  nameAr: string;
}

interface ReportsPanelProps {
  companyId: string;
}

export function ReportsPanel({ companyId }: ReportsPanelProps) {
  const [reportType, setReportType] = useState<'gl' | 'income' | 'balance'>('gl');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter states
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [asOfDate, setAsOfDate] = useState<string>('');

  // Report data states
  const [glData, setGlData] = useState<any | null>(null);
  const [incomeData, setIncomeData] = useState<any | null>(null);
  const [balanceData, setBalanceData] = useState<any | null>(null);

  useEffect(() => {
    async function loadAccounts() {
      if (!companyId) return;
      try {
        const res = await apiFetch(`/api/accounting/accounts?companyId=${companyId}`);
        if (res.ok) {
          const body = await res.json();
          const list: AccountOption[] = (body.accounts || []).filter((a: any) => a.isPostable);
          setAccounts(list);
          if (list.length > 0 && !selectedAccountId) {
            setSelectedAccountId(list[0].id);
          }
        }
      } catch {
        // ignore account list error
      }
    }
    loadAccounts();
  }, [companyId]);

  const loadReport = async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      if (reportType === 'gl') {
        if (!selectedAccountId) {
          setError('يرجى اختيار الحساب المحاسبي لعرض الأستاذ العام');
          setLoading(false);
          return;
        }
        const params = new URLSearchParams({
          companyId,
          accountId: selectedAccountId,
          ...(fromDate ? { fromDate } : {}),
          ...(toDate ? { toDate } : {}),
        });
        const res = await apiFetch(`/api/accounting/reports/general-ledger?${params.toString()}`);
        if (!res.ok) {
          const errBody = await res.json();
          throw new Error(errBody.message || errBody.error || 'فشل تحميل الأستاذ العام');
        }
        const body = await res.json();
        setGlData(body.report);
      } else if (reportType === 'income') {
        const params = new URLSearchParams({
          companyId,
          ...(fromDate ? { fromDate } : {}),
          ...(toDate ? { toDate } : {}),
        });
        const res = await apiFetch(`/api/accounting/reports/income-statement?${params.toString()}`);
        if (!res.ok) {
          const errBody = await res.json();
          throw new Error(errBody.message || errBody.error || 'فشل تحميل قائمة الدخل');
        }
        const body = await res.json();
        setIncomeData(body.report);
      } else if (reportType === 'balance') {
        const params = new URLSearchParams({
          companyId,
          ...(asOfDate ? { asOfDate } : {}),
        });
        const res = await apiFetch(`/api/accounting/reports/balance-sheet?${params.toString()}`);
        if (!res.ok) {
          const errBody = await res.json();
          throw new Error(errBody.message || errBody.error || 'فشل تحميل الميزانية العمومية');
        }
        const body = await res.json();
        setBalanceData(body.report);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في جلب التقرير المالي');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReport();
  }, [reportType, companyId]);

  const handleExportCsv = () => {
    let csv = '';
    let filename = 'report.csv';

    if (reportType === 'gl' && glData) {
      filename = `general-ledger-${glData.accountCode || 'report'}.csv`;
      csv = buildGeneralLedgerCsv(glData);
    } else if (reportType === 'income' && incomeData) {
      filename = 'income-statement.csv';
      csv = buildIncomeStatementCsv(incomeData);
    } else if (reportType === 'balance' && balanceData) {
      filename = 'balance-sheet.csv';
      csv = buildBalanceSheetCsv(balanceData);
    }

    if (!csv) return;

    const blob = new Blob([withBom(csv)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="w-full flex flex-col gap-6" dir="rtl">
      {/* Report Header & Filter Card */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl backdrop-blur-md flex flex-col gap-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">التقارير المالية والختامية</h3>
              <p className="text-xs text-slate-400">كشوفات الأستاذ وقائمة الدخل والميزانية العمومية المبنية على القيود المرحلة فقط</p>
            </div>
          </div>

          {/* Report Subtabs */}
          <div className="flex items-center gap-2 bg-slate-950 p-1.5 rounded-xl border border-slate-800">
            <button
              onClick={() => setReportType('gl')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                reportType === 'gl' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              <ArrowLeftRight className="w-3.5 h-3.5" />
              <span>الأستاذ العام (General Ledger)</span>
            </button>
            <button
              onClick={() => setReportType('income')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                reportType === 'income' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              <PieChart className="w-3.5 h-3.5" />
              <span>قائمة الدخل (Income Statement)</span>
            </button>
            <button
              onClick={() => setReportType('balance')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                reportType === 'balance' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Landmark className="w-3.5 h-3.5" />
              <span>الميزانية العمومية (Balance Sheet)</span>
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
          {reportType === 'gl' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-slate-300">الحساب المحاسبي:</label>
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500"
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.code} - {acc.nameAr}
                  </option>
                ))}
              </select>
            </div>
          )}

          {reportType !== 'balance' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">من تاريخ:</label>
                <div className="relative">
                  <Calendar className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                  <input
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2 pl-9 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">إلى تاريخ:</label>
                <div className="relative">
                  <Calendar className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                  <input
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2 pl-9 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-slate-300">حتى تاريخ (As of Date):</label>
              <div className="relative">
                <Calendar className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="date"
                  value={asOfDate}
                  onChange={(e) => setAsOfDate(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2 pl-9 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={loadReport}
              disabled={loading}
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-indigo-600/20 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>عرض</span>
            </button>
            <button
              onClick={handleExportCsv}
              disabled={loading || (!glData && !incomeData && !balanceData)}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-emerald-600/20 cursor-pointer"
              title="تصدير CSV مع دعم اللغة العربية UTF-8 BOM"
            >
              <Download className="w-3.5 h-3.5" />
              <span>تصدير CSV</span>
            </button>
          </div>
        </div>
      </div>

      {/* Error View */}
      {error && (
        <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      {/* Loading View */}
      {loading && (
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-12 text-center flex flex-col items-center gap-3">
          <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin" />
          <span className="text-xs text-slate-400">جاري تجميع التقرير المالي...</span>
        </div>
      )}

      {/* Report Content View */}
      {!loading && !error && (
        <>
          {reportType === 'gl' && glData && (
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4 text-xs">
                <div>
                  <span className="text-slate-400">الحساب: </span>
                  <span className="font-bold text-white">{glData.accountCode} - {glData.accountNameAr}</span>
                </div>
                <div>
                  <span className="text-slate-400">الرصيد الافتتاحي: </span>
                  <span className="font-bold text-indigo-300 font-mono">{glData.openingBalance}</span>
                </div>
                <div>
                  <span className="text-slate-400">إجمالي المدين: </span>
                  <span className="font-bold text-emerald-400 font-mono">{glData.totalDebit}</span>
                </div>
                <div>
                  <span className="text-slate-400">إجمالي الدائن: </span>
                  <span className="font-bold text-amber-400 font-mono">{glData.totalCredit}</span>
                </div>
                <div>
                  <span className="text-slate-400">الرصيد الختامي: </span>
                  <span className="font-bold text-white font-mono">{glData.closingBalance}</span>
                </div>
              </div>

              {glData.rows.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">لا توجد حركات مرحّلة في هذه الفترة</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                        <th className="py-2.5 px-3">تاريخ القيد</th>
                        <th className="py-2.5 px-3">البيان</th>
                        <th className="py-2.5 px-3">مدين</th>
                        <th className="py-2.5 px-3">دائن</th>
                        <th className="py-2.5 px-3">الرصيد التراكمي</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                      {glData.rows.map((row: any, idx: number) => (
                        <tr key={idx} className="hover:bg-slate-800/30">
                          <td className="py-2.5 px-3 text-slate-300 font-mono">{row.entryDate}</td>
                          <td className="py-2.5 px-3 text-slate-200">{row.lineMemo || '-'}</td>
                          <td className="py-2.5 px-3 text-emerald-400 font-mono">{row.debit}</td>
                          <td className="py-2.5 px-3 text-amber-400 font-mono">{row.credit}</td>
                          <td className="py-2.5 px-3 text-white font-bold font-mono">{row.runningBalance}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {reportType === 'income' && incomeData && (
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl flex flex-col gap-6">
              {/* Revenue Section */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between border-b border-emerald-500/30 pb-2">
                  <h4 className="text-sm font-bold text-emerald-400">الإيرادات (Revenues)</h4>
                  <span className="font-mono font-bold text-emerald-400 text-sm">{incomeData.totalRevenue}</span>
                </div>
                {incomeData.revenue.length === 0 ? (
                  <div className="py-3 text-xs text-slate-500">لا توجد إيرادات مرحّلة في الفترة</div>
                ) : (
                  <div className="divide-y divide-slate-800/50">
                    {incomeData.revenue.map((r: any) => (
                      <div key={r.accountId} className="flex justify-between py-2 text-xs">
                        <span className="text-slate-300">{r.accountCode} - {r.accountNameAr}</span>
                        <span className="font-mono text-slate-200">{r.amount}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Expenses Section */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between border-b border-amber-500/30 pb-2">
                  <h4 className="text-sm font-bold text-amber-400">المصروفات (Expenses)</h4>
                  <span className="font-mono font-bold text-amber-400 text-sm">{incomeData.totalExpenses}</span>
                </div>
                {incomeData.expenses.length === 0 ? (
                  <div className="py-3 text-xs text-slate-500">لا توجد مصروفات مرحّلة في الفترة</div>
                ) : (
                  <div className="divide-y divide-slate-800/50">
                    {incomeData.expenses.map((r: any) => (
                      <div key={r.accountId} className="flex justify-between py-2 text-xs">
                        <span className="text-slate-300">{r.accountCode} - {r.accountNameAr}</span>
                        <span className="font-mono text-slate-200">{r.amount}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Net Income */}
              <div className="pt-4 border-t border-slate-700 flex items-center justify-between bg-slate-950/60 p-4 rounded-xl">
                <span className="text-sm font-bold text-white">صافي الدخل (Net Income):</span>
                <span className="text-base font-extrabold text-indigo-400 font-mono">{incomeData.netIncome}</span>
              </div>
            </div>
          )}

          {reportType === 'balance' && balanceData && (
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl flex flex-col gap-6">
              {/* Assets */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between border-b border-blue-500/30 pb-2">
                  <h4 className="text-sm font-bold text-blue-400">الأصول (Assets)</h4>
                  <span className="font-mono font-bold text-blue-400 text-sm">{balanceData.totalAssets}</span>
                </div>
                {balanceData.assets.length === 0 ? (
                  <div className="py-3 text-xs text-slate-500">لا توجد أصول مرحّلة</div>
                ) : (
                  <div className="divide-y divide-slate-800/50">
                    {balanceData.assets.map((r: any) => (
                      <div key={r.accountId} className="flex justify-between py-2 text-xs">
                        <span className="text-slate-300">{r.accountCode} - {r.accountNameAr}</span>
                        <span className="font-mono text-slate-200">{r.amount}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Liabilities */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between border-b border-rose-500/30 pb-2">
                  <h4 className="text-sm font-bold text-rose-400">الالتزامات (Liabilities)</h4>
                  <span className="font-mono font-bold text-rose-400 text-sm">{balanceData.totalLiabilities}</span>
                </div>
                {balanceData.liabilities.length === 0 ? (
                  <div className="py-3 text-xs text-slate-500">لا توجد التزامات مرحّلة</div>
                ) : (
                  <div className="divide-y divide-slate-800/50">
                    {balanceData.liabilities.map((r: any) => (
                      <div key={r.accountId} className="flex justify-between py-2 text-xs">
                        <span className="text-slate-300">{r.accountCode} - {r.accountNameAr}</span>
                        <span className="font-mono text-slate-200">{r.amount}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Equity */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between border-b border-purple-500/30 pb-2">
                  <h4 className="text-sm font-bold text-purple-400">حقوق الملكية (Equity)</h4>
                  <span className="font-mono font-bold text-purple-400 text-sm">{balanceData.totalEquity}</span>
                </div>
                {balanceData.equity.length === 0 ? (
                  <div className="py-3 text-xs text-slate-500">لا توجد حسابات حقوق ملكية مرحّلة</div>
                ) : (
                  <div className="divide-y divide-slate-800/50">
                    {balanceData.equity.map((r: any) => (
                      <div key={r.accountId} className="flex justify-between py-2 text-xs">
                        <span className="text-slate-300">{r.accountCode} - {r.accountNameAr}</span>
                        <span className="font-mono text-slate-200">{r.amount}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Total Balance Sheet Check */}
              <div className="pt-4 border-t border-slate-700 flex flex-col md:flex-row items-center justify-between gap-3 bg-slate-950/60 p-4 rounded-xl text-xs">
                <div>
                  <span className="text-slate-400">إجمالي الأصول: </span>
                  <span className="font-bold text-white font-mono text-sm">{balanceData.totalAssets}</span>
                </div>
                <div>
                  <span className="text-slate-400">إجمالي الالتزامات وحقوق الملكية: </span>
                  <span className="font-bold text-white font-mono text-sm">{balanceData.totalLiabilitiesAndEquity}</span>
                </div>
                <div>
                  {balanceData.isBalanced ? (
                    <span className="px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-400 font-semibold border border-emerald-500/30">
                      الميزانية متوازنة
                    </span>
                  ) : (
                    <span className="px-2.5 py-1 rounded-full bg-red-500/20 text-red-400 font-semibold border border-red-500/30">
                      الميزانية غير متوازنة
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
