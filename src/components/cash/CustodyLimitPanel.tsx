import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiClient.js';

interface PolicyView { id: string; employeeUserId: string | null; version: number; enabled: boolean; limitAmount: number | null; reason: string | null }
interface EmployeeOpt { userId: string; username: string }

/** سقف العهدة: افتراضي للشركة أو خاص بموظف. كل تغيير إصدار جديد، والتاريخ يبقى. الإعفاء = تعطيل صف الموظف. */
export function CustodyLimitPanel({ companyId, employees, canEdit }: { companyId: string; employees: EmployeeOpt[]; canEdit: boolean }) {
  const [policies, setPolicies] = useState<PolicyView[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [amount, setAmount] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    try {
      const res = await apiFetch(`/api/cash/custody-limit-policies?companyId=${encodeURIComponent(companyId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || 'تعذر تحميل سياسات السقف');
      setPolicies(data.policies || []);
    } catch (e) { setErr(e instanceof Error ? e.message : 'تعذر تحميل سياسات السقف'); }
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const res = await apiFetch('/api/cash/custody-limit-policies', {
        method: 'PUT',
        body: JSON.stringify({ companyId, employeeUserId: employeeId || null, enabled, limitAmount: amount.trim() === '' ? null : amount.trim(), reason: reason.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || 'تعذر حفظ السقف');
      setMsg('تم نشر إصدار جديد من السقف'); setAmount(''); setReason('');
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : 'تعذر حفظ السقف'); }
    setBusy(false);
  };
  const nameOf = (id: string | null) => (id === null ? 'افتراضي الشركة' : employees.find((e) => e.userId === id)?.username || id);

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 text-xs space-y-3" data-testid="custody-limit-panel">
      <div className="text-slate-200 font-bold">سقف العهدة لكل موظف (إجمالي المعلق والمعتمد والمفتوح)</div>
      <table className="w-full text-right">
        <thead><tr className="text-slate-400"><th>النطاق</th><th>الحالة</th><th>السقف</th><th>إصدار</th><th>السبب</th></tr></thead>
        <tbody>
          {policies.length === 0 && <tr><td colSpan={5} className="py-3 text-center text-slate-500">لا يوجد سقف منشور، لا قيد على العهد</td></tr>}
          {policies.map((p) => (
            <tr key={p.id} className="border-t border-slate-800 text-slate-200">
              <td>{nameOf(p.employeeUserId)}</td>
              <td>{p.enabled ? 'مفعّل' : (p.employeeUserId ? 'معفى' : 'معطّل')}</td>
              <td>{p.limitAmount === null ? '-' : p.limitAmount.toFixed(2)}</td>
              <td>{p.version}</td><td>{p.reason || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {canEdit ? (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2 items-end">
          <select aria-label="النطاق" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200">
            <option value="">افتراضي الشركة</option>
            {employees.map((e) => <option key={e.userId} value={e.userId}>{e.username}</option>)}
          </select>
          <input aria-label="السقف" inputMode="decimal" placeholder="السقف" value={amount} onChange={(e) => setAmount(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200" />
          <label className="flex items-center gap-1 text-slate-300"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{employeeId ? 'مفعّل (إلغاؤه يعفي الموظف)' : 'مفعّل'}</label>
          <input aria-label="السبب" placeholder="السبب (اختياري)" value={reason} onChange={(e) => setReason(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200" />
          <button type="button" disabled={busy} onClick={() => void save()} className="bg-indigo-600 hover:bg-indigo-500 text-white rounded px-3 py-1 font-bold disabled:opacity-50">نشر إصدار جديد</button>
        </div>
      ) : (
        <div className="text-slate-500">تعديل السقف يحتاج صلاحية إعدادات الشركة</div>
      )}
      {msg && <div className="text-emerald-300">{msg}</div>}
      {err && <div className="text-red-300">{err}</div>}
    </div>
  );
}
