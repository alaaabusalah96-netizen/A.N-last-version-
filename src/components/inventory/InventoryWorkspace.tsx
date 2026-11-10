import React, { useState, useEffect } from 'react';
import {
  Boxes,
  Package,
  Building2,
  TrendingDown,
  TrendingUp,
  ArrowRightLeft,
  Plus,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  X,
  History,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface Company {
  id: string;
  code: string;
  nameAr: string;
}

interface Warehouse {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string;
  isActive: boolean;
}

interface Item {
  id: string;
  code: string;
  nameAr: string;
  uom: string;
  isActive: boolean;
}

interface StockBalance {
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  itemUom?: string;
  qty: number;
  updatedAt: string;
}

interface StockMovement {
  id: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  itemCode?: string;
  itemNameAr?: string;
  movementType: 'receive' | 'issue' | 'transfer_out' | 'transfer_in' | 'transfer';
  qty: number;
  memo?: string;
  transferId?: string;
  createdAt: string;
}

interface InventoryWorkspaceProps {
  userRole: string;
}

export function InventoryWorkspace({ userRole }: InventoryWorkspaceProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'balances' | 'warehouses' | 'items' | 'movements' | 'transfers'>('balances');

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [balances, setBalances] = useState<StockBalance[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);

  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Modals
  const [showWarehouseModal, setShowWarehouseModal] = useState(false);
  const [showItemModal, setShowItemModal] = useState(false);
  const [showReceiveModal, setShowReceiveModal] = useState(false);
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);

  // Form states
  const [whCode, setWhCode] = useState('');
  const [whNameAr, setWhNameAr] = useState('');

  const [itemCode, setItemCode] = useState('');
  const [itemNameAr, setItemNameAr] = useState('');
  const [itemUom, setItemUom] = useState('unit');

  const [movementWarehouseId, setMovementWarehouseId] = useState('');
  const [movementItemId, setMovementItemId] = useState('');
  const [movementQty, setMovementQty] = useState('');
  const [movementMemo, setMovementMemo] = useState('');

  // Transfer form state
  const [transferSourceWhId, setTransferSourceWhId] = useState('');
  const [transferDestWhId, setTransferDestWhId] = useState('');
  const [transferItemId, setTransferItemId] = useState('');
  const [transferQty, setTransferQty] = useState('');
  const [transferMemo, setTransferMemo] = useState('');

  const canWrite = userRole === 'platform_admin' || userRole === 'company_admin';

  // Fetch companies
  useEffect(() => {
    async function loadCompanies() {
      try {
        const res = await apiFetch('/api/companies');
        if (res.ok) {
          const data = await res.json();
          const list: Company[] = data.companies || [];
          setCompanies(list);
          if (list.length > 0) {
            setSelectedCompanyId(list[0].id);
          }
        }
      } catch (err) {
        console.error('Failed to load companies:', err);
      }
    }
    loadCompanies();
  }, []);

  // Fetch inventory data for selected company
  const loadData = async () => {
    if (!selectedCompanyId) return;
    setLoading(true);
    setError(null);
    try {
      const [whRes, itemRes, balRes, movRes] = await Promise.all([
        apiFetch(`/api/inventory/warehouses?companyId=${selectedCompanyId}`),
        apiFetch(`/api/inventory/items?companyId=${selectedCompanyId}`),
        apiFetch(`/api/inventory/balances?companyId=${selectedCompanyId}`),
        apiFetch(`/api/inventory/movements?companyId=${selectedCompanyId}`),
      ]);

      if (whRes.ok) setWarehouses((await whRes.json()).warehouses || []);
      if (itemRes.ok) setItems((await itemRes.json()).items || []);
      if (balRes.ok) setBalances((await balRes.json()).balances || []);
      if (movRes.ok) setMovements((await movRes.json()).movements || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تحميل بيانات المخزون');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [selectedCompanyId]);

  // Handlers
  const handleCreateWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch('/api/inventory/warehouses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId, code: whCode, nameAr: whNameAr }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل في إنشاء المستودع');

      setSuccess(`تم إنشاء المستودع (${data.warehouse.nameAr}) بنجاح`);
      setShowWarehouseModal(false);
      setWhCode('');
      setWhNameAr('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء إنشاء المستودع');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCreateItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch('/api/inventory/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId, code: itemCode, nameAr: itemNameAr, uom: itemUom }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل في إنشاء الصنف');

      setSuccess(`تم إنشاء الصنف (${data.item.nameAr}) بنجاح`);
      setShowItemModal(false);
      setItemCode('');
      setItemNameAr('');
      setItemUom('unit');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء إنشاء الصنف');
    } finally {
      setActionLoading(false);
    }
  };

  const handleMovement = async (type: 'receive' | 'issue', e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const endpoint = type === 'receive' ? '/api/inventory/receive' : '/api/inventory/issue';
      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          warehouseId: movementWarehouseId,
          itemId: movementItemId,
          qty: Number(movementQty),
          memo: movementMemo,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || (type === 'receive' ? 'فشل استلام البضاعة' : 'فشل صرف البضاعة'));

      setSuccess(
        type === 'receive'
          ? `تم استلام كمية (${movementQty}) بنجاح وتحديث الرصيد`
          : `تم صرف كمية (${movementQty}) بنجاح وتحديث الرصيد`
      );

      if (type === 'receive') setShowReceiveModal(false);
      else setShowIssueModal(false);

      setMovementWarehouseId('');
      setMovementItemId('');
      setMovementQty('');
      setMovementMemo('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تسجيل الحركة المخزنية');
    } finally {
      setActionLoading(false);
    }
  };

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      if (transferSourceWhId === transferDestWhId) {
        throw new Error('مستودع المصدر ومستودع الوجهة هما نفس المستودع');
      }
      const res = await apiFetch('/api/inventory/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          sourceWarehouseId: transferSourceWhId,
          destWarehouseId: transferDestWhId,
          itemId: transferItemId,
          qty: Number(transferQty),
          memo: transferMemo,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل عملية التحويل بين المستودعين');

      setSuccess(`تم تحويل كمية (${transferQty}) بنجاح بين المستودعين وتحديث الأرصدة`);
      setShowTransferModal(false);
      setTransferSourceWhId('');
      setTransferDestWhId('');
      setTransferItemId('');
      setTransferQty('');
      setTransferMemo('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تنفيذ التحويل المخزني');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      {/* Header & Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
            <Boxes className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">إدارة المخزون والمستودعات (Inventory Core)</h3>
            <p className="text-xs text-slate-400">متابعة المستودعات، الأصناف، الأرصدة الحالية وحركات الاستلام والصرف</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Company Selector */}
          <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-300">
            <Building2 className="w-4 h-4 text-slate-400" />
            <select
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
            onClick={loadData}
            disabled={loading}
            className="p-2.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer"
            title="تحديث البيانات"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {canWrite && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowReceiveModal(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-emerald-600/20 transition cursor-pointer"
              >
                <TrendingUp className="w-3.5 h-3.5" />
                <span>إذن استلام</span>
              </button>

              <button
                onClick={() => setShowIssueModal(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-rose-600/20 transition cursor-pointer"
              >
                <TrendingDown className="w-3.5 h-3.5" />
                <span>إذن صرف</span>
              </button>

              <button
                onClick={() => setShowTransferModal(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer"
              >
                <ArrowRightLeft className="w-3.5 h-3.5" />
                <span>إذن تحويل</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Alert Notifications */}
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

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setActiveTab('balances')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'balances'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <Boxes className="w-4 h-4" />
          <span>الأرصدة الحالية</span>
        </button>

        <button
          onClick={() => setActiveTab('warehouses')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'warehouses'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <Building2 className="w-4 h-4" />
          <span>المستودعات ({warehouses.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('items')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'items'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <Package className="w-4 h-4" />
          <span>الأصناف ({items.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('movements')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'movements'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <History className="w-4 h-4" />
          <span>سجل الحركات ({movements.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('transfers')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeTab === 'transfers'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <ArrowRightLeft className="w-4 h-4" />
          <span>التحويلات بين المستودعات</span>
        </button>
      </div>

      {/* Tab Panels */}
      {activeTab === 'balances' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">المستودع</th>
                  <th className="py-3.5 px-4">كود الصنف</th>
                  <th className="py-3.5 px-4">اسم الصنف</th>
                  <th className="py-3.5 px-4 text-center">الكمية المتوفرة</th>
                  <th className="py-3.5 px-4 text-center">وحدة القياس</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {balances.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-slate-500">
                      لا توجد أرصدة مخزنية مسجلة حتى الآن. يمكنك استلام أصناف لإظهار الأرصدة.
                    </td>
                  </tr>
                ) : (
                  balances.map((b, idx) => (
                    <tr key={`${b.warehouseId}-${b.itemId}-${idx}`} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-medium text-slate-200">
                        {b.warehouseNameAr} ({b.warehouseCode})
                      </td>
                      <td className="py-3.5 px-4 font-mono font-bold text-indigo-300">{b.itemCode}</td>
                      <td className="py-3.5 px-4 text-slate-200">{b.itemNameAr}</td>
                      <td className="py-3.5 px-4 text-center font-mono font-bold text-emerald-400 text-sm">
                        {b.qty}
                      </td>
                      <td className="py-3.5 px-4 text-center text-slate-400">{b.itemUom}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'warehouses' && (
        <div className="flex flex-col gap-4">
          <div className="flex justify-end">
            {canWrite && (
              <button
                onClick={() => setShowWarehouseModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>إضافة مستودع جديد</span>
              </button>
            )}
          </div>

          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">الكود</th>
                  <th className="py-3.5 px-4">اسم المستودع</th>
                  <th className="py-3.5 px-4 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {warehouses.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-12 text-center text-slate-500">
                      لا توجد مستودعات مسجلة لهذه الشركة.
                    </td>
                  </tr>
                ) : (
                  warehouses.map((w) => (
                    <tr key={w.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-mono font-bold text-indigo-300">{w.code}</td>
                      <td className="py-3.5 px-4 font-medium text-slate-200">{w.nameAr}</td>
                      <td className="py-3.5 px-4 text-center">
                        <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-950/60 border border-emerald-800/80 text-emerald-400">
                          نشط
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'items' && (
        <div className="flex flex-col gap-4">
          <div className="flex justify-end">
            {canWrite && (
              <button
                onClick={() => setShowItemModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>إضافة صنف جديد</span>
              </button>
            )}
          </div>

          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">كود الصنف</th>
                  <th className="py-3.5 px-4">اسم الصنف</th>
                  <th className="py-3.5 px-4 text-center">وحدة القياس</th>
                  <th className="py-3.5 px-4 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-12 text-center text-slate-500">
                      لا توجد أصناف مسجلة في دليل المنتجات حتى الآن.
                    </td>
                  </tr>
                ) : (
                  items.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-mono font-bold text-indigo-300">{item.code}</td>
                      <td className="py-3.5 px-4 text-slate-200">{item.nameAr}</td>
                      <td className="py-3.5 px-4 text-center text-slate-400 font-mono">{item.uom}</td>
                      <td className="py-3.5 px-4 text-center">
                        <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-950/60 border border-emerald-800/80 text-emerald-400">
                          نشط
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'movements' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">التاريخ والوقت</th>
                <th className="py-3.5 px-4">نوع الحركة</th>
                <th className="py-3.5 px-4">المستودع</th>
                <th className="py-3.5 px-4">الصنف</th>
                <th className="py-3.5 px-4 text-center">الكمية</th>
                <th className="py-3.5 px-4">ملاحظات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {movements.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    لا توجد حركات مخزنية مسجلة.
                  </td>
                </tr>
              ) : (
                movements.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-800/30 transition">
                    <td className="py-3.5 px-4 text-slate-400 font-mono text-[11px]">
                      {new Date(m.createdAt).toLocaleString('ar-EG')}
                    </td>
                    <td className="py-3.5 px-4">
                      {m.movementType === 'receive' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-950/60 border border-emerald-800/80 text-emerald-400">
                          <TrendingUp className="w-3 h-3" />
                          <span>إستلام (+)</span>
                        </span>
                      ) : m.movementType === 'issue' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-rose-950/60 border border-rose-800/80 text-rose-400">
                          <TrendingDown className="w-3 h-3" />
                          <span>صرف (-)</span>
                        </span>
                      ) : m.movementType === 'transfer_out' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-950/60 border border-amber-800/80 text-amber-400">
                          <ArrowRightLeft className="w-3 h-3" />
                          <span>تحويل صادر (-)</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-indigo-950/60 border border-indigo-800/80 text-indigo-400">
                          <ArrowRightLeft className="w-3 h-3" />
                          <span>تحويل وارد (+)</span>
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-slate-300">{m.warehouseNameAr}</td>
                    <td className="py-3.5 px-4 text-slate-300">
                      {m.itemNameAr} ({m.itemCode})
                    </td>
                    <td className="py-3.5 px-4 text-center font-mono font-bold text-white">{m.qty}</td>
                    <td className="py-3.5 px-4 text-slate-400">{m.memo || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'transfers' && (
        <div className="flex flex-col gap-4">
          <div className="flex justify-end">
            {canWrite && (
              <button
                onClick={() => setShowTransferModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer"
              >
                <ArrowRightLeft className="w-4 h-4" />
                <span>إجراء تحويل جديد بين المستودعات</span>
              </button>
            )}
          </div>

          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">التاريخ والوقت</th>
                  <th className="py-3.5 px-4">معرّف التحويل (Transfer ID)</th>
                  <th className="py-3.5 px-4">نوع الحركة</th>
                  <th className="py-3.5 px-4">المستودع</th>
                  <th className="py-3.5 px-4">الصنف</th>
                  <th className="py-3.5 px-4 text-center">الكمية</th>
                  <th className="py-3.5 px-4">ملاحظات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {movements.filter((m) => m.transferId || m.movementType === 'transfer_out' || m.movementType === 'transfer_in').length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-500">
                      لا توجد عمليات تحويل مخزني مسجلة حتى الآن.
                    </td>
                  </tr>
                ) : (
                  movements
                    .filter((m) => m.transferId || m.movementType === 'transfer_out' || m.movementType === 'transfer_in')
                    .map((m) => (
                      <tr key={m.id} className="hover:bg-slate-800/30 transition">
                        <td className="py-3.5 px-4 text-slate-400 font-mono text-[11px]">
                          {new Date(m.createdAt).toLocaleString('ar-EG')}
                        </td>
                        <td className="py-3.5 px-4 font-mono text-indigo-300 text-[11px]">
                          {m.transferId ? `${m.transferId.slice(0, 8)}...` : '—'}
                        </td>
                        <td className="py-3.5 px-4">
                          {m.movementType === 'transfer_out' ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-950/60 border border-amber-800/80 text-amber-400">
                              <ArrowRightLeft className="w-3 h-3" />
                              <span>تحويل صادر (-)</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-indigo-950/60 border border-indigo-800/80 text-indigo-400">
                              <ArrowRightLeft className="w-3 h-3" />
                              <span>تحويل وارد (+)</span>
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-slate-300">{m.warehouseNameAr}</td>
                        <td className="py-3.5 px-4 text-slate-300">
                          {m.itemNameAr} ({m.itemCode})
                        </td>
                        <td className="py-3.5 px-4 text-center font-mono font-bold text-white">{m.qty}</td>
                        <td className="py-3.5 px-4 text-slate-400">{m.memo || '—'}</td>
                      </tr>
                    ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Warehouse Modal */}
      {showWarehouseModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إضافة مستودع جديد</h4>
              <button onClick={() => setShowWarehouseModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateWarehouse} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">كود المستودع *</label>
                <input
                  type="text"
                  required
                  placeholder="مثال: WH-MAIN"
                  value={whCode}
                  onChange={(e) => setWhCode(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">اسم المستودع (بالعربية) *</label>
                <input
                  type="text"
                  required
                  placeholder="مثال: المستودع الرئيسي"
                  value={whNameAr}
                  onChange={(e) => setWhNameAr(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowWarehouseModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-indigo-600/20 disabled:opacity-50"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ المستودع'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Item Modal */}
      {showItemModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إضافة صنف جديد</h4>
              <button onClick={() => setShowItemModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateItem} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">كود الصنف *</label>
                <input
                  type="text"
                  required
                  placeholder="مثال: ITEM-101"
                  value={itemCode}
                  onChange={(e) => setItemCode(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">اسم الصنف (بالعربية) *</label>
                <input
                  type="text"
                  required
                  placeholder="مثال: منتج تجريبي أ"
                  value={itemNameAr}
                  onChange={(e) => setItemNameAr(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">وحدة القياس</label>
                <input
                  type="text"
                  required
                  placeholder="مثال: وحدة، قطعة، كجم"
                  value={itemUom}
                  onChange={(e) => setItemUom(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowItemModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-indigo-600/20 disabled:opacity-50"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ الصنف'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Movement Modal (Receive / Issue) */}
      {(showReceiveModal || showIssueModal) && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">
                {showReceiveModal ? 'إذن استلام بضاعة (+)' : 'إذن صرف بضاعة (-)'}
              </h4>
              <button
                onClick={() => {
                  setShowReceiveModal(false);
                  setShowIssueModal(false);
                }}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={(e) => handleMovement(showReceiveModal ? 'receive' : 'issue', e)} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">المستودع *</label>
                <select
                  required
                  value={movementWarehouseId}
                  onChange={(e) => setMovementWarehouseId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value="">-- اختر المستودع --</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.nameAr} ({w.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الصنف *</label>
                <select
                  required
                  value={movementItemId}
                  onChange={(e) => setMovementItemId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value="">-- اختر الصنف --</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.nameAr} ({i.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الكمية *</label>
                <input
                  type="number"
                  step="0.0001"
                  min="0.0001"
                  required
                  placeholder="مثال: 10"
                  value={movementQty}
                  onChange={(e) => setMovementQty(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">ملاحظات / بيان الحركة</label>
                <input
                  type="text"
                  placeholder="بيان اختياري"
                  value={movementMemo}
                  onChange={(e) => setMovementMemo(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowReceiveModal(false);
                    setShowIssueModal(false);
                  }}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className={`px-5 py-2 text-white rounded-xl text-xs font-bold shadow-lg disabled:opacity-50 ${
                    showReceiveModal ? 'bg-emerald-600 shadow-emerald-600/20' : 'bg-rose-600 shadow-rose-600/20'
                  }`}
                >
                  {actionLoading ? 'جاري التنفيذ...' : showReceiveModal ? 'تأكيد الاستلام' : 'تأكيد الصرف'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Transfer Modal */}
      {showTransferModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إذن تحويل بين مستودعين</h4>
              <button onClick={() => setShowTransferModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleTransfer} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">مستودع المصدر (من) *</label>
                <select
                  required
                  value={transferSourceWhId}
                  onChange={(e) => setTransferSourceWhId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value="">-- اختر مستودع المصدر --</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.nameAr} ({w.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">مستودع الوجهة (إلى) *</label>
                <select
                  required
                  value={transferDestWhId}
                  onChange={(e) => setTransferDestWhId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value="">-- اختر مستودع الوجهة --</option>
                  {warehouses
                    .filter((w) => w.id !== transferSourceWhId)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.nameAr} ({w.code})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الصنف *</label>
                <select
                  required
                  value={transferItemId}
                  onChange={(e) => setTransferItemId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value="">-- اختر الصنف --</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.nameAr} ({i.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الكمية المراد تحويلها *</label>
                <input
                  type="number"
                  step="0.0001"
                  min="0.0001"
                  required
                  placeholder="مثال: 5"
                  value={transferQty}
                  onChange={(e) => setTransferQty(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">ملاحظات / سبب التحويل</label>
                <input
                  type="text"
                  placeholder="ملاحظات اختيارية"
                  value={transferMemo}
                  onChange={(e) => setTransferMemo(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowTransferModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-indigo-600/20 disabled:opacity-50"
                >
                  {actionLoading ? 'جاري التحويل...' : 'تأكيد التحويل'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
