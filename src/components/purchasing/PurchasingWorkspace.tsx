import React, { useState, useEffect, useCallback } from 'react';
import {
  ShoppingBag,
  Users,
  FileCheck,
  ClipboardList,
  Plus,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  X,
  Building2,
  Check,
  Ban,
  Lock,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface Company {
  id: string;
  code: string;
  nameAr: string;
}

interface Supplier {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  isActive: boolean;
}

interface Warehouse {
  id: string;
  code: string;
  nameAr: string;
}

interface Item {
  id: string;
  code: string;
  nameAr: string;
  uom: string;
}

interface GrnLine {
  id: string;
  itemCode?: string;
  itemNameAr?: string;
  itemUom?: string;
  qty: number;
  unitCost?: number;
}

interface GrnHeader {
  id: string;
  supplierCode?: string;
  supplierNameAr?: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  status: 'draft' | 'posted';
  grnNo?: string;
  createdAt: string;
  lines?: GrnLine[];
}

type PoStatus = 'draft' | 'approved' | 'closed' | 'cancelled';

interface PurchaseOrder {
  id: string;
  companyId: string;
  supplierId: string;
  supplierCode?: string;
  supplierNameAr?: string;
  status: PoStatus;
  poNo?: string | null;
  orderDate: string;
  expectedDate?: string | null;
  memo?: string | null;
  approvedAt?: string | null;
  closedAt?: string | null;
  createdAt: string;
}

interface PurchasingWorkspaceProps {
  userRole: string;
}

const PO_STATUS_LABELS: Record<PoStatus, string> = {
  draft: 'مسودة',
  approved: 'معتمد',
  closed: 'مغلق',
  cancelled: 'ملغي',
};

const PO_STATUS_STYLES: Record<PoStatus, string> = {
  draft: 'bg-amber-950/60 border border-amber-800/80 text-amber-300',
  approved: 'bg-emerald-950/60 border border-emerald-800/80 text-emerald-300',
  closed: 'bg-slate-800 border border-slate-700 text-slate-300',
  cancelled: 'bg-rose-950/60 border border-rose-800/80 text-rose-300',
};

export function PurchasingWorkspace({ userRole }: PurchasingWorkspaceProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'suppliers' | 'po' | 'grn'>('suppliers');

  const [userPermissions, setUserPermissions] = useState<string[]>([]);
  const [authMeLoaded, setAuthMeLoaded] = useState(false);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [grns, setGrns] = useState<GrnHeader[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Modals
  const [showSupplierModal, setShowSupplierModal] = useState(false);
  const [showPoModal, setShowPoModal] = useState(false);
  const [showGrnModal, setShowGrnModal] = useState(false);

  // Supplier Form state
  const [suppCode, setSuppCode] = useState('');
  const [suppNameAr, setSuppNameAr] = useState('');

  // PO Form state
  const [poSupplierId, setPoSupplierId] = useState('');
  const [poExpectedDate, setPoExpectedDate] = useState('');
  const [poMemo, setPoMemo] = useState('');
  const [poLines, setPoLines] = useState<{ itemId: string; qty: string; unitCost: string }[]>([
    { itemId: '', qty: '1', unitCost: '' },
  ]);

  // GRN Form state
  const [grnSupplierId, setGrnSupplierId] = useState('');
  const [grnWarehouseId, setGrnWarehouseId] = useState('');
  const [grnMemo, setGrnMemo] = useState('');
  const [grnLines, setGrnLines] = useState<{ itemId: string; qty: string; unitCost: string }[]>([
    { itemId: '', qty: '1', unitCost: '' },
  ]);

  const isPlatformAdmin = userRole === 'platform_admin';
  const canReadPo = isPlatformAdmin || userPermissions.includes('purchasing:read');
  const canWritePo = isPlatformAdmin || userPermissions.includes('purchasing:write');
  const canPostPo = isPlatformAdmin || userPermissions.includes('purchasing:post');
  const canWrite = isPlatformAdmin || userRole === 'company_admin' || userPermissions.includes('purchasing:write');

  useEffect(() => {
    async function bootstrap() {
      try {
        const [compRes, meRes] = await Promise.all([
          apiFetch('/api/companies'),
          apiFetch('/api/auth/me'),
        ]);

        if (compRes.ok) {
          const data = await compRes.json();
          const list: Company[] = data.companies || [];
          setCompanies(list);
          if (list.length > 0) setSelectedCompanyId(list[0].id);
        }

        if (meRes.ok) {
          const meData = await meRes.json();
          if (Array.isArray(meData.permissions)) {
            setUserPermissions(meData.permissions);
          }
        }
      } catch (err) {
        console.error('Failed to initialize purchasing workspace:', err);
      } finally {
        setAuthMeLoaded(true);
      }
    }
    bootstrap();
  }, []);

  useEffect(() => {
    if (authMeLoaded && activeTab === 'po' && !canReadPo) {
      setActiveTab('suppliers');
    }
  }, [authMeLoaded, activeTab, canReadPo]);

  const loadData = useCallback(async () => {
    if (!selectedCompanyId) return;
    setLoading(true);
    setError(null);
    try {
      const requests: Promise<Response>[] = [
        apiFetch(`/api/purchasing/suppliers?companyId=${selectedCompanyId}`),
        apiFetch(`/api/purchasing/grn?companyId=${selectedCompanyId}`),
        apiFetch(`/api/inventory/warehouses?companyId=${selectedCompanyId}`),
        apiFetch(`/api/inventory/items?companyId=${selectedCompanyId}`),
      ];

      if (canReadPo) {
        requests.push(apiFetch(`/api/purchasing/purchase-orders?companyId=${selectedCompanyId}`));
      }

      const [suppRes, grnRes, whRes, itemRes, poRes] = await Promise.all(requests);

      if (suppRes.ok) setSuppliers((await suppRes.json()).suppliers || []);
      if (grnRes.ok) setGrns((await grnRes.json()).grns || []);
      if (whRes.ok) setWarehouses((await whRes.json()).warehouses || []);
      if (itemRes.ok) setItems((await itemRes.json()).items || []);
      if (poRes && poRes.ok) {
        setPurchaseOrders((await poRes.json()).purchaseOrders || []);
      } else if (!canReadPo) {
        setPurchaseOrders([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تحميل بيانات المشتريات');
    } finally {
      setLoading(false);
    }
  }, [selectedCompanyId, canReadPo]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreateSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch('/api/purchasing/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId, code: suppCode, nameAr: suppNameAr }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل إنشاء المورد');

      setSuccess(`تم إضافة المورد (${data.supplier.nameAr}) بنجاح`);
      setShowSupplierModal(false);
      setSuppCode('');
      setSuppNameAr('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء إضافة المورد');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddPoLine = () => {
    setPoLines([...poLines, { itemId: '', qty: '1', unitCost: '' }]);
  };

  const handleRemovePoLine = (index: number) => {
    setPoLines(poLines.filter((_, i) => i !== index));
  };

  const handleCreatePo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWritePo) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const formattedLines = poLines.map((l) => ({
        itemId: l.itemId,
        qty: Number(l.qty),
        unitCost: l.unitCost !== '' ? Number(l.unitCost) : undefined,
      }));

      const res = await apiFetch('/api/purchasing/purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          supplierId: poSupplierId,
          expectedDate: poExpectedDate || undefined,
          memo: poMemo || undefined,
          lines: formattedLines,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل إنشاء مسودة أمر الشراء');

      setSuccess('تم إنشاء مسودة أمر الشراء (PO) بنجاح');
      setShowPoModal(false);
      setPoSupplierId('');
      setPoExpectedDate('');
      setPoMemo('');
      setPoLines([{ itemId: '', qty: '1', unitCost: '' }]);
      setActiveTab('po');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء إنشاء أمر الشراء');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePoTransition = async (poId: string, action: 'approve' | 'close' | 'cancel') => {
    if (!canPostPo) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/purchasing/purchase-orders/${poId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل تحديث حالة أمر الشراء');

      const label = data.purchaseOrder?.poNo || data.purchaseOrder?.id?.slice(0, 8) || poId.slice(0, 8);
      const verb = action === 'approve' ? 'اعتماد' : action === 'close' ? 'إغلاق' : 'إلغاء';
      setSuccess(`تم ${verb} أمر الشراء (${label}) بنجاح`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تحديث حالة أمر الشراء');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddGrnLine = () => {
    setGrnLines([...grnLines, { itemId: '', qty: '1', unitCost: '' }]);
  };

  const handleRemoveGrnLine = (index: number) => {
    setGrnLines(grnLines.filter((_, i) => i !== index));
  };

  const handleCreateGrn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const formattedLines = grnLines.map((l) => ({
        itemId: l.itemId,
        qty: Number(l.qty),
        unitCost: l.unitCost ? Number(l.unitCost) : undefined,
      }));

      const res = await apiFetch('/api/purchasing/grn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          supplierId: grnSupplierId,
          warehouseId: grnWarehouseId,
          memo: grnMemo,
          lines: formattedLines,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل إنشاء مسودة سند الاستلام');

      setSuccess('تم إنشاء مسودة سند استلام البضائع (GRN) بنجاح');
      setShowGrnModal(false);
      setGrnSupplierId('');
      setGrnWarehouseId('');
      setGrnMemo('');
      setGrnLines([{ itemId: '', qty: '1', unitCost: '' }]);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء إنشاء سند الاستلام');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePostGrn = async (grnId: string) => {
    if (!canWrite) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/purchasing/grn/${grnId}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل ترحيل سند الاستلام');

      setSuccess(`تم ترحيل سند الاستلام (${data.grn.grnNo}) وتحديث رصيد المستودع بالمخزون بنجاح`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء ترحيل السند');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      {/* Header & Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-amber-600/20 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
            <ShoppingBag className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">إدارة المشتريات والاستلام (Purchasing Core)</h3>
            <p className="text-xs text-slate-400">إدارة دليل الموردين وأوامر الشراء وسندات استلام البضائع (GRN)</p>
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
            <button
              onClick={() => setShowSupplierModal(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-amber-600/20 transition cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>إضافة مورد</span>
            </button>
          )}

          {canWritePo && (
            <button
              onClick={() => setShowPoModal(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-emerald-600/20 transition cursor-pointer whitespace-nowrap shrink-0"
            >
              <ClipboardList className="w-3.5 h-3.5" />
              <span>أمر شراء جديد</span>
            </button>
          )}

          {canWrite && (
            <button
              onClick={() => setShowGrnModal(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer whitespace-nowrap shrink-0"
            >
              <FileCheck className="w-3.5 h-3.5" />
              <span>سند استلام جديد</span>
            </button>
          )}
        </div>
      </div>

      {/* Alerts */}
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
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setActiveTab('suppliers')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
            activeTab === 'suppliers'
              ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>الموردون ({suppliers.length})</span>
        </button>

        {canReadPo && (
          <button
            onClick={() => setActiveTab('po')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
              activeTab === 'po'
                ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/20'
                : 'bg-slate-900 text-slate-400 hover:text-white'
            }`}
          >
            <ClipboardList className="w-4 h-4" />
            <span>أوامر الشراء ({purchaseOrders.length})</span>
          </button>
        )}

        <button
          onClick={() => setActiveTab('grn')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
            activeTab === 'grn'
              ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <FileCheck className="w-4 h-4" />
          <span>سندات استلام البضائع GRN ({grns.length})</span>
        </button>
      </div>

      {/* Tab 1: Suppliers */}
      {activeTab === 'suppliers' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">كود المورد</th>
                  <th className="py-3.5 px-4">اسم المورد</th>
                  <th className="py-3.5 px-4 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {suppliers.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-12 text-center text-slate-500">
                      لا يوجد موردون مسجلون لشركة المشتريات حتى الآن.
                    </td>
                  </tr>
                ) : (
                  suppliers.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-mono tabular-nums font-bold text-amber-300">{s.code}</td>
                      <td className="py-3.5 px-4 font-medium text-slate-200">{s.nameAr}</td>
                      <td className="py-3.5 px-4 text-center">
                        <span className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-emerald-950/60 border border-emerald-800/80 text-emerald-400">
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

      {/* Tab 2: Purchase Orders */}
      {activeTab === 'po' && canReadPo && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">رقم الأمر</th>
                  <th className="py-3.5 px-4">المورد</th>
                  <th className="py-3.5 px-4 text-center">تاريخ الأمر</th>
                  <th className="py-3.5 px-4 text-center">التسليم المتوقع</th>
                  <th className="py-3.5 px-4">البيان</th>
                  <th className="py-3.5 px-4 text-center">الحالة</th>
                  <th className="py-3.5 px-4 text-center">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {purchaseOrders.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-500">
                      لا توجد أوامر شراء مسجلة لهذه الشركة حتى الآن.
                    </td>
                  </tr>
                ) : (
                  purchaseOrders.map((po) => (
                    <tr key={po.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-mono tabular-nums font-bold text-indigo-300">
                        {po.poNo || `مسودة (${po.id.slice(0, 8)}...)`}
                      </td>
                      <td className="py-3.5 px-4 text-slate-200">{po.supplierNameAr}</td>
                      <td className="py-3.5 px-4 text-center font-mono tabular-nums text-[11px] text-slate-400">
                        {po.orderDate}
                      </td>
                      <td className="py-3.5 px-4 text-center font-mono tabular-nums text-[11px] text-slate-400">
                        {po.expectedDate || '—'}
                      </td>
                      <td className="py-3.5 px-4 text-slate-300 max-w-[200px] truncate">
                        {po.memo || '—'}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <span
                          className={`px-2.5 py-1 rounded-md text-[11px] font-semibold inline-flex items-center gap-1 ${PO_STATUS_STYLES[po.status]}`}
                        >
                          {po.status === 'approved' && <Check className="w-3 h-3" />}
                          {po.status === 'closed' && <Lock className="w-3 h-3" />}
                          {po.status === 'cancelled' && <Ban className="w-3 h-3" />}
                          <span>{PO_STATUS_LABELS[po.status]}</span>
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <div className="inline-flex items-center justify-center gap-1.5">
                          {po.status === 'draft' && canPostPo && (
                            <>
                              <button
                                onClick={() => handlePoTransition(po.id, 'approve')}
                                disabled={actionLoading}
                                className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold transition shadow cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                              >
                                اعتماد
                              </button>
                              <button
                                onClick={() => handlePoTransition(po.id, 'cancel')}
                                disabled={actionLoading}
                                className="px-2.5 py-1 bg-rose-700 hover:bg-rose-600 text-white rounded-lg text-[11px] font-bold transition shadow cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                              >
                                إلغاء
                              </button>
                            </>
                          )}
                          {po.status === 'approved' && canPostPo && (
                            <>
                              <button
                                onClick={() => handlePoTransition(po.id, 'close')}
                                disabled={actionLoading}
                                className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-[11px] font-bold transition shadow cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                              >
                                إغلاق
                              </button>
                              <button
                                onClick={() => handlePoTransition(po.id, 'cancel')}
                                disabled={actionLoading}
                                className="px-2.5 py-1 bg-rose-700 hover:bg-rose-600 text-white rounded-lg text-[11px] font-bold transition shadow cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                              >
                                إلغاء
                              </button>
                            </>
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
      )}

      {/* Tab 3: GRNs */}
      {activeTab === 'grn' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">رقم السند</th>
                  <th className="py-3.5 px-4">المورد</th>
                  <th className="py-3.5 px-4">مستودع الاستلام</th>
                  <th className="py-3.5 px-4 text-center">الحالة</th>
                  <th className="py-3.5 px-4 text-center">التاريخ</th>
                  <th className="py-3.5 px-4 text-center">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {grns.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-500">
                      لا توجد سندات استلام بضائع مسجلة.
                    </td>
                  </tr>
                ) : (
                  grns.map((g) => (
                    <tr key={g.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-mono tabular-nums font-bold text-indigo-300">
                        {g.grnNo || `مسودة (${g.id.slice(0, 8)}...)`}
                      </td>
                      <td className="py-3.5 px-4 text-slate-200">{g.supplierNameAr}</td>
                      <td className="py-3.5 px-4 text-slate-200">{g.warehouseNameAr}</td>
                      <td className="py-3.5 px-4 text-center">
                        {g.status === 'posted' ? (
                          <span className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-emerald-950/60 border border-emerald-800/80 text-emerald-400 inline-flex items-center gap-1">
                            <Check className="w-3 h-3" />
                            <span>مرحل للمخزون</span>
                          </span>
                        ) : (
                          <span className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-amber-950/60 border border-amber-800/80 text-amber-400">
                            مسودة
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-center font-mono tabular-nums text-[11px] text-slate-400">
                        {new Date(g.createdAt).toLocaleDateString('ar-EG')}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        {g.status === 'draft' && canWrite && (
                          <button
                            onClick={() => handlePostGrn(g.id)}
                            disabled={actionLoading}
                            className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition shadow cursor-pointer disabled:opacity-50"
                          >
                            رحّل للمخزون
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Supplier Modal */}
      {showSupplierModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إضافة مورد جديد</h4>
              <button onClick={() => setShowSupplierModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateSupplier} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">كود المورد *</label>
                <input
                  type="text"
                  required
                  placeholder="مثال: SUPP-001"
                  value={suppCode}
                  onChange={(e) => setSuppCode(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono focus:outline-none focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">اسم المورد (بالعربية) *</label>
                <input
                  type="text"
                  required
                  placeholder="مثال: شركة التوريدات الكبرى"
                  value={suppNameAr}
                  onChange={(e) => setSuppNameAr(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-amber-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowSupplierModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-amber-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-amber-600/20 disabled:opacity-50"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ المورد'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PO Modal */}
      {showPoModal && canWritePo && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إنشاء أمر شراء جديد (PO)</h4>
              <button onClick={() => setShowPoModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreatePo} className="flex flex-col gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">المورد *</label>
                  <select
                    required
                    value={poSupplierId}
                    onChange={(e) => setPoSupplierId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
                  >
                    <option value="">-- اختر المورد --</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nameAr} ({s.code})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">تاريخ التسليم المتوقع</label>
                  <input
                    type="date"
                    value={poExpectedDate}
                    onChange={(e) => setPoExpectedDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">ملاحظات / بيان أمر الشراء</label>
                <input
                  type="text"
                  placeholder="ملاحظات اختيارية"
                  value={poMemo}
                  onChange={(e) => setPoMemo(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              {/* Lines Table */}
              <div className="border border-slate-800 rounded-xl p-3 bg-slate-950/60 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300">بنود الأصناف المطلوبة</span>
                  <button
                    type="button"
                    onClick={handleAddPoLine}
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-emerald-300 rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    <span>إضافة بند</span>
                  </button>
                </div>

                {poLines.map((line, idx) => (
                  <div key={idx} className="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-slate-900 p-2 rounded-lg border border-slate-800">
                    <select
                      required
                      value={line.itemId}
                      onChange={(e) => {
                        const newLines = [...poLines];
                        newLines[idx].itemId = e.target.value;
                        setPoLines(newLines);
                      }}
                      className="flex-1 min-w-[140px] px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white focus:outline-none"
                    >
                      <option value="">-- اختر الصنف --</option>
                      {items.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.nameAr} ({i.code})
                        </option>
                      ))}
                    </select>

                    <input
                      type="number"
                      step="0.0001"
                      min="0.0001"
                      required
                      placeholder="الكمية"
                      value={line.qty}
                      onChange={(e) => {
                        const newLines = [...poLines];
                        newLines[idx].qty = e.target.value;
                        setPoLines(newLines);
                      }}
                      className="w-24 px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white font-mono tabular-nums focus:outline-none"
                    />

                    <input
                      type="number"
                      step="0.0001"
                      min="0"
                      placeholder="التكلفة (اختياري)"
                      value={line.unitCost}
                      onChange={(e) => {
                        const newLines = [...poLines];
                        newLines[idx].unitCost = e.target.value;
                        setPoLines(newLines);
                      }}
                      className="w-28 px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white font-mono tabular-nums focus:outline-none"
                    />

                    {poLines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemovePoLine(idx)}
                        className="p-1.5 text-rose-400 hover:text-rose-300 cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowPoModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-emerald-600/20 disabled:opacity-50"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ كمسودة'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* GRN Modal */}
      {showGrnModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إنشاء سند استلام بضائع (GRN)</h4>
              <button onClick={() => setShowGrnModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateGrn} className="flex flex-col gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">المورد *</label>
                  <select
                    required
                    value={grnSupplierId}
                    onChange={(e) => setGrnSupplierId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                  >
                    <option value="">-- اختر المورد --</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nameAr} ({s.code})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">مستودع الاستلام *</label>
                  <select
                    required
                    value={grnWarehouseId}
                    onChange={(e) => setGrnWarehouseId(e.target.value)}
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
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">ملاحظات / بيان السند</label>
                <input
                  type="text"
                  placeholder="ملاحظات اختياري"
                  value={grnMemo}
                  onChange={(e) => setGrnMemo(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Lines Table */}
              <div className="border border-slate-800 rounded-xl p-3 bg-slate-950/60 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300">بنود الاصناف المستلمة</span>
                  <button
                    type="button"
                    onClick={handleAddGrnLine}
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-indigo-300 rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    <span>إضافة بند</span>
                  </button>
                </div>

                {grnLines.map((line, idx) => (
                  <div key={idx} className="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-slate-900 p-2 rounded-lg border border-slate-800">
                    <select
                      required
                      value={line.itemId}
                      onChange={(e) => {
                        const newLines = [...grnLines];
                        newLines[idx].itemId = e.target.value;
                        setGrnLines(newLines);
                      }}
                      className="flex-1 px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white focus:outline-none"
                    >
                      <option value="">-- اختر الصنف --</option>
                      {items.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.nameAr} ({i.code})
                        </option>
                      ))}
                    </select>

                    <input
                      type="number"
                      step="0.0001"
                      min="0.0001"
                      required
                      placeholder="الكمية"
                      value={line.qty}
                      onChange={(e) => {
                        const newLines = [...grnLines];
                        newLines[idx].qty = e.target.value;
                        setGrnLines(newLines);
                      }}
                      className="w-24 px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white font-mono tabular-nums focus:outline-none"
                    />

                    {grnLines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveGrnLine(idx)}
                        className="p-1.5 text-rose-400 hover:text-rose-300 cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowGrnModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-indigo-600/20 disabled:opacity-50"
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
