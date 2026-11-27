import React, { useState, useEffect, useCallback } from 'react';
import { Plus, X } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import type { TripVehicle } from './FleetTripsPanel.js';

export const MAINTENANCE_KIND_AR: Record<string, string> = { service: 'صيانة دورية', repair: 'إصلاح', inspection: 'فحص', tires: 'إطارات', insurance: 'تأمين', license: 'رخصة', other: 'أخرى' };
const STATE_AR: Record<string, string> = { overdue: 'متأخر', due_soon: 'قريب الاستحقاق', ok: 'سليم' };
const STATE_BADGE: Record<string, string> = { overdue: 'bg-red-500/20 text-red-300', due_soon: 'bg-amber-500/20 text-amber-300', ok: 'bg-emerald-500/20 text-emerald-300' };
const money = (n: number) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface DueItem { id: string; vehicleId: string; kind: string; code: string; plateNo: string; nextDueDate: string | null; nextDueKm: number | null; vehicleKm: number; state: string }
interface Rec { id: string; kind: string; performedOn: string; odometerKm: number | null; cost: number; vendor: string | null; notes: string | null; nextDueDate: string | null; nextDueKm: number | null; status: string; voidReason: string | null }
interface Props { companyId: string; vehicles: TripVehicle[]; can: (perm: string) => boolean }

export function FleetMaintenancePanel({ companyId, vehicles, can }: Props) {
  const [due, setDue] = useState<DueItem[]>([]);
  const [soonDays, setSoonDays] = useState('30');
  const [soonKm, setSoonKm] = useState('1000');
  const [vehicleId, setVehicleId] = useState('');
  const [records, setRecords] = useState<Rec[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [f, setF] = useState<Record<string, string>>({ kind: 'service' });
  const [voiding, setVoiding] = useState<Rec | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const canManage = can('fleet:manage');
  const q = `companyId=${encodeURIComponent(companyId)}`;

  const loadDue = useCallback(async () => {
    if (!companyId) return;
    try {
      const res = await apiFetch(`/api/fleet/maintenance/due?${q}&soonDays=${encodeURIComponent(soonDays || '30')}&soonKm=${encodeURIComponent(soonKm || '1000')}`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message || d.error || 'تعذر تحميل الاستحقاقات');
      setDue(d.items || []);
    } catch (e) { setError(e instanceof Error ? e.message : 'حدث خطأ أثناء التحميل'); }
  }, [companyId, soonDays, soonKm, q]);
  const loadRecords = useCallback(async () => {
    if (!companyId || !vehicleId) { setRecords([]); return; }
    try {
      const res = await apiFetch(`/api/fleet/vehicles/${vehicleId}/maintenance?${q}`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message || d.error || 'تعذر تحميل السجلات');
      setRecords(d.records || []);
    } catch (e) { setError(e instanceof Error ? e.message : 'حدث خطأ أثناء التحميل'); }
  }, [companyId, vehicleId, q]);
  useEffect(() => { void loadDue(); }, [loadDue]);
  useEffect(() => { void loadRecords(); }, [loadRecords]);

  const send = async (url: string, body: Record<string, unknown>, fallback: string) => {
    const res = await apiFetch(url, { method: 'POST', body: JSON.stringify({ companyId, ...body }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.message || d.error || fallback);
    return d;
  };
  const num = (s: string | undefined) => (s && s.trim() !== '' ? Number(s) : undefined);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage || !vehicleId) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      await send(`/api/fleet/vehicles/${vehicleId}/maintenance`, { kind: f.kind, performedOn: f.performedOn, odometerKm: num(f.odometerKm), cost: num(f.cost), vendor: f.vendor || undefined,
        notes: f.notes || undefined, nextDueDate: f.nextDueDate || undefined, nextDueKm: num(f.nextDueKm) }, 'تعذر حفظ السجل');
      setSuccess('تم حفظ السجل. التكلفة للمعلومية فقط؛ سجّل المصروف من تبويب المصروفات لترحيله محاسبياً.');
      setShowForm(false); setF({ kind: 'service' }); await Promise.all([loadRecords(), loadDue()]);
    } catch (err) { setError(err instanceof Error ? err.message : 'حدث خطأ أثناء الحفظ'); } finally { setBusy(false); }
  };
  const doVoid = async () => {
    if (!voiding) return;
    setBusy(true); setError(null);
    try { await send(`/api/fleet/maintenance/${voiding.id}/void`, { reason }, 'تعذر إلغاء السجل'); setVoiding(null); setReason(''); await Promise.all([loadRecords(), loadDue()]); }
    catch (err) { setError(err instanceof Error ? err.message : 'حدث خطأ'); } finally { setBusy(false); }
  };
  const vLabel = (id: string) => { const v = vehicles.find((x) => x.id === id); return v ? `${v.code} (${v.plateNo})` : '-'; };
  const input = 'bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white';

  return (
    <div className="space-y-4" data-testid="maintenance-panel">
      {error && <div role="alert" className="p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-xs text-red-300">{error}</div>}
      {success && <div className="p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">{success}</div>}

      <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-sm font-bold text-white">الاستحقاقات القادمة</h3>
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <label>نافذة الأيام <input aria-label="نافذة الأيام" type="number" min="0" className={`${input} w-20 mx-1`} value={soonDays} onChange={(e) => setSoonDays(e.target.value)} /></label>
            <label>نافذة الكيلومترات <input aria-label="نافذة الكيلومترات" type="number" min="0" className={`${input} w-24 mx-1`} value={soonKm} onChange={(e) => setSoonKm(e.target.value)} /></label>
          </div>
        </div>
        {due.length === 0 ? <p className="text-xs text-slate-400" data-testid="maintenance-due-empty">لا توجد استحقاقات مسجلة. أضف سجلاً مع تاريخ أو عداد الاستحقاق القادم.</p> : (
          <table className="w-full text-right text-xs"><thead><tr className="text-slate-400"><th className="py-2 px-2">المركبة</th><th className="px-2">النوع</th><th className="px-2">الاستحقاق (تاريخ)</th><th className="px-2">الاستحقاق (كم)</th><th className="px-2">العداد الحالي</th><th className="px-2">الحالة</th></tr></thead>
            <tbody>{due.map((d) => (
              <tr key={d.id} data-testid="maintenance-due-row" className="border-t border-slate-800 text-slate-200">
                <td className="py-2 px-2">{d.code} ({d.plateNo})</td><td className="px-2">{MAINTENANCE_KIND_AR[d.kind] || d.kind}</td>
                <td className="px-2 font-mono">{d.nextDueDate || '-'}</td><td className="px-2 font-mono">{d.nextDueKm ?? '-'}</td><td className="px-2 font-mono">{d.vehicleKm}</td>
                <td className="px-2"><span className={`px-2 py-0.5 rounded-full font-bold ${STATE_BADGE[d.state] || ''}`}>{STATE_AR[d.state] || d.state}</span></td>
              </tr>))}</tbody></table>)}
      </section>

      <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <select aria-label="المركبة" data-testid="maintenance-vehicle" className={input} value={vehicleId} onChange={(e) => { setVehicleId(e.target.value); setShowForm(false); }}>
            <option value="">اختر مركبة لعرض سجلها</option>
            {vehicles.map((v) => <option key={v.id} value={v.id}>{v.code} ({v.plateNo})</option>)}
          </select>
          {canManage && vehicleId && (
            <button type="button" data-testid="maintenance-add" onClick={() => setShowForm((s) => !s)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold cursor-pointer">
              {showForm ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}<span>{showForm ? 'إغلاق' : 'سجل جديد'}</span>
            </button>)}
        </div>

        {showForm && canManage && (
          <form onSubmit={create} className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs" data-testid="maintenance-form">
            <select aria-label="النوع" data-testid="maintenance-kind" className={input} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              {Object.entries(MAINTENANCE_KIND_AR).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <input aria-label="تاريخ التنفيذ" data-testid="maintenance-date" type="date" required className={input} value={f.performedOn || ''} onChange={(e) => setF({ ...f, performedOn: e.target.value })} />
            <input aria-label="قراءة العداد" data-testid="maintenance-odo" type="number" min="0" placeholder="قراءة العداد (كم)" className={input} value={f.odometerKm || ''} onChange={(e) => setF({ ...f, odometerKm: e.target.value })} />
            <input aria-label="التكلفة" data-testid="maintenance-cost" type="number" min="0" step="0.01" placeholder="التكلفة (للمعلومية)" className={input} value={f.cost || ''} onChange={(e) => setF({ ...f, cost: e.target.value })} />
            <input aria-label="الجهة" placeholder="الورشة / الجهة" className={input} value={f.vendor || ''} onChange={(e) => setF({ ...f, vendor: e.target.value })} />
            <input aria-label="الاستحقاق القادم (تاريخ)" data-testid="maintenance-next-date" type="date" className={input} value={f.nextDueDate || ''} onChange={(e) => setF({ ...f, nextDueDate: e.target.value })} />
            <input aria-label="الاستحقاق القادم (كم)" data-testid="maintenance-next-km" type="number" min="0" placeholder="العداد المستحق (كم)" className={input} value={f.nextDueKm || ''} onChange={(e) => setF({ ...f, nextDueKm: e.target.value })} />
            <input aria-label="ملاحظات" placeholder="ملاحظات" className={input} value={f.notes || ''} onChange={(e) => setF({ ...f, notes: e.target.value })} />
            <button type="submit" disabled={busy} data-testid="maintenance-save" className="col-span-2 md:col-span-4 px-3 py-2 rounded-lg bg-emerald-600 text-white font-bold cursor-pointer disabled:opacity-50">حفظ</button>
            <p className="col-span-2 md:col-span-4 text-slate-400">التكلفة هنا للمعلومية فقط ولا تُرحَّل. لترحيل المصروف سجّله في تبويب المصروفات.</p>
          </form>)}

        {vehicleId && (records.length === 0 ? <p className="text-xs text-slate-400">لا توجد سجلات لهذه المركبة.</p> : (
          <table className="w-full text-right text-xs" data-testid="maintenance-records"><thead><tr className="text-slate-400"><th className="py-2 px-2">التاريخ</th><th className="px-2">النوع</th><th className="px-2">العداد</th><th className="px-2">التكلفة</th><th className="px-2">الجهة</th><th className="px-2">الاستحقاق القادم</th><th className="px-2">الحالة</th><th /></tr></thead>
            <tbody>{records.map((r) => (
              <tr key={r.id} data-testid="maintenance-record" className={`border-t border-slate-800 ${r.status === 'voided' ? 'text-slate-500 line-through' : 'text-slate-200'}`}>
                <td className="py-2 px-2 font-mono">{r.performedOn}</td><td className="px-2">{MAINTENANCE_KIND_AR[r.kind] || r.kind}</td><td className="px-2 font-mono">{r.odometerKm ?? '-'}</td>
                <td className="px-2 font-mono">{money(r.cost)}</td><td className="px-2">{r.vendor || '-'}</td>
                <td className="px-2 font-mono">{[r.nextDueDate, r.nextDueKm !== null ? `${r.nextDueKm} كم` : null].filter(Boolean).join(' / ') || '-'}</td>
                <td className="px-2">{r.status === 'voided' ? `ملغى: ${r.voidReason}` : 'ساري'}</td>
                <td className="px-2">{canManage && r.status === 'active' && <button type="button" data-testid="maintenance-void" onClick={() => { setVoiding(r); setReason(''); }} className="text-red-300 cursor-pointer">إلغاء</button>}</td>
              </tr>))}</tbody></table>))}
        {voiding && (
          <div className="flex items-center gap-2 text-xs" data-testid="maintenance-void-box">
            <input aria-label="سبب الإلغاء" data-testid="maintenance-void-reason" placeholder={`سبب إلغاء سجل ${vLabel(vehicleId)}`} className={`${input} flex-1`} value={reason} onChange={(e) => setReason(e.target.value)} />
            <button type="button" disabled={busy} data-testid="maintenance-void-confirm" onClick={() => void doVoid()} className="px-3 py-2 rounded-lg bg-red-600 text-white font-bold cursor-pointer disabled:opacity-50">تأكيد الإلغاء</button>
            <button type="button" onClick={() => setVoiding(null)} className="px-3 py-2 rounded-lg bg-slate-800 text-slate-200 cursor-pointer">تراجع</button>
          </div>)}
      </section>
    </div>
  );
}
