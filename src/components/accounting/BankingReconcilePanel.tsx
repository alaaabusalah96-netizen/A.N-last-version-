import React, { useState, useEffect } from 'react';
import {
  Landmark,
  Plus,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Link2,
  Unlink,
  Check,
  X,
  FileSpreadsheet,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { getLocalTodayDateString } from '../../lib/calendarDate.js';

interface BankAccount {
  id: string;
  code: string;
  nameAr: string;
  bankName: string;
  accountNumber: string | null;
  iban: string | null;
  currencyCode: string;
  glAccountId: string;
  glAccountCode?: string;
  glAccountNameAr?: string;
  openingBalance: string;
  bookBalance?: string;
  unmatchedStatementCount?: number;
  lastReconciledAt?: string | null;
  isActive: boolean;
}

interface StatementLine {
  id: string;
  statementDate: string;
  reference: string | null;
  description: string;
  debitAmount: string;
  creditAmount: string;
  status: 'unmatched' | 'matched';
  matchedJournalLineId: string | null;
  matchedEntryNo?: string | null;
  reconciliationId: string | null;
}

interface GlMovement {
  journalLineId: string;
  entryId: string;
  entryNo: string | null;
  entryDate: string;
  entryMemo: string | null;
  lineMemo: string | null;
  debit: string;
  credit: string;
  isMatched: boolean;
  matchedStatementLineId: string | null;
}

interface ReconciliationRecord {
  id: string;
  statementEndDate: string;
  statementEndingBalance: string;
  bookBalance: string;
  differenceAmount: string;
  status: string;
  completedAt: string | null;
  memo: string | null;
}

interface ReconciliationWorkspace {
  bankAccount: BankAccount;
  asOfDate: string;
  bookBalance: string;
  statementLines: StatementLine[];
  bookMovements: GlMovement[];
  unmatchedStatementNet: string;
  unmatchedBookNet: string;
  matchedCount: number;
  unmatchedStatementCount: number;
  unmatchedBookCount: number;
  reconciliations: ReconciliationRecord[];
}

interface AccountOption {
  id: string;
  code: string;
  nameAr: string;
  accountType: string;
  isPostable: boolean;
  isActive: boolean;
}

interface BankingReconcilePanelProps {
  companyId: string;
  canWrite: boolean;
  canReconcile: boolean;
}

function toCents(val: string | number): number {
  const num = Number(val || 0);
  return Math.round(num * 100);
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function BankingReconcilePanel({ companyId, canWrite, canReconcile }: BankingReconcilePanelProps) {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [selectedBankId, setSelectedBankId] = useState<string>('');
  const [workspace, setWorkspace] = useState<ReconciliationWorkspace | null>(null);
  const [assetGlAccounts, setAssetGlAccounts] = useState<AccountOption[]>([]);

  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [asOfDate, setAsOfDate] = useState<string>(() => getLocalTodayDateString());
  const [selectedStmtLineId, setSelectedStmtLineId] = useState<string>('');
  const [selectedGlLineId, setSelectedGlLineId] = useState<string>('');

  // Complete reconciliation inputs
  const [stmtEndingBalance, setStmtEndingBalance] = useState<string>('');
  const [reconMemo, setReconMemo] = useState<string>('');

  // Modals
  const [showNewBankModal, setShowNewBankModal] = useState(false);
  const [newBankForm, setNewBankForm] = useState({
    code: '',
    nameAr: '',
    bankName: '',
    accountNumber: '',
    iban: '',
    currencyCode: '', // empty = the company's default currency (resolved by the server)
    glAccountId: '',
    openingBalance: '0.00',
  });

  const [showAddStmtModal, setShowAddStmtModal] = useState(false);
  const [newStmtForm, setNewStmtForm] = useState({
    statementDate: getLocalTodayDateString(),
    reference: '',
    description: '',
    direction: 'credit' as 'credit' | 'debit',
    amount: '',
  });

  const loadBankAccounts = async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const [bankRes, glRes] = await Promise.all([
        apiFetch(`/api/banking/accounts?companyId=${companyId}`),
        apiFetch(`/api/accounting/accounts?companyId=${companyId}`),
      ]);
      if (!bankRes.ok) {
        const err = await bankRes.json().catch(() => ({}));
        throw new Error(err.message || err.error || 'تعذر تحميل الحسابات البنكية');
      }
      const bankJson = await bankRes.json();
      const list: BankAccount[] = bankJson.accounts || [];
      setAccounts(list);

      if (glRes.ok) {
        const glJson = await glRes.json();
        const postableAssets = (glJson.accounts || []).filter(
          (a: AccountOption) => a.accountType === 'asset' && a.isPostable && a.isActive
        );
        setAssetGlAccounts(postableAssets);
        if (postableAssets.length > 0 && !newBankForm.glAccountId) {
          setNewBankForm((prev) => ({ ...prev, glAccountId: postableAssets[0].id }));
        }
      }

      if (list.length > 0) {
        const currentStillExists = list.some((b) => b.id === selectedBankId);
        if (!selectedBankId || !currentStillExists) {
          setSelectedBankId(list[0].id);
        }
      } else {
        setSelectedBankId('');
        setWorkspace(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في جلب الحسابات البنكية');
    } finally {
      setLoading(false);
    }
  };

  const loadWorkspace = async (bankId: string, targetDate: string) => {
    if (!companyId || !bankId) {
      setWorkspace(null);
      return;
    }
    setError(null);
    try {
      const res = await apiFetch(
        `/api/banking/accounts/${bankId}/reconciliation?companyId=${companyId}&asOfDate=${targetDate}`
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || err.error || 'تعذر تحميل بيانات التسوية البنكية');
      }
      const data = await res.json();
      setWorkspace(data.workspace);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في تحميل التسوية البنكية');
    }
  };

  useEffect(() => {
    loadBankAccounts();
  }, [companyId]);

  useEffect(() => {
    if (selectedBankId) {
      loadWorkspace(selectedBankId, asOfDate);
    }
  }, [selectedBankId, asOfDate, companyId]);

  const handleCreateBank = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch('/api/banking/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, ...newBankForm }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || err.error || 'فشل إنشاء الحساب البنكي');
      }
      const data = await res.json();
      setSuccess('تم إنشاء الحساب البنكي وربطه بدليل الحسابات بنجاح');
      setShowNewBankModal(false);
      setNewBankForm((prev) => ({
        ...prev,
        code: '',
        nameAr: '',
        bankName: '',
        accountNumber: '',
        iban: '',
        openingBalance: '0.00',
      }));
      await loadBankAccounts();
      if (data.account?.id) {
        setSelectedBankId(data.account.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في إنشاء الحساب البنكي');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddStatementLine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite || !selectedBankId) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const payloadLine = {
        statementDate: newStmtForm.statementDate,
        reference: newStmtForm.reference || null,
        description: newStmtForm.description,
        debitAmount: newStmtForm.direction === 'debit' ? newStmtForm.amount : '0.00',
        creditAmount: newStmtForm.direction === 'credit' ? newStmtForm.amount : '0.00',
      };
      const res = await apiFetch(`/api/banking/accounts/${selectedBankId}/statement-lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, lines: [payloadLine] }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || err.error || 'تعذر إضافة سطر كشف الحساب');
      }
      setSuccess('تمت إضافة حركة كشف الحساب البنكي');
      setShowAddStmtModal(false);
      setNewStmtForm((prev) => ({ ...prev, reference: '', description: '', amount: '' }));
      await loadWorkspace(selectedBankId, asOfDate);
      await loadBankAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء إضافة سطر كشف الحساب');
    } finally {
      setActionLoading(false);
    }
  };

  const handleMatchSelected = async () => {
    if (!canReconcile || !selectedBankId || !selectedStmtLineId || !selectedGlLineId) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(
        `/api/banking/accounts/${selectedBankId}/statement-lines/${selectedStmtLineId}/match`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companyId, journalLineId: selectedGlLineId }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || err.error || 'تعذر تنفيذ المطابقة');
      }
      setSuccess('تمت مطابقة حركة الكشف مع القيد المحاسبي بنجاح');
      setSelectedStmtLineId('');
      setSelectedGlLineId('');
      await loadWorkspace(selectedBankId, asOfDate);
      await loadBankAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في المطابقة');
    } finally {
      setActionLoading(false);
    }
  };

  const handleUnmatch = async (statementLineId: string) => {
    if (!canReconcile || !selectedBankId) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(
        `/api/banking/accounts/${selectedBankId}/statement-lines/${statementLineId}/unmatch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companyId }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || err.error || 'تعذر فك المطابقة');
      }
      setSuccess('تم فك مطابقة السطر البنكي');
      await loadWorkspace(selectedBankId, asOfDate);
      await loadBankAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في فك المطابقة');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCompleteReconciliation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canReconcile || !selectedBankId) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/banking/accounts/${selectedBankId}/reconciliations/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          statementEndDate: asOfDate,
          statementEndingBalance: stmtEndingBalance,
          memo: reconMemo || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || err.error || 'فشل اعتماد التسوية البنكية');
      }
      setSuccess('تم اعتماد التسوية البنكية بدون فروقات وحفظها بنجاح');
      setReconMemo('');
      await loadWorkspace(selectedBankId, asOfDate);
      await loadBankAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء اعتماد التسوية البنكية');
    } finally {
      setActionLoading(false);
    }
  };

  // Live math preview for reconciliation
  const stmtEndCents = stmtEndingBalance.trim() !== '' ? toCents(stmtEndingBalance) : null;
  const bookCents = workspace ? toCents(workspace.bookBalance) : 0;
  const unmatchedBookCents = workspace ? toCents(workspace.unmatchedBookNet) : 0;
  const unmatchedStmtCents = workspace ? toCents(workspace.unmatchedStatementNet) : 0;
  const adjustedBankCents = stmtEndCents !== null ? stmtEndCents + unmatchedBookCents : null;
  const adjustedBookCents = bookCents + unmatchedStmtCents;
  const diffCents = adjustedBankCents !== null ? adjustedBankCents - adjustedBookCents : null;

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      {/* Header Bar */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <Landmark className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">الحسابات البنكية والتسوية المبسطة</h3>
            <p className="text-xs text-slate-400">
              ربط الحسابات البنكية بدليل الحسابات ومطابقة كشف البنك مقابل حركات الأستاذ العام
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {accounts.length > 0 && (
            <select
              value={selectedBankId}
              onChange={(e) => {
                setSelectedBankId(e.target.value);
                setSelectedStmtLineId('');
                setSelectedGlLineId('');
              }}
              className="px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-semibold text-white focus:outline-none focus:border-indigo-500 min-w-[220px]"
            >
              {accounts.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} - {b.nameAr} ({b.bankName})
                </option>
              ))}
            </select>
          )}

          <input
            type="date"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          />

          <button
            onClick={() => {
              loadBankAccounts();
              if (selectedBankId) loadWorkspace(selectedBankId, asOfDate);
            }}
            disabled={loading}
            className="p-2.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer"
            title="تحديث"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {canWrite && (
            <button
              onClick={() => setShowNewBankModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              <span>حساب بنكي جديد</span>
            </button>
          )}
        </div>
      </div>

      {/* Notifications */}
      {error && (
        <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="p-4 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          <span>{success}</span>
        </div>
      )}

      {/* Empty State */}
      {!loading && accounts.length === 0 ? (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-12 text-center flex flex-col items-center gap-3">
          <Landmark className="w-10 h-10 text-slate-600" />
          <h4 className="text-sm font-bold text-white">لا توجد حسابات بنكية مسجلة بعد</h4>
          <p className="text-xs text-slate-400 max-w-md">
            أنشئ حساباً بنكياً واربطه بحساب أصول في الدليل المحاسبي لبدء إدخال كشوف البنك وتنفيذ التسوية.
          </p>
        </div>
      ) : (
        workspace && (
          <>
            {/* Summary Strip + Complete Form */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 grid grid-cols-1 xl:grid-cols-12 gap-4 items-center">
              <div className="xl:col-span-7 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
                  <div className="text-slate-400 text-[11px] mb-1">الرصيد الدفتري (GL)</div>
                  <div className="font-mono tabular-nums font-bold text-white text-sm">
                    {workspace.bookBalance}
                  </div>
                </div>
                <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
                  <div className="text-slate-400 text-[11px] mb-1">صافي الدفتر غير المطابق</div>
                  <div className="font-mono tabular-nums font-bold text-amber-400 text-sm">
                    {workspace.unmatchedBookNet}
                  </div>
                </div>
                <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
                  <div className="text-slate-400 text-[11px] mb-1">صافي الكشف غير المطابق</div>
                  <div className="font-mono tabular-nums font-bold text-indigo-400 text-sm">
                    {workspace.unmatchedStatementNet}
                  </div>
                </div>
                <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
                  <div className="text-slate-400 text-[11px] mb-1">فارق التسوية المعدّل</div>
                  <div
                    className={`font-mono tabular-nums font-bold text-sm ${
                      diffCents === null
                        ? 'text-slate-400'
                        : diffCents === 0
                        ? 'text-emerald-400'
                        : 'text-rose-400'
                    }`}
                  >
                    {diffCents === null ? '—' : formatCents(diffCents)}
                  </div>
                </div>
              </div>

              <form
                onSubmit={handleCompleteReconciliation}
                className="xl:col-span-5 flex flex-wrap items-end gap-2.5 justify-end"
              >
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-slate-400">الرصيد الختامي بكشف البنك</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    placeholder="0.00"
                    value={stmtEndingBalance}
                    onChange={(e) => setStmtEndingBalance(e.target.value)}
                    className="w-36 px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-slate-400">ملاحظة</label>
                  <input
                    type="text"
                    placeholder="تسوية شهر..."
                    value={reconMemo}
                    onChange={(e) => setReconMemo(e.target.value)}
                    className="w-36 px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
                {canReconcile && (
                  <button
                    type="submit"
                    disabled={actionLoading || diffCents === null || diffCents !== 0}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-xl text-xs font-bold transition cursor-pointer whitespace-nowrap"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>اعتماد التسوية</span>
                  </button>
                )}
              </form>
            </div>

            {/* Matching Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-3 text-xs">
              <div className="flex items-center gap-4 text-slate-400">
                <span>
                  مطابق: <strong className="text-emerald-400 font-mono">{workspace.matchedCount}</strong>
                </span>
                <span>·</span>
                <span>
                  كشف غير مطابق:{' '}
                  <strong className="text-indigo-400 font-mono">{workspace.unmatchedStatementCount}</strong>
                </span>
                <span>·</span>
                <span>
                  دفتر غير مطابق:{' '}
                  <strong className="text-amber-400 font-mono">{workspace.unmatchedBookCount}</strong>
                </span>
              </div>

              <div className="flex items-center gap-2.5">
                {canReconcile && (
                  <button
                    type="button"
                    onClick={handleMatchSelected}
                    disabled={actionLoading || !selectedStmtLineId || !selectedGlLineId}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg text-xs font-bold transition cursor-pointer whitespace-nowrap"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                    <span>مطابقة السطرين المحددين</span>
                  </button>
                )}

                {canWrite && (
                  <button
                    type="button"
                    onClick={() => setShowAddStmtModal(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-950 hover:bg-slate-800 border border-slate-700 text-slate-200 rounded-lg text-xs font-semibold transition cursor-pointer whitespace-nowrap"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>إضافة حركة كشف بنك</span>
                  </button>
                )}
              </div>
            </div>

            {/* Side-by-Side Reconciliation Tables */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Bank Statement Lines */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl flex flex-col">
                <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
                  <h4 className="text-xs font-bold text-white flex items-center gap-2">
                    <FileSpreadsheet className="w-4 h-4 text-indigo-400" />
                    <span>سطور كشف الحساب البنكي</span>
                  </h4>
                  <span className="text-[11px] text-slate-400">اختر حركة للمطابقة</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400">
                        <th className="py-2.5 px-3">التاريخ</th>
                        <th className="py-2.5 px-3">البيان / المرجع</th>
                        <th className="py-2.5 px-3">إيداع (+)</th>
                        <th className="py-2.5 px-3">سحب (-)</th>
                        <th className="py-2.5 px-3 text-center">الحالة</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                      {workspace.statementLines.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-10 text-center text-slate-500">
                            لا توجد حركات كشف حتى تاريخ {asOfDate}
                          </td>
                        </tr>
                      ) : (
                        workspace.statementLines.map((sl) => {
                          const isSelected = selectedStmtLineId === sl.id;
                          return (
                            <tr
                              key={sl.id}
                              onClick={() => {
                                if (sl.status === 'unmatched') {
                                  setSelectedStmtLineId(isSelected ? '' : sl.id);
                                }
                              }}
                              className={`transition ${
                                sl.status === 'unmatched' ? 'cursor-pointer hover:bg-slate-800/40' : 'opacity-75'
                              } ${isSelected ? 'bg-indigo-600/20' : ''}`}
                            >
                              <td className="py-2.5 px-3 font-mono text-slate-300">{sl.statementDate}</td>
                              <td className="py-2.5 px-3 text-slate-200">
                                <div>{sl.description}</div>
                                {sl.reference && (
                                  <div className="text-[10px] text-slate-500 font-mono">{sl.reference}</div>
                                )}
                              </td>
                              <td className="py-2.5 px-3 font-mono tabular-nums text-emerald-400">
                                {Number(sl.creditAmount) > 0 ? sl.creditAmount : '—'}
                              </td>
                              <td className="py-2.5 px-3 font-mono tabular-nums text-rose-400">
                                {Number(sl.debitAmount) > 0 ? sl.debitAmount : '—'}
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                {sl.status === 'matched' ? (
                                  <div className="inline-flex items-center gap-1.5">
                                    <span className="text-[11px] font-semibold text-emerald-400">
                                      مطابق {sl.matchedEntryNo ? `(${sl.matchedEntryNo})` : ''}
                                    </span>
                                    {canReconcile && !sl.reconciliationId && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleUnmatch(sl.id);
                                        }}
                                        className="p-1 text-slate-400 hover:text-rose-400 transition cursor-pointer"
                                        title="فك المطابقة"
                                      >
                                        <Unlink className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-[11px] text-amber-400">غير مطابق</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Posted GL Movements */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl flex flex-col">
                <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
                  <h4 className="text-xs font-bold text-white">
                    حركات الدفتر (GL: {workspace.bankAccount.glAccountCode || ''})
                  </h4>
                  <span className="text-[11px] text-slate-400">القيود المرحلة على حساب البنك</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400">
                        <th className="py-2.5 px-3">التاريخ / القيد</th>
                        <th className="py-2.5 px-3">البيان</th>
                        <th className="py-2.5 px-3">مدين (+)</th>
                        <th className="py-2.5 px-3">دائن (-)</th>
                        <th className="py-2.5 px-3 text-center">الحالة</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                      {workspace.bookMovements.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-10 text-center text-slate-500">
                            لا توجد قيود مرحلة على حساب البنك حتى تاريخ {asOfDate}
                          </td>
                        </tr>
                      ) : (
                        workspace.bookMovements.map((gl) => {
                          const isSelected = selectedGlLineId === gl.journalLineId;
                          return (
                            <tr
                              key={gl.journalLineId}
                              onClick={() => {
                                if (!gl.isMatched) {
                                  setSelectedGlLineId(isSelected ? '' : gl.journalLineId);
                                }
                              }}
                              className={`transition ${
                                !gl.isMatched ? 'cursor-pointer hover:bg-slate-800/40' : 'opacity-75'
                              } ${isSelected ? 'bg-indigo-600/20' : ''}`}
                            >
                              <td className="py-2.5 px-3">
                                <div className="font-mono text-slate-300">{gl.entryDate}</div>
                                <div className="text-[10px] font-mono text-indigo-400">
                                  {gl.entryNo || gl.entryId.slice(0, 8)}
                                </div>
                              </td>
                              <td className="py-2.5 px-3 text-slate-200">
                                {gl.lineMemo || gl.entryMemo || '—'}
                              </td>
                              <td className="py-2.5 px-3 font-mono tabular-nums text-emerald-400">
                                {Number(gl.debit) > 0 ? gl.debit : '—'}
                              </td>
                              <td className="py-2.5 px-3 font-mono tabular-nums text-rose-400">
                                {Number(gl.credit) > 0 ? gl.credit : '—'}
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                {gl.isMatched ? (
                                  <span className="text-[11px] font-semibold text-emerald-400">مطابق</span>
                                ) : (
                                  <span className="text-[11px] text-amber-400">مفتوح</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Completed Reconciliations History */}
            {workspace.reconciliations.length > 0 && (
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
                <div className="px-5 py-3.5 border-b border-slate-800">
                  <h4 className="text-xs font-bold text-white">سجل التسويات البنكية المعتمدة</h4>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400">
                        <th className="py-2.5 px-4">تاريخ نهاية الكشف</th>
                        <th className="py-2.5 px-4">رصيد الكشف الختامي</th>
                        <th className="py-2.5 px-4">الرصيد الدفتري</th>
                        <th className="py-2.5 px-4">الفارق</th>
                        <th className="py-2.5 px-4">البيان</th>
                        <th className="py-2.5 px-4">تاريخ الاعتماد</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50 text-slate-300">
                      {workspace.reconciliations.map((rec) => (
                        <tr key={rec.id} className="hover:bg-slate-800/30">
                          <td className="py-2.5 px-4 font-mono">{rec.statementEndDate}</td>
                          <td className="py-2.5 px-4 font-mono tabular-nums">{rec.statementEndingBalance}</td>
                          <td className="py-2.5 px-4 font-mono tabular-nums">{rec.bookBalance}</td>
                          <td className="py-2.5 px-4 font-mono tabular-nums text-emerald-400">
                            {rec.differenceAmount}
                          </td>
                          <td className="py-2.5 px-4">{rec.memo || '—'}</td>
                          <td className="py-2.5 px-4 font-mono text-[11px] text-slate-400">
                            {rec.completedAt ? new Date(rec.completedAt).toLocaleDateString('ar-EG') : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )
      )}

      {/* New Bank Account Modal */}
      {showNewBankModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <h4 className="font-bold text-white text-sm">إضافة حساب بنكي جديد</h4>
              <button
                type="button"
                onClick={() => setShowNewBankModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateBank} className="p-6 flex flex-col gap-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">رمز الحساب البنكي *</label>
                  <input
                    type="text"
                    required
                    placeholder="BNK-01"
                    value={newBankForm.code}
                    onChange={(e) => setNewBankForm({ ...newBankForm, code: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">العملة</label>
                  <input
                    type="text"
                    value={newBankForm.currencyCode}
                    placeholder="عملة الشركة الافتراضية"
                    onChange={(e) => setNewBankForm({ ...newBankForm, currencyCode: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">الاسم التعريفي *</label>
                  <input
                    type="text"
                    required
                    placeholder="الحساب الجاري - الراجحي"
                    value={newBankForm.nameAr}
                    onChange={(e) => setNewBankForm({ ...newBankForm, nameAr: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">اسم البنك *</label>
                  <input
                    type="text"
                    required
                    placeholder="مصرف الراجحي"
                    value={newBankForm.bankName}
                    onChange={(e) => setNewBankForm({ ...newBankForm, bankName: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white"
                  />
                </div>
              </div>
              <div>
                <label className="block text-slate-300 mb-1">حساب الأستاذ العام المرتبط (أصول) *</label>
                <select
                  required
                  value={newBankForm.glAccountId}
                  onChange={(e) => setNewBankForm({ ...newBankForm, glAccountId: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white"
                >
                  {assetGlAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} - {a.nameAr}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">رقم الحساب</label>
                  <input
                    type="text"
                    value={newBankForm.accountNumber}
                    onChange={(e) => setNewBankForm({ ...newBankForm, accountNumber: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">الرصيد الافتتاحي</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={newBankForm.openingBalance}
                    onChange={(e) => setNewBankForm({ ...newBankForm, openingBalance: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white font-mono"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowNewBankModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl cursor-pointer"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ الحساب البنكي'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Statement Line Modal */}
      {showAddStmtModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <h4 className="font-bold text-white text-sm">إضافة حركة كشف حساب بنكي</h4>
              <button
                type="button"
                onClick={() => setShowAddStmtModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAddStatementLine} className="p-6 flex flex-col gap-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">تاريخ الحركة *</label>
                  <input
                    type="date"
                    required
                    value={newStmtForm.statementDate}
                    onChange={(e) => setNewStmtForm({ ...newStmtForm, statementDate: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">نوع الحركة *</label>
                  <select
                    value={newStmtForm.direction}
                    onChange={(e) =>
                      setNewStmtForm({ ...newStmtForm, direction: e.target.value as 'credit' | 'debit' })
                    }
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white"
                  >
                    <option value="credit">إيداع / وارد (+)</option>
                    <option value="debit">سحب / صادر (-)</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">المبلغ *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    placeholder="0.00"
                    value={newStmtForm.amount}
                    onChange={(e) => setNewStmtForm({ ...newStmtForm, amount: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">المرجع البنكي</label>
                  <input
                    type="text"
                    placeholder="REF-101"
                    value={newStmtForm.reference}
                    onChange={(e) => setNewStmtForm({ ...newStmtForm, reference: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block text-slate-300 mb-1">البيان *</label>
                <input
                  type="text"
                  required
                  placeholder="تحويل عميل / رسوم بنكية"
                  value={newStmtForm.description}
                  onChange={(e) => setNewStmtForm({ ...newStmtForm, description: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddStmtModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl cursor-pointer"
                >
                  {actionLoading ? 'جاري الإضافة...' : 'إضافة الحركة'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
