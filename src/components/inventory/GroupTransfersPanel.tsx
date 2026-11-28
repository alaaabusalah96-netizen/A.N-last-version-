import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface Props { companyId: string }
interface Partner { id: string; code: string; nameAr: string }
interface Wh { id: string; code: string; nameAr: string; isActive?: boolean }
interface Item { id: string; code: string; nameAr: string; uom?: string; isActive?: boolean }
interface Acc { id: string; code: string; nameAr: string; accountType: string; isPostable: boolean; isActive: boolean }
interface Row {
  id: string; transferNo: number; status: 'shipped' | 'received' | 'received_short'; direction: 'in' | 'out';
  reference: string; fromCompanyName: string; toCompanyName: string; fromCurrency: string; toCurrency: string; fxRate: number;
  shippedAt: string; lineCount: number; totalCost: number;
}
interface Line { id: string; itemCode: string; qtyShipped: number; unitCost: number; totalCost: number; qtyReceived: number | null; receivedUnitCost: number | null }
interface Detail extends Row { lines: Line[] }
interface DraftLine { itemId: string; qty: string }

const STATUS_AR: Record<Row['status'], string> = { shipped: 'في الطريق', received: 'تم الاستلام', received_short: 'استُلم بنقص' };
const MAX_LINES = 100;

async function call(path: string, method = 'GET', body?: unknown) {
  const res = await apiFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'تعذر تنفيذ العملية');
  return data;
}

export function GroupTransfersPanel({ companyId }: Props) {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [whs, setWhs] = useState<Wh[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [accts, setAccts] = useState<Acc[]>([]);
  const [map, setMap] = useState<{ receivableAccountId: string; payableAccountId: string }>({ receivableAccountId: '', payableAccountId: '' });
  const [rows, setRows] = useState<Row[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toCompany, setToCompany] = useState('');
  const [fromWh, setFromWh] = useState('');
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const [fx, setFx] = useState('');
  const [draft, setDraft] = useState<DraftLine[]>([{ itemId: '', qty: '' }]);
  const [recvWh, setRecvWh] = useState('');
  const [recvQty, setRecvQty] = useState<Record<string, string>>({});

  const q = encodeURIComponent(companyId);
  const loadAll = useCallback(async () => {
    if (!companyId) return;
    setError(null);
    try {
      const [p, w, i, a, m, l] = await Promise.all([
        call(`/api/group-transfers/partners?companyId=${q}`),
        call(`/api/inventory/warehouses?companyId=${q}`),
        call(`/api/inventory/items?companyId=${q}`),
        call(`/api/accounting/accounts?companyId=${q}`).catch(() => ({ accounts: [] })),
        call(`/api/group-transfers/accounts?companyId=${q}`).catch(() => ({ accounts: { receivableAccountId: null, payableAccountId: null } })),
        call(`/api/group-transfers?companyId=${q}`),
      ]);
      setPartners(p.partners || []); setWhs((w.warehouses || []).filter((x: Wh) => x.isActive !== false));
      setItems((i.items || []).filter((x: Item) => x.isActive !== false)); setAccts(a.accounts || []);
      setMap({ receivableAccountId: m.accounts?.receivableAccountId || '', payableAccountId: m.accounts?.payableAccountId || '' });
      setRows(l.transfers || []);
    } catch (e: any) { setError(e.message); }
  }, [companyId, q]);
  useEffect(() => { setDetail(null); loadAll(); }, [loadAll]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); setNote(ok); await loadAll(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const open = async (id: string) => {
    setError(null);
    try { const d = (await call(`/api/group-transfers/${id}?companyId=${q}`)).transfer as Detail; setDetail(d); setRecvQty({}); } catch (e: any) { setError(e.message); }
  };

  const inputCls = 'px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500';
  const btnCls = 'flex items-center gap-1 px-3 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold cursor-pointer disabled:opacity-40';
  const card = 'bg-slate-900 border border-slate-800 rounded-2xl p-3 flex flex-col gap-2';
  const assets = accts.filter((a) => a.accountType === 'asset' && a.isPostable && a.isActive);
  const liabs = accts.filter((a) => a.accountType === 'liability' && a.isPostable && a.isActive);
  const validLines = draft.filter((l) => l.itemId && Number(l.qty) > 0);
  const tooMany = draft.length > MAX_LINES;

  const ship = () => act(async () => {
    await call('/api/group-transfers', 'POST', {
      companyId, toCompanyId: toCompany, fromWarehouseId: fromWh, reference, memo: memo || undefined,
      fxRate: fx ? Number(fx) : undefined, lines: validLines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })),
    });
    setReference(''); setMemo(''); setFx(''); setDraft([{ itemId: '', qty: '' }]);
  }, 'تم شحن التحويل وهو الآن في الطريق إلى الشركة المستلمة');

  return (
    <div className="flex flex-col gap-4" data-testid="gt-panel">
      {error && <div className="text-xs text-rose-400" role="alert" data-testid="gt-error">{error}</div>}
      {note && <div className="text-xs text-emerald-400" data-testid="gt-note">{note}</div>}
      <div className="text-xs text-slate-400">تحويل بضاعة بين شركات المجموعة بالتكلفة. تظهر في الشركة المرسلة قيدًا (مدين ذمم المجموعة، دائن المخزون) وفي الشركة المستلمة عند الاستلام (مدين المخزون، دائن ذمم المجموعة).</div>

      <div className={card}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white">حسابات ذمم المجموعة لهذه الشركة</h3>
          <button onClick={loadAll} aria-label="تحديث" className="text-slate-400 cursor-pointer"><RefreshCw className="w-4 h-4" /></button>
        </div>
        <div className="grid md:grid-cols-3 gap-2">
          <select value={map.receivableAccountId} onChange={(e) => setMap({ ...map, receivableAccountId: e.target.value })} className={inputCls} data-testid="gt-acc-rec">
            <option value="">حساب ذمم المجموعة المدينة (أصول)</option>
            {assets.map((a) => <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>)}
          </select>
          <select value={map.payableAccountId} onChange={(e) => setMap({ ...map, payableAccountId: e.target.value })} className={inputCls} data-testid="gt-acc-pay">
            <option value="">حساب ذمم المجموعة الدائنة (التزامات)</option>
            {liabs.map((a) => <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>)}
          </select>
          <button disabled={busy} className={btnCls} data-testid="gt-acc-save"
            onClick={() => act(() => call('/api/group-transfers/accounts', 'PUT', { companyId, receivableAccountId: map.receivableAccountId || null, payableAccountId: map.payableAccountId || null }), 'تم حفظ الحسابات')}>حفظ الحسابات</button>
        </div>
      </div>

      <div className={card}>
        <h3 className="text-sm font-bold text-white">شحن تحويل إلى شركة أخرى في المجموعة</h3>
        {partners.length === 0 && <div className="text-xs text-amber-300" data-testid="gt-no-partners">هذه الشركة ليست في مجموعة نشطة أو لا توجد شركات أخرى فيها.</div>}
        <div className="grid md:grid-cols-4 gap-2">
          <select value={toCompany} onChange={(e) => setToCompany(e.target.value)} className={inputCls} data-testid="gt-to">
            <option value="">الشركة المستلمة</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.code} - {p.nameAr}</option>)}
          </select>
          <select value={fromWh} onChange={(e) => setFromWh(e.target.value)} className={inputCls} data-testid="gt-from-wh">
            <option value="">المستودع المرسل</option>
            {whs.map((w) => <option key={w.id} value={w.id}>{w.code} - {w.nameAr}</option>)}
          </select>
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="رقم مرجع التحويل (فريد)" className={inputCls} data-testid="gt-ref" />
          <input value={fx} onChange={(e) => setFx(e.target.value)} placeholder="سعر التحويل (عند اختلاف العملة)" className={inputCls} data-testid="gt-fx" />
        </div>
        <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="ملاحظات" className={inputCls} data-testid="gt-memo" />
        {draft.map((l, idx) => (
          <div key={idx} className="grid grid-cols-[1fr_120px_32px] gap-2" data-testid="gt-line">
            <select value={l.itemId} onChange={(e) => setDraft(draft.map((x, i) => (i === idx ? { ...x, itemId: e.target.value } : x)))} className={inputCls} data-testid="gt-line-item">
              <option value="">الصنف</option>
              {items.map((it) => <option key={it.id} value={it.id}>{it.code} - {it.nameAr}</option>)}
            </select>
            <input type="number" min="0" step="any" value={l.qty} onChange={(e) => setDraft(draft.map((x, i) => (i === idx ? { ...x, qty: e.target.value } : x)))} placeholder="الكمية" className={inputCls} data-testid="gt-line-qty" />
            <button onClick={() => setDraft(draft.length > 1 ? draft.filter((_, i) => i !== idx) : draft)} aria-label="حذف السطر" className="text-slate-400 cursor-pointer"><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <button onClick={() => setDraft([...draft, { itemId: '', qty: '' }])} disabled={draft.length >= MAX_LINES} className="flex items-center gap-1 text-xs text-slate-300 cursor-pointer disabled:opacity-40" data-testid="gt-add-line"><Plus className="w-4 h-4" /> سطر</button>
          <span className="text-[11px] text-slate-500">{draft.length} / {MAX_LINES}</span>
          <button disabled={busy || !toCompany || !fromWh || !reference.trim() || validLines.length === 0 || tooMany} onClick={ship} className={btnCls} data-testid="gt-ship">شحن التحويل</button>
        </div>
      </div>

      <div className={card}>
        <h3 className="text-sm font-bold text-white">التحويلات ({rows.length})</h3>
        {rows.length === 0 && <div className="text-xs text-slate-400" data-testid="gt-empty">لا توجد تحويلات</div>}
        {rows.map((r) => (
          <button key={r.id} onClick={() => open(r.id)} data-testid="gt-row"
            className="text-right text-xs px-3 py-2 rounded-xl bg-slate-950 text-slate-200 cursor-pointer flex flex-wrap gap-x-4 gap-y-1">
            <span>#{r.transferNo}</span><span>{r.direction === 'out' ? 'صادر إلى' : 'وارد من'} {r.direction === 'out' ? r.toCompanyName : r.fromCompanyName}</span>
            <span>{r.reference}</span><span data-testid="gt-row-status">{STATUS_AR[r.status]}</span><span>{r.lineCount} سطر</span><span>{r.totalCost} {r.fromCurrency}</span>
          </button>
        ))}
      </div>

      {detail && (
        <div className={card} data-testid="gt-detail">
          <div className="text-sm font-bold text-white">تحويل #{detail.transferNo} ({detail.reference}) - {STATUS_AR[detail.status]}</div>
          <div className="text-xs text-slate-400">{detail.fromCompanyName} إلى {detail.toCompanyName}. العملة {detail.fromCurrency} إلى {detail.toCurrency}، السعر {detail.fxRate}.</div>
          <table className="text-xs text-slate-200 w-full">
            <thead><tr className="text-slate-400"><th className="text-right">الصنف</th><th>المشحون</th><th>التكلفة</th><th>المستلم</th>{detail.direction === 'in' && detail.status === 'shipped' && <th>الكمية المستلمة</th>}</tr></thead>
            <tbody>
              {detail.lines.map((l) => (
                <tr key={l.id} data-testid="gt-detail-line">
                  <td>{l.itemCode}</td><td className="text-center">{l.qtyShipped}</td><td className="text-center">{l.totalCost}</td>
                  <td className="text-center" data-testid="gt-detail-received">{l.qtyReceived ?? '-'}</td>
                  {detail.direction === 'in' && detail.status === 'shipped' && (
                    <td><input type="number" min="0" step="any" value={recvQty[l.id] ?? String(l.qtyShipped)} onChange={(e) => setRecvQty({ ...recvQty, [l.id]: e.target.value })} className={inputCls + ' w-24'} data-testid="gt-recv-qty" /></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {detail.direction === 'in' && detail.status === 'shipped' && (
            <div className="flex items-center gap-2">
              <select value={recvWh} onChange={(e) => setRecvWh(e.target.value)} className={inputCls} data-testid="gt-recv-wh">
                <option value="">مستودع الاستلام</option>
                {whs.map((w) => <option key={w.id} value={w.id}>{w.code} - {w.nameAr}</option>)}
              </select>
              <button disabled={busy || !recvWh} className={btnCls} data-testid="gt-receive"
                onClick={() => act(async () => {
                  await call(`/api/group-transfers/${detail.id}/receive`, 'POST', { companyId, warehouseId: recvWh, lines: detail.lines.map((l) => ({ lineId: l.id, qtyReceived: Number(recvQty[l.id] ?? l.qtyShipped) })) });
                  await open(detail.id);
                }, 'تم الاستلام')}>تأكيد الاستلام</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
