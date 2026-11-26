import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { AccountOption } from '../../lib/accountRules.js';
import { VoucherLineDraft, emptyLine, sumLinesMoney, linesReady, toPayloadLines, draftFromVoucher } from '../../lib/voucherLines.js';
import { printCustodyVoucher } from '../../lib/custodyVoucherPrint.js';

/**
 * كشف حساب العهدة (حوافظ، تعزيز، جرد، مطالبة عجز وسداد).
 * الحكم النهائي للصلاحيات والمحاسبة على الخادم؛ الشاشة تعرض وتطلب فقط.
 * الجرد لا يرحّل أي قيد. القيود الوحيدة: حافظة معتمدة، عكسها، تعزيز، وسداد عجز نقدي.
 */

interface VoucherLineView {
  lineNo: number;
  expenseAccountId: string;
  amount: number;
  memo: string | null;
}

interface VoucherView {
  id: string;
  voucherNo: string;
  status: 'submitted' | 'approved' | 'rejected' | 'reversed';
  totalAmount: number;
  memo: string | null;
  rejectReason: string | null;
  reversalReason: string | null;
  lines: VoucherLineView[];
}

interface CountView {
  id: string;
  countedAmount: number;
  expectedAmount: number;
  variance: number;
  memo: string | null;
  countedAt: string;
}

interface RepaymentView {
  id: string;
  amount: number;
  memo: string | null;
  createdAt: string;
}

interface SettlementView {
  id: string;
  treatment: 'WRITE_OFF' | 'PAYROLL_DEDUCT';
  amount: number;
  reason: string;
  status: 'pending' | 'rejected' | 'posted';
}

interface PolicyView {
  treatment: 'WRITE_OFF' | 'PAYROLL_DEDUCT';
  enabled: boolean;
  ceiling: number | null;
}

interface ClaimView {
  id: string;
  cashCountId: string;
  amount: number;
  repaid: number;
  outstanding: number;
  settled?: number;
  pendingSettlement?: number;
  settlements?: SettlementView[];
  status: 'open' | 'partly_repaid' | 'repaid' | 'settled';
  repayments: RepaymentView[];
}

interface StatementView {
  totals: {
    disbursed: number;
    topUps: number;
    approvedExpenses: number;
    reversedExpenses: number;
    cashReturned: number;
    remaining: number;
    pendingVouchers: number;
    pendingVoucherAmount?: number;
    available?: number;
  };
  vouchers: VoucherView[];
  cashCounts: CountView[];
  shortageClaims: ClaimView[];
}

export interface CustodyStatementPanelProps {
  companyId: string;
  custodyId: string;
  custodyStatus: string;
  expenseAccounts: AccountOption[];
  can: (permission: string) => boolean;
  onChanged?: () => void;
  /** Company name printed on the voucher header (selected company, Arabic name). */
  companyName?: string;
}

const VOUCHER_STATUS_AR: Record<string, string> = {
  submitted: 'مقدّمة',
  approved: 'معتمدة',
  rejected: 'مرفوضة',
  reversed: 'معكوسة',
};

const CLAIM_STATUS_AR: Record<string, string> = {
  open: 'مفتوحة',
  partly_repaid: 'مسددة جزئياً',
  repaid: 'مسددة بالكامل',
  settled: 'مسوّاة بتسوية معتمدة',
};

const TREATMENT_AR: Record<string, string> = {
  WRITE_OFF: 'إعدام العجز (تتحمله الشركة)',
  PAYROLL_DEDUCT: 'خصم من راتب الموظف',
};

const SETTLEMENT_STATUS_AR: Record<string, string> = {
  pending: 'بانتظار الاعتماد',
  rejected: 'مرفوضة',
  posted: 'معتمدة ومرحّلة',
};

const fmt = (n: number) => Number(n || 0).toFixed(2);

export function CustodyStatementPanel(props: CustodyStatementPanelProps) {
  const { companyId, custodyId, custodyStatus, expenseAccounts, can, onChanged, companyName } = props;
  const isOpen = custodyStatus === 'open';
  const [statement, setStatement] = useState<StatementView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const [vLines, setVLines] = useState<VoucherLineDraft[]>([emptyLine()]);
  const [vMemo, setVMemo] = useState('');
  const [topUpAmount, setTopUpAmount] = useState('');
  const [topUpMemo, setTopUpMemo] = useState('');
  const [countAmount, setCountAmount] = useState('');
  const [countMemo, setCountMemo] = useState('');
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [repayById, setRepayById] = useState<Record<string, string>>({});
  const [policies, setPolicies] = useState<PolicyView[]>([]);
  const [stTreatment, setStTreatment] = useState<Record<string, string>>({});
  const [stAmount, setStAmount] = useState<Record<string, string>>({});
  const [stReason, setStReason] = useState<Record<string, string>>({});
  const [decisionReason, setDecisionReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/cash/custodies/${custodyId}/statement?companyId=${encodeURIComponent(companyId)}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر تحميل كشف العهدة');
      setStatement(data.statement as StatementView);
      try {
        const pr = await apiFetch(`/api/cash/custody-settlement-policies?companyId=${encodeURIComponent(companyId)}`);
        const pd = await pr.json().catch(() => ({}));
        setPolicies(pr.ok && Array.isArray(pd.policies) ? (pd.policies as PolicyView[]) : []);
      } catch {
        setPolicies([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل كشف العهدة');
    } finally {
      setLoading(false);
    }
  }, [companyId, custodyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (path: string, body: Record<string, unknown>, doneMessage: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await apiFetch(path, { method: 'POST', body: JSON.stringify({ companyId, ...body }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر تنفيذ العملية');
      setOk(doneMessage);
      await load();
      if (onChanged) onChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تنفيذ العملية');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitVoucher = async (e: React.FormEvent) => {
    e.preventDefault();
    const done = await post(
      `/api/cash/custodies/${custodyId}/vouchers`,
      { lines: toPayloadLines(vLines), memo: vMemo.trim() || null },
      'تم تقديم الحافظة'
    );
    if (done) {
      setVLines([emptyLine()]);
      setVMemo('');
    }
  };

  const topUp = async (e: React.FormEvent) => {
    e.preventDefault();
    const done = await post(`/api/cash/custodies/${custodyId}/topup`, { amount: topUpAmount, memo: topUpMemo.trim() || null }, 'تم تعزيز العهدة');
    if (done) {
      setTopUpAmount('');
      setTopUpMemo('');
    }
  };

  const recordCount = async (e: React.FormEvent) => {
    e.preventDefault();
    const done = await post(
      `/api/cash/custodies/${custodyId}/cash-counts`,
      { countedAmount: countAmount, memo: countMemo.trim() || null },
      'تم تسجيل الجرد (لا يرحّل أي قيد)'
    );
    if (done) {
      setCountAmount('');
      setCountMemo('');
    }
  };

  const setReason = (id: string, v: string) => setReasonById((prev) => ({ ...prev, [id]: v }));
  const setRepay = (id: string, v: string) => setRepayById((prev) => ({ ...prev, [id]: v }));

  const claimedCountIds = new Set((statement?.shortageClaims || []).map((c) => c.cashCountId));
  const accountName = (id: string) => {
    const a = expenseAccounts.find((x) => x.id === id);
    return a ? `${a.code} ${a.nameAr}` : id.slice(0, 8);
  };

  const input = 'bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white';
  const btn = 'px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer disabled:opacity-50';

  return (
    <div data-testid="custody-statement-panel" className="flex flex-col gap-4 border-t border-slate-800 pt-4">
      <div className="flex items-center justify-between">
        <h5 className="text-xs font-bold text-slate-200">كشف حساب العهدة</h5>
        <button type="button" onClick={() => void load()} className="text-slate-400 hover:text-white cursor-pointer" aria-label="تحديث">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-300 bg-rose-950/40 border border-rose-900 rounded-lg p-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}
      {ok && (
        <div className="flex items-center gap-2 text-xs text-emerald-300 bg-emerald-950/40 border border-emerald-900 rounded-lg p-2">
          <CheckCircle2 className="w-4 h-4" /> {ok}
        </div>
      )}

      {statement && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-950/70 border border-slate-800 rounded-xl p-3">
            <div><div className="text-slate-400">المصروف أصلاً</div><div className="text-white font-bold">{fmt(statement.totals.disbursed)}</div></div>
            <div><div className="text-slate-400">التعزيزات</div><div className="text-white font-bold">{fmt(statement.totals.topUps)}</div></div>
            <div><div className="text-slate-400">مصروفات معتمدة</div><div className="text-white font-bold">{fmt(statement.totals.approvedExpenses)}</div></div>
            <div><div className="text-slate-400">مرتجع نقدي وسداد عجز</div><div className="text-white font-bold">{fmt(statement.totals.cashReturned)}</div></div>
            <div><div className="text-slate-400">المتبقي</div><div data-testid="custody-remaining" className="text-emerald-300 font-bold">{fmt(statement.totals.remaining)}</div></div>
            <div><div className="text-slate-400">حوافظ بانتظار القرار</div><div className="text-amber-300 font-bold">{statement.totals.pendingVouchers}</div></div>
            <div><div className="text-slate-400">محجوز لحوافظ معلقة (بدون قيد)</div><div data-testid="custody-reserved" className="text-amber-300 font-bold">{fmt(statement.totals.pendingVoucherAmount ?? 0)}</div></div>
            <div><div className="text-slate-400">المتاح بعد الحجز</div><div data-testid="custody-available" className="text-emerald-300 font-bold">{fmt(statement.totals.available ?? statement.totals.remaining)}</div></div>
          </div>
          <CustodyPeriodReportPanel companyId={companyId} custodyId={custodyId} />

          <div>
            <h6 className="text-xs font-bold text-slate-300 mb-2">الحوافظ</h6>
            <div className="border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-950/60 text-slate-400">
                    <th className="py-2 px-3">الرقم</th>
                    <th className="py-2 px-3">الحالة</th>
                    <th className="py-2 px-3">المبلغ</th>
                    <th className="py-2 px-3">البنود</th>
                    <th className="py-2 px-3">إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {statement.vouchers.length === 0 && (
                    <tr><td colSpan={5} className="py-4 text-center text-slate-500">لا توجد حوافظ</td></tr>
                  )}
                  {statement.vouchers.map((v) => (
                    <tr key={v.id}>
                      <td className="py-2 px-3 font-medium text-white">{v.voucherNo}</td>
                      <td className="py-2 px-3">{VOUCHER_STATUS_AR[v.status] || v.status}</td>
                      <td className="py-2 px-3">{fmt(v.totalAmount)}</td>
                      <td className="py-2 px-3">{v.lines.map((l) => `${accountName(l.expenseAccountId)}: ${fmt(l.amount)}`).join(' | ')}</td>
                      <td className="py-2 px-3">
                        {v.status === 'approved' && (
                          <button
                            type="button"
                            data-testid={`print-voucher-${v.voucherNo}`}
                            className="mb-1 px-2 py-1 rounded bg-slate-700 text-white text-xs"
                            onClick={() => {
                              try {
                                printCustodyVoucher(
                                  { voucherNo: v.voucherNo, status: v.status, totalAmount: v.totalAmount, memo: v.memo,
                                    lines: v.lines.map((l) => ({ expenseAccountName: accountName(l.expenseAccountId), amount: l.amount, memo: l.memo })) },
                                  companyName || 'A.N ERP'
                                );
                              } catch (e) {
                                setError(e instanceof Error ? e.message : 'تعذرت الطباعة');
                              }
                            }}
                          >
                            طباعة
                          </button>
                        )}
                        {(v.status === 'submitted' || v.status === 'approved') && can('custody:approve') && (
                          <div className="flex items-center gap-2">
                            <input
                              className={input}
                              placeholder={v.status === 'submitted' ? 'سبب الرفض' : 'سبب العكس'}
                              value={reasonById[v.id] || ''}
                              onChange={(e) => setReason(v.id, e.target.value)}
                            />
                            {v.status === 'submitted' && (
                              <>
                                <button type="button" disabled={busy} className={`${btn} bg-emerald-600 text-white`}
                                  onClick={() => void post(`/api/cash/custody-vouchers/${v.id}/approve`, {}, 'تم اعتماد الحافظة')}>اعتماد</button>
                                <button type="button" disabled={busy || !(reasonById[v.id] || '').trim()} className={`${btn} bg-rose-700 text-white`}
                                  onClick={() => void post(`/api/cash/custody-vouchers/${v.id}/reject`, { reason: reasonById[v.id] }, 'تم رفض الحافظة')}>رفض</button>
                              </>
                            )}
                            {v.status === 'approved' && isOpen && (
                              <button type="button" disabled={busy || !(reasonById[v.id] || '').trim()} className={`${btn} bg-amber-600 text-white`}
                                onClick={() => void post(`/api/cash/custody-vouchers/${v.id}/reverse`, { reason: reasonById[v.id] }, 'تم عكس الحافظة بقيد عكسي')}>عكس</button>
                            )}
                          </div>
                        )}
                        {v.status === 'rejected' && (
                          <div className="flex items-center gap-2">
                            <span className="text-slate-400">{v.rejectReason}</span>
                            {isOpen && can('custody:request') && (
                              <button type="button" data-testid={`resubmit-${v.voucherNo}`} className={`${btn} bg-slate-700 text-white`}
                                onClick={() => { setVLines(draftFromVoucher(v.lines)); setVMemo(v.memo || ''); }}>إعادة تقديم كحافظة جديدة</button>
                            )}
                          </div>
                        )}
                        {v.status === 'reversed' && <span className="text-slate-400">{v.reversalReason}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {isOpen && can('custody:request') && (
            <form onSubmit={submitVoucher} className="flex flex-wrap items-end gap-2 bg-slate-950/50 border border-slate-800 rounded-xl p-3">
              <div className="w-full space-y-2" data-testid="voucher-lines">
                {vLines.map((l, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <div className="flex flex-col gap-1">
                      <label className="text-slate-400 text-xs">حساب المصروف</label>
                      <select className={input} value={l.account} onChange={(e) => setVLines(vLines.map((x, k) => (k === i ? { ...x, account: e.target.value } : x)))} required>
                        <option value="">اختر</option>
                        {expenseAccounts.map((a) => (
                          <option key={a.id} value={a.id}>{a.code} {a.nameAr}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-slate-400 text-xs">المبلغ</label>
                      <input className={input} inputMode="decimal" value={l.amount} onChange={(e) => setVLines(vLines.map((x, k) => (k === i ? { ...x, amount: e.target.value } : x)))} required />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-slate-400 text-xs">بيان البند</label>
                      <input className={input} value={l.memo} onChange={(e) => setVLines(vLines.map((x, k) => (k === i ? { ...x, memo: e.target.value } : x)))} />
                    </div>
                    {vLines.length > 1 && (
                      <button type="button" className={`${btn} bg-slate-700 text-white`} onClick={() => setVLines(vLines.filter((_, k) => k !== i))}>حذف البند</button>
                    )}
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" className={`${btn} bg-slate-700 text-white`} onClick={() => setVLines([...vLines, emptyLine()])}>إضافة بند</button>
                  <span className="text-slate-300 text-xs">إجمالي الحافظة: <b data-testid="voucher-total">{fmt(sumLinesMoney(vLines))}</b></span>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-xs">بيان الحافظة</label>
                <input className={input} value={vMemo} onChange={(e) => setVMemo(e.target.value)} />
              </div>
              <button type="submit" disabled={busy || !linesReady(vLines)} className={`${btn} bg-sky-600 text-white`}>تقديم حافظة</button>
            </form>
          )}

          {isOpen && can('custody:disburse') && (
            <form onSubmit={topUp} className="flex flex-wrap items-end gap-2 bg-slate-950/50 border border-slate-800 rounded-xl p-3">
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-xs">مبلغ التعزيز</label>
                <input className={input} inputMode="decimal" value={topUpAmount} onChange={(e) => setTopUpAmount(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-xs">بيان</label>
                <input className={input} value={topUpMemo} onChange={(e) => setTopUpMemo(e.target.value)} />
              </div>
              <button type="submit" disabled={busy} className={`${btn} bg-indigo-600 text-white`}>تعزيز العهدة</button>
            </form>
          )}

          <div>
            <h6 className="text-xs font-bold text-slate-300 mb-2">جرد العهدة (للمراقبة فقط، لا يرحّل قيداً)</h6>
            <div className="border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-950/60 text-slate-400">
                    <th className="py-2 px-3">التاريخ</th>
                    <th className="py-2 px-3">المتوقع</th>
                    <th className="py-2 px-3">المعدود</th>
                    <th className="py-2 px-3">الفرق</th>
                    <th className="py-2 px-3">إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {statement.cashCounts.length === 0 && (
                    <tr><td colSpan={5} className="py-4 text-center text-slate-500">لا توجد عمليات جرد</td></tr>
                  )}
                  {statement.cashCounts.map((c) => (
                    <tr key={c.id}>
                      <td className="py-2 px-3">{String(c.countedAt).slice(0, 10)}</td>
                      <td className="py-2 px-3">{fmt(c.expectedAmount)}</td>
                      <td className="py-2 px-3">{fmt(c.countedAmount)}</td>
                      <td className={`py-2 px-3 font-bold ${c.variance < 0 ? 'text-rose-300' : c.variance > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{fmt(c.variance)}</td>
                      <td className="py-2 px-3">
                        {c.variance < 0 && isOpen && !claimedCountIds.has(c.id) && can('custody:settle') && (
                          <button type="button" disabled={busy} className={`${btn} bg-rose-700 text-white`}
                            onClick={() => void post(`/api/cash/custodies/${custodyId}/cash-counts/${c.id}/shortage-claim`, {}, 'تم تسجيل مطالبة العجز على الموظف (بدون قيد)')}>
                            تسجيل مطالبة عجز
                          </button>
                        )}
                        {claimedCountIds.has(c.id) && <span className="text-slate-400">لها مطالبة</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {isOpen && can('custody:settle') && (
            <form onSubmit={recordCount} className="flex flex-wrap items-end gap-2 bg-slate-950/50 border border-slate-800 rounded-xl p-3">
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-xs">المبلغ المعدود فعلياً</label>
                <input className={input} inputMode="decimal" value={countAmount} onChange={(e) => setCountAmount(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-xs">ملاحظة</label>
                <input className={input} value={countMemo} onChange={(e) => setCountMemo(e.target.value)} />
              </div>
              <button type="submit" disabled={busy} className={`${btn} bg-slate-600 text-white`}>تسجيل الجرد</button>
            </form>
          )}

          {statement.shortageClaims.length > 0 && (
            <div>
              <h6 className="text-xs font-bold text-slate-300 mb-2">مطالبات العجز على الموظف</h6>
              <div className="flex flex-col gap-2">
                {statement.shortageClaims.map((c) => (
                  <div key={c.id} className="border border-slate-800 rounded-xl p-3 text-xs text-slate-200 flex flex-col gap-2">
                    <div className="flex flex-wrap gap-4">
                      <span>المطالبة: <b className="text-white">{fmt(c.amount)}</b></span>
                      <span>المسدد: <b className="text-white">{fmt(c.repaid)}</b></span>
                      <span>المتبقي: <b className="text-rose-300">{fmt(c.outstanding)}</b></span>
                      <span>{CLAIM_STATUS_AR[c.status] || c.status}</span>
                    </div>
                    {c.repayments.length > 0 && (
                      <div className="text-slate-400">
                        {c.repayments.map((r) => `${String(r.createdAt).slice(0, 10)}: ${fmt(r.amount)}`).join(' | ')}
                      </div>
                    )}
                    {(c.settlements || []).length > 0 && (
                      <div className="flex flex-col gap-1 border-t border-slate-800 pt-2" data-testid="claim-settlements">
                        {(c.settlements || []).map((st) => (
                          <div key={st.id} className="flex flex-wrap items-center gap-2">
                            <span>{TREATMENT_AR[st.treatment]}: <b className="text-white">{fmt(st.amount)}</b></span>
                            <span className="text-slate-400">{SETTLEMENT_STATUS_AR[st.status]} - {st.reason}</span>
                            {st.status === 'pending' && can('custody:approve') && (
                              <>
                                <input className={input} placeholder="سبب الرفض" value={decisionReason[st.id] || ''}
                                  onChange={(e) => setDecisionReason((prev) => ({ ...prev, [st.id]: e.target.value }))} />
                                <button type="button" disabled={busy} className={`${btn} bg-emerald-600 text-white`}
                                  onClick={() => void post(`/api/cash/custody-shortage-settlements/${st.id}/approve`, {}, 'تم اعتماد التسوية')}>اعتماد التسوية</button>
                                <button type="button" disabled={busy || !(decisionReason[st.id] || '').trim()} className={`${btn} bg-rose-700 text-white`}
                                  onClick={() => void post(`/api/cash/custody-shortage-settlements/${st.id}/reject`, { reason: decisionReason[st.id] }, 'تم رفض التسوية')}>رفض التسوية</button>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {c.outstanding - (c.pendingSettlement || 0) > 0 && isOpen && can('custody:settle') && policies.some((pl) => pl.enabled) && (
                      <div className="flex flex-wrap items-center gap-2" data-testid="settlement-request">
                        <select className={input} value={stTreatment[c.id] || ''} onChange={(e) => setStTreatment((prev) => ({ ...prev, [c.id]: e.target.value }))}>
                          <option value="">نوع التسوية</option>
                          {policies.filter((pl) => pl.enabled).map((pl) => (
                            <option key={pl.treatment} value={pl.treatment}>{TREATMENT_AR[pl.treatment]}</option>
                          ))}
                        </select>
                        <input className={input} inputMode="decimal" placeholder="المبلغ" value={stAmount[c.id] || ''}
                          onChange={(e) => setStAmount((prev) => ({ ...prev, [c.id]: e.target.value }))} />
                        <input className={input} placeholder="سبب التسوية" value={stReason[c.id] || ''}
                          onChange={(e) => setStReason((prev) => ({ ...prev, [c.id]: e.target.value }))} />
                        <button type="button" className={`${btn} bg-sky-600 text-white`}
                          disabled={busy || !stTreatment[c.id] || !(stAmount[c.id] || '').trim() || (stReason[c.id] || '').trim().length < 3}
                          onClick={() => void post(`/api/cash/custody-shortage-claims/${c.id}/settlements`,
                            { treatment: stTreatment[c.id], amount: stAmount[c.id], reason: stReason[c.id] },
                            'تم رفع طلب التسوية للاعتماد (لا قيد قبل الاعتماد)')}>
                          طلب تسوية للاعتماد
                        </button>
                      </div>
                    )}
                    {c.outstanding - (c.pendingSettlement || 0) > 0 && isOpen && can('custody:settle') && (
                      <div className="flex items-center gap-2">
                        <input className={input} inputMode="decimal" placeholder="مبلغ السداد النقدي"
                          value={repayById[c.id] || ''} onChange={(e) => setRepay(c.id, e.target.value)} />
                        <button type="button" disabled={busy || !(repayById[c.id] || '').trim()} className={`${btn} bg-emerald-600 text-white`}
                          onClick={() => void post(`/api/cash/custody-shortage-claims/${c.id}/repay`, { amount: repayById[c.id] }, 'تم تسجيل السداد النقدي')}>
                          تسجيل سداد
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}


interface PeriodReportView {
  opening: number; totalIn: number; totalOut: number; closing: number; reconciled: boolean;
  rows: { movementType: string; signedAmount: number; createdAt: string; memo: string | null; runningBalance: number }[];
}
const TYPE_AR: Record<string, string> = {
  disburse: 'صرف عهدة', topup: 'تعزيز', settle_expense: 'مصروف معتمد', reverse: 'عكس حافظة',
  settle_return: 'مرتجع نقدي', shortage_repay: 'سداد عجز',
};

/** تقرير فترة العهدة: افتتاحي، وارد، صادر، ختامي. قراءة فقط ولا يرحّل شيئا. */
export function CustodyPeriodReportPanel({ companyId, custodyId }: { companyId: string; custodyId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [rep, setRep] = useState<PeriodReportView | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    setErr('');
    try {
      const q = `companyId=${encodeURIComponent(companyId)}&from=${from}T00:00:00.000Z&to=${to}T23:59:59.999Z`;
      const res = await apiFetch(`/api/cash/custodies/${custodyId}/period-report?${q}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || data?.message || 'تعذر تحميل التقرير');
      setRep(data.report);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذر تحميل التقرير');
    }
  }, [companyId, custodyId, from, to]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 space-y-2 text-xs" data-testid="custody-period-report">
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-slate-300 font-bold">تقرير الفترة</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white" aria-label="من" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white" aria-label="إلى" />
      </div>
      {err && <div className="text-red-300">{err}</div>}
      {rep && (
        <>
          <div className="grid grid-cols-4 gap-2">
            <div><div className="text-slate-400">افتتاحي</div><div className="text-white font-bold">{fmt(rep.opening)}</div></div>
            <div><div className="text-slate-400">وارد</div><div className="text-emerald-300 font-bold">{fmt(rep.totalIn)}</div></div>
            <div><div className="text-slate-400">صادر</div><div className="text-amber-300 font-bold">{fmt(rep.totalOut)}</div></div>
            <div><div className="text-slate-400">ختامي</div><div data-testid="period-closing" className="text-white font-bold">{fmt(rep.closing)}</div></div>
          </div>
          {!rep.reconciled && <div className="text-red-300">تنبيه: مجموع الحركات لا يطابق المتبقي في الكشف، راجع المحاسب.</div>}
          <table className="w-full text-right">
            <thead><tr className="text-slate-400"><th>التاريخ</th><th>النوع</th><th>المبلغ</th><th>الرصيد</th></tr></thead>
            <tbody>
              {rep.rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-800 text-slate-200">
                  <td>{r.createdAt.slice(0, 10)}</td><td>{TYPE_AR[r.movementType] || r.movementType}</td>
                  <td>{fmt(r.signedAmount)}</td><td>{fmt(r.runningBalance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
