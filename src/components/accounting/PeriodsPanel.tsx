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
  User,
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء جلب الفترات المالية');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPeriods();
  }, [companyId]);

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
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>فترة مالية جديدة</span>
            </button>
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
    </div>
  );
}
