import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Check, X, AlertCircle } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { getLocalTodayDateString } from '../../lib/calendarDate.js';

const MAX_LINES = 100;

interface Props {
  companyId: string;
  canWrite: boolean;
  canPost: boolean;
  invoices: any[];
  warehouses: Array<{ id: string; nameAr: string; code: string }>;
}

interface RetLineRowProps {
  idx: number;
  line: any;
  qty: string;
  onQty: (idx: number, v: string) => void;
}

const ReturnLineRow = React.memo(function ReturnLineRow({ idx, line, qty, onQty }: RetLineRowProps) {
  return (
    <div className="flex items-center gap-2" data-testid="return-line-row">
      <span className="w-8 text-[10px] text-slate-500 font-mono">{idx + 1}</span>
      <span className="flex-1 text-xs text-slate-200 truncate">
        {line.itemNameAr || line.itemCode || line.itemId}
      </span>
      <span className="w-24 text-[11px] text-slate-400 font-mono text-center">
        فاتورة: {Number(line.qty)}
      </span>
      <input
        type="number"
        min="0"
        step="any"
        value={qty}
        aria-label={`كمية المرتجع للسطر ${idx + 1}`}
        onChange={(e) => onQty(idx, e.target.value)}
        className="w-24 px-2 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono"
      />
    </div>
  );
});

const STATUS_AR: Record<string, string> = { draft: 'مسودة', posted: 'مرحّل بالـ GL', cancelled: 'ملغى' };

export function SalesReturnsPanel({ companyId, canWrite, canPost, invoices, warehouses }: Props) {
  const [returns, setReturns] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [invoiceId, setInvoiceId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [returnDate, setReturnDate] = useState(() => getLocalTodayDateString());
  const [reason, setReason] = useState('');
  const [invLines, setInvLines] = useState<any[]>([]);
  const [qtys, setQtys] = useState<string[]>([]);
  const [viewing, setViewing] = useState<any | null>(null);

  const postedInvoices = useMemo(() => invoices.filter((i) => i.status === 'posted'), [invoices]);

  const load = useCallback(async () => {
    if (!companyId) return;
    try {
      const res = await apiFetch(`/api/sales/returns?companyId=${encodeURIComponent(companyId)}`);
      if (res.ok) setReturns((await res.json()).returns || []);
      else setErr('تعذر تحميل المرتجعات');
    } catch (e: any) {
      setErr(e.message || 'تعذر تحميل المرتجعات');
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pickInvoice = async (id: string) => {
    setInvoiceId(id);
    setInvLines([]);
    setQtys([]);
    if (!id) return;
    try {
      const res = await apiFetch(`/api/sales/invoices/${id}?companyId=${encodeURIComponent(companyId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || 'تعذر تحميل بنود الفاتورة');
      const lines = data.invoice?.lines || [];
      setInvLines(lines);
      setQtys(lines.map(() => ''));
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const onQty = useCallback((idx: number, v: string) => {
    setQtys((prev) => {
      const next = prev.slice();
      next[idx] = v;
      return next;
    });
  }, []);

  const returnAll = () => setQtys(invLines.map((l) => String(Number(l.qty))));

  const chosen = qtys.filter((q) => Number(q) > 0).length;

  const submit = async () => {
    setErr(null);
    const inv = postedInvoices.find((i) => i.id === invoiceId);
    if (!inv) return setErr('اختر فاتورة مرحّلة');
    if (!warehouseId) return setErr('اختر المستودع');
    const lines = invLines
      .map((l, i) => ({ invoiceLineId: l.id, qty: Number(qtys[i]) }))
      .filter((l) => l.qty > 0);
    if (lines.length === 0) return setErr('أدخل كمية مرتجعة لسطر واحد على الأقل');
    if (lines.length > MAX_LINES) return setErr(`الحد الأقصى ${MAX_LINES} بند في المستند الواحد`);
    setBusy(true);
    try {
      const res = await apiFetch('/api/sales/returns', {
        method: 'POST',
        body: JSON.stringify({
          companyId,
          customerId: inv.customerId,
          invoiceId,
          warehouseId,
          returnDate,
          reason: reason || undefined,
          lines,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || 'فشل إنشاء المرتجع');
      setOk('تم إنشاء مرتجع المبيعات كمسودة');
      setShowModal(false);
      setInvoiceId('');
      setInvLines([]);
      setQtys([]);
      setReason('');
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, kind: 'post' | 'delete') => {
    setErr(null);
    setBusy(true);
    try {
      const res =
        kind === 'post'
          ? await apiFetch(`/api/sales/returns/${id}/post`, { method: 'POST', body: JSON.stringify({ companyId }) })
          : await apiFetch(`/api/sales/returns/${id}?companyId=${encodeURIComponent(companyId)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || 'فشلت العملية');
      setOk(kind === 'post' ? 'تم ترحيل المرتجع' : 'تم حذف المسودة');
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const openView = async (id: string) => {
    try {
      const res = await apiFetch(`/api/sales/returns/${id}?companyId=${encodeURIComponent(companyId)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) setViewing(data.return);
      else setErr('تعذر تحميل المرتجع');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div className="space-y-3" data-testid="sales-returns-panel">
      {canWrite && (
        <div className="flex justify-end">
          <button
            onClick={() => setShowModal(true)}
            className="px-3.5 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>مرتجع مبيعات جديد</span>
          </button>
        </div>
      )}
      {err && (
        <div className="flex items-center gap-2 p-3 bg-rose-950/60 border border-rose-800/80 rounded-xl text-rose-300 text-xs">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{err}</span>
          <button onClick={() => setErr(null)}><X className="w-4 h-4" /></button>
        </div>
      )}
      {ok && (
        <div className="flex items-center gap-2 p-3 bg-emerald-950/60 border border-emerald-800/80 rounded-xl text-emerald-300 text-xs">
          <Check className="w-4 h-4 shrink-0" />
          <span className="flex-1">{ok}</span>
          <button onClick={() => setOk(null)}><X className="w-4 h-4" /></button>
        </div>
      )}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">رقم المرتجع</th>
                <th className="py-3.5 px-4">العميل</th>
                <th className="py-3.5 px-4">الفاتورة</th>
                <th className="py-3.5 px-4 text-center">التاريخ</th>
                <th className="py-3.5 px-4 text-center">الإجمالي</th>
                <th className="py-3.5 px-4 text-center">الحالة</th>
                <th className="py-3.5 px-4 text-center">قيد اليومية</th>
                <th className="py-3.5 px-4 text-left">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {returns.length === 0 ? (
                <tr><td colSpan={8} className="py-12 text-center text-slate-500">لا توجد مرتجعات مبيعات حتى الآن.</td></tr>
              ) : (
                returns.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-800/30">
                    <td className="py-3.5 px-4 font-mono font-bold text-white">{r.returnNo || r.id.slice(0, 8)}</td>
                    <td className="py-3.5 px-4">{r.customerNameAr || r.customerCode}</td>
                    <td className="py-3.5 px-4 font-mono text-blue-400">{r.invoiceNo || '—'}</td>
                    <td className="py-3.5 px-4 text-center font-mono">{r.returnDate}</td>
                    <td className="py-3.5 px-4 text-center font-mono font-bold">{Number(r.totalAmount).toFixed(2)}</td>
                    <td className="py-3.5 px-4 text-center">{STATUS_AR[r.status] || r.status}</td>
                    <td className="py-3.5 px-4 text-center font-mono text-cyan-300">{r.journalEntryNo || '—'}</td>
                    <td className="py-3.5 px-4 text-left">
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => openView(r.id)} className="px-2.5 py-1 bg-slate-800 text-slate-200 rounded-lg text-[11px] font-bold cursor-pointer">البنود</button>
                        {r.status === 'draft' && canPost && (
                          <button disabled={busy} onClick={() => act(r.id, 'post')} className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[11px] font-bold cursor-pointer">ترحيل للـ GL</button>
                        )}
                        {r.status === 'draft' && canWrite && (
                          <button disabled={busy} onClick={() => act(r.id, 'delete')} className="px-2.5 py-1 bg-rose-950/60 text-rose-300 border border-rose-800/60 rounded-lg text-[11px] font-bold cursor-pointer">حذف</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" role="dialog">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">بنود المرتجع {viewing.returnNo || ''} ({(viewing.lines || []).length})</h3>
              <button onClick={() => setViewing(null)}><X className="w-4 h-4 text-slate-400" /></button>
            </div>
            <table className="w-full text-right text-xs text-slate-200">
              <thead><tr className="text-slate-400"><th className="py-2">#</th><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الضريبة</th><th>الإجمالي</th></tr></thead>
              <tbody>
                {(viewing.lines || []).map((l: any, i: number) => (
                  <tr key={l.id} className="border-t border-slate-800">
                    <td className="py-1.5 font-mono">{i + 1}</td>
                    <td>{l.itemNameAr || l.itemCode}</td>
                    <td className="font-mono">{Number(l.qty)}</td>
                    <td className="font-mono">{Number(l.unitPrice).toFixed(2)}</td>
                    <td className="font-mono">{Number(l.taxAmount).toFixed(2)}</td>
                    <td className="font-mono">{Number(l.lineTotal).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" role="dialog">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">مرتجع مبيعات جديد</h3>
              <button onClick={() => setShowModal(false)}><X className="w-4 h-4 text-slate-400" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <select aria-label="فاتورة المبيعات" value={invoiceId} onChange={(e) => void pickInvoice(e.target.value)} className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white">
                <option value="">اختر فاتورة مرحّلة</option>
                {postedInvoices.map((i) => (
                  <option key={i.id} value={i.id}>{i.invoiceNo || i.id.slice(0, 8)} - {i.customerNameAr || i.customerCode} - {Number(i.totalAmount).toFixed(2)}</option>
                ))}
              </select>
              <select aria-label="المستودع" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white">
                <option value="">اختر المستودع</option>
                {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.nameAr} ({w.code})</option>))}
              </select>
              <input type="date" aria-label="تاريخ المرتجع" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white" />
              <input aria-label="سبب المرتجع" placeholder="سبب المرتجع" value={reason} onChange={(e) => setReason(e.target.value)} className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white" />
            </div>
            {invLines.length > 0 && (
              <>
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>بنود الفاتورة: {invLines.length} | بنود مختارة للإرجاع: {chosen} (الحد الأقصى {MAX_LINES})</span>
                  <button type="button" onClick={returnAll} className="px-2.5 py-1 bg-slate-800 text-slate-200 rounded-lg cursor-pointer">إرجاع الكميات كاملة</button>
                </div>
                <div className="space-y-1.5 max-h-[45vh] overflow-y-auto">
                  {invLines.map((l, i) => (
                    <ReturnLineRow key={l.id} idx={i} line={l} qty={qtys[i] ?? ''} onQty={onQty} />
                  ))}
                </div>
              </>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowModal(false)} className="px-3 py-2 text-slate-300 text-xs cursor-pointer">إلغاء</button>
              <button disabled={busy || chosen === 0} onClick={submit} className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white rounded-xl text-xs font-bold cursor-pointer">حفظ كمسودة</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
