import React, { useState, useEffect } from 'react';
import {
  FileText,
  Plus,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  RotateCcw,
  Send,
  Eye,
  X,
  Trash2,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface JournalLine {
  id?: string;
  accountId: string;
  debit: number;
  credit: number;
  lineMemo?: string | null;
  accountCode?: string;
  accountNameAr?: string;
}

interface JournalEntry {
  id: string;
  companyId: string;
  entryDate: string;
  entryNo?: string | null;
  memo?: string | null;
  status: 'draft' | 'posted';
  postedAt?: string | null;
  reversedByEntryId?: string | null;
  orgUnitId?: string | null;
  orgUnitCode?: string | null;
  orgUnitNameAr?: string | null;
  lines?: JournalLine[];
}

interface Account {
  id: string;
  code: string;
  nameAr: string;
  isPostable: boolean;
  isActive: boolean;
}

interface OrgUnit {
  id: string;
  code: string;
  nameAr: string;
  isActive: boolean;
}

interface JournalWorkspaceProps {
  companyId: string;
  canWrite: boolean;
  canPost: boolean;
}

export function JournalWorkspace({ companyId, canWrite, canPost }: JournalWorkspaceProps) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [orgUnits, setOrgUnits] = useState<OrgUnit[]>([]);
  const [filterOrgUnitId, setFilterOrgUnitId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Modals state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<JournalEntry | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // New draft form state
  const [newDate, setNewDate] = useState(new Date().toISOString().split('T')[0]);
  const [newMemo, setNewMemo] = useState('');
  const [newOrgUnitId, setNewOrgUnitId] = useState('');
  const [newLines, setNewLines] = useState<
    { accountId: string; debit: string; credit: string; lineMemo: string }[]
  >([
    { accountId: '', debit: '', credit: '', lineMemo: '' },
    { accountId: '', debit: '', credit: '', lineMemo: '' },
  ]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. Load journals with optional orgUnitId filter
      let url = `/api/accounting/journals?companyId=${companyId}`;
      if (filterOrgUnitId) {
        url += `&orgUnitId=${filterOrgUnitId}`;
      }
      const resJournals = await apiFetch(url);
      if (!resJournals.ok) {
        const data = await resJournals.json();
        throw new Error(data.message || data.error || 'فشل في تحميل قيود اليومية');
      }
      const dataJournals = await resJournals.json();
      setEntries(dataJournals.journals || []);

      // 2. Load accounts for dropdowns
      const resAccounts = await apiFetch(`/api/accounting/accounts?companyId=${companyId}`);
      if (resAccounts.ok) {
        const dataAccounts = await resAccounts.json();
        setAccounts((dataAccounts.accounts || []).filter((a: Account) => a.isPostable && a.isActive));
      }

      // 3. Load org units
      const resOrgUnits = await apiFetch(`/api/companies/${companyId}/org-units`);
      if (resOrgUnits.ok) {
        const dataOrg = await resOrgUnits.json();
        setOrgUnits((dataOrg.orgUnits || []).filter((u: OrgUnit) => u.isActive));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تحميل البيانات');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (companyId) {
      loadData();
    }
  }, [companyId, filterOrgUnitId]);

  const handleAddLine = () => {
    setNewLines([...newLines, { accountId: '', debit: '', credit: '', lineMemo: '' }]);
  };

  const handleRemoveLine = (index: number) => {
    if (newLines.length <= 2) return;
    setNewLines(newLines.filter((_, i) => i !== index));
  };

  const handleLineChange = (
    index: number,
    field: 'accountId' | 'debit' | 'credit' | 'lineMemo',
    value: string
  ) => {
    const updated = [...newLines];
    if (field === 'debit' && value !== '') {
      updated[index].debit = value;
      updated[index].credit = ''; // Single sided entry enforcement
    } else if (field === 'credit' && value !== '') {
      updated[index].credit = value;
      updated[index].debit = ''; // Single sided entry enforcement
    } else {
      updated[index][field] = value;
    }
    setNewLines(updated);
  };

  // Calculations
  const totalDebit = newLines.reduce((acc, l) => acc + (parseFloat(l.debit) || 0), 0);
  const totalCredit = newLines.reduce((acc, l) => acc + (parseFloat(l.credit) || 0), 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.001 && totalDebit > 0;

  const handleCreateDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const formattedLines = newLines
        .filter((l) => l.accountId && (parseFloat(l.debit) > 0 || parseFloat(l.credit) > 0))
        .map((l) => ({
          accountId: l.accountId,
          debit: parseFloat(l.debit) || 0,
          credit: parseFloat(l.credit) || 0,
          lineMemo: l.lineMemo || undefined,
        }));

      if (formattedLines.length < 2) {
        throw new Error('يجب تحديد حسابين على الأقل للقيد مع مبالغ صالحة');
      }

      const res = await apiFetch('/api/accounting/journals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          entryDate: newDate,
          memo: newMemo || undefined,
          orgUnitId: newOrgUnitId || undefined,
          lines: formattedLines,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'تعذر إنشاء مسودة القيد');
      }

      setSuccess('تم إنشاء مسودة القيد بنجاح');
      setShowCreateModal(false);
      setNewMemo('');
      setNewOrgUnitId('');
      setNewLines([
        { accountId: '', debit: '', credit: '', lineMemo: '' },
        { accountId: '', debit: '', credit: '', lineMemo: '' },
      ]);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء إنشاء القيد');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePostEntry = async (id: string) => {
    if (!canPost) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await apiFetch(`/api/accounting/journals/${id}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'فشل في ترحيل القيد');
      }

      setSuccess('تم ترحيل القيد بنجاح وتوليد الرقم التسلسلي');
      if (selectedEntry?.id === id) {
        const updated = await apiFetch(`/api/accounting/journals/${id}?companyId=${companyId}`);
        if (updated.ok) {
          const uData = await updated.json();
          setSelectedEntry(uData.journal);
        }
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء ترحيل القيد');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReverseEntry = async (id: string) => {
    if (!canPost) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await apiFetch(`/api/accounting/journals/${id}/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          reversalMemo: 'عكس القيد المحاسبي بناءً على طلب المستخدم',
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'فشل في عكس القيد');
      }

      setSuccess('تم عكس القيد المحاسبي بنجاح وإنشاء قيد عكسي مرحل');
      if (selectedEntry?.id === id) {
        setSelectedEntry(null);
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء عكس القيد');
    } finally {
      setActionLoading(false);
    }
  };

  const viewEntryDetails = async (id: string) => {
    try {
      const res = await apiFetch(`/api/accounting/journals/${id}?companyId=${companyId}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedEntry(data.journal);
      }
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      {/* Top Header & Action */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">دفتر اليومية العامة (General Ledger)</h3>
            <p className="text-xs text-slate-400">
              تسجيل وترحيل قيود اليومية المحاسبية المزدوجة المتوازنة مع إمكانية العكس الآمن
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {orgUnits.length > 0 && (
            <div className="flex items-center gap-2 bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800 text-xs">
              <span className="text-slate-400">الوحدة:</span>
              <select
                value={filterOrgUnitId}
                onChange={(e) => setFilterOrgUnitId(e.target.value)}
                className="bg-transparent text-slate-200 focus:outline-none text-xs cursor-pointer"
              >
                <option value="" className="bg-slate-900 text-slate-200">كل الوحدات التنظيمية</option>
                {orgUnits.map((ou) => (
                  <option key={ou.id} value={ou.id} className="bg-slate-900 text-slate-200">
                    {ou.code} — {ou.nameAr}
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            onClick={loadData}
            disabled={loading}
            className="p-2.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer"
            title="تحديث"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {canWrite && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>قيد محاسبي جديد</span>
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

      {/* Entries Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">رقم القيد</th>
                <th className="py-3.5 px-4">التاريخ</th>
                <th className="py-3.5 px-4">الوحدة التنظيمية</th>
                <th className="py-3.5 px-4">البيان / الشرح</th>
                <th className="py-3.5 px-4 text-center">الحالة</th>
                <th className="py-3.5 px-4 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    <div className="flex items-center justify-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                      <span>جاري تحميل دفتر القيود...</span>
                    </div>
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    لا توجد قيود مسجلة بعد في دفتر اليومية
                  </td>
                </tr>
              ) : (
                entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-slate-800/30 transition">
                    <td className="py-3.5 px-4 font-mono font-bold text-indigo-300">
                      {entry.entryNo || 'مسودة (لم يرحل)'}
                    </td>
                    <td className="py-3.5 px-4">{entry.entryDate}</td>
                    <td className="py-3.5 px-4 text-slate-300">
                      {entry.orgUnitNameAr ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-slate-800 text-slate-300 font-medium">
                          {entry.orgUnitCode ? `${entry.orgUnitCode} - ` : ''}{entry.orgUnitNameAr}
                        </span>
                      ) : (
                        <span className="text-slate-500 font-mono">—</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-slate-300 max-w-xs truncate">
                      {entry.memo || '—'}
                      {entry.reversedByEntryId && (
                        <span className="mr-2 inline-flex items-center text-[10px] text-amber-400 bg-amber-950/40 px-2 py-0.5 rounded border border-amber-800/40">
                          تم العكس
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      {entry.status === 'posted' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-950/60 border border-emerald-800/80 text-emerald-400">
                          <CheckCircle2 className="w-3 h-3" />
                          <span>مرحّل</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-950/60 border border-amber-800/80 text-amber-400">
                          <span>مسودة</span>
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => viewEntryDetails(entry.id)}
                          className="px-2.5 py-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg text-slate-300 hover:text-white text-[11px] font-medium transition cursor-pointer flex items-center gap-1"
                        >
                          <Eye className="w-3 h-3" />
                          <span>تفاصيل</span>
                        </button>

                        {entry.status === 'draft' && canPost && (
                          <button
                            onClick={() => handlePostEntry(entry.id)}
                            disabled={actionLoading}
                            className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-medium transition cursor-pointer flex items-center gap-1 shadow-md shadow-emerald-600/20"
                          >
                            <Send className="w-3 h-3" />
                            <span>ترحيل</span>
                          </button>
                        )}

                        {entry.status === 'posted' && !entry.reversedByEntryId && canPost && (
                          <button
                            onClick={() => handleReverseEntry(entry.id)}
                            disabled={actionLoading}
                            className="px-2.5 py-1.5 bg-rose-950 hover:bg-rose-900 border border-rose-800 text-rose-300 rounded-lg text-[11px] font-medium transition cursor-pointer flex items-center gap-1"
                            title="عكس القيد المحاسبي"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>عكس</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Entry Details Modal */}
      {selectedEntry && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <FileText className="w-5 h-5 text-indigo-400" />
                <h4 className="font-bold text-white text-sm">
                  تفاصيل القيد المحاسبي: {selectedEntry.entryNo || 'مسودة'}
                </h4>
              </div>
              <button
                onClick={() => setSelectedEntry(null)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex flex-col gap-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 bg-slate-950 p-4 rounded-xl border border-slate-800 text-xs">
                <div>
                  <span className="text-slate-500 block">التاريخ:</span>
                  <span className="font-semibold text-slate-200">{selectedEntry.entryDate}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">الحالة:</span>
                  <span
                    className={`font-semibold ${
                      selectedEntry.status === 'posted' ? 'text-emerald-400' : 'text-amber-400'
                    }`}
                  >
                    {selectedEntry.status === 'posted' ? 'مرحّل' : 'مسودة'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">تاريخ الترحيل:</span>
                  <span className="font-semibold text-slate-200">
                    {selectedEntry.postedAt ? new Date(selectedEntry.postedAt).toLocaleString('ar-EG') : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">القيد العكسي:</span>
                  <span className="font-semibold text-slate-200">
                    {selectedEntry.reversedByEntryId ? 'تم العكس' : 'لا يوجد'}
                  </span>
                </div>
              </div>

              {selectedEntry.memo && (
                <div className="text-xs bg-slate-950/60 p-3 rounded-xl border border-slate-800 text-slate-300">
                  <span className="text-slate-500 font-semibold block mb-1">البيان / الشرح:</span>
                  {selectedEntry.memo}
                </div>
              )}

              {/* Lines Table */}
              <div className="border border-slate-800 rounded-xl overflow-hidden">
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="bg-slate-950 border-b border-slate-800 text-slate-400">
                      <th className="py-2.5 px-3">كود الحساب</th>
                      <th className="py-2.5 px-3">اسم الحساب</th>
                      <th className="py-2.5 px-3">شرح السطر</th>
                      <th className="py-2.5 px-3 text-left">مدين</th>
                      <th className="py-2.5 px-3 text-left">دائن</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-200">
                    {selectedEntry.lines?.map((line, idx) => (
                      <tr key={idx} className="hover:bg-slate-800/20">
                        <td className="py-2 px-3 font-mono text-indigo-400">{line.accountCode || '—'}</td>
                        <td className="py-2 px-3">{line.accountNameAr || line.accountId}</td>
                        <td className="py-2 px-3 text-slate-400">{line.lineMemo || '—'}</td>
                        <td className="py-2 px-3 text-left font-mono font-semibold text-emerald-400">
                          {line.debit > 0 ? line.debit.toFixed(2) : '—'}
                        </td>
                        <td className="py-2 px-3 text-left font-mono font-semibold text-rose-400">
                          {line.credit > 0 ? line.credit.toFixed(2) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-950 font-bold border-t border-slate-800 text-xs">
                      <td colSpan={3} className="py-3 px-3 text-right">
                        الإجمالي:
                      </td>
                      <td className="py-3 px-3 text-left font-mono text-emerald-400">
                        {(selectedEntry.lines || []).reduce((acc, l) => acc + (l.debit || 0), 0).toFixed(2)}
                      </td>
                      <td className="py-3 px-3 text-left font-mono text-rose-400">
                        {(selectedEntry.lines || []).reduce((acc, l) => acc + (l.credit || 0), 0).toFixed(2)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            <div className="p-4 border-t border-slate-800 bg-slate-950 flex items-center justify-end gap-2">
              {selectedEntry.status === 'draft' && canPost && (
                <button
                  onClick={() => handlePostEntry(selectedEntry.id)}
                  disabled={actionLoading}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition cursor-pointer flex items-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>ترحيل القيد</span>
                </button>
              )}

              {selectedEntry.status === 'posted' && !selectedEntry.reversedByEntryId && canPost && (
                <button
                  onClick={() => handleReverseEntry(selectedEntry.id)}
                  disabled={actionLoading}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold transition cursor-pointer flex items-center gap-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>عكس القيد</span>
                </button>
              )}

              <button
                onClick={() => setSelectedEntry(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition cursor-pointer"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Draft Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl flex flex-col max-h-[92vh]">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Plus className="w-5 h-5 text-indigo-400" />
                <h4 className="font-bold text-white text-sm">إنشاء قيد محاسبي جديد</h4>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateDraft} className="p-6 overflow-y-auto flex flex-col gap-5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    تاريخ القيد <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={newDate}
                    onChange={(e) => setNewDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    الوحدة التنظيمية (اختياري)
                  </label>
                  <select
                    value={newOrgUnitId}
                    onChange={(e) => setNewOrgUnitId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">(غير محدد - على مستوى الشركة)</option>
                    {orgUnits.map((ou) => (
                      <option key={ou.id} value={ou.id}>
                        {ou.code} — {ou.nameAr}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    البيان العام للقيد
                  </label>
                  <input
                    type="text"
                    value={newMemo}
                    onChange={(e) => setNewMemo(e.target.value)}
                    placeholder="شرح طبيعة القيد المحاسبي..."
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Lines Input */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300">أسطر القيد (على الأقل سطرين):</span>
                  <button
                    type="button"
                    onClick={handleAddLine}
                    className="text-indigo-400 hover:text-indigo-300 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>إضافة سطر</span>
                  </button>
                </div>

                <div className="border border-slate-800 rounded-xl overflow-hidden">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="bg-slate-950 border-b border-slate-800 text-slate-400">
                        <th className="py-2.5 px-3 w-5/12">الحساب</th>
                        <th className="py-2.5 px-3 w-2/12">مدين</th>
                        <th className="py-2.5 px-3 w-2/12">دائن</th>
                        <th className="py-2.5 px-3 w-3/12">شرح السطر</th>
                        <th className="py-2.5 px-2 w-8"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {newLines.map((line, idx) => (
                        <tr key={idx} className="bg-slate-900/40">
                          <td className="py-2 px-2">
                            <select
                              required
                              value={line.accountId}
                              onChange={(e) => handleLineChange(idx, 'accountId', e.target.value)}
                              className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white focus:outline-none focus:border-indigo-500"
                            >
                              <option value="">اختر الحساب...</option>
                              {accounts.map((acc) => (
                                <option key={acc.id} value={acc.id}>
                                  {acc.code} — {acc.nameAr}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-2">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              placeholder="0.00"
                              value={line.debit}
                              onChange={(e) => handleLineChange(idx, 'debit', e.target.value)}
                              className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-emerald-400 font-mono text-left focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="py-2 px-2">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              placeholder="0.00"
                              value={line.credit}
                              onChange={(e) => handleLineChange(idx, 'credit', e.target.value)}
                              className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-rose-400 font-mono text-left focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="py-2 px-2">
                            <input
                              type="text"
                              placeholder="شرح اختياري..."
                              value={line.lineMemo}
                              onChange={(e) => handleLineChange(idx, 'lineMemo', e.target.value)}
                              className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="py-2 px-2 text-center">
                            {newLines.length > 2 && (
                              <button
                                type="button"
                                onClick={() => handleRemoveLine(idx)}
                                className="text-slate-500 hover:text-red-400 p-1 transition cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-950 font-bold border-t border-slate-800 text-xs">
                        <td className="py-3 px-3 text-right">المجموع:</td>
                        <td className="py-3 px-2 text-left font-mono text-emerald-400">
                          {totalDebit.toFixed(2)}
                        </td>
                        <td className="py-3 px-2 text-left font-mono text-rose-400">
                          {totalCredit.toFixed(2)}
                        </td>
                        <td colSpan={2} className="py-3 px-3 text-left">
                          {isBalanced ? (
                            <span className="text-emerald-400 flex items-center gap-1 font-semibold text-[11px]">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>القيد متوازن</span>
                            </span>
                          ) : (
                            <span className="text-amber-400 flex items-center gap-1 font-semibold text-[11px]">
                              <AlertCircle className="w-3.5 h-3.5" />
                              <span>غير متوازن (الفرق: {Math.abs(totalDebit - totalCredit).toFixed(2)})</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              <div className="p-4 border-t border-slate-800 bg-slate-950/80 -mx-6 -mb-6 flex items-center justify-end gap-3 mt-4">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition cursor-pointer shadow-lg shadow-indigo-600/20 disabled:opacity-50"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ كمسودة'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
