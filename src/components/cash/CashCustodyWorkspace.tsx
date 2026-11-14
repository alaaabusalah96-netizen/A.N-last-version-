import React, { useState, useEffect, useCallback } from 'react';
import {
  Wallet,
  Landmark,
  Receipt,
  Users,
  Plus,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  X,
  Building2,
  Edit3,
  Power,
  Eye,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { AccountOption, usableAccounts } from '../../lib/accountRules.js';

interface Company {
  id: string;
  code: string;
  nameAr: string;
}

interface CashRegister {
  id: string;
  companyId: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  glAccountId: string;
  glAccountCode?: string | null;
  glAccountNameAr?: string | null;
  openingBalance: number;
  isActive: boolean;
  memo?: string | null;
  createdAt: string;
}

interface RegisterBalance {
  registerId: string;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  currentBalance: number;
}

type CustodyStatus = 'pending' | 'approved' | 'rejected' | 'open' | 'settled' | 'cancelled';

interface CustodyRecord {
  id: string;
  companyId: string;
  custodyNo: string | null;
  employeeUserId: string;
  employeeUsername?: string | null;
  registerId: string;
  registerCode?: string | null;
  registerNameAr?: string | null;
  amount: number;
  purpose: string;
  status: CustodyStatus;
  requestDate: string;
  requestedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  disbursedBy: string | null;
  disbursedAt: string | null;
  settledBy: string | null;
  settledAt: string | null;
  disburseJournalEntryId: string | null;
  disburseJournalEntryNo?: string | null;
  settleJournalEntryId: string | null;
  settleJournalEntryNo?: string | null;
  settledExpenseTotal: number | null;
  settledCashReturn: number | null;
  memo: string | null;
  createdAt: string;
}

interface CustodyMovement {
  id: string;
  custodyId: string;
  registerId: string;
  movementType: 'disburse' | 'settle_expense' | 'settle_return' | 'reverse';
  direction: 'out' | 'in' | 'none';
  amount: number;
  expenseAccountId: string | null;
  expenseAccountCode?: string | null;
  expenseAccountNameAr?: string | null;
  journalEntryId: string | null;
  journalEntryNo?: string | null;
  memo: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface CustodyEmployeeOption {
  userId: string;
  username: string;
  role: string;
  roleId?: string | null;
}

interface OpenCustodyEmployeeSummary {
  employeeUserId: string;
  employeeUsername: string;
  openCount: number;
  totalAmount: number;
}

export interface CashCustodyWorkspaceProps {
  userRole: string;
  permissions: string[];
}

type CashTabKey = 'registers' | 'custodies' | 'open_balances';

const TABS: Array<{
  key: CashTabKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { key: 'registers', label: 'الصناديق', icon: Landmark },
  { key: 'custodies', label: 'العهد', icon: Receipt },
  { key: 'open_balances', label: 'أرصدة العهد المفتوحة', icon: Users },
];

const CUSTODY_STATUS_LABELS: Record<CustodyStatus, string> = {
  pending: 'قيد الانتظار',
  approved: 'معتمدة',
  rejected: 'مرفوضة',
  open: 'مفتوحة',
  settled: 'مسوّاة',
  cancelled: 'ملغاة',
};

const CUSTODY_STATUS_STYLES: Record<CustodyStatus, string> = {
  pending: 'text-amber-300',
  approved: 'text-sky-300',
  rejected: 'text-rose-300',
  open: 'text-indigo-300',
  settled: 'text-emerald-300',
  cancelled: 'text-slate-400',
};

const MOVEMENT_TYPE_LABELS: Record<CustodyMovement['movementType'], string> = {
  disburse: 'صرف عهدة',
  settle_expense: 'تسوية مصروف',
  settle_return: 'مرتجع نقدي',
  reverse: 'عكس حركة',
};

const DIRECTION_LABELS: Record<CustodyMovement['direction'], string> = {
  out: 'منصرف (out)',
  in: 'وارد (in)',
  none: 'قيد مصروف (none)',
};

function toCents(val: number | string): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

export function CashCustodyWorkspace({ userRole, permissions }: CashCustodyWorkspaceProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<CashTabKey>('registers');

  const [registers, setRegisters] = useState<CashRegister[]>([]);
  const [balancesByRegisterId, setBalancesByRegisterId] = useState<Record<string, RegisterBalance>>({});
  const [custodies, setCustodies] = useState<CustodyRecord[]>([]);
  const [employees, setEmployees] = useState<CustodyEmployeeOption[]>([]);
  const [openSummary, setOpenSummary] = useState<OpenCustodyEmployeeSummary[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);

  // Custody list filters
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterEmployeeId, setFilterEmployeeId] = useState<string>('');
  const [filterRegisterId, setFilterRegisterId] = useState<string>('');
  const [filterFrom, setFilterFrom] = useState<string>('');
  const [filterTo, setFilterTo] = useState<string>('');

  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Register Modals
  const [showCreateRegisterModal, setShowCreateRegisterModal] = useState(false);
  const [regCode, setRegCode] = useState('');
  const [regNameAr, setRegNameAr] = useState('');
  const [regNameEn, setRegNameEn] = useState('');
  const [regGlAccountId, setRegGlAccountId] = useState('');
  const [regOpeningBalance, setRegOpeningBalance] = useState('0');
  const [regMemo, setRegMemo] = useState('');

  const [editingRegister, setEditingRegister] = useState<CashRegister | null>(null);
  const [editRegNameAr, setEditRegNameAr] = useState('');
  const [editRegNameEn, setEditRegNameEn] = useState('');
  const [editRegMemo, setEditRegMemo] = useState('');
  const [editRegIsActive, setEditRegIsActive] = useState(true);

  // Request Custody Modal
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [reqEmployeeUserId, setReqEmployeeUserId] = useState('');
  const [reqRegisterId, setReqRegisterId] = useState('');
  const [reqAmount, setReqAmount] = useState('');
  const [reqPurpose, setReqPurpose] = useState('');
  const [reqDate, setReqDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reqMemo, setReqMemo] = useState('');

  // Reject Modal
  const [rejectTarget, setRejectTarget] = useState<CustodyRecord | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // Settle Modal
  const [settleTarget, setSettleTarget] = useState<CustodyRecord | null>(null);
  const [settleLines, setSettleLines] = useState<Array<{ expenseAccountId: string; amount: string; memo: string }>>([
    { expenseAccountId: '', amount: '', memo: '' },
  ]);
  const [settleCashReturn, setSettleCashReturn] = useState('0');
  const [settleMemo, setSettleMemo] = useState('');

  // Detail & Movements Drawer/Modal
  const [detailCustody, setDetailCustody] = useState<CustodyRecord | null>(null);
  const [detailMovements, setDetailMovements] = useState<CustodyMovement[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // WP-6: fail-open للعرض فقط عند غياب القائمة؛ الحكم النهائي للخادم
  const can = useCallback(
    (perm: string): boolean => {
      if (userRole === 'platform_admin') return true;
      if (permissions.length === 0) return true;
      return permissions.includes(perm);
    },
    [userRole, permissions]
  );

  // Load companies on mount (PurchasingWorkspace pattern)
  useEffect(() => {
    let mounted = true;
    async function loadCompanies() {
      try {
        const res = await apiFetch('/api/companies');
        if (!res.ok) return;
        const data = await res.json();
        if (!mounted) return;
        const list: Company[] = data.companies || [];
        setCompanies(list);
        if (list.length > 0) {
          setSelectedCompanyId(list[0].id);
        }
      } catch {
        // handled cleanly
      }
    }
    loadCompanies();
    return () => {
      mounted = false;
    };
  }, []);

  const loadData = useCallback(async () => {
    if (!selectedCompanyId) return;
    setLoading(true);
    setError(null);

    try {
      const custodyParams = new URLSearchParams({ companyId: selectedCompanyId });
      if (filterStatus) custodyParams.set('status', filterStatus);
      if (filterEmployeeId) custodyParams.set('employeeUserId', filterEmployeeId);
      if (filterRegisterId) custodyParams.set('registerId', filterRegisterId);
      if (filterFrom) custodyParams.set('from', filterFrom);
      if (filterTo) custodyParams.set('to', filterTo);

      const reqs: Promise<Response>[] = [
        apiFetch(`/api/cash/registers?companyId=${encodeURIComponent(selectedCompanyId)}`),
        apiFetch(`/api/cash/custodies?${custodyParams.toString()}`),
        apiFetch(`/api/cash/reports/open-custodies?companyId=${encodeURIComponent(selectedCompanyId)}`),
        apiFetch(`/api/accounting/accounts?companyId=${encodeURIComponent(selectedCompanyId)}`),
      ];

      if (can('custody:request')) {
        reqs.push(apiFetch(`/api/cash/custodies/employees?companyId=${encodeURIComponent(selectedCompanyId)}`));
      }

      const [regRes, cusRes, openRes, accRes, empRes] = await Promise.all(reqs);

      if (!regRes.ok) {
        const errBody = await regRes.json().catch(() => ({}));
        throw new Error(errBody.message || errBody.error || 'تعذر تحميل قائمة الصناديق');
      }

      const regBody = await regRes.json();
      const loadedRegisters: CashRegister[] = regBody.registers || [];
      setRegisters(loadedRegisters);

      // Fetch balances directly from server API per register (never calculated client-side)
      const balancePairs = await Promise.all(
        loadedRegisters.map(async (r) => {
          try {
            const bRes = await apiFetch(
              `/api/cash/registers/${r.id}/balance?companyId=${encodeURIComponent(selectedCompanyId)}`
            );
            if (!bRes.ok) return null;
            const bData = await bRes.json();
            return [r.id, bData.balance as RegisterBalance] as const;
          } catch {
            return null;
          }
        })
      );
      const nextBalances: Record<string, RegisterBalance> = {};
      for (const pair of balancePairs) {
        if (pair && pair[1]) {
          nextBalances[pair[0]] = pair[1];
        }
      }
      setBalancesByRegisterId(nextBalances);

      if (cusRes.ok) {
        const cusBody = await cusRes.json();
        setCustodies(cusBody.custodies || []);
      } else {
        const errBody = await cusRes.json().catch(() => ({}));
        throw new Error(errBody.message || errBody.error || 'تعذر تحميل قائمة العهد');
      }

      if (openRes.ok) {
        const openBody = await openRes.json();
        setOpenSummary(openBody.summary || []);
      }

      if (accRes.ok) {
        const accBody = await accRes.json();
        setAccounts(accBody.accounts || []);
      }

      if (empRes && empRes.ok) {
        const empBody = await empRes.json();
        setEmployees(empBody.employees || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تحميل بيانات الخزينة والعهد');
    } finally {
      setLoading(false);
    }
  }, [selectedCompanyId, filterStatus, filterEmployeeId, filterRegisterId, filterFrom, filterTo, can]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreateRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!can('cash:write')) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch('/api/cash/registers', {
        method: 'POST',
        body: JSON.stringify({
          companyId: selectedCompanyId,
          code: regCode.trim(),
          nameAr: regNameAr.trim(),
          nameEn: regNameEn.trim() || undefined,
          glAccountId: regGlAccountId,
          openingBalance: Number(regOpeningBalance || 0),
          memo: regMemo.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر إنشاء الصندوق');

      setSuccess(`تم إنشاء الصندوق (${data.register?.nameAr || regNameAr}) بنجاح`);
      setShowCreateRegisterModal(false);
      setRegCode('');
      setRegNameAr('');
      setRegNameEn('');
      setRegGlAccountId('');
      setRegOpeningBalance('0');
      setRegMemo('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حدث خطأ أثناء إنشاء الصندوق');
    } finally {
      setActionLoading(false);
    }
  };

  const handleOpenEditRegister = (reg: CashRegister) => {
    setEditingRegister(reg);
    setEditRegNameAr(reg.nameAr);
    setEditRegNameEn(reg.nameEn || '');
    setEditRegMemo(reg.memo || '');
    setEditRegIsActive(reg.isActive);
  };

  const handleUpdateRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRegister || !can('cash:write')) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/cash/registers/${editingRegister.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          companyId: selectedCompanyId,
          nameAr: editRegNameAr.trim(),
          nameEn: editRegNameEn.trim() || null,
          memo: editRegMemo.trim() || null,
          isActive: editRegIsActive,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر تعديل الصندوق');

      setSuccess(`تم تحديث الصندوق (${data.register?.nameAr || editRegNameAr}) بنجاح`);
      setEditingRegister(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حدث خطأ أثناء تعديل الصندوق');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeactivateRegister = async (reg: CashRegister) => {
    if (!can('cash:write')) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/cash/registers/${reg.id}/deactivate`, {
        method: 'POST',
        body: JSON.stringify({ companyId: selectedCompanyId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر تعطيل الصندوق');

      setSuccess(`تم تعطيل الصندوق (${reg.nameAr}) بنجاح`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حدث خطأ أثناء تعطيل الصندوق');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRequestCustody = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!can('custody:request')) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch('/api/cash/custodies', {
        method: 'POST',
        body: JSON.stringify({
          companyId: selectedCompanyId,
          employeeUserId: reqEmployeeUserId,
          registerId: reqRegisterId,
          amount: Number(reqAmount),
          purpose: reqPurpose.trim(),
          requestDate: reqDate || undefined,
          memo: reqMemo.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر تقديم طلب العهدة');

      setSuccess(`تم تسجيل طلب العهدة (${data.custody?.custodyNo || ''}) بنجاح`);
      setShowRequestModal(false);
      setReqEmployeeUserId('');
      setReqRegisterId('');
      setReqAmount('');
      setReqPurpose('');
      setReqMemo('');
      setActiveTab('custodies');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حدث خطأ أثناء تقديم طلب العهدة');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCustodyAction = async (
    custody: CustodyRecord,
    action: 'approve' | 'disburse' | 'cancel',
    extraBody?: Record<string, unknown>
  ) => {
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/cash/custodies/${custody.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ companyId: selectedCompanyId, ...(extraBody || {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر تنفيذ العملية على العهدة');

      const label = data.custody?.custodyNo || custody.custodyNo || custody.id.slice(0, 8);
      const verb = action === 'approve' ? 'اعتماد' : action === 'disburse' ? 'صرف' : 'إلغاء';
      setSuccess(`تم ${verb} العهدة (${label}) بنجاح`);
      await loadData();
      if (detailCustody?.id === custody.id && data.custody) {
        setDetailCustody(data.custody);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حدث خطأ أثناء تحديث العهدة');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRejectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectTarget) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/cash/custodies/${rejectTarget.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({
          companyId: selectedCompanyId,
          reason: rejectReason.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر رفض العهدة');

      setSuccess(`تم رفض العهدة (${rejectTarget.custodyNo || ''}) بنجاح`);
      setRejectTarget(null);
      setRejectReason('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حدث خطأ أثناء رفض العهدة');
    } finally {
      setActionLoading(false);
    }
  };

  const openSettleModal = (custody: CustodyRecord) => {
    setSettleTarget(custody);
    setSettleLines([{ expenseAccountId: '', amount: '', memo: '' }]);
    setSettleCashReturn('0');
    setSettleMemo('');
  };

  // Display counter only (in integer cents, no Array.reduce used). Authoritative enforcement stays on the server.
  let settleAllocatedCents = toCents(settleCashReturn || '0');
  for (const line of settleLines) {
    settleAllocatedCents += toCents(line.amount || '0');
  }
  const settleTargetCents = settleTarget ? toCents(settleTarget.amount) : 0;
  const settleDiffCents = settleTargetCents - settleAllocatedCents;

  const handleSettleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settleTarget || !can('custody:settle')) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const payloadLines = settleLines
        .filter((l) => l.expenseAccountId !== '' || Number(l.amount) > 0)
        .map((l) => ({
          expenseAccountId: l.expenseAccountId,
          amount: Number(l.amount || 0),
          memo: l.memo.trim() || undefined,
        }));

      const res = await apiFetch(`/api/cash/custodies/${settleTarget.id}/settle`, {
        method: 'POST',
        body: JSON.stringify({
          companyId: selectedCompanyId,
          lines: payloadLines,
          cashReturn: Number(settleCashReturn || 0),
          memo: settleMemo.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر تسوية العهدة');

      setSuccess(`تمت تسوية العهدة (${data.custody?.custodyNo || settleTarget.custodyNo || ''}) بنجاح`);
      setSettleTarget(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حدث خطأ أثناء تسوية العهدة');
    } finally {
      setActionLoading(false);
    }
  };

  const openCustodyDetail = async (custody: CustodyRecord) => {
    setDetailCustody(custody);
    setDetailMovements([]);
    setLoadingDetail(true);
    try {
      const [detailRes, movRes] = await Promise.all([
        apiFetch(`/api/cash/custodies/${custody.id}?companyId=${encodeURIComponent(selectedCompanyId)}`),
        apiFetch(`/api/cash/custodies/${custody.id}/movements?companyId=${encodeURIComponent(selectedCompanyId)}`),
      ]);
      if (detailRes.ok) {
        const d = await detailRes.json();
        if (d.custody) setDetailCustody(d.custody);
      }
      if (movRes.ok) {
        const m = await movRes.json();
        setDetailMovements(m.movements || []);
      }
    } catch {
      // keep drawer open with current summary
    } finally {
      setLoadingDetail(false);
    }
  };

  const registerGlOptions = usableAccounts(accounts, 'cash_register_gl_account');
  const expenseAccountOptions = usableAccounts(accounts, 'custody_expense_account');

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      {/* Header & Company Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
            <Wallet className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">الخزينة والعهد النقدية</h3>
            <p className="text-xs text-slate-400">إدارة الصناديق ودورة العهد من الطلب حتى التسوية المحاسبية</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-300">
            <Building2 className="w-4 h-4 text-slate-400" />
            <select
              aria-label="اختيار الشركة"
              value={selectedCompanyId}
              onChange={(e) => setSelectedCompanyId(e.target.value)}
              className="bg-transparent text-white focus:outline-none font-medium cursor-pointer"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id} className="bg-slate-900 text-white">
                  {c.nameAr} ({c.code})
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={loadData}
            disabled={loading}
            className="p-2.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer"
            title="تحديث البيانات"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {can('cash:write') && (
            <button
              type="button"
              onClick={() => setShowCreateRegisterModal(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>صندوق جديد</span>
            </button>
          )}

          {can('custody:request') && (
            <button
              type="button"
              onClick={() => setShowRequestModal(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-emerald-600/20 transition cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>طلب عهدة</span>
            </button>
          )}
        </div>
      </div>

      {/* Feedback Alerts */}
      {error && (
        <div role="alert" className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div role="status" className="p-4 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          <span>{success}</span>
        </div>
      )}

      {/* Extensible Tab Bar (never hidden by permissions) */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-2" role="tablist">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
                isActive
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                  : 'bg-slate-900 text-slate-400 hover:text-white'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab 1: Cash Registers */}
      {activeTab === 'registers' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">الكود</th>
                  <th className="py-3.5 px-4">الاسم</th>
                  <th className="py-3.5 px-4">حساب النقدية</th>
                  <th className="py-3.5 px-4">الرصيد الحالي</th>
                  <th className="py-3.5 px-4">الحالة</th>
                  <th className="py-3.5 px-4 text-center">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {loading && registers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400">
                      جاري تحميل الصناديق...
                    </td>
                  </tr>
                ) : registers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-500">
                      لا توجد صناديق بعد
                    </td>
                  </tr>
                ) : (
                  registers.map((reg) => {
                    const bal = balancesByRegisterId[reg.id];
                    const linkedAcc = accounts.find((a) => a.id === reg.glAccountId);
                    const glDisplay = reg.glAccountCode
                      ? `${reg.glAccountCode} - ${reg.glAccountNameAr || ''}`
                      : linkedAcc
                      ? `${linkedAcc.code} - ${linkedAcc.nameAr}`
                      : reg.glAccountId;
                    return (
                      <tr key={reg.id} className="hover:bg-slate-800/30 transition">
                        <td className="py-3.5 px-4 font-mono tabular-nums font-bold text-indigo-300">{reg.code}</td>
                        <td className="py-3.5 px-4 font-medium text-white">{reg.nameAr}</td>
                        <td className="py-3.5 px-4 text-slate-300">{glDisplay}</td>
                        <td className="py-3.5 px-4 font-mono tabular-nums font-bold text-emerald-300">
                          {bal ? bal.currentBalance.toFixed(2) : Number(reg.openingBalance).toFixed(2)}
                        </td>
                        <td className="py-3.5 px-4">
                          <span className={reg.isActive ? 'text-emerald-400 font-semibold' : 'text-slate-400'}>
                            {reg.isActive ? 'نشط' : 'معطّل'}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          {can('cash:write') && (
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleOpenEditRegister(reg)}
                                disabled={actionLoading}
                                className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-[11px] font-semibold transition cursor-pointer whitespace-nowrap shrink-0"
                              >
                                <Edit3 className="w-3 h-3" />
                                <span>تعديل</span>
                              </button>
                              {reg.isActive && (
                                <button
                                  type="button"
                                  onClick={() => handleDeactivateRegister(reg)}
                                  disabled={actionLoading}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-rose-900/60 hover:bg-rose-800 text-rose-200 rounded-lg text-[11px] font-semibold transition cursor-pointer whitespace-nowrap shrink-0"
                                >
                                  <Power className="w-3 h-3" />
                                  <span>تعطيل</span>
                                </button>
                              )}
                            </div>
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
      )}

      {/* Tab 2: Custodies */}
      {activeTab === 'custodies' && (
        <div className="flex flex-col gap-4">
          {/* Filter Bar */}
          <div
            data-testid="custody-filter-bar"
            className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3"
          >
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">الحالة</label>
              <select
                aria-label="تصفية حسب الحالة"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="">كل الحالات</option>
                <option value="pending">قيد الانتظار</option>
                <option value="approved">معتمدة</option>
                <option value="open">مفتوحة</option>
                <option value="settled">مسوّاة</option>
                <option value="rejected">مرفوضة</option>
                <option value="cancelled">ملغاة</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">الموظف</label>
              <select
                aria-label="تصفية حسب الموظف"
                value={filterEmployeeId}
                onChange={(e) => setFilterEmployeeId(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="">كل الموظفين</option>
                {employees.map((emp) => (
                  <option key={emp.userId} value={emp.userId}>
                    {emp.username}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">الصندوق</label>
              <select
                aria-label="تصفية حسب الصندوق"
                value={filterRegisterId}
                onChange={(e) => setFilterRegisterId(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="">كل الصناديق</option>
                {registers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.nameAr} ({r.code})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">من تاريخ</label>
              <input
                aria-label="من تاريخ"
                type="date"
                value={filterFrom}
                onChange={(e) => setFilterFrom(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">إلى تاريخ</label>
              <input
                aria-label="إلى تاريخ"
                type="date"
                value={filterTo}
                onChange={(e) => setFilterTo(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Custodies Table */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                    <th className="py-3.5 px-4">رقم العهدة</th>
                    <th className="py-3.5 px-4">الموظف</th>
                    <th className="py-3.5 px-4">الصندوق</th>
                    <th className="py-3.5 px-4">المبلغ</th>
                    <th className="py-3.5 px-4">الحالة</th>
                    <th className="py-3.5 px-4">تاريخ الطلب</th>
                    <th className="py-3.5 px-4 text-center">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {loading && custodies.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-12 text-center text-slate-400">
                        جاري تحميل العهد...
                      </td>
                    </tr>
                  ) : custodies.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-12 text-center text-slate-500">
                        لا توجد عهد مطابقة للبحث حالياً
                      </td>
                    </tr>
                  ) : (
                    custodies.map((c) => (
                      <tr
                        key={c.id}
                        data-custody-status={c.status}
                        onClick={() => openCustodyDetail(c)}
                        className="hover:bg-slate-800/40 transition cursor-pointer"
                      >
                        <td className="py-3.5 px-4 font-mono tabular-nums font-bold text-indigo-300">
                          <span className="inline-flex items-center gap-1.5">
                            <Eye className="w-3.5 h-3.5 text-slate-400" />
                            <span>{c.custodyNo || c.id.slice(0, 8)}</span>
                          </span>
                        </td>
                        <td className="py-3.5 px-4 font-medium text-white">{c.employeeUsername || c.employeeUserId}</td>
                        <td className="py-3.5 px-4 text-slate-300">
                          {c.registerCode ? `${c.registerCode} · ${c.registerNameAr || ''}` : c.registerNameAr || c.registerId}
                        </td>
                        <td className="py-3.5 px-4 font-mono tabular-nums font-bold text-emerald-300">
                          {Number(c.amount).toFixed(2)}
                        </td>
                        <td className={`py-3.5 px-4 font-semibold ${CUSTODY_STATUS_STYLES[c.status]}`}>
                          {CUSTODY_STATUS_LABELS[c.status] || c.status}
                        </td>
                        <td className="py-3.5 px-4 font-mono tabular-nums text-slate-400">{c.requestDate}</td>
                        <td className="py-3.5 px-4 text-center" onClick={(e) => e.stopPropagation()}>
                          <div className="inline-flex items-center justify-center gap-1.5">
                            {c.status === 'pending' && can('custody:approve') && (
                              <>
                                <button
                                  type="button"
                                  disabled={actionLoading}
                                  onClick={() => handleCustodyAction(c, 'approve')}
                                  className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold transition cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                                >
                                  اعتماد
                                </button>
                                <button
                                  type="button"
                                  disabled={actionLoading}
                                  onClick={() => {
                                    setRejectTarget(c);
                                    setRejectReason('');
                                  }}
                                  className="px-2.5 py-1 bg-rose-700 hover:bg-rose-600 text-white rounded-lg text-[11px] font-bold transition cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                                >
                                  رفض
                                </button>
                              </>
                            )}
                            {c.status === 'pending' && can('custody:request') && (
                              <button
                                type="button"
                                disabled={actionLoading}
                                onClick={() => handleCustodyAction(c, 'cancel')}
                                className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-[11px] font-bold transition cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                              >
                                إلغاء
                              </button>
                            )}
                            {c.status === 'approved' && can('custody:disburse') && (
                              <button
                                type="button"
                                disabled={actionLoading}
                                onClick={() => handleCustodyAction(c, 'disburse')}
                                className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[11px] font-bold transition cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                              >
                                صرف
                              </button>
                            )}
                            {c.status === 'approved' && can('custody:approve') && (
                              <button
                                type="button"
                                disabled={actionLoading}
                                onClick={() => handleCustodyAction(c, 'cancel')}
                                className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-[11px] font-bold transition cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                              >
                                إلغاء
                              </button>
                            )}
                            {c.status === 'open' && can('custody:settle') && (
                              <button
                                type="button"
                                disabled={actionLoading}
                                onClick={() => openSettleModal(c)}
                                className="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-[11px] font-bold transition cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                              >
                                تسوية
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
        </div>
      )}

      {/* Tab 3: Open Custody Balances by Employee */}
      {activeTab === 'open_balances' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">الموظف</th>
                  <th className="py-3.5 px-4">عدد العهد</th>
                  <th className="py-3.5 px-4">إجمالي المبلغ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {loading && openSummary.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-12 text-center text-slate-400">
                      جاري تحميل أرصدة العهد المفتوحة...
                    </td>
                  </tr>
                ) : openSummary.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-12 text-center text-slate-500">
                      لا توجد عهد مفتوحة على الموظفين حالياً
                    </td>
                  </tr>
                ) : (
                  openSummary.map((row) => (
                    <tr key={row.employeeUserId} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-medium text-white">
                        {row.employeeUsername || row.employeeUserId}
                      </td>
                      <td className="py-3.5 px-4 font-mono tabular-nums text-indigo-300 font-bold">{row.openCount}</td>
                      <td className="py-3.5 px-4 font-mono tabular-nums text-emerald-300 font-bold">
                        {Number(row.totalAmount).toFixed(2)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create Register Modal */}
      {showCreateRegisterModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إنشاء صندوق جديد</h4>
              <button type="button" onClick={() => setShowCreateRegisterModal(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateRegister} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">كود الصندوق *</label>
                <input
                  type="text"
                  name="code"
                  required
                  value={regCode}
                  onChange={(e) => setRegCode(e.target.value)}
                  placeholder="مثال: CASH-01"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الاسم بالعربية *</label>
                <input
                  type="text"
                  name="nameAr"
                  required
                  value={regNameAr}
                  onChange={(e) => setRegNameAr(e.target.value)}
                  placeholder="مثال: الخزينة الرئيسية"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">حساب النقدية في الدليل المحاسبي *</label>
                <select
                  name="glAccountId"
                  required
                  value={regGlAccountId}
                  onChange={(e) => setRegGlAccountId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value="">-- اختر حساب النقدية --</option>
                  {registerGlOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} - {a.nameAr}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الرصيد الافتتاحي</label>
                <input
                  type="number"
                  name="openingBalance"
                  step="0.01"
                  min="0"
                  value={regOpeningBalance}
                  onChange={(e) => setRegOpeningBalance(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono tabular-nums focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">ملاحظات</label>
                <input
                  type="text"
                  name="memo"
                  value={regMemo}
                  onChange={(e) => setRegMemo(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCreateRegisterModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-indigo-600/20 disabled:opacity-50 cursor-pointer"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ الصندوق'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Register Modal */}
      {editingRegister && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">تعديل بيانات الصندوق ({editingRegister.code})</h4>
              <button type="button" onClick={() => setEditingRegister(null)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleUpdateRegister} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الاسم بالعربية *</label>
                <input
                  type="text"
                  required
                  value={editRegNameAr}
                  onChange={(e) => setEditRegNameAr(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الاسم بالإنجليزية</label>
                <input
                  type="text"
                  value={editRegNameEn}
                  onChange={(e) => setEditRegNameEn(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">ملاحظات</label>
                <input
                  type="text"
                  value={editRegMemo}
                  onChange={(e) => setEditRegMemo(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editRegIsActive}
                  onChange={(e) => setEditRegIsActive(e.target.checked)}
                />
                <span>الصندوق نشط</span>
              </label>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditingRegister(null)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer"
                >
                  {actionLoading ? 'جاري التحديث...' : 'حفظ التعديلات'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Request Custody Modal */}
      {showRequestModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">تقديم طلب عهدة جديدة</h4>
              <button type="button" onClick={() => setShowRequestModal(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleRequestCustody} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الموظف المستلم *</label>
                <select
                  name="employeeUserId"
                  required
                  value={reqEmployeeUserId}
                  onChange={(e) => setReqEmployeeUserId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
                >
                  <option value="">-- اختر الموظف --</option>
                  {employees.map((emp) => (
                    <option key={emp.userId} value={emp.userId}>
                      {emp.username}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الصندوق / الخزينة *</label>
                <select
                  name="registerId"
                  required
                  value={reqRegisterId}
                  onChange={(e) => setReqRegisterId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
                >
                  <option value="">-- اختر الصندوق --</option>
                  {registers
                    .filter((r) => r.isActive)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.nameAr} ({r.code})
                      </option>
                    ))}
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">المبلغ *</label>
                  <input
                    type="number"
                    name="amount"
                    step="0.01"
                    min="0.01"
                    required
                    value={reqAmount}
                    onChange={(e) => setReqAmount(e.target.value)}
                    placeholder="1000.00"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono tabular-nums focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">تاريخ الطلب</label>
                  <input
                    type="date"
                    name="requestDate"
                    value={reqDate}
                    onChange={(e) => setReqDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الغرض من العهدة *</label>
                <textarea
                  name="purpose"
                  required
                  minLength={3}
                  rows={2}
                  value={reqPurpose}
                  onChange={(e) => setReqPurpose(e.target.value)}
                  placeholder="وصف واضح للغرض من العهدة"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">ملاحظات</label>
                <input
                  type="text"
                  name="memo"
                  value={reqMemo}
                  onChange={(e) => setReqMemo(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowRequestModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-emerald-600/20 disabled:opacity-50 cursor-pointer"
                >
                  {actionLoading ? 'جاري الإرسال...' : 'إرسال الطلب'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {rejectTarget && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">رفض طلب العهدة ({rejectTarget.custodyNo || ''})</h4>
              <button type="button" onClick={() => setRejectTarget(null)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleRejectSubmit} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">سبب الرفض (5 أحرف على الأقل) *</label>
                <textarea
                  name="rejectReason"
                  required
                  minLength={5}
                  rows={3}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="اذكر سبب رفض الطلب بوضوح"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-rose-500"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setRejectTarget(null)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  تراجع
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-rose-700 hover:bg-rose-600 text-white rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer"
                >
                  {actionLoading ? 'جاري التنفيذ...' : 'تأكيد الرفض'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Settle Modal */}
      {settleTarget && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h4 className="font-bold text-white text-sm">تسوية العهدة ({settleTarget.custodyNo || ''})</h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  قيمة العهدة المصروفة:{' '}
                  <span className="font-mono tabular-nums text-white font-bold">
                    {Number(settleTarget.amount).toFixed(2)}
                  </span>
                </p>
              </div>
              <button type="button" onClick={() => setSettleTarget(null)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSettleSubmit} className="flex flex-col gap-4">
              <div className="border border-slate-800 rounded-xl p-3 bg-slate-950/60 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300">بنود المصروفات</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSettleLines([...settleLines, { expenseAccountId: '', amount: '', memo: '' }])
                    }
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-indigo-300 rounded-lg text-[11px] font-bold flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    <span>إضافة بند مصروف</span>
                  </button>
                </div>

                {settleLines.map((line, idx) => (
                  <div key={idx} className="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-slate-900 p-2 rounded-lg border border-slate-800">
                    <select
                      name={`settleLineAccount_${idx}`}
                      value={line.expenseAccountId}
                      onChange={(e) => {
                        const copy = [...settleLines];
                        copy[idx].expenseAccountId = e.target.value;
                        setSettleLines(copy);
                      }}
                      className="flex-1 min-w-[160px] px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white focus:outline-none"
                    >
                      <option value="">-- اختر حساب المصروف --</option>
                      {expenseAccountOptions.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} - {a.nameAr}
                        </option>
                      ))}
                    </select>

                    <input
                      type="number"
                      name={`settleLineAmount_${idx}`}
                      step="0.01"
                      min="0"
                      placeholder="المبلغ"
                      value={line.amount}
                      onChange={(e) => {
                        const copy = [...settleLines];
                        copy[idx].amount = e.target.value;
                        setSettleLines(copy);
                      }}
                      className="w-28 px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white font-mono tabular-nums focus:outline-none"
                    />

                    <input
                      type="text"
                      name={`settleLineMemo_${idx}`}
                      placeholder="بيان السطر"
                      value={line.memo}
                      onChange={(e) => {
                        const copy = [...settleLines];
                        copy[idx].memo = e.target.value;
                        setSettleLines(copy);
                      }}
                      className="w-32 px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white focus:outline-none"
                    />

                    {settleLines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setSettleLines(settleLines.filter((_, i) => i !== idx))}
                        className="p-1.5 text-rose-400 hover:text-rose-300 cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">المرتجع النقدي للصندوق</label>
                  <input
                    type="number"
                    name="cashReturn"
                    step="0.01"
                    min="0"
                    value={settleCashReturn}
                    onChange={(e) => setSettleCashReturn(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono tabular-nums focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">ملاحظات التسوية</label>
                  <input
                    type="text"
                    name="settleMemo"
                    value={settleMemo}
                    onChange={(e) => setSettleMemo(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>

              <div className="px-4 py-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between text-xs">
                <span className="text-slate-400">الفرق المتبقي للتطابق التام:</span>
                <span
                  data-testid="settle-diff-counter"
                  className={`font-mono tabular-nums font-bold ${
                    settleDiffCents === 0 ? 'text-emerald-400' : 'text-amber-300'
                  }`}
                >
                  {(settleDiffCents / 100).toFixed(2)}
                </span>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setSettleTarget(null)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  data-testid="submit-settle-btn"
                  disabled={actionLoading || settleDiffCents !== 0}
                  className="px-5 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-xl text-xs font-bold disabled:opacity-40 cursor-pointer"
                >
                  {actionLoading ? 'جاري الترحيل...' : 'اعتماد التسوية وترحيل القيد'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Custody Detail & Movements Drawer/Modal */}
      {detailCustody && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div
            data-testid="custody-movements-drawer"
            className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl p-6 flex flex-col gap-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h4 className="font-bold text-white text-sm">
                  تفصيل وحركة العهدة ({detailCustody.custodyNo || detailCustody.id.slice(0, 8)})
                </h4>
                <p className="text-xs text-slate-400 mt-0.5">
                  {detailCustody.employeeUsername || detailCustody.employeeUserId} ·{' '}
                  {detailCustody.registerCode || ''} {detailCustody.registerNameAr || ''}
                </p>
              </div>
              <button type="button" onClick={() => setDetailCustody(null)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-950/70 border border-slate-800 rounded-xl p-4">
              <div>
                <div className="text-slate-400">المبلغ</div>
                <div className="font-mono tabular-nums font-bold text-white mt-0.5">
                  {Number(detailCustody.amount).toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-slate-400">الحالة</div>
                <div className="font-semibold text-indigo-300 mt-0.5">
                  {CUSTODY_STATUS_LABELS[detailCustody.status] || detailCustody.status}
                </div>
              </div>
              <div>
                <div className="text-slate-400">قيد الصرف</div>
                <div className="font-mono tabular-nums text-emerald-300 mt-0.5">
                  {detailCustody.disburseJournalEntryNo || '—'}
                </div>
              </div>
              <div>
                <div className="text-slate-400">قيد التسوية</div>
                <div className="font-mono tabular-nums text-amber-300 mt-0.5">
                  {detailCustody.settleJournalEntryNo || '—'}
                </div>
              </div>
            </div>

            <div>
              <h5 className="text-xs font-bold text-slate-200 mb-2">سجل حركة العهدة</h5>
              <div className="border border-slate-800 rounded-xl overflow-hidden">
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                      <th className="py-2.5 px-3">نوع الحركة</th>
                      <th className="py-2.5 px-3">الاتجاه</th>
                      <th className="py-2.5 px-3">المبلغ</th>
                      <th className="py-2.5 px-3">حساب المصروف</th>
                      <th className="py-2.5 px-3">رقم القيد</th>
                      <th className="py-2.5 px-3">ملاحظات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-200">
                    {loadingDetail ? (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-slate-400">
                          جاري تحميل الحركات...
                        </td>
                      </tr>
                    ) : detailMovements.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-slate-500">
                          لا توجد حركات مسجلة لهذه العهدة بعد
                        </td>
                      </tr>
                    ) : (
                      detailMovements.map((m) => (
                        <tr key={m.id}>
                          <td className="py-2.5 px-3 font-medium text-white">
                            {MOVEMENT_TYPE_LABELS[m.movementType] || m.movementType}
                          </td>
                          <td className="py-2.5 px-3 text-slate-300">
                            {DIRECTION_LABELS[m.direction] || m.direction}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums font-bold text-emerald-300">
                            {Number(m.amount).toFixed(2)}
                          </td>
                          <td className="py-2.5 px-3 text-slate-300">
                            {m.expenseAccountCode
                              ? `${m.expenseAccountCode} - ${m.expenseAccountNameAr || ''}`
                              : '—'}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-indigo-300">
                            {m.journalEntryNo || '—'}
                          </td>
                          <td className="py-2.5 px-3 text-slate-400">{m.memo || '—'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setDetailCustody(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold cursor-pointer"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
