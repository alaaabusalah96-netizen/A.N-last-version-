import React, { useState, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface MyTrip {
  id: string; tripNo: string; purpose: string; plannedStart: string; plannedEnd: string; status: string;
  odometerStart: number | null; odometerEnd: number | null; stops: Array<{ stopNo: number; placeName: string }>;
}
interface MyExpense { id: string; expenseNo: string; tripId: string | null; categoryId: string; expenseDate: string; amount: number; description: string; status: string; rejectReason: string | null }
interface Cat { id: string; nameAr: string }

const TRIP_AR: Record<string, string> = { dispatched: 'جاهزة للانطلاق', in_progress: 'جارية', completed: 'مكتملة' };
const EXP_AR: Record<string, string> = { draft: 'بانتظار الاعتماد', approved: 'معتمد', rejected: 'مرفوض', posted: 'مرحّل', reversed: 'معكوس' };
const money = (n: number) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (iso: string) => new Date(iso).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
const today = () => new Date().toISOString().slice(0, 10);

type Dialog = { kind: 'start' | 'complete'; trip: MyTrip } | { kind: 'expense'; trip: MyTrip } | null;

/** Driver portal: the logged-in driver sees only their own trips, starts and completes them with an odometer reading, and logs expenses as drafts. */
export function FleetDriverPortal({ companyId }: { companyId: string }) {
  const [trips, setTrips] = useState<MyTrip[]>([]);
  const [expenses, setExpenses] = useState<MyExpense[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [driverName, setDriverName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dlg, setDlg] = useState<Dialog>(null);
  const [f, setF] = useState<Record<string, string>>({});

  const q = `companyId=${encodeURIComponent(companyId)}`;
  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true); setError(null);
    try {
      const [pr, tr, er, cr] = await Promise.all([
        apiFetch(`/api/fleet/my/profile?${q}`), apiFetch(`/api/fleet/my/trips?${q}`), apiFetch(`/api/fleet/my/expenses?${q}`), apiFetch(`/api/fleet/my/expense-categories?${q}`),
      ]);
      const pd = await pr.json().catch(() => ({}));
      if (!pr.ok) { setDriverName(null); setTrips([]); setExpenses([]); throw new Error(pd.message || pd.error || 'حسابك غير مرتبط بسائق في هذه الشركة'); }
      setDriverName(pd.driver?.fullName || null);
      const td = await tr.json().catch(() => ({})); const ed = await er.json().catch(() => ({})); const cd = await cr.json().catch(() => ({}));
      if (!tr.ok) throw new Error(td.message || td.error || 'تعذر تحميل رحلاتك');
      setTrips(td.trips || []); setExpenses(ed.expenses || []); setCats(cd.categories || []);
    } catch (e) { setError(e instanceof Error ? e.message : 'حدث خطأ أثناء التحميل'); } finally { setLoading(false); }
  }, [companyId, q]);
  useEffect(() => { void load(); }, [load]);

  const send = async (url: string, body: Record<string, unknown>, fallback: string) => {
    const res = await apiFetch(url, { method: 'POST', body: JSON.stringify({ companyId, ...body }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || fallback);
  };
  const run = async () => {
    if (!dlg) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      if (dlg.kind === 'expense') {
        const amount = Number(f.amount);
        if (!f.categoryId) throw new Error('اختر فئة المصروف');
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');
        if (!f.description?.trim()) throw new Error('وصف المصروف مطلوب');
        await send(`/api/fleet/my/trips/${dlg.trip.id}/expenses`, { categoryId: f.categoryId, expenseDate: f.expenseDate || today(), amount, description: f.description.trim(), referenceNo: f.referenceNo || undefined }, 'تعذر تسجيل المصروف');
        setSuccess('تم تسجيل المصروف وهو بانتظار اعتماد المكتب');
      } else {
        const odo = Number(f.odometer);
        if (!f.odometer || !Number.isFinite(odo) || odo < 0) throw new Error('أدخل قراءة العداد');
        await send(`/api/fleet/my/trips/${dlg.trip.id}/${dlg.kind}`, dlg.kind === 'start' ? { odometerStart: odo } : { odometerEnd: odo }, 'تعذر تنفيذ العملية');
        setSuccess(dlg.kind === 'start' ? `بدأت الرحلة ${dlg.trip.tripNo}` : `انتهت الرحلة ${dlg.trip.tripNo}`);
      }
      setDlg(null); setF({}); await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'حدث خطأ'); } finally { setBusy(false); }
  };
  const open = (d: Dialog) => { setError(null); setSuccess(null); setF({ expenseDate: today() }); setDlg(d); };
  const inp = 'w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500';
  const tripNo = (id: string | null) => trips.find((t) => t.id === id)?.tripNo || '-';
  const catName = (id: string) => cats.find((c) => c.id === id)?.nameAr || '-';

  return (
    <div className="space-y-4" data-testid="fleet-driver-portal">
      {driverName && <p className="text-xs text-slate-400">السائق: <span className="text-white font-bold">{driverName}</span></p>}
      {error && <div role="alert" className="p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-xs text-red-300">{error}</div>}
      {success && <div className="p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">{success}</div>}
      {loading && <p className="text-xs text-slate-500">جار التحميل...</p>}

      <div className="space-y-3" data-testid="my-trips">
        {trips.length === 0 && !loading && !error && <p className="text-xs text-slate-500">لا توجد رحلات مسندة إليك حاليا</p>}
        {trips.map((t) => (
          <div key={t.id} data-testid="my-trip" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-emerald-400 text-xs">{t.tripNo}</span>
              <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-indigo-500/20 text-indigo-300">{TRIP_AR[t.status] || t.status}</span>
            </div>
            <p className="text-sm text-white">{t.purpose}</p>
            <p className="text-[11px] text-slate-400">من {fmt(t.plannedStart)} إلى {fmt(t.plannedEnd)}</p>
            {t.stops.length > 0 && <p className="text-[11px] text-slate-300">المحطات: {t.stops.map((s) => s.placeName).join(' ← ')}</p>}
            {(t.odometerStart !== null || t.odometerEnd !== null) && <p className="text-[11px] text-slate-400 font-mono tabular-nums">العداد: {t.odometerStart ?? '-'} إلى {t.odometerEnd ?? '-'}</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              {t.status === 'dispatched' && <button type="button" data-testid="my-trip-start" onClick={() => open({ kind: 'start', trip: t })} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold cursor-pointer">بدء الرحلة</button>}
              {t.status === 'in_progress' && <button type="button" data-testid="my-trip-complete" onClick={() => open({ kind: 'complete', trip: t })} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold cursor-pointer">إنهاء الرحلة</button>}
              <button type="button" data-testid="my-trip-expense" onClick={() => open({ kind: 'expense', trip: t })} className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-100 text-xs font-bold cursor-pointer">تسجيل مصروف</button>
            </div>
          </div>
        ))}
      </div>

      <div>
        <h4 className="text-xs font-bold text-slate-300 mb-2">مصروفاتي</h4>
        <ul className="text-xs text-slate-300 space-y-1" data-testid="my-expenses">
          {expenses.length === 0 ? <li className="text-slate-500">لا توجد مصروفات مسجلة</li> : expenses.map((x) => (
            <li key={x.id} className="flex flex-wrap gap-x-3">
              <span className="font-mono text-emerald-400">{x.expenseNo}</span><span>{tripNo(x.tripId)}</span><span>{catName(x.categoryId)}</span>
              <span className="font-mono tabular-nums">{money(x.amount)}</span><span>{EXP_AR[x.status] || x.status}</span>
              {x.status === 'rejected' && x.rejectReason && <span className="text-red-300">{x.rejectReason}</span>}
            </li>
          ))}
        </ul>
      </div>

      {dlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" data-testid="my-trip-dialog">
          <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-white text-sm">{dlg.kind === 'start' ? 'بدء الرحلة' : dlg.kind === 'complete' ? 'إنهاء الرحلة' : 'تسجيل مصروف'} - {dlg.trip.tripNo}</h4>
              <button type="button" aria-label="إغلاق" onClick={() => setDlg(null)} className="p-1.5 rounded-lg text-slate-400 hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            {dlg.kind !== 'expense' ? (
              <label className="block text-xs text-slate-300">{dlg.kind === 'start' ? 'قراءة العداد عند الانطلاق (كم) *' : 'قراءة العداد عند الوصول (كم) *'}
                <input type="number" min={0} step="0.1" inputMode="decimal" className={inp} value={f.odometer || ''} onChange={(e) => setF((p) => ({ ...p, odometer: e.target.value }))} data-testid="my-trip-odometer" /></label>
            ) : (
              <>
                <label className="block text-xs text-slate-300">الفئة *
                  <select className={inp} value={f.categoryId || ''} onChange={(e) => setF((p) => ({ ...p, categoryId: e.target.value }))} data-testid="my-expense-category"><option value="">-- اختر --</option>{cats.map((c) => (<option key={c.id} value={c.id}>{c.nameAr}</option>))}</select></label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-slate-300">المبلغ *<input type="number" min={0} step="0.01" className={inp} value={f.amount || ''} onChange={(e) => setF((p) => ({ ...p, amount: e.target.value }))} data-testid="my-expense-amount" /></label>
                  <label className="text-xs text-slate-300">التاريخ *<input type="date" className={inp} value={f.expenseDate || ''} onChange={(e) => setF((p) => ({ ...p, expenseDate: e.target.value }))} /></label>
                </div>
                <label className="block text-xs text-slate-300">الوصف *<input maxLength={300} className={inp} value={f.description || ''} onChange={(e) => setF((p) => ({ ...p, description: e.target.value }))} data-testid="my-expense-desc" /></label>
                <label className="block text-xs text-slate-300">رقم الإيصال<input maxLength={60} className={inp} value={f.referenceNo || ''} onChange={(e) => setF((p) => ({ ...p, referenceNo: e.target.value }))} /></label>
                <p className="text-[11px] text-slate-500">يُسجَّل كمسودة ويعتمده المكتب. لا يمكنك اعتماده أو ترحيله.</p>
              </>
            )}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void run()} data-testid="my-trip-confirm" className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl cursor-pointer">تأكيد</button>
              <button type="button" onClick={() => setDlg(null)} className="px-4 py-2 bg-slate-800 text-slate-200 text-xs rounded-xl cursor-pointer">تراجع</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
