import React, { useState, useEffect, useCallback } from 'react';
import { Truck, UserRound, Plus, RefreshCw, Building2, X, Search, AlertTriangle } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface Company { id: string; code: string; nameAr: string }
interface OrgUnit { id: string; code: string; nameAr: string }
interface Vehicle {
  id: string; orgUnitId: string | null; code: string; plateNo: string; vehicleType: string;
  make: string | null; model: string | null; modelYear: number | null; odometerKm: number; status: string;
}
interface Driver {
  id: string; orgUnitId: string | null; userId: string | null; fullName: string; phone: string | null;
  licenseNo: string | null; licenseExpiry: string | null; status: string;
}

const VEHICLE_STATUS: Record<string, string> = { active: 'نشطة', maintenance: 'في الصيانة', out_of_service: 'خارج الخدمة', retired: 'مستبعدة' };
const DRIVER_STATUS: Record<string, string> = { active: 'نشط', suspended: 'موقوف', inactive: 'غير نشط' };

const VEHICLE_TYPE: Record<string, string> = { car: 'سيارة ملاكي', pickup: 'نصف نقل', van: 'ميكروباص / فان', truck: 'شاحنة', bus: 'أتوبيس', motorcycle: 'دراجة نارية', other: 'أخرى' };
const typeLabel = (t: string) => VEHICLE_TYPE[t] || t;
const fmtKm = (n: number) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const daysUntil = (iso: string, today: string) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);

interface FleetWorkspaceProps { userRole?: string; permissions?: string[] }

export function FleetWorkspace({ userRole, permissions = [] }: FleetWorkspaceProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [tab, setTab] = useState<'vehicles' | 'drivers'>('vehicles');
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<{ kind: 'vehicles' | 'drivers'; id: string; status: string; name: string; from: string } | null>(null);

  const can = useCallback(
    (perm: string): boolean => {
      if (userRole === 'platform_admin') return true;
      if (permissions.length === 0) return true;
      return permissions.includes(perm);
    },
    [userRole, permissions]
  );
  const canManage = can('fleet:manage');
  const unitLabel = (id: string | null) => { const u = units.find((x) => x.id === id); return u ? `${u.nameAr} (${u.code})` : 'مستوى الشركة'; };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await apiFetch('/api/companies');
        if (!r.ok) return;
        const d = await r.json();
        if (!alive) return;
        const list: Company[] = d.companies || [];
        setCompanies(list);
        if (list.length > 0) setCompanyId(list[0].id);
      } catch { /* shown empty */ }
    })();
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const q = `companyId=${encodeURIComponent(companyId)}`;
      const [v, d, u] = await Promise.all([
        apiFetch(`/api/fleet/vehicles?${q}`),
        apiFetch(`/api/fleet/drivers?${q}`),
        apiFetch(`/api/accounting/journals/org-units?${q}`),
      ]);
      const vd = await v.json().catch(() => ({}));
      const dd = await d.json().catch(() => ({}));
      if (!v.ok) throw new Error(vd.message || vd.error || 'تعذر تحميل المركبات');
      if (!d.ok) throw new Error(dd.message || dd.error || 'تعذر تحميل السائقين');
      setVehicles(vd.vehicles || []);
      setDrivers(dd.drivers || []);
      if (u.ok) {
        const ud = await u.json().catch(() => ({}));
        setUnits(((ud.units || ud.orgUnits || []) as any[]).filter((x) => x.isActive !== false));
      } else {
        setUnits([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'حدث خطأ أثناء تحميل بيانات الأسطول');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const body: Record<string, unknown> = { companyId, orgUnitId: f.orgUnitId || undefined };
      if (tab === 'vehicles') {
        Object.assign(body, { code: f.code, plateNo: f.plateNo, vehicleType: f.vehicleType || undefined, make: f.make || undefined, model: f.model || undefined,
          modelYear: f.modelYear ? Number(f.modelYear) : undefined, odometerKm: f.odometerKm ? Number(f.odometerKm) : undefined });
      } else {
        Object.assign(body, { fullName: f.fullName, phone: f.phone || undefined, licenseNo: f.licenseNo || undefined, licenseExpiry: f.licenseExpiry || undefined });
      }
      const res = await apiFetch(tab === 'vehicles' ? '/api/fleet/vehicles' : '/api/fleet/drivers', { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر الحفظ');
      setSuccess(tab === 'vehicles' ? 'تمت إضافة المركبة' : 'تمت إضافة السائق');
      setShowForm(false); setF({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حدث خطأ أثناء الحفظ');
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (kind: 'vehicles' | 'drivers', id: string, status: string) => {
    if (!canManage) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const res = await apiFetch(`/api/fleet/${kind}/${id}`, { method: 'PATCH', body: JSON.stringify({ companyId, status }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر تغيير الحالة');
      setSuccess('تم تغيير الحالة');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حدث خطأ أثناء تغيير الحالة');
    } finally {
      setBusy(false);
    }
  };

  const inp = 'w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500';
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const today = new Date().toISOString().slice(0, 10);
  const needle = q.trim().toLowerCase();
  const shownVehicles = vehicles.filter((v) => !needle || [v.code, v.plateNo, v.make, v.model].some((x) => (x || '').toLowerCase().includes(needle)));
  const shownDrivers = drivers.filter((d) => !needle || [d.fullName, d.phone, d.licenseNo].some((x) => (x || '').toLowerCase().includes(needle)));

  return (
    <div className="space-y-4" data-testid="fleet-workspace">
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center"><Truck className="w-5 h-5 text-indigo-300" /></div>
          <div>
            <h3 className="text-sm font-bold text-white">بيانات الأسطول</h3>
            <p className="text-xs text-slate-400">اختر الشركة ثم أضف أو راجع المركبات والسائقين</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Building2 className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} aria-label="الشركة"
              className="pr-8 pl-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white cursor-pointer">
              {companies.map((c) => (<option key={c.id} value={c.id}>{c.nameAr} ({c.code})</option>))}
            </select>
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث بالكود أو اللوحة أو الاسم" aria-label="بحث"
              className="pr-8 pl-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white w-52" />
          </div>
          <button type="button" onClick={() => void load()} title="تحديث البيانات" className="p-2 bg-slate-800 rounded-xl text-slate-300 hover:text-white cursor-pointer">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {canManage && (
            <button type="button" onClick={() => { setF({}); setShowForm(true); }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl cursor-pointer">
              <Plus className="w-3.5 h-3.5" /><span>{tab === 'vehicles' ? 'مركبة جديدة' : 'سائق جديد'}</span>
            </button>
          )}
        </div>
      </div>

      <div role="tablist" className="flex gap-2">
        {([['vehicles', 'المركبات', Truck], ['drivers', 'السائقون', UserRound]] as const).map(([k, label, Icon]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setShowForm(false); }}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-bold cursor-pointer ${tab === k ? 'bg-indigo-600 text-white' : 'bg-slate-900 text-slate-300 border border-slate-800'}`}>
            <Icon className="w-3.5 h-3.5" /><span>{label}</span>
          </button>
        ))}
      </div>

      {error && <div role="alert" className="p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-xs text-red-300">{error}</div>}
      {success && <div className="p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">{success}</div>}

      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          {tab === 'vehicles' ? (
            <table className="w-full text-right text-xs">
              <thead><tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">الكود</th><th className="py-3.5 px-4">اللوحة</th><th className="py-3.5 px-4">النوع</th><th className="py-3.5 px-4">الماركة</th><th className="py-3.5 px-4">الموديل</th><th className="py-3.5 px-4">سنة الصنع</th>
                <th className="py-3.5 px-4">الوحدة التنظيمية</th><th className="py-3.5 px-4">العداد (كم)</th><th className="py-3.5 px-4">الحالة</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {vehicles.length === 0 ? (
                  <tr><td colSpan={9} className="py-12 text-center text-slate-500">{loading ? 'جاري التحميل...' : vehicles.length === 0 ? 'لا توجد مركبات بعد' : 'لا نتائج مطابقة للبحث'}</td></tr>
                ) : shownVehicles.map((v) => (
                  <tr key={v.id} data-testid="fleet-vehicle-row">
                    <td className="py-3.5 px-4 font-mono text-indigo-300">{v.code}</td>
                    <td className="py-3.5 px-4"><bdi dir="ltr">{v.plateNo}</bdi></td>
                    <td className="py-3.5 px-4 text-slate-300">{typeLabel(v.vehicleType)}</td>
                    <td className="py-3.5 px-4 text-slate-300">{v.make || '-'}</td>
                    <td className="py-3.5 px-4 text-slate-300">{v.model || '-'}</td>
                    <td className="py-3.5 px-4 font-mono tabular-nums">{v.modelYear ?? '-'}</td>
                    <td className="py-3.5 px-4 text-slate-300">{unitLabel(v.orgUnitId)}</td>
                    <td className="py-3.5 px-4 font-mono tabular-nums">{fmtKm(v.odometerKm)}</td>
                    <td className="py-3.5 px-4">
                      {canManage && v.status !== 'retired' ? (
                        <select value={v.status} disabled={busy} onChange={(e) => setPending({ kind: 'vehicles', id: v.id, status: e.target.value, name: `${v.code} - ${v.plateNo}`, from: v.status })} aria-label="حالة المركبة"
                          className="px-2 py-1 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white cursor-pointer">
                          {Object.entries(VEHICLE_STATUS).map(([k, l]) => (<option key={k} value={k}>{l}</option>))}
                        </select>
                      ) : (<span>{VEHICLE_STATUS[v.status] || v.status}</span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-right text-xs">
              <thead><tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">الاسم</th><th className="py-3.5 px-4">الهاتف</th><th className="py-3.5 px-4">رقم الرخصة</th>
                <th className="py-3.5 px-4">انتهاء الرخصة</th><th className="py-3.5 px-4">الوحدة التنظيمية</th><th className="py-3.5 px-4">الحالة</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {drivers.length === 0 ? (
                  <tr><td colSpan={6} className="py-12 text-center text-slate-500">{loading ? 'جاري التحميل...' : drivers.length === 0 ? 'لا يوجد سائقون بعد' : 'لا نتائج مطابقة للبحث'}</td></tr>
                ) : shownDrivers.map((d) => {
                  const expired = !!d.licenseExpiry && d.licenseExpiry < today;
                  const left = d.licenseExpiry && !expired ? daysUntil(d.licenseExpiry, today) : null;
                  const soon = left !== null && left <= 30;
                  const noLicense = !d.licenseExpiry;
                  return (
                    <tr key={d.id} data-testid="fleet-driver-row">
                      <td className="py-3.5 px-4 font-medium text-white">{d.fullName}</td>
                      <td className="py-3.5 px-4 text-slate-300"><bdi dir="ltr">{d.phone || '-'}</bdi></td>
                      <td className="py-3.5 px-4 font-mono"><bdi dir="ltr">{d.licenseNo || '-'}</bdi></td>
                      <td className="py-3.5 px-4">
                        <bdi dir="ltr" className={`font-mono ${expired ? 'text-red-300' : ''}`}>{d.licenseExpiry || '-'}</bdi>
                        {expired && <span className="mr-2 px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/30">رخصة منتهية</span>}
                        {soon && <span className="mr-2 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">تنتهي خلال {left} يوم</span>}
                        {d.status === 'active' && (expired || noLicense) && (
                          <div className="mt-1 inline-flex items-center gap-1 text-amber-300"><AlertTriangle className="w-3 h-3" /><span>{expired ? 'نشط لكن لا يصلح للتكليف برحلة (الرخصة منتهية)' : 'نشط لكن لا يصلح للتكليف (لا يوجد تاريخ رخصة)'}</span></div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-slate-300">{unitLabel(d.orgUnitId)}</td>
                      <td className="py-3.5 px-4">
                        {canManage ? (
                          <select value={d.status} disabled={busy} onChange={(e) => setPending({ kind: 'drivers', id: d.id, status: e.target.value, name: d.fullName, from: d.status })} aria-label="حالة السائق"
                            className="px-2 py-1 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white cursor-pointer">
                            {Object.entries(DRIVER_STATUS).map(([k, l]) => (<option key={k} value={k}>{l}</option>))}
                          </select>
                        ) : (<span>{DRIVER_STATUS[d.status] || d.status}</span>)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showForm && canManage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <form onSubmit={submit} className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-white text-sm">{tab === 'vehicles' ? 'إضافة مركبة' : 'إضافة سائق'}</h4>
              <button type="button" onClick={() => setShowForm(false)} aria-label="إغلاق" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            {tab === 'vehicles' ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-slate-300">الكود *<input required className={inp} placeholder="مثال: VEH-003" value={f.code || ''} onChange={set('code')} /></label>
                  <label className="text-xs text-slate-300">رقم اللوحة *<input required className={inp} value={f.plateNo || ''} onChange={set('plateNo')} /></label>
                  <label className="text-xs text-slate-300">نوع المركبة
                    <select className={inp} value={f.vehicleType || 'car'} onChange={set('vehicleType')}>
                      {Object.entries(VEHICLE_TYPE).map(([k, l]) => (<option key={k} value={k}>{l}</option>))}
                    </select>
                  </label>
                  <span />
                  <label className="text-xs text-slate-300">الماركة<input className={inp} placeholder="مثال: تويوتا" value={f.make || ''} onChange={set('make')} /></label>
                  <label className="text-xs text-slate-300">الموديل<input className={inp} placeholder="مثال: هايلكس" value={f.model || ''} onChange={set('model')} /></label>
                  <label className="text-xs text-slate-300">سنة الصنع<input type="number" min="1950" max="2100" className={inp} placeholder="مثال: 2021" value={f.modelYear || ''} onChange={set('modelYear')} /></label>
                </div>
                <label className="block text-xs text-slate-300">قراءة العداد (كم)<input type="number" min="0" step="0.1" className={inp} value={f.odometerKm || ''} onChange={set('odometerKm')} /></label>
              </>
            ) : (
              <>
                <label className="block text-xs text-slate-300">الاسم *<input required className={inp} value={f.fullName || ''} onChange={set('fullName')} /></label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-slate-300">الهاتف<input className={inp} value={f.phone || ''} onChange={set('phone')} /></label>
                  <label className="text-xs text-slate-300">رقم الرخصة<input className={inp} value={f.licenseNo || ''} onChange={set('licenseNo')} /></label>
                </div>
                <label className="block text-xs text-slate-300">انتهاء الرخصة (مطلوب مع رقمها)<input type="date" className={inp} value={f.licenseExpiry || ''} onChange={set('licenseExpiry')} /></label>
              </>
            )}
            {units.length > 0 && (
              <label className="block text-xs text-slate-300">الوحدة التنظيمية
                <select className={inp} value={f.orgUnitId || ''} onChange={set('orgUnitId')}>
                  <option value="">-- على مستوى الشركة --</option>
                  {units.map((u) => (<option key={u.id} value={u.id}>{u.nameAr} ({u.code})</option>))}
                </select>
              </label>
            )}
            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={busy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl cursor-pointer">{busy ? 'جاري الحفظ...' : 'حفظ'}</button>
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 bg-slate-800 text-slate-200 text-xs rounded-xl cursor-pointer">إلغاء</button>
            </div>
          </form>
        </div>
      )}

      {pending && canManage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" data-testid="fleet-status-confirm">
          <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <h4 className="font-bold text-white text-sm">تأكيد تغيير الحالة</h4>
            <p className="text-xs text-slate-300">
              تغيير حالة <bdi dir="auto" className="font-bold text-white">{pending.name}</bdi> من «{(pending.kind === 'vehicles' ? VEHICLE_STATUS : DRIVER_STATUS)[pending.from] || pending.from}» إلى «{(pending.kind === 'vehicles' ? VEHICLE_STATUS : DRIVER_STATUS)[pending.status] || pending.status}».
            </p>
            {pending.kind === 'vehicles' && pending.status === 'retired' && (
              <p className="text-xs text-amber-300">المركبة المستبعدة لا يمكن إعادتها للخدمة لاحقا.</p>
            )}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={async () => { const p = pending; setPending(null); await changeStatus(p.kind, p.id, p.status); }}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl cursor-pointer">تأكيد</button>
              <button type="button" onClick={() => setPending(null)} className="px-4 py-2 bg-slate-800 text-slate-200 text-xs rounded-xl cursor-pointer">إلغاء</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
