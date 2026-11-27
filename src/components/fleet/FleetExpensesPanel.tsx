import React, { useState, useEffect, useCallback } from 'react';
import { Plus, X } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import type { TripVehicle } from './FleetTripsPanel.js';

interface Category { id: string; code: string; nameAr: string; expenseAccountId: string; isActive: boolean }
interface Expense {
  id: string; expenseNo: string; vehicleId: string; tripId: string | null; categoryId: string; expenseDate: string; amount: number; description: string;
  referenceNo: string | null; odometerKm: number | null; status: string; rejectReason: string | null; reverseReason: string | null;
  journalEntryId: string | null; reversalEntryId: string | null; counterAccountId: string | null; custodyVoucherId?: string | null;
}
interface OpenCustody { id: string; custodyNo: string | null; employeeUsername?: string | null; amount: number; purpose: string }
interface Account { id: string; code: string; nameAr: string; accountType: string; isPostable: boolean; isActive?: boolean }

export const EXPENSE_STATUS_AR: Record<string, string> = { draft: 'مسودة', approved: 'معتمد', rejected: 'مرفوض', posted: 'مرحّل', reversed: 'معكوس' };
const BADGE: Record<string, string> = {
  draft: 'bg-slate-700 text-slate-200', approved: 'bg-sky-500/20 text-sky-300', rejected: 'bg-red-500/20 text-red-300',
  posted: 'bg-emerald-500/20 text-emerald-300', reversed: 'bg-amber-500/20 text-amber-300',
};
type Action = 'approve' | 'reject' | 'post' | 'custody' | 'reverse';
const ACTION_AR: Record<Action, string> = { approve: 'اعتماد', reject: 'رفض', post: 'ترحيل محاسبي', custody: 'دفع من العهدة', reverse: 'عكس القيد' };
const money = (n: number) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Props { companyId: string; vehicles: TripVehicle[]; can: (perm: string) => boolean }

export function FleetExpensesPanel({ companyId, vehicles, can }: Props) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsNote, setAccountsNote] = useState<string | null>(null);
  const [custodies, setCustodies] = useState<OpenCustody[]>([]);
  const [custodyNote, setCustodyNote] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showCat, setShowCat] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});
  const [cf, setCf] = useState<Record<string, string>>({});
  const [act, setAct] = useState<{ exp: Expense; action: Action } | null>(null);
  const [actVal, setActVal] = useState('');

  const canCreate = can('fleet:expense:create');
  const canApprove = can('fleet:expense:approve');
  const canPost = can('fleet:expense:post');
  const vLabel = (id: string) => { const v = vehicles.find((x) => x.id === id); return v ? `${v.code} (${v.plateNo})` : '-'; };
  const cLabel = (id: string) => cats.find((x) => x.id === id)?.nameAr || '-';
  const expenseAccounts = accounts.filter((a) => a.accountType === 'expense' && a.isPostable && a.isActive !== false);
  const counterAccounts = accounts.filter((a) => (a.accountType === 'asset' || a.accountType === 'liability') && a.isPostable && a.isActive !== false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true); setError(null);
    try {
      const q = `companyId=${encodeURIComponent(companyId)}`;
      const [er, cr] = await Promise.all([
        apiFetch(`/api/fleet/expenses?${q}${filter ? `&status=${filter}` : ''}`),
        apiFetch(`/api/fleet/expense-categories?${q}`),
      ]);
      const ed = await er.json().catch(() => ({}));
      const cd = await cr.json().catch(() => ({}));
      if (!er.ok) throw new Error(ed.message || ed.error || 'تعذر تحميل المصروفات');
      if (!cr.ok) throw new Error(cd.message || cd.error || 'تعذر تحميل فئات المصروف');
      setExpenses(ed.expenses || []); setCats(cd.categories || []);
    } catch (e) { setError(e instanceof Error ? e.message : 'حدث خطأ أثناء التحميل'); } finally { setLoading(false); }
  }, [companyId, filter]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!companyId || !(canPost || canCreate)) return;
    (async () => {
      try {
        const res = await apiFetch(`/api/accounting/accounts?companyId=${encodeURIComponent(companyId)}`);
        if (res.ok) { const b = await res.json(); setAccounts(b.accounts || []); setAccountsNote(null); }
        else setAccountsNote('تعذر تحميل دليل الحسابات. اختيار الحسابات يحتاج صلاحية الاطلاع على الحسابات.');
      } catch { setAccountsNote('تعذر تحميل دليل الحسابات'); }
    })();
  }, [companyId, canPost, canCreate]);

  const post = async (url: string, body: Record<string, unknown>, fallback: string) => {
    const res = await apiFetch(url, { method: 'POST', body: JSON.stringify({ companyId, ...body }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || fallback);
    return data;
  };

  const createExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const amount = Number(f.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');
      const data = await post('/api/fleet/expenses', { vehicleId: f.vehicleId, categoryId: f.categoryId, expenseDate: f.expenseDate, amount, description: f.description,
        referenceNo: f.referenceNo || undefined, odometerKm: f.odometerKm ? Number(f.odometerKm) : undefined }, 'تعذر حفظ المصروف');
      setSuccess(`تم تسجيل المصروف ${data.expense?.expenseNo || ''} كمسودة بانتظار الاعتماد`);
      setShowForm(false); setF({}); await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'حدث خطأ أثناء الحفظ'); } finally { setBusy(false); }
  };

  const createCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      await post('/api/fleet/expense-categories', { code: cf.code, nameAr: cf.nameAr, expenseAccountId: cf.expenseAccountId }, 'تعذر حفظ الفئة');
      setSuccess('تم إنشاء فئة المصروف'); setShowCat(false); setCf({}); await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'حدث خطأ أثناء الحفظ'); } finally { setBusy(false); }
  };

  const openAction = (x: Expense, a: Action) => {
    setError(null); setSuccess(null); setActVal(''); setAct({ exp: x, action: a });
    if (a === 'custody') {
      setCustodies([]); setCustodyNote(null);
      (async () => {
        try {
          const r = await apiFetch(`/api/cash/custodies?companyId=${encodeURIComponent(companyId)}&status=open`);
          if (r.ok) { const b = await r.json(); setCustodies(b.custodies || []); }
          else setCustodyNote('تعذر تحميل العهد المفتوحة. يلزم صلاحية الاطلاع على الخزينة.');
        } catch { setCustodyNote('تعذر تحميل العهد المفتوحة'); }
      })();
    }
  };

  const runAction = async () => {
    if (!act) return;
    const { exp, action } = act;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const body: Record<string, unknown> = {};
      if (action === 'reject' || action === 'reverse') { if (!actVal.trim()) throw new Error('السبب مطلوب'); body.reason = actVal.trim(); }
      if (action === 'post') { if (!actVal) throw new Error('اختر الحساب المقابل (الدائن)'); body.counterAccountId = actVal; }
      if (action === 'custody') { if (!actVal) throw new Error('اختر العهدة'); body.custodyId = actVal; }
      await post(`/api/fleet/expenses/${exp.id}/${action === 'custody' ? 'pay-from-custody' : action}`, body, 'تعذر تنفيذ الإجراء');
      setSuccess(action === 'custody' ? `تم تقديم حافظة عهدة للمصروف (${exp.expenseNo}). يُرحَّل باعتماد الحافظة من شاشة العهدة` : `تم: ${ACTION_AR[action]} (${exp.expenseNo})`);
      setAct(null); setActVal(''); await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'حدث خطأ أثناء التنفيذ'); setAct(null); } finally { setBusy(false); }
  };

  const actionsFor = (x: Expense): Action[] => {
    const a: Action[] = [];
    if (x.status === 'draft' && canApprove) a.push('approve', 'reject');
    if (x.status === 'approved' && x.custodyVoucherId) return a;
    if (x.status === 'approved' && canApprove) a.push('reject');
    if (x.status === 'approved' && canPost) a.unshift('post', 'custody');
    if (x.status === 'posted' && canPost && !x.custodyVoucherId) a.push('reverse');
    return a;
  };
  const inp = 'w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500';
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const setC = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setCf((p) => ({ ...p, [k]: e.target.value }));
  const activeCats = cats.filter((c) => c.isActive);

  return (
    <div className="space-y-3" data-testid="fleet-expenses">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="تصفية حسب حالة المصروف"
          className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white cursor-pointer">
          <option value="">كل الحالات</option>
          {Object.entries(EXPENSE_STATUS_AR).map(([k, l]) => (<option key={k} value={k}>{l}</option>))}
        </select>
        <div className="flex gap-2">
          {canCreate && (<button type="button" onClick={() => { setCf({}); setShowCat(true); setError(null); }}
            className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-bold rounded-xl cursor-pointer">فئات المصروف ({cats.length})</button>)}
          {canCreate && (<button type="button" onClick={() => { setF({ expenseDate: new Date().toISOString().slice(0, 10) }); setShowForm(true); setError(null); }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl cursor-pointer">
            <Plus className="w-3.5 h-3.5" /><span>مصروف جديد</span></button>)}
        </div>
      </div>
      {error && <div role="alert" className="p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-xs text-red-300">{error}</div>}
      {success && <div className="p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">{success}</div>}
      {accountsNote && <div className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-xs text-amber-300">{accountsNote}</div>}

      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead><tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
              <th className="py-3.5 px-4">الرقم</th><th className="py-3.5 px-4">التاريخ</th><th className="py-3.5 px-4">المركبة</th><th className="py-3.5 px-4">الفئة</th>
              <th className="py-3.5 px-4">الوصف</th><th className="py-3.5 px-4">المبلغ</th><th className="py-3.5 px-4">الحالة</th><th className="py-3.5 px-4">الإجراءات</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {expenses.length === 0 ? (
                <tr><td colSpan={8} className="py-12 text-center text-slate-500">{loading ? 'جاري التحميل...' : 'لا توجد مصروفات'}</td></tr>
              ) : expenses.map((x) => (
                <tr key={x.id} data-testid="fleet-expense-row">
                  <td className="py-3.5 px-4 font-mono text-indigo-300">{x.expenseNo}</td>
                  <td className="py-3.5 px-4"><span dir="ltr" className="font-mono tabular-nums">{x.expenseDate}</span></td>
                  <td className="py-3.5 px-4">{vLabel(x.vehicleId)}</td>
                  <td className="py-3.5 px-4">{cLabel(x.categoryId)}</td>
                  <td className="py-3.5 px-4 text-slate-300">{x.description}{x.rejectReason ? <div className="text-red-300">سبب الرفض: {x.rejectReason}</div> : null}{x.reverseReason ? <div className="text-amber-300">سبب العكس: {x.reverseReason}</div> : null}</td>
                  <td className="py-3.5 px-4 font-mono tabular-nums">{money(x.amount)}</td>
                  <td className="py-3.5 px-4"><span className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${BADGE[x.status] || ''}`}>{EXPENSE_STATUS_AR[x.status] || x.status}</span></td>
                  <td className="py-3.5 px-4"><div className="flex flex-wrap gap-1.5">
                    {actionsFor(x).map((a) => (
                      <button key={a} type="button" disabled={busy} data-testid={`expense-${a}`} onClick={() => openAction(x, a)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer ${a === 'reject' || a === 'reverse' ? 'bg-red-500/15 text-red-300 hover:bg-red-500/25' : 'bg-emerald-600/80 text-white hover:bg-emerald-500'}`}>{ACTION_AR[a]}</button>
                    ))}
                    {x.custodyVoucherId && x.status === 'approved' && <span className="text-[11px] text-amber-300" data-testid="expense-custody-pending">بانتظار اعتماد حافظة العهدة</span>}
                    {x.custodyVoucherId && x.status === 'posted' && <span className="text-[11px] text-slate-400">مدفوع من العهدة (يُعكس من الحافظة)</span>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && canCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="مصروف جديد">
          <form onSubmit={createExpense} className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-white text-sm">مصروف جديد</h4>
              <button type="button" aria-label="إغلاق" onClick={() => setShowForm(false)} className="p-1.5 rounded-lg text-slate-400 hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-300">المركبة *
                <select required className={inp} value={f.vehicleId || ''} onChange={set('vehicleId')}><option value="">-- اختر --</option>{vehicles.map((v) => (<option key={v.id} value={v.id}>{v.code} ({v.plateNo})</option>))}</select></label>
              <label className="text-xs text-slate-300">الفئة *
                <select required className={inp} value={f.categoryId || ''} onChange={set('categoryId')}><option value="">-- اختر --</option>{activeCats.map((c) => (<option key={c.id} value={c.id}>{c.nameAr}</option>))}</select></label>
              <label className="text-xs text-slate-300">التاريخ *<input required type="date" className={inp} value={f.expenseDate || ''} onChange={set('expenseDate')} /></label>
              <label className="text-xs text-slate-300">المبلغ *<input required type="number" min="0.01" step="0.01" className={inp} value={f.amount || ''} onChange={set('amount')} /></label>
              <label className="text-xs text-slate-300">رقم المرجع<input maxLength={60} className={inp} value={f.referenceNo || ''} onChange={set('referenceNo')} /></label>
              <label className="text-xs text-slate-300">قراءة العداد (كم)<input type="number" min="0" step="0.1" className={inp} value={f.odometerKm || ''} onChange={set('odometerKm')} /></label>
            </div>
            <label className="block text-xs text-slate-300">الوصف *<input required maxLength={300} className={inp} value={f.description || ''} onChange={set('description')} /></label>
            {activeCats.length === 0 && <p className="text-[11px] text-amber-300">لا توجد فئات. أنشئ فئة مصروف أولا من زر «فئات المصروف».</p>}
            <p className="text-[11px] text-slate-500">يُحفظ المصروف كمسودة ولا يُرحَّل محاسبيا قبل الاعتماد، ولا يعتمده نفس منشئه.</p>
            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={busy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl cursor-pointer">{busy ? 'جاري الحفظ...' : 'حفظ كمسودة'}</button>
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 bg-slate-800 text-slate-200 text-xs rounded-xl cursor-pointer">إلغاء</button>
            </div>
          </form>
        </div>
      )}

      {showCat && canCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="فئات المصروف">
          <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-white text-sm">فئات المصروف</h4>
              <button type="button" aria-label="إغلاق" onClick={() => setShowCat(false)} className="p-1.5 rounded-lg text-slate-400 hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            <ul className="text-xs text-slate-300 space-y-1" data-testid="fleet-expense-categories">
              {cats.length === 0 ? <li className="text-slate-500">لا توجد فئات بعد</li> : cats.map((c) => {
                const a = accounts.find((x) => x.id === c.expenseAccountId);
                return <li key={c.id}>{c.nameAr} ({c.code}) - حساب المصروف: {a ? `${a.code} ${a.nameAr}` : 'غير معروض'}{c.isActive ? '' : ' - معطّلة'}</li>;
              })}
            </ul>
            <form onSubmit={createCategory} className="space-y-3 border-t border-slate-800 pt-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-slate-300">الكود *<input required maxLength={30} className={inp} value={cf.code || ''} onChange={setC('code')} /></label>
                <label className="text-xs text-slate-300">الاسم *<input required maxLength={100} className={inp} value={cf.nameAr || ''} onChange={setC('nameAr')} /></label>
              </div>
              <label className="block text-xs text-slate-300">حساب المصروف (مدين) *
                <select required className={inp} value={cf.expenseAccountId || ''} onChange={setC('expenseAccountId')}>
                  <option value="">-- اختر حساب مصروف --</option>{expenseAccounts.map((a) => (<option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>))}
                </select></label>
              <button type="submit" disabled={busy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl cursor-pointer">إضافة الفئة</button>
            </form>
          </div>
        </div>
      )}

      {act && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" data-testid="fleet-expense-confirm">
          <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
            <h4 className="font-bold text-white text-sm">{ACTION_AR[act.action]} - {act.exp.expenseNo}</h4>
            <p className="text-xs text-slate-400">المبلغ: <span className="font-mono tabular-nums">{money(act.exp.amount)}</span> - {cLabel(act.exp.categoryId)}</p>
            {(act.action === 'reject' || act.action === 'reverse') && (
              <label className="block text-xs text-slate-300">السبب *<textarea rows={3} maxLength={300} className={inp} value={actVal} onChange={(e) => setActVal(e.target.value)} /></label>
            )}
            {act.action === 'post' && (
              <label className="block text-xs text-slate-300">الحساب المقابل (دائن) *
                <select className={inp} value={actVal} onChange={(e) => setActVal(e.target.value)}>
                  <option value="">-- اختر (الموردون أو الصندوق) --</option>{counterAccounts.map((a) => (<option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>))}
                </select></label>
            )}
            {act.action === 'custody' && (
              <label className="block text-xs text-slate-300">العهدة المفتوحة *
                <select className={inp} value={actVal} onChange={(e) => setActVal(e.target.value)} data-testid="expense-custody-select">
                  <option value="">-- اختر العهدة --</option>{custodies.map((c) => (<option key={c.id} value={c.id}>{c.custodyNo || c.id.slice(0, 8)} - {c.employeeUsername || ''} - {money(c.amount)}</option>))}
                </select></label>
            )}
            {act.action === 'custody' && custodyNote && <p className="text-[11px] text-amber-300" role="alert">{custodyNote}</p>}
            {act.action === 'custody' && <p className="text-[11px] text-slate-500">تُقدَّم حافظة عهدة بنفس المبلغ ولا يُرحَّل شيء قبل أن يعتمدها شخص آخر. تصرف من عهدتك الشخصية فقط.</p>}
            {act.action === 'post' && <p className="text-[11px] text-slate-500">القيد: مدين حساب مصروف الفئة، دائن الحساب الذي تختاره. لو فشل القيد لا يُرحَّل شيء.</p>}
            {act.action === 'reverse' && <p className="text-[11px] text-slate-500">يُنشأ قيد عكسي ولا يُحذف القيد الأصلي.</p>}
            {act.action === 'approve' && <p className="text-xs text-slate-300">هل تريد اعتماد هذا المصروف؟ لا يُرحَّل قبل خطوة الترحيل.</p>}
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
