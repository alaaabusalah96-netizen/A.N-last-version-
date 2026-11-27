import React, { useState, useEffect, useCallback } from 'react';
import { FleetTripTrack } from './FleetTripTrack.js';
import { Plus, X, MapPin, ChevronDown, ChevronUp } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

export interface TripVehicle { id: string; code: string; plateNo: string; odometerKm: number; status: string }
export interface TripDriver { id: string; fullName: string; status: string }
export interface TripUnit { id: string; code: string; nameAr: string }
interface Trip {
  id: string; tripNo: string; orgUnitId: string | null; vehicleId: string; driverId: string; purpose: string;
  plannedStart: string; plannedEnd: string; status: string; rejectReason: string | null; cancelReason: string | null;
  odometerStart: number | null; odometerEnd: number | null; notes: string | null; stops?: { stopNo: number; placeName: string }[];
}

export const TRIP_STATUS_AR: Record<string, string> = {
  draft: 'مسودة', approved: 'معتمدة', rejected: 'مرفوضة', dispatched: 'تم التكليف', in_progress: 'جارية', completed: 'مكتملة', cancelled: 'ملغاة',
};
const TRIP_BADGE: Record<string, string> = {
  draft: 'bg-slate-700 text-slate-200', approved: 'bg-sky-500/20 text-sky-300', rejected: 'bg-red-500/20 text-red-300',
  dispatched: 'bg-indigo-500/20 text-indigo-300', in_progress: 'bg-amber-500/20 text-amber-300', completed: 'bg-emerald-500/20 text-emerald-300', cancelled: 'bg-slate-800 text-slate-400',
};
type Action = 'approve' | 'reject' | 'dispatch' | 'start' | 'complete' | 'cancel';
const ACTION_AR: Record<Action, string> = { approve: 'اعتماد', reject: 'رفض', dispatch: 'تكليف السائق', start: 'بدء الرحلة', complete: 'إنهاء الرحلة', cancel: 'إلغاء' };

interface Props {
  companyId: string; vehicles: TripVehicle[]; drivers: TripDriver[]; units: TripUnit[];
  can: (perm: string) => boolean; onChanged?: () => void;
}

const fmt = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short', hour12: false }); };

export function FleetTripsPanel({ companyId, vehicles, drivers, units, can, onChanged }: Props) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});
  const [stops, setStops] = useState<string[]>(['', '']);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, Trip>>({});
  const [act, setAct] = useState<{ trip: Trip; action: Action } | null>(null);
  const [actVal, setActVal] = useState('');

  const canCreate = can('fleet:trip:create');
  const canApprove = can('fleet:trip:approve');
  const canDispatch = can('fleet:trip:dispatch');
  const canTrack = can('fleet:track:read');
  const vLabel = (id: string) => { const v = vehicles.find((x) => x.id === id); return v ? `${v.code} (${v.plateNo})` : '-'; };
  const dLabel = (id: string) => drivers.find((x) => x.id === id)?.fullName || '-';

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true); setError(null);
    try {
      const q = `companyId=${encodeURIComponent(companyId)}${filter ? `&status=${filter}` : ''}`;
      const res = await apiFetch(`/api/fleet/trips?${q}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر تحميل الرحلات');
      setTrips(data.trips || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'حدث خطأ أثناء تحميل الرحلات');
    } finally { setLoading(false); }
  }, [companyId, filter]);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (t: Trip) => {
    if (open === t.id) { setOpen(null); return; }
    setOpen(t.id);
    try {
      const res = await apiFetch(`/api/fleet/trips/${t.id}?companyId=${encodeURIComponent(companyId)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.trip) setDetail((p) => ({ ...p, [t.id]: data.trip }));
    } catch { /* detail stays empty */ }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const names = stops.map((s) => s.trim()).filter(Boolean);
      if (names.length < 2) throw new Error('الرحلة تحتاج محطتين على الأقل (نقطة الانطلاق ونقطة الوصول)');
      const s = new Date(f.plannedStart || ''); const en = new Date(f.plannedEnd || '');
      if (Number.isNaN(s.getTime()) || Number.isNaN(en.getTime())) throw new Error('حدد بداية ونهاية الرحلة');
      const body = { companyId, vehicleId: f.vehicleId, driverId: f.driverId, orgUnitId: f.orgUnitId || undefined, purpose: f.purpose,
        plannedStart: s.toISOString(), plannedEnd: en.toISOString(), notes: f.notes || undefined, stops: names.map((placeName) => ({ placeName })) };
      const res = await apiFetch('/api/fleet/trips', { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر حفظ الرحلة');
      setSuccess(`تم إنشاء الرحلة ${data.trip?.tripNo || ''} كمسودة بانتظار الاعتماد`);
      setShowForm(false); setF({}); setStops(['', '']);
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'حدث خطأ أثناء الحفظ'); } finally { setBusy(false); }
  };

  const needsValue = (a: Action) => a === 'reject' || a === 'cancel' || a === 'start' || a === 'complete';
  const openAction = (trip: Trip, action: Action) => {
    setError(null); setSuccess(null);
    const v = vehicles.find((x) => x.id === trip.vehicleId);
    setActVal(action === 'start' ? String(v?.odometerKm ?? '') : action === 'complete' ? String(trip.odometerStart ?? '') : '');
    setAct({ trip, action });
  };
  const runAction = async () => {
    if (!act) return;
    const { trip, action } = act;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const body: Record<string, unknown> = { companyId };
      if (action === 'reject' || action === 'cancel') {
        if (!actVal.trim()) throw new Error('السبب مطلوب');
        body.reason = actVal.trim();
      }
      if (action === 'start' || action === 'complete') {
        const n = Number(actVal);
        if (actVal.trim() === '' || !Number.isFinite(n) || n < 0) throw new Error('أدخل قراءة العداد بالكيلومتر');
        body[action === 'start' ? 'odometerStart' : 'odometerEnd'] = n;
      }
      const res = await apiFetch(`/api/fleet/trips/${trip.id}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر تنفيذ الإجراء');
      setSuccess(`تم: ${ACTION_AR[action]} (${trip.tripNo})`);
      setAct(null); setActVal('');
      await load(); onChanged?.();
    } catch (err) { setError(err instanceof Error ? err.message : 'حدث خطأ أثناء التنفيذ'); setAct(null); } finally { setBusy(false); }
  };

  const actionsFor = (t: Trip): Action[] => {
    const a: Action[] = [];
    if (t.status === 'draft' && canApprove) a.push('approve', 'reject');
    if (t.status === 'approved' && canDispatch) a.push('dispatch');
    if (t.status === 'dispatched' && canDispatch) a.push('start');
    if (t.status === 'in_progress' && canDispatch) a.push('complete');
    if (['draft', 'approved', 'dispatched'].includes(t.status) && canDispatch) a.push('cancel');
    return a;
  };
  const inp = 'w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500';
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const usableV = vehicles.filter((v) => v.status === 'active');
  const usableD = drivers.filter((d) => d.status === 'active');

  return (
    <div className="space-y-3" data-testid="fleet-trips">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="تصفية حسب حالة الرحلة"
          className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white cursor-pointer">
          <option value="">كل الحالات</option>
          {Object.entries(TRIP_STATUS_AR).map(([k, l]) => (<option key={k} value={k}>{l}</option>))}
        </select>
        {canCreate && (
          <button type="button" onClick={() => { setF({}); setStops(['', '']); setShowForm(true); setError(null); }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl cursor-pointer">
            <Plus className="w-3.5 h-3.5" /><span>رحلة جديدة</span>
          </button>
        )}
      </div>

      {error && <div role="alert" className="p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-xs text-red-300">{error}</div>}
      {success && <div className="p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">{success}</div>}

      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead><tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
              <th className="py-3.5 px-4">رقم الرحلة</th><th className="py-3.5 px-4">المركبة</th><th className="py-3.5 px-4">السائق</th>
              <th className="py-3.5 px-4">الغرض</th><th className="py-3.5 px-4">من</th><th className="py-3.5 px-4">إلى</th>
              <th className="py-3.5 px-4">الحالة</th><th className="py-3.5 px-4">الإجراءات</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {trips.length === 0 ? (
                <tr><td colSpan={8} className="py-12 text-center text-slate-500">{loading ? 'جاري التحميل...' : 'لا توجد رحلات'}</td></tr>
              ) : trips.map((t) => (
                <React.Fragment key={t.id}>
                  <tr data-testid="fleet-trip-row">
                    <td className="py-3.5 px-4 font-mono text-indigo-300">
                      <button type="button" onClick={() => void toggle(t)} aria-expanded={open === t.id} className="inline-flex items-center gap-1 cursor-pointer">
                        {open === t.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}<span>{t.tripNo}</span>
                      </button>
                    </td>
                    <td className="py-3.5 px-4">{vLabel(t.vehicleId)}</td>
                    <td className="py-3.5 px-4">{dLabel(t.driverId)}</td>
                    <td className="py-3.5 px-4 text-slate-300">{t.purpose}</td>
                    <td className="py-3.5 px-4 text-slate-300"><span dir="ltr" className="font-mono tabular-nums">{fmt(t.plannedStart)}</span></td>
                    <td className="py-3.5 px-4 text-slate-300"><span dir="ltr" className="font-mono tabular-nums">{fmt(t.plannedEnd)}</span></td>
                    <td className="py-3.5 px-4"><span className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${TRIP_BADGE[t.status] || ''}`}>{TRIP_STATUS_AR[t.status] || t.status}</span></td>
                    <td className="py-3.5 px-4">
                      <div className="flex flex-wrap gap-1.5">
                        {actionsFor(t).map((a) => (
                          <button key={a} type="button" disabled={busy} onClick={() => openAction(t, a)} data-testid={`trip-${a}`}
                            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer ${a === 'reject' || a === 'cancel' ? 'bg-red-500/15 text-red-300 hover:bg-red-500/25' : 'bg-emerald-600/80 text-white hover:bg-emerald-500'}`}>{ACTION_AR[a]}</button>
                        ))}
                      </div>
                    </td>
                  </tr>
                  {open === t.id && (
                    <tr data-testid="fleet-trip-detail"><td colSpan={8} className="py-3 px-6 bg-slate-950/50 text-slate-300">
                      <div className="flex flex-wrap gap-x-8 gap-y-2">
                        <div className="space-y-1">
                          <div className="text-slate-400">المحطات</div>
                          {(detail[t.id]?.stops || []).map((s) => (<div key={s.stopNo} className="flex items-center gap-1.5"><MapPin className="w-3 h-3 text-indigo-300" /><span>{s.stopNo}. {s.placeName}</span></div>))}
                        </div>
                        <div className="space-y-1">
                          {t.odometerStart != null && <div>عداد البداية: <span className="font-mono tabular-nums">{Number(t.odometerStart).toLocaleString('en-US')}</span> كم</div>}
                          {t.odometerEnd != null && <div>عداد النهاية: <span className="font-mono tabular-nums">{Number(t.odometerEnd).toLocaleString('en-US')}</span> كم</div>}
                          {t.rejectReason && <div className="text-red-300">سبب الرفض: {t.rejectReason}</div>}
                          {t.cancelReason && <div className="text-red-300">سبب الإلغاء: {t.cancelReason}</div>}
                          {t.notes && <div>ملاحظات: {t.notes}</div>}
                        </div>
                        {canTrack && ['in_progress', 'completed'].includes(t.status) && (
                          <div className="space-y-1"><div className="text-slate-400">المسار (GPS)</div><FleetTripTrack companyId={companyId} tripId={t.id} /></div>
                        )}
                      </div>
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && canCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="رحلة جديدة">
          <form onSubmit={create} className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-white text-sm">رحلة جديدة</h4>
              <button type="button" aria-label="إغلاق" onClick={() => setShowForm(false)} className="p-1.5 rounded-lg text-slate-400 hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-300">المركبة *
                <select required className={inp} value={f.vehicleId || ''} onChange={set('vehicleId')}>
                  <option value="">-- اختر --</option>{usableV.map((v) => (<option key={v.id} value={v.id}>{v.code} ({v.plateNo})</option>))}
                </select></label>
              <label className="text-xs text-slate-300">السائق *
                <select required className={inp} value={f.driverId || ''} onChange={set('driverId')}>
                  <option value="">-- اختر --</option>{usableD.map((d) => (<option key={d.id} value={d.id}>{d.fullName}</option>))}
                </select></label>
              <label className="text-xs text-slate-300">بداية الرحلة *<input required type="datetime-local" className={inp} value={f.plannedStart || ''} onChange={set('plannedStart')} /></label>
              <label className="text-xs text-slate-300">نهاية الرحلة *<input required type="datetime-local" className={inp} value={f.plannedEnd || ''} onChange={set('plannedEnd')} /></label>
            </div>
            <label className="block text-xs text-slate-300">غرض الرحلة *<input required maxLength={200} className={inp} value={f.purpose || ''} onChange={set('purpose')} /></label>
            <div className="space-y-2">
              <div className="text-xs text-slate-300">المحطات * (محطتان على الأقل)</div>
              {stops.map((s, i) => (
                <div key={i} className="flex gap-2">
                  <input aria-label={`المحطة ${i + 1}`} placeholder={i === 0 ? 'نقطة الانطلاق' : i === stops.length - 1 ? 'نقطة الوصول' : 'محطة وسطى'} className={inp} value={s}
                    onChange={(e) => setStops((p) => p.map((x, j) => (j === i ? e.target.value : x)))} />
                  {stops.length > 2 && (<button type="button" aria-label="حذف المحطة" onClick={() => setStops((p) => p.filter((_, j) => j !== i))} className="p-2 text-slate-400 hover:text-red-300 cursor-pointer"><X className="w-4 h-4" /></button>)}
                </div>
              ))}
              {stops.length < 10 && (<button type="button" onClick={() => setStops((p) => [...p, ''])} className="text-xs text-indigo-300 hover:text-indigo-200 cursor-pointer">+ إضافة محطة</button>)}
            </div>
            {units.length > 0 && (
              <label className="block text-xs text-slate-300">الوحدة التنظيمية
                <select className={inp} value={f.orgUnitId || ''} onChange={set('orgUnitId')}>
                  <option value="">-- على مستوى الشركة --</option>{units.map((u) => (<option key={u.id} value={u.id}>{u.nameAr} ({u.code})</option>))}
                </select></label>
            )}
            <label className="block text-xs text-slate-300">ملاحظات<textarea maxLength={500} rows={2} className={inp} value={f.notes || ''} onChange={set('notes')} /></label>
            <p className="text-[11px] text-slate-500">تُحفظ الرحلة كمسودة، ولا يعتمدها نفس منشئها.</p>
            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={busy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl cursor-pointer">{busy ? 'جاري الحفظ...' : 'حفظ كمسودة'}</button>
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 bg-slate-800 text-slate-200 text-xs rounded-xl cursor-pointer">إلغاء</button>
            </div>
          </form>
        </div>
      )}

      {act && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" data-testid="fleet-trip-confirm">
          <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <h4 className="font-bold text-white text-sm">{ACTION_AR[act.action]} - {act.trip.tripNo}</h4>
            {(act.action === 'reject' || act.action === 'cancel') && (
              <label className="block text-xs text-slate-300">السبب *<textarea rows={3} maxLength={300} className={inp} value={actVal} onChange={(e) => setActVal(e.target.value)} /></label>
            )}
            {(act.action === 'start' || act.action === 'complete') && (
              <label className="block text-xs text-slate-300">{act.action === 'start' ? 'قراءة العداد عند البدء (كم) *' : 'قراءة العداد عند الانتهاء (كم) *'}
                <input type="number" min="0" step="0.1" className={inp} value={actVal} onChange={(e) => setActVal(e.target.value)} /></label>
            )}
            {!needsValue(act.action) && <p className="text-xs text-slate-300">هل تريد تنفيذ هذا الإجراء؟ لا يمكن التراجع عنه بعد التنفيذ.</p>}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void runAction()} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl cursor-pointer">تأكيد</button>
              <button type="button" onClick={() => setAct(null)} className="px-4 py-2 bg-slate-800 text-slate-200 text-xs rounded-xl cursor-pointer">تراجع</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
