import React, { useState } from 'react';
import {
  ShieldAlert,
  ShieldCheck,
  Clock,
  Check,
  Ban,
  AlertTriangle,
  X,
  RefreshCw,
  FileWarning,
  Send,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

export type PriceVarianceExceptionStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

export interface PriceVarianceExceptionItem {
  id: string;
  companyId: string;
  invoiceId: string;
  supplierId: string;
  status: PriceVarianceExceptionStatus;
  requestedBy: string | null;
  requestedByUsername?: string | null;
  approvedBy: string | null;
  approvedByUsername?: string | null;
  rejectedBy: string | null;
  rejectedByUsername?: string | null;
  supersededBy?: string | null;
  supersededByUsername?: string | null;
  reason: string;
  decisionReason: string | null;
  fingerprint: string;
  maxVariancePc: number;
  decidedAt?: string | null;
  supersededAt?: string | null;
  createdAt: string;
  updatedAt: string;
  isFingerprintValid?: boolean;
  isExpired?: boolean;
}

export interface ExceptionMatchReportLine {
  grnLineId: string;
  itemNameAr?: string;
  invoiceQty: number;
  grnQty: number;
  poQty?: number | null;
  priceVariancePct: number;
  qtyExceeded?: boolean;
  priceExceeded?: boolean;
}

export interface ExceptionMatchReport {
  invoiceId: string;
  supplierInvoiceNo: string;
  overallStatus: 'matched' | 'within_tolerance' | 'variance_exceeded' | 'grn_only';
  hasQtyExceeded?: boolean;
  hasPriceExceeded?: boolean;
  lines: ExceptionMatchReportLine[];
}

interface PriceVarianceExceptionPanelProps {
  companyId: string;
  invoice: {
    id: string;
    companyId?: string;
    supplierInvoiceNo: string;
    status: 'draft' | 'posted' | 'cancelled';
  } | null;
  matchReport: ExceptionMatchReport | null;
  exceptions: PriceVarianceExceptionItem[];
  loading: boolean;
  loadError?: string | null;
  currentUserId: string | null;
  canRequestVariance: boolean;
  canApproveVariance: boolean;
  canPostInvoice: boolean;
  actionLoading: boolean;
  onRefresh: () => Promise<void>;
  onPostInvoice?: (invoiceId: string) => Promise<void>;
  onError: (msg: string | null) => void;
  onSuccess: (msg: string | null) => void;
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  return `${d.toLocaleDateString('ar-EG')} ${d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
}

export function PriceVarianceExceptionPanel({
  companyId,
  invoice,
  matchReport,
  exceptions,
  loading,
  loadError = null,
  currentUserId,
  canRequestVariance,
  canApproveVariance,
  canPostInvoice,
  actionLoading,
  onRefresh,
  onPostInvoice,
  onError,
  onSuccess,
}: PriceVarianceExceptionPanelProps) {
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [requestReason, setRequestReason] = useState('');

  const [decisionModal, setDecisionModal] = useState<{
    mode: 'approve' | 'reject';
    exception: PriceVarianceExceptionItem;
  } | null>(null);
  const [decisionReason, setDecisionReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!matchReport) {
    return null;
  }

  const isTrustedInvoice = Boolean(
    invoice &&
      invoice.id &&
      invoice.id === matchReport.invoiceId &&
      (!invoice.companyId || invoice.companyId === companyId) &&
      (invoice.status === 'draft' || invoice.status === 'posted' || invoice.status === 'cancelled')
  );
  const isTrustedDraft = isTrustedInvoice && invoice!.status === 'draft';
  const hasLoadError = Boolean(loadError && loadError.trim() !== '');
  const actionsBlockedBySync = loading || hasLoadError || !isTrustedInvoice;

  const isValidExceptionFingerprint = (exc: PriceVarianceExceptionItem): boolean =>
    exc.isFingerprintValid === true && exc.isExpired !== true;

  const hasQtyExceeded = Boolean(
    matchReport.hasQtyExceeded ||
      matchReport.lines.some(
        (l) =>
          Boolean(l.qtyExceeded) ||
          l.invoiceQty > l.grnQty ||
          (typeof l.poQty === 'number' && l.invoiceQty > l.poQty)
      )
  );

  const isVarianceExceeded = matchReport.overallStatus === 'variance_exceeded';
  const maxPriceVariancePct = matchReport.lines.reduce(
    (max, l) => Math.max(max, Number(l.priceVariancePct || 0)),
    0
  );

  const validApproved = !actionsBlockedBySync
    ? exceptions.find((e) => e.status === 'approved' && isValidExceptionFingerprint(e))
    : undefined;
  const validPending = !actionsBlockedBySync
    ? exceptions.find((e) => e.status === 'pending' && isValidExceptionFingerprint(e))
    : undefined;
  const latestException = exceptions[0] || null;
  const hasExpiredLatest = Boolean(
    latestException &&
      (latestException.status === 'pending' || latestException.status === 'approved') &&
      (latestException.isExpired === true || latestException.isFingerprintValid === false)
  );
  const hasUnverifiedLatest = Boolean(
    latestException &&
      (latestException.status === 'pending' || latestException.status === 'approved') &&
      !hasExpiredLatest &&
      latestException.isFingerprintValid !== true
  );

  const canDecideException = (exc: PriceVarianceExceptionItem): boolean => {
    if (actionsBlockedBySync || !isTrustedDraft || hasQtyExceeded) return false;
    if (!canApproveVariance) return false;
    if (!currentUserId || !exc.requestedBy || exc.requestedBy === currentUserId) return false;
    if (exc.status !== 'pending') return false;
    if (!isValidExceptionFingerprint(exc)) return false;
    return true;
  };

  const showRequestButton =
    !actionsBlockedBySync &&
    isTrustedDraft &&
    isVarianceExceeded &&
    !hasQtyExceeded &&
    !hasUnverifiedLatest &&
    canRequestVariance &&
    !validApproved;

  const showPostButton =
    !actionsBlockedBySync &&
    isTrustedDraft &&
    Boolean(validApproved) &&
    !hasQtyExceeded &&
    !hasUnverifiedLatest &&
    canPostInvoice &&
    Boolean(onPostInvoice);

  const handleRequestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (actionsBlockedBySync || !isTrustedDraft || !invoice) {
      onError('لا يمكن تقديم طلب استثناء قبل اكتمال التحقق من حالة الفاتورة والسجل.');
      return;
    }
    const trimmed = requestReason.trim();
    if (!trimmed) {
      onError('يرجى إدخال سبب طلب استثناء تباين السعر');
      return;
    }
    setSubmitting(true);
    onError(null);
    onSuccess(null);
    try {
      const res = await apiFetch(`/api/purchasing/supplier-invoices/${invoice.id}/price-exceptions`, {
        method: 'POST',
        body: JSON.stringify({
          companyId,
          reason: trimmed,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(data.message || data.error || 'تعذر تقديم طلب استثناء تباين السعر');
        return;
      }
      setShowRequestModal(false);
      setRequestReason('');
      onSuccess('تم تقديم طلب استثناء تباين السعر بنجاح وبانتظار اعتماد صاحب الصلاحية');
    } catch (err: any) {
      onError(err?.message || 'حدث خطأ أثناء إرسال طلب الاستثناء');
    } finally {
      setSubmitting(false);
      await onRefresh();
    }
  };

  const handleDecisionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!decisionModal || actionsBlockedBySync || !isTrustedDraft) return;
    const { mode, exception } = decisionModal;
    const trimmed = decisionReason.trim();
    if (mode === 'reject' && !trimmed) {
      onError('يرجى كتابة سبب رفض طلب الاستثناء');
      return;
    }

    setSubmitting(true);
    onError(null);
    onSuccess(null);
    try {
      const res = await apiFetch(`/api/purchasing/price-exceptions/${exception.id}/${mode}`, {
        method: 'POST',
        body: JSON.stringify({
          companyId,
          decisionReason: trimmed || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(
          data.message ||
            data.error ||
            (mode === 'approve' ? 'تعذر اعتماد طلب الاستثناء' : 'تعذر رفض طلب الاستثناء')
        );
        setDecisionModal(null);
        setDecisionReason('');
        return;
      }
      setDecisionModal(null);
      setDecisionReason('');
      onSuccess(
        mode === 'approve'
          ? 'تم اعتماد استثناء تباين السعر بنجاح؛ الفاتورة جاهزة الآن للترحيل'
          : 'تم رفض طلب استثناء تباين السعر'
      );
    } catch (err: any) {
      onError(err?.message || 'حدث خطأ أثناء تنفيذ قرار الاستثناء');
    } finally {
      setSubmitting(false);
      await onRefresh();
    }
  };

  const statusBadge = (exc: PriceVarianceExceptionItem) => {
    const expired = Boolean(exc.isExpired === true || exc.isFingerprintValid === false);
    const unverified = !expired && exc.isFingerprintValid !== true;
    if (exc.status === 'approved') {
      if (expired) {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-950/70 border border-amber-700 text-amber-300">
            <FileWarning className="w-3 h-3" />
            <span>معتمد (منتهي الصلاحية - تغيرت البنود)</span>
          </span>
        );
      }
      if (unverified) {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-slate-800 border border-amber-700/70 text-amber-300">
            <FileWarning className="w-3 h-3" />
            <span>معتمد (صلاحية البصمة غير مؤكدة)</span>
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-950/60 border border-emerald-800 text-emerald-300">
          <ShieldCheck className="w-3 h-3" />
          <span>معتمد (ساري)</span>
        </span>
      );
    }
    if (exc.status === 'pending') {
      if (expired) {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-950/70 border border-amber-700 text-amber-300">
            <FileWarning className="w-3 h-3" />
            <span>معلق (منتهي الصلاحية - تغيرت البنود)</span>
          </span>
        );
      }
      if (unverified) {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-slate-800 border border-amber-700/70 text-amber-300">
            <FileWarning className="w-3 h-3" />
            <span>معلق (صلاحية البصمة غير مؤكدة)</span>
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-950/60 border border-amber-800 text-amber-300">
          <Clock className="w-3 h-3" />
          <span>قيد المراجعة</span>
        </span>
      );
    }
    if (exc.status === 'rejected') {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-rose-950/60 border border-rose-800 text-rose-300">
          <Ban className="w-3 h-3" />
          <span>مرفوض</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-slate-800 border border-slate-700 text-slate-300">
        <FileWarning className="w-3 h-3" />
        <span>مستبدل / ملغى (Superseded)</span>
      </span>
    );
  };

  const renderDeciderInfo = (exc: PriceVarianceExceptionItem) => {
    if (exc.status === 'approved') {
      return (
        <div className="text-[11px]">
          <div className="font-semibold text-emerald-300">{exc.approvedByUsername || 'معتمد النظام'}</div>
          <div className="text-[10px] text-slate-400 font-mono">{formatDateTime(exc.decidedAt || exc.updatedAt)}</div>
        </div>
      );
    }
    if (exc.status === 'rejected') {
      return (
        <div className="text-[11px]">
          <div className="font-semibold text-rose-300">{exc.rejectedByUsername || 'معتمد النظام'}</div>
          <div className="text-[10px] text-slate-400 font-mono">{formatDateTime(exc.decidedAt || exc.updatedAt)}</div>
        </div>
      );
    }
    if (exc.status === 'superseded') {
      return (
        <div className="text-[11px]">
          <div className="font-semibold text-slate-300">{exc.supersededByUsername || 'النظام'}</div>
          <div className="text-[10px] text-slate-400 font-mono">{formatDateTime(exc.supersededAt || exc.updatedAt)}</div>
        </div>
      );
    }
    return <span className="text-slate-500">—</span>;
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
      {/* Header */}
      <div className="p-4 bg-slate-950/60 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-amber-600/20 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
            <ShieldAlert className="w-4 h-4" />
          </div>
          <div>
            <h4 className="font-bold text-white text-sm">استثناءات تباين الأسعار وفصل المهام (Price Variance Exception)</h4>
            <p className="text-[11px] text-slate-400">
              حالة الفاتورة:{' '}
              <span className="font-bold text-white">
                {isTrustedInvoice && invoice
                  ? invoice.status === 'posted'
                    ? 'مرحّلة'
                    : invoice.status === 'cancelled'
                    ? 'ملغاة'
                    : 'مسودة'
                  : 'غير معروفة'}
              </span>{' '}
              | أقصى فارق سعر:{' '}
              <span className="font-mono font-bold text-amber-400">{maxPriceVariancePct.toFixed(2)}%</span>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onRefresh()}
            disabled={loading || submitting || actionLoading}
            className="p-2 bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer"
            title="تحديث حالة الاستثناءات"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {showRequestButton && (
            <button
              type="button"
              onClick={() => {
                setRequestReason('');
                setShowRequestModal(true);
              }}
              disabled={submitting || actionLoading}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-amber-600/20 transition cursor-pointer disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{latestException ? 'تقديم طلب استثناء جديد' : 'طلب استثناء تباين سعر'}</span>
            </button>
          )}

          {showPostButton && invoice && onPostInvoice && (
            <button
              type="button"
              onClick={() => onPostInvoice(invoice.id)}
              disabled={actionLoading || submitting}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-emerald-600/20 transition cursor-pointer disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" />
              <span>ترحيل الفاتورة الآن</span>
            </button>
          )}
        </div>
      </div>

      {/* State Summary Banner */}
      <div className="p-4 border-b border-slate-800/80">
        {hasLoadError ? (
          <div className="p-3.5 rounded-xl bg-rose-950/50 border border-rose-800/80 text-rose-200 text-xs flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
            <div>
              <div className="font-bold text-rose-300">تعذر تحديث حالة الاستثناءات</div>
              <p className="mt-1 text-rose-200/90">
                {loadError} — تم إخفاء وتعطيل إجراءات الطلب والاعتماد والرفض والترحيل لحين نجاح تحديث الحالة.
              </p>
            </div>
          </div>
        ) : loading ? (
          <div className="p-3.5 rounded-xl bg-slate-800/70 border border-slate-700 text-slate-200 text-xs flex items-center gap-2.5">
            <RefreshCw className="w-4 h-4 shrink-0 text-amber-400 animate-spin" />
            <span>جاري تحديث حالة المطابقة والاستثناءات... تم تعطيل إجراءات الطلب والاعتماد والترحيل مؤقتاً حتى تكتمل المزامنة.</span>
          </div>
        ) : !isTrustedInvoice || !invoice ? (
          <div className="p-3.5 rounded-xl bg-rose-950/40 border border-rose-800/70 text-rose-200 text-xs flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
            <div>
              <div className="font-bold text-rose-300">حالة الفاتورة غير معروفة أو غير متطابقة مع السياق الحالي</div>
              <p className="mt-1 text-rose-200/90">
                لا تتوفر بيانات فاتورة موثوقة لهذه الشركة في القائمة الحالية؛ تم إخفاء إجراءات الطلب والاعتماد والرفض والترحيل.
              </p>
            </div>
          </div>
        ) : invoice.status === 'posted' ? (
          <div className="p-3.5 rounded-xl bg-emerald-950/40 border border-emerald-800/60 text-emerald-300 text-xs flex items-center gap-2.5">
            <ShieldCheck className="w-4 h-4 shrink-0 text-emerald-400" />
            <span>الفاتورة مرحّلة بالفعل ومغلقة محاسبياً؛ لا يمكن تقديم طلبات استثناء أو اتخاذ قرارات جديدة عليها.</span>
          </div>
        ) : invoice.status === 'cancelled' ? (
          <div className="p-3.5 rounded-xl bg-slate-800/60 border border-slate-700 text-slate-300 text-xs flex items-center gap-2.5">
            <Ban className="w-4 h-4 shrink-0 text-slate-400" />
            <span>الفاتورة ملغاة؛ مسار استثناء تباين الأسعار مغلق لهذه الفاتورة.</span>
          </div>
        ) : hasQtyExceeded ? (
          <div className="p-3.5 rounded-xl bg-rose-950/50 border border-rose-800/80 text-rose-200 text-xs flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
            <div>
              <div className="font-bold text-rose-300">حظر إلزامي: تجاوز في الكمية (Quantity Exceeded)</div>
              <p className="mt-1 text-rose-200/90">
                تتجاوز الكمية المفوترة كمية الاستلام (GRN) أو كمية أمر الشراء (PO). استثناء تباين الأسعار مخصص لتباين السعر فقط ولا يمكن استخدامه لتمرير فروقات الكمية؛ يرجى تعديل كميات الفاتورة أو حذف المسودة.
              </p>
            </div>
          </div>
        ) : !isVarianceExceeded ? (
          <div className="p-3.5 rounded-xl bg-emerald-950/30 border border-emerald-800/50 text-emerald-300 text-xs flex items-center gap-2.5">
            <ShieldCheck className="w-4 h-4 shrink-0 text-emerald-400" />
            <span>أسعار وكميات الفاتورة ضمن سياسة المطابقة والتسامح المسموح به؛ لا يلزم طلب استثناء تباين سعر للترحيل.</span>
          </div>
        ) : validApproved ? (
          <div className="p-3.5 rounded-xl bg-emerald-950/40 border border-emerald-800/70 text-emerald-200 text-xs flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 shrink-0 text-emerald-400 mt-0.5" />
            <div>
              <div className="font-bold text-emerald-300">يوجد اعتماد ساري لاستثناء تباين السعر</div>
              <p className="mt-1">
                تم اعتماد الطلب بواسطة <span className="font-bold">{validApproved.approvedByUsername || 'صاحب الصلاحية'}</span> وبصمة الفاتورة مطابقة وسارية؛ يمكن لصاحب صلاحية الترحيل ترحيل الفاتورة الآن.
              </p>
            </div>
          </div>
        ) : hasExpiredLatest && latestException ? (
          <div className="p-3.5 rounded-xl bg-amber-950/50 border border-amber-700/80 text-amber-200 text-xs flex items-start gap-2.5">
            <FileWarning className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
            <div>
              <div className="font-bold text-amber-300">انتهت صلاحية بصمة الاستثناء (Expired Fingerprint)</div>
              <p className="mt-1">
                تغيرت بنود الفاتورة أو أسعارها بعد {latestException.status === 'approved' ? 'اعتماد' : 'تقديم'} طلب الاستثناء السابق. لا يمكن إعادة استخدام هذا الاستثناء لترحيل الفاتورة، ويلزم تقديم طلب استثناء جديد.
              </p>
            </div>
          </div>
        ) : hasUnverifiedLatest ? (
          <div className="p-3.5 rounded-xl bg-amber-950/50 border border-amber-700/80 text-amber-200 text-xs flex items-start gap-2.5">
            <FileWarning className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
            <div>
              <div className="font-bold text-amber-300">صلاحية بصمة الاستثناء غير مؤكدة</div>
              <p className="mt-1">
                لم يثبت الخادم تطابق بصمة الاستثناء الحالية؛ لا يُسمح باعتماد الاستثناء أو الترحيل حتى تكتمل صلاحية التحقق.
              </p>
            </div>
          </div>
        ) : validPending ? (
          <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-800/70 text-amber-200 text-xs flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-2.5">
              <Clock className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
              <div>
                <div className="font-bold text-amber-300">يوجد طلب استثناء قيد المراجعة</div>
                <p className="mt-1">
                  مقدم الطلب: <span className="font-bold">{validPending.requestedByUsername || 'مستخدم النظام'}</span> | السبب: {validPending.reason}
                </p>
                {canApproveVariance && currentUserId && validPending.requestedBy === currentUserId && (
                  <p className="mt-1 text-amber-300/90 font-semibold">
                    تنبيه فصل المهام (SoD): تم إخفاء أزرار الاعتماد والرفض لأنك مقدم هذا الطلب ولا يمكنك اعتماده أو رفضه بنفسك.
                  </p>
                )}
              </div>
            </div>
            {canDecideException(validPending) && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDecisionReason('');
                    setDecisionModal({ mode: 'approve', exception: validPending });
                  }}
                  disabled={submitting || actionLoading}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition flex items-center gap-1 cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>اعتماد</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDecisionReason('');
                    setDecisionModal({ mode: 'reject', exception: validPending });
                  }}
                  disabled={submitting || actionLoading}
                  className="px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold transition flex items-center gap-1 cursor-pointer"
                >
                  <Ban className="w-3.5 h-3.5" />
                  <span>رفض</span>
                </button>
              </div>
            )}
          </div>
        ) : latestException?.status === 'rejected' ? (
          <div className="p-3.5 rounded-xl bg-rose-950/40 border border-rose-800/70 text-rose-200 text-xs flex items-start gap-2.5">
            <Ban className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
            <div>
              <div className="font-bold text-rose-300">تم رفض طلب الاستثناء الأخير</div>
              <p className="mt-1">
                بواسطة: <span className="font-bold">{latestException.rejectedByUsername || 'صاحب الصلاحية'}</span>
                {latestException.decisionReason ? ` | سبب الرفض: ${latestException.decisionReason}` : ''}
              </p>
            </div>
          </div>
        ) : latestException?.status === 'superseded' ? (
          <div className="p-3.5 rounded-xl bg-slate-800/70 border border-slate-700 text-slate-200 text-xs flex items-start gap-2.5">
            <FileWarning className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
            <div>
              <div className="font-bold text-amber-300">تم إلغاء/استبدال طلب الاستثناء السابق (Superseded)</div>
              <p className="mt-1">
                {latestException.decisionReason || 'تغيرت بنود الفاتورة أو تم استبدال الطلب بطلب جديد.'} — يلزم تقديم طلب استثناء واعتماده قبل ترحيل الفاتورة.
              </p>
            </div>
          </div>
        ) : (
          <div className="p-3.5 rounded-xl bg-rose-950/40 border border-rose-800/60 text-rose-200 text-xs flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
            <div>
              <div className="font-bold text-rose-300">تتجاوز الفاتورة حد تسامح السعر ولا يوجد استثناء معتمد</div>
              <p className="mt-1">
                ترحيل هذه الفاتورة محظور إلى حين تقديم طلب استثناء تباين سعر واعتماده من مستخدم آخر يملك صلاحية الاعتماد.
                {!canRequestVariance && ' (تتطلب هذه الخطوة صلاحية purchasing:variance:request)'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* History Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-right text-xs">
          <thead>
            <tr className="bg-slate-950/40 border-b border-slate-800 text-slate-400 font-semibold">
              <th className="py-3 px-4">تاريخ الطلب</th>
              <th className="py-3 px-4">مقدم الطلب</th>
              <th className="py-3 px-4">سبب الاستثناء</th>
              <th className="py-3 px-4 text-center">أقصى تباين</th>
              <th className="py-3 px-4 text-center">الحالة</th>
              <th className="py-3 px-4">صاحب القرار / الاستبدال</th>
              <th className="py-3 px-4">سبب القرار أو الاستبدال</th>
              <th className="py-3 px-4 text-left">الإجراءات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 text-slate-200">
            {loading && exceptions.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-slate-400">
                  جاري تحميل سجل طلبات الاستثناء...
                </td>
              </tr>
            ) : exceptions.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-slate-500">
                  لا توجد طلبات استثناء مسجلة لهذه الفاتورة حتى الآن.
                </td>
              </tr>
            ) : (
              exceptions.map((exc) => {
                const isRequesterSelf = Boolean(currentUserId && exc.requestedBy && exc.requestedBy === currentUserId);
                return (
                  <tr key={exc.id} className="hover:bg-slate-800/30 transition">
                    <td className="py-3 px-4 font-mono text-[11px] whitespace-nowrap">{formatDateTime(exc.createdAt)}</td>
                    <td className="py-3 px-4 font-semibold text-white">
                      {exc.requestedByUsername || 'مستخدم النظام'}
                      {isRequesterSelf && (
                        <span className="mr-1.5 text-[10px] text-amber-400 font-normal">(أنت)</span>
                      )}
                    </td>
                    <td className="py-3 px-4 max-w-xs break-words">{exc.reason}</td>
                    <td className="py-3 px-4 text-center font-mono font-bold text-amber-300">
                      {Number(exc.maxVariancePc ?? 0).toFixed(2)}%
                    </td>
                    <td className="py-3 px-4 text-center whitespace-nowrap">{statusBadge(exc)}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{renderDeciderInfo(exc)}</td>
                    <td className="py-3 px-4 max-w-xs break-words text-slate-300">
                      {exc.decisionReason || <span className="text-slate-500">—</span>}
                    </td>
                    <td className="py-3 px-4 text-left whitespace-nowrap">
                      {canDecideException(exc) ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setDecisionReason('');
                              setDecisionModal({ mode: 'approve', exception: exc });
                            }}
                            disabled={submitting || actionLoading}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                          >
                            <Check className="w-3 h-3" />
                            <span>اعتماد</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDecisionReason('');
                              setDecisionModal({ mode: 'reject', exception: exc });
                            }}
                            disabled={submitting || actionLoading}
                            className="px-2.5 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                          >
                            <Ban className="w-3 h-3" />
                            <span>رفض</span>
                          </button>
                        </div>
                      ) : exc.status === 'pending' && !actionsBlockedBySync && isValidExceptionFingerprint(exc) && canApproveVariance && isRequesterSelf && isTrustedDraft && !hasQtyExceeded ? (
                        <span className="text-[10px] text-amber-400 font-semibold">فصل المهام (SoD)</span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Request Exception Modal (asks ONLY for reason) */}
      {showRequestModal && !actionsBlockedBySync && isTrustedDraft && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-amber-400" />
                <h4 className="font-bold text-white text-sm">طلب استثناء تباين السعر</h4>
              </div>
              <button
                type="button"
                onClick={() => setShowRequestModal(false)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-xl text-xs text-slate-300 flex flex-col gap-1">
              <div>
                فاتورة المورد: <span className="font-mono font-bold text-white">{invoice?.supplierInvoiceNo || matchReport.supplierInvoiceNo}</span>
              </div>
              <div>
                أقصى نسبة تباين سعر مسجلة:{' '}
                <span className="font-mono font-bold text-amber-400">{maxPriceVariancePct.toFixed(2)}%</span>
              </div>
            </div>

            <form onSubmit={handleRequestSubmit} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  سبب ومبرر طلب الاستثناء *
                </label>
                <textarea
                  required
                  rows={3}
                  placeholder="مثال: زيادة سعر الصرف / موافقة المورد على تعديل السعر المعتمد"
                  value={requestReason}
                  onChange={(e) => setRequestReason(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-amber-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowRequestModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={submitting || !requestReason.trim()}
                  className="px-5 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-amber-600/20 disabled:opacity-50 cursor-pointer"
                >
                  {submitting ? 'جاري الإرسال...' : 'إرسال طلب الاستثناء'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Approve / Reject Modal */}
      {decisionModal && !actionsBlockedBySync && isTrustedDraft && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                {decisionModal.mode === 'approve' ? (
                  <ShieldCheck className="w-5 h-5 text-emerald-400" />
                ) : (
                  <Ban className="w-5 h-5 text-rose-400" />
                )}
                <h4 className="font-bold text-white text-sm">
                  {decisionModal.mode === 'approve' ? 'اعتماد استثناء تباين السعر' : 'رفض استثناء تباين السعر'}
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setDecisionModal(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-xl text-xs text-slate-300 flex flex-col gap-1">
              <div>
                مقدم الطلب:{' '}
                <span className="font-bold text-white">
                  {decisionModal.exception.requestedByUsername || 'مستخدم النظام'}
                </span>
              </div>
              <div>سبب الطلب: {decisionModal.exception.reason}</div>
              <div>
                نسبة التباين:{' '}
                <span className="font-mono font-bold text-amber-400">
                  {Number(decisionModal.exception.maxVariancePc ?? 0).toFixed(2)}%
                </span>
              </div>
            </div>

            <form onSubmit={handleDecisionSubmit} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  {decisionModal.mode === 'reject' ? 'سبب الرفض *' : 'ملاحظات / سبب الاعتماد (اختياري)'}
                </label>
                <textarea
                  required={decisionModal.mode === 'reject'}
                  rows={3}
                  placeholder={
                    decisionModal.mode === 'reject'
                      ? 'اكتب سبب رفض طلب الاستثناء...'
                      : 'مثال: معتمد بناءً على موافقة الإدارة المالية'
                  }
                  value={decisionReason}
                  onChange={(e) => setDecisionReason(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-amber-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setDecisionModal(null)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={submitting || (decisionModal.mode === 'reject' && !decisionReason.trim())}
                  className={`px-5 py-2 text-white rounded-xl text-xs font-bold shadow-lg disabled:opacity-50 cursor-pointer ${
                    decisionModal.mode === 'approve'
                      ? 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/20'
                      : 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/20'
                  }`}
                >
                  {submitting
                    ? 'جاري التنفيذ...'
                    : decisionModal.mode === 'approve'
                    ? 'تأكيد الاعتماد'
                    : 'تأكيد الرفض'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
