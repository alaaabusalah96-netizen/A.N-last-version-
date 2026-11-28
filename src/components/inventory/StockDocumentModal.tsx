import React, { useState, useEffect } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface WarehouseRef {
  id: string;
  code: string;
  nameAr: string;
}
interface ItemRef {
  id: string;
  code: string;
  nameAr: string;
}

type DocType = 'receipt' | 'issue' | 'adjustment' | 'transfer';

interface Line {
  itemId: string;
  qty: string;
  unitCost: string;
  expiryDate?: string;
  direction: 'increase' | 'decrease';
}

interface StockDocumentModalProps {
  companyId: string;
  warehouses: WarehouseRef[];
  items: ItemRef[];
  initialType?: DocType;
  onClose: () => void;
  onDone: (message: string) => void;
}

const TYPE_LABEL: Record<DocType, string> = {
  receipt: 'إذن استلام',
  issue: 'إذن صرف',
  adjustment: 'تسوية / جرد',
  transfer: 'إذن تحويل بين مستودعات',
};

const MAX_LINES = 100;
const emptyLine = (): Line => ({ itemId: '', qty: '', unitCost: '', direction: 'increase' });

const inputCls =
  'w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white focus:outline-none focus:border-indigo-500';

/**
 * Multi-line stock document: one header and many lines posted together (all or nothing) via POST /api/inventory/documents.
 * Lines can be typed one by one or pasted as "itemCode,qty[,unitCost]" rows (for example 100 lines at once).
 */
export function StockDocumentModal({ companyId, warehouses, items, initialType = 'issue', onClose, onDone }: StockDocumentModalProps) {
  const [docType, setDocType] = useState<DocType>(initialType);
  const [warehouseId, setWarehouseId] = useState('');
  const [destWarehouseId, setDestWarehouseId] = useState('');
  const [reason, setReason] = useState('');
  const [memo, setMemo] = useState('');
  const [costCenterId, setCostCenterId] = useState('');
  const [costCenters, setCostCenters] = useState<{ id: string; code: string; nameAr: string }[]>([]);
  useEffect(() => {
    apiFetch(`/api/inventory/cost-centers?companyId=${encodeURIComponent(companyId)}`)
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d.costCenters)) setCostCenters(d.costCenters); })
      .catch(() => {});
  }, [companyId]);
  const [costSource, setCostSource] = useState('APPROVED_VALUATION');
  const [adjustmentType, setAdjustmentType] = useState<'adjustment' | 'write_off' | 'damage' | 'internal_consumption'>('adjustment');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsCost = docType === 'receipt' || (docType === 'adjustment' && lines.some((l) => l.direction === 'increase'));

  const updateLine = (i: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const applyPaste = () => {
    const byCode = new Map(items.map((it) => [it.code.trim().toLowerCase(), it.id]));
    const parsed: Line[] = [];
    const unknown: string[] = [];
    pasteText.split(/\r?\n/).forEach((raw, idx) => {
      const row = raw.trim();
      if (!row) return;
      const [code, qty, cost, expiry] = row.split(/[,\t;]/).map((p) => p.trim());
      const id = byCode.get((code || '').toLowerCase());
      if (!id) {
        unknown.push(`السطر ${idx + 1}: كود الصنف غير معروف (${code || 'فارغ'})`);
        return;
      }
      parsed.push({ itemId: id, qty: qty || '', unitCost: cost || '', expiryDate: expiry || '', direction: 'increase' });
    });
    if (unknown.length > 0) {
      setError(unknown.slice(0, 5).join(' | ') + (unknown.length > 5 ? ` ... (+${unknown.length - 5})` : ''));
      return;
    }
    setError(null);
    setLines((prev) => [...prev.filter((l) => l.itemId || l.qty), ...parsed]);
    setPasteText('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const real = lines.filter((l) => l.itemId || l.qty);
    if (real.length === 0) {
      setError('أضف سطرا واحدا على الأقل');
      return;
    }
    const bad = real.findIndex((l) => !l.itemId || !(Number(l.qty) > 0));
    if (bad >= 0) {
      setError(`السطر ${bad + 1}: اختر الصنف وأدخل كمية أكبر من الصفر`);
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        companyId,
        docType,
        reason,
        memo: memo || undefined,
        lines: real.map((l) => ({
          itemId: l.itemId,
          qty: Number(l.qty),
          unitCost: l.unitCost !== '' ? Number(l.unitCost) : undefined,
          expiryDate: docType === 'receipt' && l.expiryDate ? l.expiryDate : undefined,
          direction: docType === 'adjustment' ? l.direction : undefined,
        })),
      };
      if (docType === 'transfer') {
        body.sourceWarehouseId = warehouseId;
        body.destWarehouseId = destWarehouseId;
      } else {
        body.warehouseId = warehouseId;
      }
      if (needsCost) body.costSource = costSource;
      if (docType === 'adjustment') body.adjustmentType = adjustmentType;
      if (docType === 'issue' && costCenterId) body.costCenterId = costCenterId;
      const large = real.length > 50;
      if (large) body.async = true;
      const res = await apiFetch('/api/inventory/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل ترحيل المستند');
      if (res.status === 202 && data.jobId) {
        // Large document: posted in the background, poll until it finishes (up to 10 minutes).
        try {
          sessionStorage.setItem('anerp.pendingStockDocJob', JSON.stringify({ jobId: data.jobId, companyId, label: TYPE_LABEL[docType] }));
        } catch { /* storage unavailable */ }
        const started = Date.now();
        while (Date.now() - started < 10 * 60 * 1000) {
          await new Promise((r) => setTimeout(r, 1500));
          const pr = await apiFetch(`/api/inventory/documents/jobs/${data.jobId}?companyId=${encodeURIComponent(companyId)}`);
          const pd = await pr.json();
          if (!pr.ok) throw new Error(pd.message || pd.error || 'تعذر قراءة حالة الترحيل');
          const job = pd.job;
          if (job?.status === 'done' && job.result) {
            try { sessionStorage.removeItem('anerp.pendingStockDocJob'); } catch { /* ignore */ }
            onDone(`تم ترحيل ${TYPE_LABEL[docType]} رقم ${job.result.docNo} بعدد ${job.result.lineCount} سطر`);
            return;
          }
          if (job?.status === 'failed') try { sessionStorage.removeItem('anerp.pendingStockDocJob'); } catch { /* ignore */ }
          if (job?.status === 'failed') throw new Error(job.errorMessage || 'فشل ترحيل المستند');
        }
        throw new Error('ما زال الترحيل جاريًا. لا تعد الإرسال، راجع الحركات بعد دقائق قبل أي محاولة أخرى.');
      }
      onDone(`تم ترحيل ${TYPE_LABEL[docType]} رقم ${data.docNo} بعدد ${data.lineCount} سطر`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء ترحيل المستند');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto shadow-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <h4 className="font-bold text-white text-sm">مستند مخزني متعدد الأسطر: {TYPE_LABEL[docType]}</h4>
          <button onClick={onClose} className="text-slate-400 hover:text-white" type="button">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">نوع المستند *</label>
              <select value={docType} onChange={(e) => setDocType(e.target.value as DocType)} className={inputCls}>
                {(Object.keys(TYPE_LABEL) as DocType[]).map((t) => (
                  <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                {docType === 'transfer' ? 'من مستودع *' : 'المستودع *'}
              </label>
              <select required value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={inputCls}>
                <option value="">-- اختر --</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.nameAr} ({w.code})</option>
                ))}
              </select>
            </div>
            {docType === 'transfer' && (
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">إلى مستودع *</label>
                <select required value={destWarehouseId} onChange={(e) => setDestWarehouseId(e.target.value)} className={inputCls}>
                  <option value="">-- اختر --</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>{w.nameAr} ({w.code})</option>
                  ))}
                </select>
              </div>
            )}
            {docType === 'adjustment' && (
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">نوع التسوية</label>
                <select value={adjustmentType} onChange={(e) => setAdjustmentType(e.target.value as typeof adjustmentType)} className={inputCls}>
                  <option value="adjustment">تسوية جرد</option>
                  <option value="write_off">شطب</option>
                  <option value="damage">إتلاف</option>
                  <option value="internal_consumption">استهلاك داخلي</option>
                </select>
              </div>
            )}
            {docType === 'issue' && (
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">مركز التكلفة (اختياري)</label>
                <select value={costCenterId} onChange={(e) => setCostCenterId(e.target.value)} className={inputCls} data-testid="doc-cost-center">
                  <option value="">-- بدون مركز تكلفة --</option>
                  {costCenters.map((c) => (
                    <option key={c.id} value={c.id}>{c.nameAr} ({c.code})</option>
                  ))}
                </select>
              </div>
            )}
            <div className={docType === 'transfer' ? 'md:col-span-2' : ''}>
              <label className="block text-xs font-semibold text-slate-300 mb-1">السبب {docType === 'transfer' ? '' : '*'}</label>
              <input required={docType !== 'transfer'} value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">ملاحظات</label>
              <input value={memo} onChange={(e) => setMemo(e.target.value)} className={inputCls} />
            </div>
            {needsCost && (
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">مصدر التكلفة *</label>
                <input required value={costSource} onChange={(e) => setCostSource(e.target.value)} className={inputCls} />
              </div>
            )}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-200">الأسطر ({lines.filter((l) => l.itemId || l.qty).length} / {MAX_LINES})</span>
            <button
              type="button"
              onClick={() => setLines((p) => (p.length >= MAX_LINES ? p : [...p, emptyLine()]))}
              disabled={lines.length >= MAX_LINES}
              title={lines.length >= MAX_LINES ? `الحد الأقصى ${MAX_LINES} سطر لكل مستند` : undefined}
              className="disabled:opacity-40 inline-flex items-center gap-1 px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg"
            >
              <Plus className="w-3.5 h-3.5" /> سطر
            </button>
          </div>
          <div className="overflow-x-auto max-h-80 overflow-y-auto border border-slate-800 rounded-xl">
            <table className="w-full text-xs text-right">
              <thead className="bg-slate-950 text-slate-400 sticky top-0">
                <tr>
                  <th className="p-2 w-10">#</th>
                  <th className="p-2">الصنف</th>
                  {docType === 'adjustment' && <th className="p-2 w-28">الاتجاه</th>}
                  <th className="p-2 w-28">الكمية</th>
                  {needsCost && <th className="p-2 w-28">تكلفة الوحدة</th>}
                  {docType === 'receipt' && <th className="p-2 w-36">تاريخ الصلاحية</th>}
                  <th className="p-2 w-10" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-t border-slate-800">
                    <td className="p-2 text-slate-400">{i + 1}</td>
                    <td className="p-2">
                      <select value={l.itemId} onChange={(e) => updateLine(i, { itemId: e.target.value })} className={inputCls}>
                        <option value="">-- اختر الصنف --</option>
                        {items.map((it) => (
                          <option key={it.id} value={it.id}>{it.code} - {it.nameAr}</option>
                        ))}
                      </select>
                    </td>
                    {docType === 'adjustment' && (
                      <td className="p-2">
                        <select value={l.direction} onChange={(e) => updateLine(i, { direction: e.target.value as Line['direction'] })} className={inputCls}>
                          <option value="increase">زيادة</option>
                          <option value="decrease">نقص</option>
                        </select>
                      </td>
                    )}
                    <td className="p-2">
                      <input type="number" step="any" min="0" value={l.qty} onChange={(e) => updateLine(i, { qty: e.target.value })} className={inputCls} />
                    </td>
                    {needsCost && (
                      <td className="p-2">
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={l.unitCost}
                          disabled={docType === 'adjustment' && l.direction === 'decrease'}
                          onChange={(e) => updateLine(i, { unitCost: e.target.value })}
                          className={inputCls}
                        />
                      </td>
                    )}
                    {docType === 'receipt' && (
                      <td className="p-2">
                        <input type="date" value={l.expiryDate || ''} data-testid={`line-expiry-${i}`} onChange={(e) => updateLine(i, { expiryDate: e.target.value })} className={inputCls} />
                      </td>
                    )}
                    <td className="p-2">
                      <button type="button" onClick={() => setLines((p) => (p.length > 1 ? p.filter((_, idx) => idx !== i) : [emptyLine()]))} className="text-rose-400 hover:text-rose-300">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-slate-300">لصق أسطر (كل سطر: كود الصنف، الكمية، تكلفة الوحدة اختياري)</label>
            <textarea
              rows={3}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={'ITEM-001,10,5.5\nITEM-002,4,3'}
              className={inputCls + ' font-mono'}
            />
            <button type="button" onClick={applyPaste} disabled={!pasteText.trim()} className="self-start px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded-lg disabled:opacity-50">
              إضافة الأسطر الملصوقة
            </button>
          </div>

          {error && <div className="p-3 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs">{error}</div>}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 bg-slate-800 text-white text-xs font-bold rounded-xl">إلغاء</button>
            <button type="submit" disabled={busy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl disabled:opacity-50">
              {busy ? 'جار الترحيل...' : 'ترحيل المستند (كله أو لا شيء)'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
