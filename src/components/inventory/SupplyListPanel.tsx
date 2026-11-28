import React, { useState, useCallback } from 'react';
import { Printer, RefreshCw } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface Props {
  companyId: string;
}
interface Row {
  movementId: string;
  receivedDate: string;
  itemCode: string;
  itemNameAr: string;
  uom: string;
  warehouseNameAr: string;
  qty: string;
  expiryDate: string | null;
  expiryLabel: string;
  status: 'expired' | 'valid' | 'none';
}
interface Report {
  from: string | null;
  to: string | null;
  asOf: string;
  rows: Row[];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STATUS_AR: Record<Row['status'], string> = { expired: 'منتهي', valid: 'ساري', none: '-' };

export function buildSupplyListHtml(r: Report): string {
  const body = r.rows
    .map(
      (x) =>
        `<tr><td>${esc(x.receivedDate)}</td><td>${esc(x.itemCode)}</td><td>${esc(x.itemNameAr)}</td><td>${esc(x.warehouseNameAr)}</td><td>${esc(x.qty)} ${esc(x.uom)}</td><td>${esc(x.expiryLabel)}</td><td>${STATUS_AR[x.status]}</td></tr>`
    )
    .join('');
  return `<html dir="rtl"><head><meta charset="utf-8"><title>قائمة التوريد والصلاحية</title><style>body{font-family:Arial;padding:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #444;padding:4px 6px;font-size:12px}</style></head><body><h3>قائمة التوريد وتواريخ الصلاحية</h3><table><thead><tr><th>تاريخ التوريد</th><th>كود الصنف</th><th>الصنف</th><th>المستودع</th><th>الكمية</th><th>تاريخ الصلاحية</th><th>الحالة</th></tr></thead><tbody>${body}</tbody></table></body></html>`;
}

export function SupplyListPanel({ companyId }: Props) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expiringBy, setExpiringBy] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ companyId });
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      if (expiringBy) q.set('expiringBy', expiringBy);
      const res = await apiFetch(`/api/inventory/reports/supply-list?${q.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر تحميل القائمة');
      setReport(data.report);
    } catch (e: any) {
      setError(e.message || 'تعذر تحميل القائمة');
    } finally {
      setLoading(false);
    }
  }, [companyId, from, to, expiringBy]);

  const print = () => {
    if (!report) return;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(buildSupplyListHtml(report));
    w.document.close();
    w.print();
  };

  const inputCls = 'px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500';
  return (
    <div className="flex flex-col gap-3" data-testid="supply-panel">
      <div className="flex flex-wrap items-end gap-3 bg-slate-900 border border-slate-800 rounded-2xl p-3">
        <div>
          <label className="block text-xs text-slate-300 mb-1">من تاريخ توريد</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} data-testid="sup-from" />
        </div>
        <div>
          <label className="block text-xs text-slate-300 mb-1">إلى تاريخ توريد</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} data-testid="sup-to" />
        </div>
        <div>
          <label className="block text-xs text-slate-300 mb-1">تنتهي صلاحيته حتى</label>
          <input type="date" value={expiringBy} onChange={(e) => setExpiringBy(e.target.value)} className={inputCls} data-testid="sup-expiring" />
        </div>
        <button onClick={load} disabled={loading} className="flex items-center gap-1 px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold cursor-pointer" data-testid="sup-run">
          <RefreshCw className="w-4 h-4" /> عرض القائمة
        </button>
        <button onClick={print} disabled={!report || report.rows.length === 0} className="flex items-center gap-1 px-4 py-2 rounded-xl bg-slate-800 text-white text-xs font-bold cursor-pointer disabled:opacity-40" data-testid="sup-print">
          <Printer className="w-4 h-4" /> طباعة
        </button>
      </div>
      {error && <div className="text-xs text-rose-400" role="alert">{error}</div>}
      {report && (
        <div className="overflow-x-auto bg-slate-900 border border-slate-800 rounded-2xl">
          <table className="w-full text-xs text-right text-slate-200">
            <thead>
              <tr className="text-slate-400">
                <th className="p-2">تاريخ التوريد</th><th className="p-2">كود الصنف</th><th className="p-2">الصنف</th>
                <th className="p-2">المستودع</th><th className="p-2">الكمية</th><th className="p-2">تاريخ الصلاحية</th><th className="p-2">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 && (
                <tr><td colSpan={7} className="p-4 text-center text-slate-400" data-testid="sup-empty">لا توجد توريدات في هذه الفترة</td></tr>
              )}
              {report.rows.map((x) => (
                <tr key={x.movementId} className="border-t border-slate-800" data-testid="sup-row">
                  <td className="p-2">{x.receivedDate}</td><td className="p-2">{x.itemCode}</td><td className="p-2">{x.itemNameAr}</td>
                  <td className="p-2">{x.warehouseNameAr}</td><td className="p-2">{x.qty} {x.uom}</td>
                  <td className={`p-2 ${x.status === 'expired' ? 'text-rose-400' : ''}`} data-testid="sup-expiry">{x.expiryLabel}</td>
                  <td className="p-2">{STATUS_AR[x.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
