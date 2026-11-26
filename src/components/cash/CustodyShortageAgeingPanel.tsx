import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiClient.js';

interface AgeingRowView {
  employeeUserId: string; employeeUsername: string;
  b0_30: number; b31_60: number; b61_90: number; over90: number; total: number; claims: number; oldestDays: number;
}
const fmt = (n: number) => Number(n || 0).toFixed(2);

/** أعمار عجز العهد المستحق على الموظفين. قراءة فقط، ولا يرحّل شيئا. */
export function CustodyShortageAgeingPanel({ companyId }: { companyId: string }) {
  const [rows, setRows] = useState<AgeingRowView[]>([]);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    if (!companyId) return;
    setErr('');
    try {
      const res = await apiFetch(`/api/cash/reports/custody-shortage-ageing?companyId=${encodeURIComponent(companyId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || 'تعذر تحميل أعمار العجز');
      setRows(data.report?.rows || []);
      setTotal(data.report.total);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذر تحميل أعمار العجز');
    }
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 text-xs space-y-2" data-testid="shortage-ageing">
      <div className="flex items-center justify-between">
        <span className="text-slate-200 font-bold">أعمار عجز العهد المستحق على الموظفين</span>
        <span className="text-amber-300 font-bold" data-testid="shortage-ageing-total">{fmt(total)}</span>
      </div>
      {err && <div className="text-red-300">{err}</div>}
      <table className="w-full text-right">
        <thead><tr className="text-slate-400"><th>الموظف</th><th>0-30</th><th>31-60</th><th>61-90</th><th>أكثر من 90</th><th>الإجمالي</th><th>أقدم (يوم)</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7} className="py-3 text-center text-slate-500">لا يوجد عجز مستحق</td></tr>}
          {rows.map((r) => (
            <tr key={r.employeeUserId} className="border-t border-slate-800 text-slate-200">
              <td>{r.employeeUsername || r.employeeUserId}</td><td>{fmt(r.b0_30)}</td><td>{fmt(r.b31_60)}</td><td>{fmt(r.b61_90)}</td>
              <td className={r.over90 > 0 ? 'text-red-300' : ''}>{fmt(r.over90)}</td><td className="font-bold">{fmt(r.total)}</td><td>{r.oldestDays}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
