import React, { useState, useEffect } from 'react';
import {
  Calendar,
  Plus,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Lock,
  Unlock,
  X,
  Clock,
  ShieldCheck,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

export interface AccountingPeriod {
  id: string;
  companyId: string;
  code: string;
  startDate: string;
  endDate: string;
  isClosed: boolean;
  closedAt: string | null;
  closedBy: string | null;
  createdAt: string;
}

interface PeriodsPanelProps {
  companyId: string;
  canManage: boolean;
}

export function PeriodsPanel({ companyId, canManage }: PeriodsPanelProps) {
  const [periods, setPeriods] = useState<AccountingPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Create modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newStartDate, setNewStartDate] = useState('');
  const [newEndDate, setNewEndDate] = useState('');

  // Confirm close/reopen dialog state
  const [confirmModal, setConfirmModal] = useState<{
    period: AccountingPeriod;
    action: 'close' | 'reopen';
  } | null>(null);

  // Fiscal Year Close state (AN-YEAR-CLOSE-1)
  const [yearCloses, setYearCloses] = useState<any[]>([]);
  const [equityAccounts, setEquityAccounts] = useState<any[]>([]);
  const [showYearCloseModal, setShowYearCloseModal] = useState(false);
  const [ycForm, setYcForm] = useState({
    fiscalYearCode: `FY-${new Date().getFullYear()}`,
    startDate: `${new Date().getFullYear()}-01-01`,
    endDate: `${new Date().getFullYear()}-12-31`,
    retainedEarningsAccountId: '',
    notes: '',
  });
  const [ycPreview, setYcPreview] = useState<any | null>(null);

  const loadPeriods = async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/accounting/periods?companyId=${companyId}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || 'تعذر تحميل الفترات المالية');
      }
      const data = await res.json();
      setPeriods(data.periods || []);

      const [ycRes, accRes] = await Promise.all([
        apiFetch(`/api/accounting/year-close?companyId=${companyId}`),
        apiFetch(`/api/accounting/accounts?companyId=${companyId}`),
      ]);
      if (ycRes.ok) {
        const ycJson = await ycRes.json();
        setYearCloses(ycJson.closes || []);
      }
      if (accRes.ok) {
        const accJson = await accRes.json();
        const eq = (accJson.accounts || []).filter(
          (a: any) => a.accountType === 'equity' && a.isPostable && a.isActive
        );
        setEquityAccounts(eq);
        if (eq.length > 0 && !ycForm.retainedEarningsAccountId) {
          setYcForm((prev) => ({ ...prev, retainedEarningsAccountId: eq[0].id }));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء جلب الفترات المالية');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPeriods();
  }, [companyId]);

  const handlePreviewYearClose = async () => {
    setActionLoading(true);
    setError(null);
    setYcPreview(null);
    try {
      const res = await apiFetch('/api/accounting/year-close/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          fiscalYearCode: ycForm.fiscalYearCode,
          startDate: ycForm.startDate,
          endDate: ycForm.endDate,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || err.error || 'تعذر معاينة إقفال السنة المالية');
      }
      const data = await res.json();
      setYcPreview(data.preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في معاينة إقفال السنة المالية');
    } finally {
      setActionLoading(false);
    }
  };

  const handleExecuteYearClose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch('/api/accounting/year-close/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, ...ycForm }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || err.error || 'فشل إقفال السنة المالية');
      }
      setSuccess(`تم إقفال السنة المالية (${ycForm.fiscalYearCode}) وترحيل النتيجة إلى الأرباح المبقاة بنجاح`);
      setShowYearCloseModal(false);
      setYcPreview(null);
      await loadPeriods();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في تنفيذ إقفال السنة المالية');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCreatePeriod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await apiFetch('/api/accounting/periods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          code: newCode.trim(),
          startDate: newStartDate,
          endDate: newEndDate,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || 'فشل في إنشاء الفترة المالية');
      }

      setSuccess('تم إنشاء الفترة المالية بنجاح');
      setShowCreateModal(false);
      setNewCode('');
      setNewStartDate('');
      setNewEndDate('');
      await loadPeriods();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء إنشاء الفترة المالية');
    } finally {
      setActionLoading(false);
    }
  };

  const handleTogglePeriod = async () => {
    if (!confirmModal || !canManage) return;
    const { period, action } = confirmModal;

    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const endpoint =
        action === 'close'
          ? `/api/accounting/periods/${period.id}/close`
          : `/api/accounting/periods/${period.id}/reopen`;

      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          data.message || data.error || (action === 'close' ? 'فشل إغلاق الفترة' : 'فشل إعادة فتح الفترة')
        );
      }

      setSuccess(
        action === 'close'
          ? `تم إغلاق الفترة المالية (${period.code}) بنجاح. لن يُسمح بترحيل قيود في هذه الفترة.`
          : `تم إعادة فتح الفترة المالية (${period.code}) بنجاح.`
      );
      setConfirmModal(null);
      await loadPeriods();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تحديث حالة الفترة');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      {/* Top Header Card */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <Calendar className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">الفترات المالية والمحاسبية (Accounting Periods)</h3>
            <p className="text-xs text-slate-400">
              إدارة الفترات المالية وإغلاق الفترات لمنع الترحيل أو التعديل في الفترات المقفلة
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={loadPeriods}
            disabled={loading}
            className="p-2.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer"
            title="تحديث"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {canManage && (
            <>
              <button
                onClick={() => {
                  setYcPreview(null);
                  setShowYearCloseModal(true);
                }}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-amber-600/20 transition cursor-pointer"
              >
                <ShieldCheck className="w-4 h-4" />
                <span>إقفال سنة مالية</span>
              </button>

              <button
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>فترة مالية جديدة</span>
              </button>
            </>
          )}
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
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          <span>{success}</span>
        </div>
      )}

      {/* Periods Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">رمز الفترة (الكود)</th>
                <th className="py-3.5 px-4">تاريخ البداية</th>
                <th className="py-3.5 px-4">تاريخ النهاية</th>
                <th className="py-3.5 px-4 text-center">الحالة</th>
                <th className="py-3.5 px-4">تفاصيل الإغلاق</th>
                <th className="py-3.5 px-4 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    <div className="flex items-center justify-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                      <span>جاري تحميل الفترات المالية...</span>
                    </div>
                  </td>
                </tr>
              ) : periods.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    لا توجد فترات مالية مسجلة لهذه الشركة بعد. يرجى إنشاء فترة مالية لتتمكن من ترحيل القيود.
                  </td>
                </tr>
              ) : (
                periods.map((period) => (
                  <tr key={period.id} className="hover:bg-slate-800/30 transition">
                    <td className="py-3.5 px-4 font-mono font-bold text-indigo-300">
                      {period.code}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-slate-300">
                      {period.startDate}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-slate-300">
                      {period.endDate}
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      {period.isClosed ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-rose-950/60 border border-rose-800/80 text-rose-400">
                          <Lock className="w-3 h-3" />
                          <span>مغلقة (Closed)</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-950/60 border border-emerald-800/80 text-emerald-400">
                          <Unlock className="w-3 h-3" />
                          <span>مفتوحة (Open)</span>
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-slate-400 text-[11px]">
                      {period.isClosed && period.closedAt ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="flex items-center gap-1 text-slate-300">
                            <Clock className="w-3 h-3 text-slate-500" />
                            {new Date(period.closedAt).toLocaleString('ar-EG')}
                          </span>
                        </div>
                      ) : (
                        <span className="text-slate-600 font-mono">—</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      {canManage ? (
                        period.isClosed ? (
                          <button
                            onClick={() => setConfirmModal({ period, action: 'reopen' })}
                            disabled={actionLoading}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-950 hover:bg-slate-800 border border-emerald-800/60 hover:border-emerald-700 text-emerald-400 rounded-lg text-[11px] font-medium transition cursor-pointer"
                          >
                            <Unlock className="w-3 h-3" />
                            <span>إعادة فتح</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => setConfirmModal({ period, action: 'close' })}
                            disabled={actionLoading}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-rose-950/40 hover:bg-rose-900/60 border border-rose-800/80 text-rose-300 rounded-lg text-[11px] font-medium transition cursor-pointer"
                          >
                            <Lock className="w-3 h-3" />
                            <span>إغلاق الفترة</span>
                          </button>
                        )
                      ) : (
                        <span className="text-slate-600 text-xs">عرض فقط</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Fiscal Year Close History Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h4 className="text-sm font-bold text-white">سجل إقفال السنوات المالية وترحيل الأرباح المبقاة</h4>
            <p className="text-[11px] text-slate-400">
              يُنشئ قيد إقفال متوازن لإقفال حسابات الإيرادات والمصروفات وترحيل صافي الدخل لحقوق الملكية مع إغلاق الفترات المفتوحة
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3 px-4">السنة المالية</th>
                <th className="py-3 px-4">النطاق الزمني</th>
                <th className="py-3 px-4">إجمالي الإيرادات</th>
                <th className="py-3 px-4">إجمالي المصروفات</th>
                <th className="py-3 px-4">صافي النتيجة</th>
                <th className="py-3 px-4">حساب الترحيل</th>
                <th className="py-3 px-4">قيد الإقفال</th>
                <th className="py-3 px-4 text-center">الفترات المغلقة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {yearCloses.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    لم يتم تنفيذ أي إقفال سنة مالية لهذه الشركة بعد
                  </td>
                </tr>
              ) : (
                yearCloses.map((yc) => (
                  <tr key={yc.id} className="hover:bg-slate-800/30">
                    <td className="py-3 px-4 font-mono font-bold text-amber-400">{yc.fiscalYearCode}</td>
                    <td className="py-3 px-4 font-mono text-slate-300">
                      {yc.startDate} → {yc.endDate}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-emerald-400">{yc.totalRevenue}</td>
                    <td className="py-3 px-4 font-mono tabular-nums text-rose-400">{yc.totalExpenses}</td>
                    <td className="py-3 px-4 font-mono tabular-nums font-bold text-white">{yc.netIncome}</td>
                    <td className="py-3 px-4 text-slate-300">
                      {yc.retainedEarningsAccountCode} - {yc.retainedEarningsAccountNameAr}
                    </td>
                    <td className="py-3 px-4 font-mono text-indigo-300">{yc.closingEntryNo || '—'}</td>
                    <td className="py-3 px-4 text-center font-mono">{yc.closedPeriodsCount}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Period Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl flex flex-col">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Calendar className="w-5 h-5 text-indigo-400" />
                <h4 className="font-bold text-white text-sm">إنشاء فترة مالية جديدة</h4>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreatePeriod} className="p-6 flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  رمز الفترة (الكود) <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="مثال: 2026-01 أو Q1-2026"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    تاريخ البداية <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={newStartDate}
                    onChange={(e) => setNewStartDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    تاريخ النهاية <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={newEndDate}
                    onChange={(e) => setNewEndDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="p-4 border-t border-slate-800 bg-slate-950/80 -mx-6 -mb-6 flex items-center justify-end gap-3 mt-4">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition cursor-pointer shadow-lg shadow-indigo-600/20 disabled:opacity-50"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ الفترة'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirm Close/Reopen Modal */}
      {confirmModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                  confirmModal.action === 'close'
                    ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                    : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                }`}
              >
                {confirmModal.action === 'close' ? <Lock className="w-5 h-5" /> : <Unlock className="w-5 h-5" />}
              </div>
              <div>
                <h4 className="font-bold text-white text-sm">
                  {confirmModal.action === 'close'
                    ? `تأكيد إغلاق الفترة (${confirmModal.period.code})`
                    : `تأكيد إعادة فتح الفترة (${confirmModal.period.code})`}
                </h4>
                <p className="text-xs text-slate-400">
                  {confirmModal.action === 'close'
                    ? 'عند إغلاق الفترة، سيتم منع ترحيل أو عكس أي قيود يومية تقع ضمن تواريخ هذه الفترة.'
                    : 'إعادة فتح الفترة ستسمح للمستخدمين المصرح لهم بترحيل القيود ضمن نطاق هذه الفترة مجدداً.'}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setConfirmModal(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={handleTogglePeriod}
                disabled={actionLoading}
                className={`px-5 py-2 rounded-xl text-xs font-bold text-white transition cursor-pointer ${
                  confirmModal.action === 'close'
                    ? 'bg-rose-600 hover:bg-rose-500'
                    : 'bg-emerald-600 hover:bg-emerald-500'
                }`}
              >
                {actionLoading
                  ? 'جاري التنفيذ...'
                  : confirmModal.action === 'close'
                  ? 'نعم، إغلاق الفترة'
                  : 'نعم، إعادة فتح الفترة'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Fiscal Year Close Modal */}
      {showYearCloseModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="w-5 h-5 text-amber-400" />
                <h4 className="font-bold text-white text-sm">إقفال السنة المالية وترحيل النتيجة</h4>
              </div>
              <button
                type="button"
                onClick={() => setShowYearCloseModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleExecuteYearClose} className="p-6 flex flex-col gap-4 overflow-y-auto text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">رمز السنة المالية *</label>
                  <input
                    type="text"
                    required
                    value={ycForm.fiscalYearCode}
                    onChange={(e) => setYcForm({ ...ycForm, fiscalYearCode: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">تاريخ البداية *</label>
                  <input
                    type="date"
                    required
                    value={ycForm.startDate}
                    onChange={(e) => setYcForm({ ...ycForm, startDate: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">تاريخ النهاية *</label>
                  <input
                    type="date"
                    required
                    value={ycForm.endDate}
                    onChange={(e) => setYcForm({ ...ycForm, endDate: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                <div>
                  <label className="block text-slate-300 mb-1">حساب الأرباح المبقاة (حقوق الملكية) *</label>
                  <select
                    required
                    value={ycForm.retainedEarningsAccountId}
                    onChange={(e) => setYcForm({ ...ycForm, retainedEarningsAccountId: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white"
                  >
                    {equityAccounts.length === 0 ? (
                      <option value="">لا يوجد حساب حقوق ملكية قابل للترحيل</option>
                    ) : (
                      equityAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} - {a.nameAr}
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={handlePreviewYearClose}
                  disabled={actionLoading}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-semibold transition cursor-pointer"
                >
                  {actionLoading ? 'جاري الفحص...' : 'معاينة النتيجة والفترات'}
                </button>
              </div>

              {ycPreview && (
                <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="p-2.5 bg-slate-900 rounded-lg border border-slate-800">
                      <div className="text-slate-400 text-[11px]">إجمالي الإيرادات</div>
                      <div className="font-mono font-bold text-emerald-400 text-sm">{ycPreview.totalRevenue}</div>
                    </div>
                    <div className="p-2.5 bg-slate-900 rounded-lg border border-slate-800">
                      <div className="text-slate-400 text-[11px]">إجمالي المصروفات</div>
                      <div className="font-mono font-bold text-rose-400 text-sm">{ycPreview.totalExpenses}</div>
                    </div>
                    <div className="p-2.5 bg-slate-900 rounded-lg border border-slate-800">
                      <div className="text-slate-400 text-[11px]">صافي الدخل للترحيل</div>
                      <div className="font-mono font-bold text-indigo-400 text-sm">{ycPreview.netIncome}</div>
                    </div>
                  </div>
                  <div className="text-[11px] text-slate-300">
                    الفترات المفتوحة التي سيتم إغلاقها تلقائياً:{' '}
                    <strong className="font-mono text-white">{ycPreview.openPeriodsToCloseCount}</strong>
                  </div>
                  {ycPreview.blockingReasons && ycPreview.blockingReasons.length > 0 && (
                    <div className="p-3 bg-rose-950/40 border border-rose-800/70 rounded-lg text-rose-300 flex flex-col gap-1">
                      {ycPreview.blockingReasons.map((reason: string, idx: number) => (
                        <div key={idx}>• {reason}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="block text-slate-300 mb-1">ملاحظات الإقفال</label>
                <input
                  type="text"
                  placeholder="إقفال السنة المالية..."
                  value={ycForm.notes}
                  onChange={(e) => setYcForm({ ...ycForm, notes: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowYearCloseModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading || !ycForm.retainedEarningsAccountId || (ycPreview && !ycPreview.canExecute)}
                  className="px-5 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-bold rounded-xl cursor-pointer"
                >
                  {actionLoading ? 'جاري التنفيذ...' : 'تنفيذ إقفال السنة المالية'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
