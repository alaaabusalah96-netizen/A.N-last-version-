import React, { useState, useEffect, useCallback } from 'react';
import { ClipboardList, Printer, RefreshCw, Plus, Save, Check, X } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface Props {
  companyId: string;
  userRole: string;
  permissions: string[];
}

interface Head {
  id: string;
  stocktakeNo: number;
  warehouseId: string;
  warehouseCode: string;
  warehouseNameAr: string;
  status: 'counting' | 'closed' | 'cancelled';
  countDate: string;
  memo: string | null;
  lineCount: number;
  countedCount: number;
}
interface Line {
  itemId: string;
  itemCode: string;
  itemNameAr: string;
  uom: string;
  systemQty: string;
  countedQty: string | null;
  varianceQty: string | null;
}
interface Detail extends Head {
  lines: Line[];
  summary: { uncounted: number; shortage: number; surplus: number; matched: number };
}

const STATUS_AR: Record<string, string> = { counting: 'قيد العدّ', closed: 'مغلق', cancelled: 'ملغي' };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Blind sheet: no system quantities, blank column for the handwritten count. System sheet: with quantities. */
export function buildStocktakeSheetHtml(d: Detail, blind: boolean): string {
  const rows = d.lines
    .map(
      (l, i) =>
        `<tr><td>${i + 1}</td><td>${esc(l.itemCode)}</td><td>${esc(l.itemNameAr)}</td><td>${esc(l.uom)}</td>` +
        (blind ? '' : `<td>${esc(l.systemQty)}</td>`) +
        `<td style="width:120px"></td></tr>`
    )
    .join('');
  const title = blind ? 'كشف جرد أعمى (بدون كميات النظام)' : 'كشف جرد بكميات النظام';
  return (
    `<html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>body{font-family:Tahoma,Arial,sans-serif;padding:16px}table{border-collapse:collapse;width:100%}` +
    `th,td{border:1px solid #333;padding:6px 8px;font-size:13px;text-align:right}th{background:#eee}</style></head><body>` +
    `<h2>${title}</h2><p>كشف رقم ${d.stocktakeNo} | المستودع: ${esc(d.warehouseNameAr)} (${esc(d.warehouseCode)}) | تاريخ الجرد: ${esc(d.countDate)}</p>` +
    `<table><thead><tr><th>#</th><th>الكود</th><th>الصنف</th><th>الوحدة</th>${blind ? '' : '<th>كمية النظام</th>'}<th>الكمية المعدودة</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    `<p style="margin-top:32px">اسم العادّ: ____________ التوقيع: ____________ المراجع: ____________</p></body></html>`
  );
}

function printHtml(html: string) {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

export const StocktakePanel: React.FC<Props> = ({ companyId, userRole, permissions }) => {
  const isAdmin = userRole === 'platform_admin' || userRole === 'company_admin';
  const canMove = isAdmin || permissions.includes('inventory:movement');
  const [heads, setHeads] = useState<Head[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; nameAr: string; code: string }[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [memo, setMemo] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    if (!companyId) return;
    try {
      const [r1, r2] = await Promise.all([
        apiFetch(`/api/inventory/stocktakes?companyId=${companyId}`),
        apiFetch(`/api/inventory/warehouses?companyId=${companyId}`),
      ]);
      const d1 = await r1.json();
      const d2 = await r2.json();
      if (!r1.ok) throw new Error(d1.message || 'فشل تحميل كشوف الجرد');
      setHeads(d1.stocktakes || []);
      setWarehouses((d2.warehouses || []).filter((w: any) => w.isActive !== false));
    } catch (e: any) {
      setError(e.message);
    }
  }, [companyId]);

  useEffect(() => {
    setDetail(null);
    loadList();
  }, [loadList]);

  const open = async (id: string) => {
    setError('');
    const r = await apiFetch(`/api/inventory/stocktakes/${id}?companyId=${companyId}`);
    const d = await r.json();
    if (!r.ok) return setError(d.message || 'فشل فتح الكشف');
    setDetail(d.stocktake);
    setDraft({});
  };

  const act = async (fn: () => Promise<Response>, okMsg: string) => {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const r = await fn();
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error || 'فشلت العملية');
      setDetail(d.stocktake);
      setDraft({});
      setMsg(okMsg);
      await loadList();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const post = (path: string, body: object) =>
    apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId, ...body }) });

  const create = () =>
    act(() => post('/api/inventory/stocktakes', { warehouseId, memo }), 'تم إنشاء كشف الجرد من أرصدة المستودع');

  const saveCounts = () => {
    if (!detail) return;
    const counts = Object.entries(draft).map(([itemId, v]) => ({ itemId, countedQty: v.trim() === '' ? null : Number(v) }));
    if (counts.length === 0) return setError('لا توجد تعديلات للحفظ');
    if (counts.some((c) => c.countedQty !== null && (!Number.isFinite(c.countedQty) || c.countedQty < 0))) {
      return setError('الكمية المعدودة يجب أن تكون رقماً غير سالب');
    }
    act(
      () =>
        apiFetch(`/api/inventory/stocktakes/${detail.id}/counts`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companyId, counts }),
        }),
      'تم حفظ الكميات المعدودة (لا ترحيل للمخزون أو القيود)'
    );
  };

  const editable = !!detail && detail.status === 'counting' && canMove;

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center gap-2 text-white font-bold">
        <ClipboardList className="w-5 h-5" />
        <span>الجرد الفعلي للمستودعات</span>
        <button onClick={loadList} className="mr-auto text-slate-400 hover:text-white" title="تحديث">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
      <p className="text-xs text-slate-400">
        العدّ لا يرحّل أي حركة أو قيد. الفروقات تظهر هنا كتقرير فقط، وأي تسوية تتم من شاشة التسويات بصلاحيتها.
      </p>
      {error && <div className="p-3 rounded-xl bg-rose-500/10 text-rose-400 text-xs">{error}</div>}
      {msg && <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-400 text-xs">{msg}</div>}

      {canMove && (
        <div className="flex flex-wrap items-end gap-2 bg-slate-900 p-3 rounded-xl">
          <label className="text-xs text-slate-400">
            المستودع
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="block mt-1 bg-slate-800 text-white rounded-lg px-2 py-1">
              <option value="">اختر</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.nameAr} ({w.code})</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            ملاحظة
            <input value={memo} onChange={(e) => setMemo(e.target.value)} className="block mt-1 bg-slate-800 text-white rounded-lg px-2 py-1" />
          </label>
          <button disabled={!warehouseId || busy} onClick={create} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold disabled:opacity-40">
            <Plus className="w-4 h-4" /> كشف جرد جديد
          </button>
        </div>
      )}

      <table className="w-full text-xs text-slate-300">
        <thead>
          <tr className="text-slate-500"><th className="text-right">رقم</th><th className="text-right">المستودع</th><th className="text-right">التاريخ</th><th className="text-right">الحالة</th><th className="text-right">المعدود</th><th /></tr>
        </thead>
        <tbody>
          {heads.length === 0 && (<tr><td colSpan={6} className="py-3 text-slate-500">لا توجد كشوف جرد</td></tr>)}
          {heads.map((h) => (
            <tr key={h.id} className="border-t border-slate-800">
              <td>{h.stocktakeNo}</td><td>{h.warehouseNameAr}</td><td>{h.countDate}</td><td>{STATUS_AR[h.status]}</td>
              <td>{h.countedCount}/{h.lineCount}</td>
              <td><button onClick={() => open(h.id)} className="text-indigo-400 hover:text-indigo-300">فتح</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      {detail && (
        <div className="bg-slate-900 p-3 rounded-xl space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-white text-sm font-bold">
            <span>كشف {detail.stocktakeNo} - {detail.warehouseNameAr} - {STATUS_AR[detail.status]}</span>
            <button onClick={() => printHtml(buildStocktakeSheetHtml(detail, true))} className="mr-auto flex items-center gap-1 px-3 py-1 rounded-lg bg-slate-700 text-xs">
              <Printer className="w-4 h-4" /> طباعة الكشف الأعمى
            </button>
            <button onClick={() => printHtml(buildStocktakeSheetHtml(detail, false))} className="flex items-center gap-1 px-3 py-1 rounded-lg bg-slate-700 text-xs">
              <Printer className="w-4 h-4" /> طباعة كشف بكميات النظام
            </button>
          </div>
          <div className="text-xs text-slate-400">
            لم يُعدّ: {detail.summary.uncounted} | عجز: {detail.summary.shortage} | زيادة: {detail.summary.surplus} | مطابق: {detail.summary.matched}
          </div>
          <table className="w-full text-xs text-slate-300">
            <thead>
              <tr className="text-slate-500"><th className="text-right">الكود</th><th className="text-right">الصنف</th><th className="text-right">الوحدة</th><th className="text-right">كمية النظام</th><th className="text-right">المعدود</th><th className="text-right">الفرق</th></tr>
            </thead>
            <tbody>
              {detail.lines.map((l) => {
                const shown = draft[l.itemId] !== undefined ? draft[l.itemId] : l.countedQty ?? '';
                const v = l.varianceQty === null ? null : Number(l.varianceQty);
                return (
                  <tr key={l.itemId} className="border-t border-slate-800">
                    <td>{l.itemCode}</td><td>{l.itemNameAr}</td><td>{l.uom}</td><td>{l.systemQty}</td>
                    <td>
                      {editable ? (
                        <input type="number" min="0" value={shown} onChange={(e) => setDraft({ ...draft, [l.itemId]: e.target.value })} className="w-24 bg-slate-800 text-white rounded px-1" />
                      ) : (l.countedQty ?? '-')}
                    </td>
                    <td className={v === null ? '' : v < 0 ? 'text-rose-400' : v > 0 ? 'text-amber-400' : 'text-emerald-400'}>
                      {v === null ? '-' : v < 0 ? `عجز ${Math.abs(v)}` : v > 0 ? `زيادة ${v}` : 'مطابق'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {editable && (
            <div className="flex gap-2">
              <button disabled={busy} onClick={saveCounts} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold"><Save className="w-4 h-4" /> حفظ الكميات</button>
              <button disabled={busy} onClick={() => act(() => post(`/api/inventory/stocktakes/${detail.id}/close`, {}), 'تم إغلاق كشف الجرد')} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold"><Check className="w-4 h-4" /> إغلاق الكشف</button>
              <button disabled={busy} onClick={() => act(() => post(`/api/inventory/stocktakes/${detail.id}/cancel`, {}), 'تم إلغاء كشف الجرد')} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-bold"><X className="w-4 h-4" /> إلغاء الكشف</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
