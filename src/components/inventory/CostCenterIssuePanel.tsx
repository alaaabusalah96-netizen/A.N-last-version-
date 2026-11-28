import React, { useState, useCallback } from 'react';
import { Printer, RefreshCw } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface Props {
  companyId: string;
  costCenters: { id: string; code: string; nameAr: string }[];
}
interface Row {
  costCenterId: string;
  costCenterCode: string;
  costCenterNameAr: string;
  itemCode: string;
  itemNameAr: string;
  uom: string;
  issueCount: number;
  totalQty: string;
  totalCost: string;
}
interface Report {
  from: string | null;
  to: string | null;
  rows: Row[];
  totals: { totalQty: string; totalCost: string };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildCostCenterIssueHtml(r: Report): string {
  const body = r.rows
    .map(
      (x) =>
        `<tr><td>${esc(x.costCenterCode)} - ${esc(x.costCenterNameAr)}</td><td>${esc(x.itemCode)}</td><td>${esc(x.itemNameAr)}</td><td>${esc(x.uom)}</td><td>${x.issueCount}</td><td>${esc(x.totalQty)}</td><td>${esc(x.totalCost)}</td></tr>`
    )
    .join('');
  return `<html dir="rtl"><head><meta charset="utf-8"><title>تقرير الصرف لمراكز التكلفة</title><style>body{font-family:Arial;padding:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #444;padding:4px 6px;font-size:12px}</style></head><body><h3>تقرير الصرف لمراكز التكلفة</h3><p>من: ${esc(r.from || 'البداية')} إلى: ${esc(r.to || 'اليوم')}</p><table><thead><tr><th>مركز التكلفة</th><th>كود الصنف</th><th>الصنف</th><th>الوحدة</th><th>عدد الصرفات</th><th>الكمية</th><th>التكلفة</th></tr></thead><tbody>${body}<tr><th colspan="5">الإجمالي</th><th>${esc(r.totals.totalQty)}</th><th>${esc(r.totals.totalCost)}</th></tr></tbody></table></body></html>`;
}

export function CostCenterIssuePanel({ companyId, costCenters }: Props) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
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
      if (cc) q.set('costCenterId', cc);
      const res = await apiFetch(`/api/inventory/reports/cost-center-issues?${q.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر تحميل التقرير');
      setReport(data.report);
    } catch (e: any) {
      setError(e.message || 'تعذر تحميل التقرير');
    } finally {
      setLoading(false);
    }
  }, [companyId, from, to, cc]);

  const print = () => {
    if (!report) return;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(buildCostCenterIssueHtml(report));
    w.document.close();
    w.print();
  };

  const inputCls = 'px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500';
  return (
    <div className="flex flex-col gap-3" data-testid="cc-issue-panel">
      <div className="flex flex-wrap items-end gap-3 bg-slate-900 border border-slate-800 rounded-2xl p-3">
        <div>
          <label className="block text-xs text-slate-300 mb-1">من تاريخ</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} data-testid="cc-from" />
        </div>
        <div>
          <label className="block text-xs text-slate-300 mb-1">إلى تاريخ</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} data-testid="cc-to" />
        </div>
        <div>
          <label className="block text-xs text-slate-300 mb-1">مركز التكلفة</label>
          <select value={cc} onChange={(e) => setCc(e.target.value)} className={inputCls} data-testid="cc-select">
            <option value="">كل المراكز</option>
            {costCenters.map((c) => (
              <option key={c.id} value={c.id}>{c.nameAr} ({c.code})</option>
            ))}
          </select>
        </div>
        <button onClick={load} disabled={loading} className="flex items-center gap-1 px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold cursor-pointer" data-testid="cc-run">
          <RefreshCw className="w-4 h-4" /> عرض التقرير
        </button>
        <button onClick={print} disabled={!report || report.rows.length === 0} className="flex items-center gap-1 px-4 py-2 rounded-xl bg-slate-800 text-white text-xs font-bold cursor-pointer disabled:opacity-40" data-testid="cc-print">
          <Printer className="w-4 h-4" /> طباعة
        </button>
      </div>
      {error && <div className="text-xs text-rose-400" role="alert">{error}</div>}
      {report && (
        <div className="overflow-x-auto bg-slate-900 border border-slate-800 rounded-2xl">
          <table className="w-full text-xs text-right text-slate-200">
            <thead>
              <tr className="text-slate-400">
                <th className="p-2">مركز التكلفة</th><th className="p-2">كود الصنف</th><th className="p-2">الصنف</th>
                <th className="p-2">الوحدة</th><th className="p-2">عدد الصرفات</th><th className="p-2">الكمية</th><th className="p-2">التكلفة</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 && (
                <tr><td colSpan={7} className="p-4 text-center text-slate-400" data-testid="cc-empty">لا توجد صرفات لمراكز تكلفة في هذه الفترة</td></tr>
              )}
              {report.rows.map((x) => (
                <tr key={x.costCenterId + x.itemCode} className="border-t border-slate-800" data-testid="cc-row">
                  <td className="p-2">{x.costCenterNameAr} ({x.costCenterCode})</td>
                  <td className="p-2">{x.itemCode}</td><td className="p-2">{x.itemNameAr}</td><td className="p-2">{x.uom}</td>
                  <td className="p-2">{x.issueCount}</td><td className="p-2">{x.totalQty}</td><td className="p-2">{x.totalCost}</td>
                </tr>
              ))}
              {report.rows.length > 0 && (
                <tr className="border-t border-slate-700 font-bold" data-testid="cc-total">
                  <td className="p-2" colSpan={5}>الإجمالي</td><td className="p-2">{report.totals.totalQty}</td><td className="p-2">{report.totals.totalCost}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
