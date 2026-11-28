import React, { useState, useEffect } from 'react';
import {
  Users,
  Truck,
  FileText,
  CreditCard,
  Plus,
  Check,
  X,
  Building2,
  Calendar,
  AlertCircle,
  Clock,
  TrendingUp,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { getLocalTodayDateString } from '../../lib/calendarDate.js';
import { SalesReturnsPanel } from './SalesReturnsPanel.js';
import { EditRecordModal } from '../ui/EditRecordModal.js';

interface Company {
  id: string;
  nameAr?: string;
  name?: string;
  code: string;
}

interface Warehouse {
  id: string;
  nameAr: string;
  code: string;
  isActive: boolean;
}

interface Item {
  id: string;
  nameAr: string;
  code: string;
  uom: string;
}

interface CashRegister {
  id: string;
  nameAr?: string;
  name?: string;
  code: string;
  balance?: number;
  isActive: boolean;
}

interface SalesWorkspaceProps {
  userRole?: string;
}

type SalesTab = 'customers' | 'deliveries' | 'invoices' | 'collections' | 'returns' | 'aging';

function sumCollectionLines(rows: Array<{ amount: string }>): number {
  let t = 0;
  for (const r of rows) t += parseFloat(r.amount) || 0;
  return Math.round(t * 100) / 100;
}

const CollectionLineRow = React.memo(function CollectionLineRow({
  line, idx, opts, canRemove, onInvoice, onAmount, onRemove,
}: {
  line: { invoiceId: string; amount: string };
  idx: number;
  opts: any[];
  canRemove: boolean;
  onInvoice: (idx: number, invId: string, openAmount: number | null) => void;
  onAmount: (idx: number, amount: string) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        name={`colInvoiceId-${idx}`}
        required
        value={line.invoiceId}
        onChange={(e) => {
          const invId = e.target.value;
          const out = opts.find((o) => o.invoiceId === invId);
          onInvoice(idx, invId, out ? out.remainingOpenAmount : null);
        }}
        className="flex-1 min-w-0 px-2 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none cursor-pointer"
      >
        <option value="">-- اختر الفاتورة --</option>
        {opts.map((o) => (
          <option key={o.invoiceId} value={o.invoiceId}>
            فاتورة: {o.invoiceNo} | المتبقي: {o.remainingOpenAmount.toFixed(2)}
          </option>
        ))}
      </select>
      <input
        name={`colAmount-${idx}`}
        type="number"
        step="0.01"
        min="0.01"
        required
        placeholder="0.00"
        value={line.amount}
        onChange={(e) => onAmount(idx, e.target.value)}
        className="w-24 px-2 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono"
      />
      <button
        type="button"
        disabled={!canRemove}
        onClick={() => onRemove(idx)}
        className="px-2 py-2 text-slate-400 hover:text-rose-400 disabled:opacity-30 cursor-pointer"
        aria-label={`حذف السطر ${idx + 1}`}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
});

export function SalesWorkspace({ userRole }: SalesWorkspaceProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<SalesTab>('customers');
  const [editingCustomer, setEditingCustomer] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Common Master Data
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [cashRegisters, setCashRegisters] = useState<CashRegister[]>([]);
  const [registersDenied, setRegistersDenied] = useState(false);
  const [userPermissions, setUserPermissions] = useState<string[]>([]);
  const [authMeLoaded, setAuthMeLoaded] = useState(false);

  // Sales Data
  const [customers, setCustomers] = useState<any[]>([]);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [outstandingInvoices, setOutstandingInvoices] = useState<any[]>([]);
  const [collections, setCollections] = useState<any[]>([]);
  const [agingReport, setAgingReport] = useState<any>(null);

  // Modals
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [showDeliveryModal, setShowDeliveryModal] = useState(false);
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [showCollectionModal, setShowCollectionModal] = useState(false);

  // Form states - Customer
  const [custCode, setCustCode] = useState('');
  const [custNameAr, setCustNameAr] = useState('');
  const [custNameEn, setCustNameEn] = useState('');
  const [custPhone, setCustPhone] = useState('');
  const [custEmail, setCustEmail] = useState('');
  const [custTaxNo, setCustTaxNo] = useState('');
  const [custAddress, setCustAddress] = useState('');
  const [custCreditLimit, setCustCreditLimit] = useState('0');

  // Form states - Delivery
  const [delCustomerId, setDelCustomerId] = useState('');
  const [delWarehouseId, setDelWarehouseId] = useState('');
  const [delDate, setDelDate] = useState(() => getLocalTodayDateString());
  const [delMemo, setDelMemo] = useState('');
  const [delLines, setDelLines] = useState<{ itemId: string; qty: number; unitPrice: number }[]>([
    { itemId: '', qty: 1, unitPrice: 0 },
  ]);

  // Form states - Invoice
  const [invCustomerId, setInvCustomerId] = useState('');
  const [invDeliveryId, setInvDeliveryId] = useState('');
  const [invDate, setInvDate] = useState(() => getLocalTodayDateString());
  const [invDueDate, setInvDueDate] = useState('');
  const [invMemo, setInvMemo] = useState('');
  const [invLines, setInvLines] = useState<{ itemId: string; deliveryLineId?: string; qty: number; unitPrice: number; taxRate: number }[]>([
    { itemId: '', qty: 1, unitPrice: 0, taxRate: 0 },
  ]);

  // Form states - Collection
  const [colCustomerId, setColCustomerId] = useState('');
  const [colLines, setColLines] = useState<Array<{ invoiceId: string; amount: string }>>([{ invoiceId: '', amount: '' }]);
  const colBaseOpts = React.useMemo(
    () => (colCustomerId ? outstandingInvoices.filter((o) => o.customerId === colCustomerId) : outstandingInvoices),
    [outstandingInvoices, colCustomerId]
  );
  const onColInvoice = React.useCallback((idx: number, invId: string, openAmount: number | null) => {
    setColLines((prev) => prev.map((l, k) => (k === idx ? { invoiceId: invId, amount: openAmount !== null ? String(openAmount) : l.amount } : l)));
  }, []);
  const onColAmount = React.useCallback((idx: number, amount: string) => {
    setColLines((prev) => prev.map((l, k) => (k === idx ? { ...l, amount } : l)));
  }, []);
  const onColRemove = React.useCallback((idx: number) => {
    setColLines((prev) => prev.filter((_, k) => k !== idx));
  }, []);
  const colHasDuplicate = React.useMemo(() => {
    const ids = colLines.map((l) => l.invoiceId).filter(Boolean);
    return new Set(ids).size !== ids.length;
  }, [colLines]);
  const [colRegisterId, setColRegisterId] = useState('');
  const [colDate, setColDate] = useState(() => getLocalTodayDateString());
  const [colRef, setColRef] = useState('');
  const [colMemo, setColMemo] = useState('');

  const isPlatformAdmin = userRole === 'platform_admin';
  const canWrite = isPlatformAdmin || userRole === 'company_admin' || userPermissions.includes('sales:write');
  const canPost = isPlatformAdmin || userRole === 'company_admin' || userPermissions.includes('sales:post');

  // Load Companies & User Permissions on Mount
  useEffect(() => {
    async function init() {
      try {
        const [compRes, meRes] = await Promise.all([
          apiFetch('/api/companies'),
          apiFetch('/api/auth/me'),
        ]);

        if (compRes.ok) {
          const compData = await compRes.json();
          const list = compData.companies || [];
          setCompanies(list);
          if (list.length > 0 && !selectedCompanyId) {
            setSelectedCompanyId(list[0].id);
          }
        }

        if (meRes.ok) {
          const meData = await meRes.json();
          setUserPermissions(Array.isArray(meData.permissions) ? meData.permissions : (meData.user?.permissions || []));
        }
      } catch (err: any) {
        setError(err.message || 'فشل تحميل بيانات الشركات');
      } finally {
        setAuthMeLoaded(true);
      }
    }
    init();
  }, []);

  // Load Data for Selected Company
  const loadData = async () => {
    if (!selectedCompanyId) return;
    setLoading(true);
    setError(null);
    try {
      const [
        custRes,
        delRes,
        invRes,
        outRes,
        colRes,
        agingRes,
        whRes,
        itemRes,
        regRes,
      ] = await Promise.all([
        apiFetch(`/api/sales/customers?companyId=${selectedCompanyId}`),
        apiFetch(`/api/sales/deliveries?companyId=${selectedCompanyId}`),
        apiFetch(`/api/sales/invoices?companyId=${selectedCompanyId}`),
        apiFetch(`/api/sales/invoices/outstanding?companyId=${selectedCompanyId}`),
        apiFetch(`/api/sales/collections?companyId=${selectedCompanyId}`),
        apiFetch(`/api/sales/ar/aging?companyId=${selectedCompanyId}`),
        apiFetch(`/api/inventory/warehouses?companyId=${selectedCompanyId}`),
        apiFetch(`/api/inventory/items?companyId=${selectedCompanyId}`),
        apiFetch(`/api/cash/registers?companyId=${selectedCompanyId}`),
      ]);

      if (custRes.ok) setCustomers((await custRes.json()).customers || []);
      if (delRes.ok) setDeliveries((await delRes.json()).deliveries || []);
      if (invRes.ok) setInvoices((await invRes.json()).invoices || []);
      if (outRes.ok) setOutstandingInvoices((await outRes.json()).outstandingInvoices || []);
      if (colRes.ok) setCollections((await colRes.json()).collections || []);
      if (agingRes.ok) setAgingReport((await agingRes.json()).agingReport || null);
      if (whRes.ok) setWarehouses((await whRes.json()).warehouses || []);
      if (itemRes.ok) setItems((await itemRes.json()).items || []);
      setRegistersDenied(!regRes.ok);
      if (regRes.ok) setCashRegisters((await regRes.json()).registers || []);
    } catch (err: any) {
      setError(err.message || 'فشل جلب بيانات المبيعات');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedCompanyId) {
      loadData();
    }
  }, [selectedCompanyId]);

  const readErrorMessage = async (res: Response, fallback: string) => {
    try {
      const data = await res.json();
      return data?.error?.message || data?.message || data?.error || fallback;
    } catch {
      return fallback;
    }
  };

  const handleSelectInvoiceDelivery = async (deliveryId: string) => {
    setInvDeliveryId(deliveryId);
    if (!deliveryId || !selectedCompanyId) {
      return;
    }
    try {
      const res = await apiFetch(`/api/sales/deliveries/${deliveryId}?companyId=${selectedCompanyId}`);
      if (res.ok) {
        const data = await res.json();
        const del = data.delivery;
        if (del?.lines && del.lines.length > 0) {
          if (!invCustomerId && del.customerId) {
            setInvCustomerId(del.customerId);
          }
          setInvLines(
            del.lines.map((l: any) => ({
              itemId: l.itemId,
              deliveryLineId: l.id,
              qty: Number(l.qty) || 1,
              unitPrice: Number(l.unitPrice) || 0,
              taxRate: 0,
            }))
          );
        }
      }
    } catch (err: any) {
      setError(err.message || 'فشل جلب بنود إذن التسليم');
    }
  };

  // Handlers - Customer
  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId) return;
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/sales/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          code: custCode,
          nameAr: custNameAr,
          nameEn: custNameEn || undefined,
          phone: custPhone || undefined,
          email: custEmail || undefined,
          taxNumber: custTaxNo || undefined,
          address: custAddress || undefined,
          creditLimit: parseFloat(custCreditLimit) || 0,
        }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'فشل إنشاء العميل'));
      setSuccess('تم إنشاء العميل بنجاح');
      setShowCustomerModal(false);
      setCustCode('');
      setCustNameAr('');
      setCustNameEn('');
      setCustPhone('');
      setCustEmail('');
      setCustTaxNo('');
      setCustAddress('');
      setCustCreditLimit('0');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل إنشاء العميل');
    } finally {
      setActionLoading(false);
    }
  };

  // Handlers - Delivery
  const handleCreateDelivery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId) return;
    const validLines = delLines.filter((l) => l.itemId && l.qty > 0);
    if (validLines.length === 0) {
      setError('يرجى إضافة بند واحد على الأقل مع تحديد الصنف والكمية');
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/sales/deliveries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          customerId: delCustomerId,
          warehouseId: delWarehouseId,
          deliveryDate: delDate,
          memo: delMemo || undefined,
          lines: validLines,
        }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'فشل إنشاء إذن التسليم'));
      setSuccess('تم إنشاء مسودة إذن التسليم بنجاح');
      setShowDeliveryModal(false);
      setDelMemo('');
      setDelLines([{ itemId: '', qty: 1, unitPrice: 0 }]);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل إنشاء إذن التسليم');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePostDelivery = async (id: string) => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/sales/deliveries/${id}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'فشل ترحيل إذن التسليم (تحقق من كفاية رصيد المخزون)'));
      setSuccess('تم ترحيل إذن التسليم وخصم المخزون بنجاح');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل ترحيل إذن التسليم (تحقق من كفاية رصيد المخزون)');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteDelivery = async (id: string) => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/sales/deliveries/${id}?companyId=${selectedCompanyId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'فشل حذف إذن التسليم'));
      setSuccess('تم حذف مسودة إذن التسليم بنجاح');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل حذف إذن التسليم');
    } finally {
      setActionLoading(false);
    }
  };

  // Handlers - Invoice
  const handleCreateInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId) return;
    const validLines = invLines.filter((l) => l.itemId && l.qty > 0);
    if (validLines.length === 0) {
      setError('يرجى إضافة بند واحد على الأقل مع تحديد الصنف والكمية');
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/sales/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          customerId: invCustomerId,
          deliveryId: invDeliveryId || undefined,
          invoiceDate: invDate,
          dueDate: invDueDate || undefined,
          memo: invMemo || undefined,
          lines: validLines,
        }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'فشل إنشاء فاتورة المبيعات'));
      setSuccess('تم إنشاء مسودة فاتورة المبيعات بنجاح');
      setShowInvoiceModal(false);
      setInvDeliveryId('');
      setInvMemo('');
      setInvLines([{ itemId: '', qty: 1, unitPrice: 0, taxRate: 0 }]);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل إنشاء فاتورة المبيعات');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePostInvoice = async (id: string) => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/sales/invoices/${id}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'فشل ترحيل فاتورة المبيعات'));
      setSuccess('تم ترحيل فاتورة المبيعات وإثبات الإيراد والمديونية بالـ GL بنجاح');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل ترحيل فاتورة المبيعات');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteInvoice = async (id: string) => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/sales/invoices/${id}?companyId=${selectedCompanyId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'فشل حذف فاتورة المبيعات'));
      setSuccess('تم حذف مسودة فاتورة المبيعات بنجاح');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل حذف فاتورة المبيعات');
    } finally {
      setActionLoading(false);
    }
  };

  // Handlers - Collection
  const handleCreateCollection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId) return;
    const payloadLines: Array<{ invoiceId: string; amount: number }> = [];
    for (let i = 0; i < colLines.length; i++) {
      const v = parseFloat(colLines[i].amount);
      if (!colLines[i].invoiceId || !v || v <= 0) {
        setError(`يرجى اختيار الفاتورة وإدخال مبلغ أكبر من الصفر في السطر ${i + 1}`);
        return;
      }
      payloadLines.push({ invoiceId: colLines[i].invoiceId, amount: v });
    }
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/sales/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          customerId: colCustomerId,
          lines: payloadLines,
          registerId: colRegisterId,
          collectionDate: colDate,
          reference: colRef || undefined,
          memo: colMemo || undefined,
        }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'فشل إنشاء سند التحصيل'));
      setSuccess('تم إنشاء مسودة سند التحصيل النقدي بنجاح');
      setShowCollectionModal(false);
      setColLines([{ invoiceId: '', amount: '' }]);
      setColRef('');
      setColMemo('');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل إنشاء سند التحصيل');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePostCollection = async (id: string) => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/sales/collections/${id}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'فشل ترحيل سند التحصيل'));
      setSuccess('تم ترحيل سند التحصيل النقدي وإثبات القيد بالـ GL بنجاح');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل ترحيل سند التحصيل');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteCollection = async (id: string) => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/sales/collections/${id}?companyId=${selectedCompanyId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'فشل حذف سند التحصيل'));
      setSuccess('تم حذف مسودة سند التحصيل بنجاح');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل حذف سند التحصيل');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full text-slate-100" dir="rtl">
      {/* Top Header & Tenant Selector */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/80 border border-slate-800 p-5 rounded-2xl backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-gradient-to-tr from-cyan-600 to-blue-500 rounded-xl shadow-lg shadow-cyan-500/20">
            <TrendingUp className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white tracking-wide">إدارة المبيعات ودورة الإيرادات</h1>
            <p className="text-xs text-slate-400">العملاء • أذون التسليم والصرف • فواتير المبيعات • التحصيل • أعمار الديون (AR)</p>
          </div>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="flex items-center gap-2 bg-slate-950/70 border border-slate-800 px-3 py-1.5 rounded-xl text-xs w-full sm:w-auto">
            <Building2 className="w-4 h-4 text-cyan-400 shrink-0" />
            <select
              value={selectedCompanyId}
              onChange={(e) => setSelectedCompanyId(e.target.value)}
              className="bg-transparent text-white focus:outline-none w-full sm:w-48 cursor-pointer"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id} className="bg-slate-900 text-white">
                  {c.nameAr || c.name} ({c.code})
                </option>
              ))}
            </select>
          </div>

          {canWrite && (
            <div className="flex items-center gap-2">
              {activeTab === 'customers' && (
                <button
                  onClick={() => setShowCustomerModal(true)}
                  className="px-3.5 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-lg shadow-cyan-600/20 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" />
                  <span>عميل جديد</span>
                </button>
              )}
              {activeTab === 'deliveries' && (
                <button
                  onClick={() => setShowDeliveryModal(true)}
                  className="px-3.5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-lg shadow-blue-600/20 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" />
                  <span>إذن تسليم جديد</span>
                </button>
              )}
              {activeTab === 'invoices' && (
                <button
                  onClick={() => setShowInvoiceModal(true)}
                  className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-lg shadow-indigo-600/20 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" />
                  <span>فاتورة مبيعات جديدة</span>
                </button>
              )}
              {activeTab === 'collections' && (
                <button
                  onClick={() => setShowCollectionModal(true)}
                  className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-lg shadow-emerald-600/20 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" />
                  <span>سند تحصيل نقدي</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Notifications */}
      {error && (
        <div className="flex items-center gap-2 p-3 bg-rose-950/60 border border-rose-800/80 rounded-xl text-rose-300 text-xs">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-rose-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 p-3 bg-emerald-950/60 border border-emerald-800/80 rounded-xl text-emerald-300 text-xs">
          <Check className="w-4 h-4 shrink-0" />
          <span className="flex-1">{success}</span>
          <button onClick={() => setSuccess(null)} className="text-emerald-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Tabs Bar */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab('customers')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer ${
            activeTab === 'customers'
              ? 'bg-cyan-600 text-white shadow-lg shadow-cyan-600/20'
              : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>العملاء ({customers.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('deliveries')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer ${
            activeTab === 'deliveries'
              ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20'
              : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
          }`}
        >
          <Truck className="w-4 h-4" />
          <span>أذون التسليم والصرف ({deliveries.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('invoices')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer ${
            activeTab === 'invoices'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
          }`}
        >
          <FileText className="w-4 h-4" />
          <span>فواتير المبيعات ({invoices.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('collections')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer ${
            activeTab === 'collections'
              ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20'
              : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
          }`}
        >
          <CreditCard className="w-4 h-4" />
          <span>التحصيل النقدي ({collections.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('returns')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer ${
            activeTab === 'returns'
              ? 'bg-rose-600 text-white shadow-lg shadow-rose-600/20'
              : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
          }`}
        >
          <FileText className="w-4 h-4" />
          <span>مرتجعات المبيعات</span>
        </button>

        <button
          onClick={() => setActiveTab('aging')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer ${
            activeTab === 'aging'
              ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/20'
              : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
          }`}
        >
          <Clock className="w-4 h-4" />
          <span>أعمار الديون (AR Aging)</span>
        </button>
      </div>

      {/* Tab 1: Customers */}
      {activeTab === 'customers' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">كود العميل</th>
                  <th className="py-3.5 px-4">اسم العميل (عربي)</th>
                  <th className="py-3.5 px-4">الاسم بالإنجليزية</th>
                  <th className="py-3.5 px-4">الهاتف</th>
                  <th className="py-3.5 px-4">الرقم الضريبي</th>
                  <th className="py-3.5 px-4 text-center">الحد الائتماني</th>
                  <th className="py-3.5 px-4 text-center">الحالة</th>
                  <th className="py-3.5 px-4 text-left">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {customers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-500">
                      لا يوجد عملاء مسجلون حالياً لهذه الشركة.
                    </td>
                  </tr>
                ) : (
                  customers.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-mono font-bold text-cyan-400">{c.code}</td>
                      <td className="py-3.5 px-4 font-semibold text-white">{c.nameAr}</td>
                      <td className="py-3.5 px-4 text-slate-400">{c.nameEn || '—'}</td>
                      <td className="py-3.5 px-4 font-mono">{c.phone || '—'}</td>
                      <td className="py-3.5 px-4 font-mono text-slate-400">{c.taxNumber || '—'}</td>
                      <td className="py-3.5 px-4 text-center font-mono tabular-nums font-bold text-amber-300">
                        {Number(c.creditLimit).toFixed(2)}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            c.isActive
                              ? 'bg-emerald-950/60 border border-emerald-800/80 text-emerald-300'
                              : 'bg-rose-950/60 border border-rose-800/80 text-rose-300'
                          }`}
                        >
                          {c.isActive ? 'نشط' : 'معطل'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-left">
                        {canWrite && (
                          <button
                            onClick={() => setEditingCustomer(c)}
                            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-[11px] font-bold cursor-pointer"
                          >
                            تعديل
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

      {/* Tab 2: Deliveries */}
      {activeTab === 'deliveries' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">رقم الإذن</th>
                  <th className="py-3.5 px-4">العميل</th>
                  <th className="py-3.5 px-4">المستودع المصروف منه</th>
                  <th className="py-3.5 px-4 text-center">تاريخ الصرف</th>
                  <th className="py-3.5 px-4 text-center">الحالة</th>
                  <th className="py-3.5 px-4 text-left">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {deliveries.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-500">
                      لا توجد أذون تسليم مسجلة حتى الآن.
                    </td>
                  </tr>
                ) : (
                  deliveries.map((del) => (
                    <tr key={del.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-mono font-bold text-white">{del.deliveryNo || del.id.slice(0, 8)}</td>
                      <td className="py-3.5 px-4 font-semibold">{del.customerNameAr || del.customerCode}</td>
                      <td className="py-3.5 px-4 text-slate-300">{del.warehouseNameAr || del.warehouseCode}</td>
                      <td className="py-3.5 px-4 text-center font-mono">{del.deliveryDate}</td>
                      <td className="py-3.5 px-4 text-center">
                        <span
                          className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                            del.status === 'posted'
                              ? 'bg-emerald-950/60 border border-emerald-800/80 text-emerald-300'
                              : 'bg-amber-950/60 border border-amber-800/80 text-amber-300'
                          }`}
                        >
                          {del.status === 'posted' ? 'مرحّل (تم الخصم)' : 'مسودة'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-left flex items-center justify-end gap-2">
                        {del.status === 'draft' && canPost && (
                          <button
                            onClick={() => handlePostDelivery(del.id)}
                            disabled={actionLoading}
                            className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                          >
                            <Check className="w-3 h-3" />
                            <span>ترحيل وصرف</span>
                          </button>
                        )}
                        {del.status === 'draft' && canWrite && (
                          <button
                            onClick={() => handleDeleteDelivery(del.id)}
                            disabled={actionLoading}
                            className="px-2.5 py-1 bg-rose-950/60 hover:bg-rose-900 text-rose-300 border border-rose-800/60 rounded-lg text-[11px] font-bold transition cursor-pointer"
                          >
                            حذف
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

      {/* Tab 3: Sales Invoices */}
      {activeTab === 'invoices' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">رقم الفاتورة</th>
                  <th className="py-3.5 px-4">العميل</th>
                  <th className="py-3.5 px-4">إذن التسليم</th>
                  <th className="py-3.5 px-4 text-center">تاريخ الفاتورة</th>
                  <th className="py-3.5 px-4 text-center font-bold text-indigo-400">الإجمالي</th>
                  <th className="py-3.5 px-4 text-center">الحالة</th>
                  <th className="py-3.5 px-4 text-center">قيد اليومية</th>
                  <th className="py-3.5 px-4 text-left">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {invoices.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-500">
                      لا توجد فواتير مبيعات مسجلة حتى الآن.
                    </td>
                  </tr>
                ) : (
                  invoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-mono font-bold text-white">{inv.invoiceNo || inv.id.slice(0, 8)}</td>
                      <td className="py-3.5 px-4 font-semibold">{inv.customerNameAr || inv.customerCode}</td>
                      <td className="py-3.5 px-4 font-mono text-blue-400">{inv.deliveryNo || '—'}</td>
                      <td className="py-3.5 px-4 text-center font-mono">{inv.invoiceDate}</td>
                      <td className="py-3.5 px-4 text-center font-mono font-bold text-indigo-300 text-sm">
                        {Number(inv.totalAmount).toFixed(2)}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <span
                          className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                            inv.status === 'posted'
                              ? 'bg-emerald-950/60 border border-emerald-800/80 text-emerald-300'
                              : 'bg-amber-950/60 border border-amber-800/80 text-amber-300'
                          }`}
                        >
                          {inv.status === 'posted' ? 'مرحّل بالـ GL' : 'مسودة'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-center font-mono text-cyan-300">
                        {inv.journalEntryNo || inv.journalEntryId?.slice(0, 8) || '—'}
                      </td>
                      <td className="py-3.5 px-4 text-left flex items-center justify-end gap-2">
                        {inv.status === 'draft' && canPost && (
                          <button
                            onClick={() => handlePostInvoice(inv.id)}
                            disabled={actionLoading}
                            className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                          >
                            <Check className="w-3 h-3" />
                            <span>ترحيل للـ GL</span>
                          </button>
                        )}
                        {inv.status === 'draft' && canWrite && (
                          <button
                            onClick={() => handleDeleteInvoice(inv.id)}
                            disabled={actionLoading}
                            className="px-2.5 py-1 bg-rose-950/60 hover:bg-rose-900 text-rose-300 border border-rose-800/60 rounded-lg text-[11px] font-bold transition cursor-pointer"
                          >
                            حذف
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

      {/* Tab 4: Collections */}
      {activeTab === 'collections' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">رقم السند</th>
                  <th className="py-3.5 px-4">العميل</th>
                  <th className="py-3.5 px-4">فاتورة المبيعات</th>
                  <th className="py-3.5 px-4">الصندوق المستلم</th>
                  <th className="py-3.5 px-4 text-center">تاريخ التحصيل</th>
                  <th className="py-3.5 px-4 text-center font-bold text-emerald-400">المبلغ المحصل</th>
                  <th className="py-3.5 px-4 text-center">الحالة</th>
                  <th className="py-3.5 px-4 text-center">قيد اليومية</th>
                  <th className="py-3.5 px-4 text-left">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {collections.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-slate-500">
                      لا توجد سندات تحصيل نقدية مسجلة حتى الآن.
                    </td>
                  </tr>
                ) : (
                  collections.map((col) => (
                    <tr key={col.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-mono font-bold text-white">{col.collectionNo || col.id.slice(0, 8)}</td>
                      <td className="py-3.5 px-4 font-semibold">{col.customerNameAr || col.customerCode}</td>
                      <td className="py-3.5 px-4 font-mono text-indigo-400">{col.invoiceNo || col.invoiceId.slice(0, 8)}
                        {col.linesCount > 1 && (
                          <span data-testid="collection-lines-count" className="ms-1 px-1.5 py-0.5 rounded bg-indigo-950 border border-indigo-800 text-[10px] text-indigo-300">+{col.linesCount - 1} فاتورة</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 font-medium text-amber-300">{col.registerNameAr || col.registerCode}</td>
                      <td className="py-3.5 px-4 text-center font-mono">{col.collectionDate}</td>
                      <td className="py-3.5 px-4 text-center font-mono font-bold text-emerald-400 text-sm">
                        {Number(col.amount).toFixed(2)}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <span
                          className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                            col.status === 'posted'
                              ? 'bg-emerald-950/60 border border-emerald-800/80 text-emerald-300'
                              : 'bg-amber-950/60 border border-amber-800/80 text-amber-300'
                          }`}
                        >
                          {col.status === 'posted' ? 'مرحّل' : 'مسودة'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-center font-mono text-cyan-300">
                        {col.journalEntryNo || col.journalEntryId?.slice(0, 8) || '—'}
                      </td>
                      <td className="py-3.5 px-4 text-left flex items-center justify-end gap-2">
                        {col.status === 'draft' && canPost && (
                          <button
                            onClick={() => handlePostCollection(col.id)}
                            disabled={actionLoading}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                          >
                            <Check className="w-3 h-3" />
                            <span>ترحيل</span>
                          </button>
                        )}
                        {col.status === 'draft' && canWrite && (
                          <button
                            onClick={() => handleDeleteCollection(col.id)}
                            disabled={actionLoading}
                            className="px-2.5 py-1 bg-rose-950/60 hover:bg-rose-900 text-rose-300 border border-rose-800/60 rounded-lg text-[11px] font-bold transition cursor-pointer"
                          >
                            حذف
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

      {/* Tab 5: AR Aging Report */}
      {editingCustomer && (
        <EditRecordModal
          title={`تعديل العميل ${editingCustomer.code}`}
          initial={editingCustomer}
          fields={[
            { key: 'nameAr', label: 'اسم العميل (عربي)', required: true },
            { key: 'nameEn', label: 'الاسم بالإنجليزية' },
            { key: 'phone', label: 'الهاتف' },
            { key: 'email', label: 'البريد الإلكتروني' },
            { key: 'taxNumber', label: 'الرقم الضريبي' },
            { key: 'address', label: 'العنوان' },
            { key: 'creditLimit', label: 'الحد الائتماني', type: 'number' },
            { key: 'isActive', label: 'نشط', type: 'checkbox' },
          ]}
          onClose={() => setEditingCustomer(null)}
          onSave={async (v) => {
            const res = await apiFetch(`/api/sales/customers/${editingCustomer.id}`, {
              method: 'PUT',
              body: JSON.stringify({
                companyId: selectedCompanyId,
                nameAr: String(v.nameAr).trim(),
                nameEn: String(v.nameEn || '').trim() || undefined,
                phone: String(v.phone || '').trim() || undefined,
                email: String(v.email || '').trim() || undefined,
                taxNumber: String(v.taxNumber || '').trim() || undefined,
                address: String(v.address || '').trim() || undefined,
                creditLimit: Number(v.creditLimit) || 0,
                isActive: !!v.isActive,
              }),
            });
            if (!res.ok) throw new Error(await readErrorMessage(res, 'فشل تعديل العميل'));
            setEditingCustomer(null);
            setSuccess('تم تعديل بيانات العميل');
            await loadData();
          }}
        />
      )}

      {activeTab === 'returns' && (
        <SalesReturnsPanel
          companyId={selectedCompanyId}
          canWrite={canWrite}
          canPost={canPost}
          invoices={invoices}
          warehouses={warehouses}
        />
      )}

      {activeTab === 'aging' && (
        <div className="flex flex-col gap-6">
          {/* Aging Summary Metric Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
              <span className="text-xs text-slate-400 font-semibold block mb-1">إجمالي المديونية المفتوحة</span>
              <span className="text-xl font-bold font-mono text-white">
                {(agingReport?.grandTotalOpen || 0).toFixed(2)}
              </span>
            </div>
            <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
              <span className="text-xs text-emerald-400 font-semibold block mb-1">فترة 0 - 30 يوم (حالي)</span>
              <span className="text-xl font-bold font-mono text-emerald-300">
                {(agingReport?.grandTotal0To30 || 0).toFixed(2)}
              </span>
            </div>
            <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
              <span className="text-xs text-amber-400 font-semibold block mb-1">فترة 31 - 60 يوم</span>
              <span className="text-xl font-bold font-mono text-amber-300">
                {(agingReport?.grandTotal31To60 || 0).toFixed(2)}
              </span>
            </div>
            <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
              <span className="text-xs text-rose-400 font-semibold block mb-1">أكثر من 60 يوم (متأخر)</span>
              <span className="text-xl font-bold font-mono text-rose-300">
                {(agingReport?.grandTotal61Plus || 0).toFixed(2)}
              </span>
            </div>
          </div>

          {/* Customer Aging Breakdown Table */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <h3 className="font-bold text-sm text-white">ملخص أعمار ديون العملاء</h3>
              <span className="text-xs text-slate-400">حسب فترات الاستحقاق</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                    <th className="py-3 px-4">كود العميل</th>
                    <th className="py-3 px-4">اسم العميل</th>
                    <th className="py-3 px-4 text-center">عدد الفواتير</th>
                    <th className="py-3 px-4 text-center text-emerald-400">0 - 30 يوم</th>
                    <th className="py-3 px-4 text-center text-amber-400">31 - 60 يوم</th>
                    <th className="py-3 px-4 text-center text-rose-400">أكثر من 60 يوم</th>
                    <th className="py-3 px-4 text-center font-bold text-white">إجمالي الرصيد</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {(!agingReport?.customerSummaries || agingReport.customerSummaries.length === 0) ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-500">
                        لا توجد مديونيات مفتوحة للعملاء حالياً.
                      </td>
                    </tr>
                  ) : (
                    agingReport.customerSummaries.map((s: any) => (
                      <tr key={s.customerId} className="hover:bg-slate-800/30 transition">
                        <td className="py-3 px-4 font-mono font-bold text-cyan-400">{s.customerCode}</td>
                        <td className="py-3 px-4 font-semibold text-white">{s.customerNameAr}</td>
                        <td className="py-3 px-4 text-center font-mono">{s.invoiceCount}</td>
                        <td className="py-3 px-4 text-center font-mono tabular-nums text-emerald-300">{s.bucket0To30.toFixed(2)}</td>
                        <td className="py-3 px-4 text-center font-mono tabular-nums text-amber-300">{s.bucket31To60.toFixed(2)}</td>
                        <td className="py-3 px-4 text-center font-mono tabular-nums text-rose-300 font-bold">{s.bucket61Plus.toFixed(2)}</td>
                        <td className="py-3 px-4 text-center font-mono tabular-nums font-bold text-white text-sm">{s.totalOpenAmount.toFixed(2)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Customer Modal */}
      {showCustomerModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إضافة عميل جديد</h4>
              <button onClick={() => setShowCustomerModal(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateCustomer} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">كود العميل *</label>
                <input
                  type="text"
                  required
                  placeholder="مثال: CUST-001"
                  value={custCode}
                  onChange={(e) => setCustCode(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">اسم العميل (عربي) *</label>
                <input
                  type="text"
                  required
                  placeholder="اسم العميل أو المؤسسة"
                  value={custNameAr}
                  onChange={(e) => setCustNameAr(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">الهاتف</label>
                  <input
                    type="text"
                    value={custPhone}
                    onChange={(e) => setCustPhone(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">الحد الائتماني</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={custCreditLimit}
                    onChange={(e) => setCustCreditLimit(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none font-mono"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowCustomerModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-cyan-600/20 disabled:opacity-50 cursor-pointer"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ العميل'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delivery Modal */}
      {showDeliveryModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إنشاء إذن تسليم وصرف بضاعة جديد</h4>
              <button onClick={() => setShowDeliveryModal(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateDelivery} className="flex flex-col gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">العميل *</label>
                  <select
                    required
                    value={delCustomerId}
                    onChange={(e) => setDelCustomerId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none cursor-pointer"
                  >
                    <option value="">-- اختر العميل --</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nameAr} ({c.code})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">المستودع المصروف منه *</label>
                  <select
                    required
                    value={delWarehouseId}
                    onChange={(e) => setDelWarehouseId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none cursor-pointer"
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

              {/* Items Lines */}
              <div className="border border-slate-800 rounded-xl p-3 bg-slate-950/60 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300">أصناف التسليم</span>
                  <button
                    type="button"
                    onClick={() => setDelLines([...delLines, { itemId: '', qty: 1, unitPrice: 0 }])}
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-blue-300 rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    <span>إضافة صنف</span>
                  </button>
                </div>
                {delLines.map((line, idx) => (
                  <div key={idx} className="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                    <select
                      required
                      value={line.itemId}
                      onChange={(e) => {
                        const updated = [...delLines];
                        updated[idx].itemId = e.target.value;
                        setDelLines(updated);
                      }}
                      className="flex-1 min-w-[140px] px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white focus:outline-none"
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
                        const updated = [...delLines];
                        updated[idx].qty = parseFloat(e.target.value) || 0;
                        setDelLines(updated);
                      }}
                      className="w-24 px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono"
                    />
                    {delLines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setDelLines(delLines.filter((_, i) => i !== idx))}
                        className="text-slate-500 hover:text-rose-400 p-1"
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
                  onClick={() => setShowDeliveryModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading || !delCustomerId || !delWarehouseId}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-blue-600/20 disabled:opacity-50 cursor-pointer"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ كمسودة تسليم'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Invoice Modal */}
      {showInvoiceModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إنشاء فاتورة مبيعات جديدة (AR Invoice)</h4>
              <button onClick={() => setShowInvoiceModal(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateInvoice} className="flex flex-col gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">العميل *</label>
                  <select
                    required
                    value={invCustomerId}
                    onChange={(e) => setInvCustomerId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none cursor-pointer"
                  >
                    <option value="">-- اختر العميل --</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nameAr} ({c.code})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">إذن التسليم المرتبط (اختياري)</label>
                  <select
                    value={invDeliveryId}
                    onChange={(e) => handleSelectInvoiceDelivery(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none cursor-pointer"
                  >
                    <option value="">-- بدون ربط بإذن تسليم --</option>
                    {deliveries
                      .filter((d) => d.status === 'posted' && (!invCustomerId || d.customerId === invCustomerId))
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          إذن رقم: {d.deliveryNo || d.id.slice(0, 8)} ({d.deliveryDate})
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              {/* Items Lines */}
              <div className="border border-slate-800 rounded-xl p-3 bg-slate-950/60 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300">بنود الفاتورة</span>
                  <button
                    type="button"
                    onClick={() => setInvLines([...invLines, { itemId: '', qty: 1, unitPrice: 0, taxRate: 0 }])}
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-indigo-300 rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    <span>إضافة بند</span>
                  </button>
                </div>
                {invLines.map((line, idx) => (
                  <div key={idx} className="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                    <select
                      required
                      value={line.itemId}
                      onChange={(e) => {
                        const updated = [...invLines];
                        updated[idx].itemId = e.target.value;
                        setInvLines(updated);
                      }}
                      className="flex-1 min-w-[130px] px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white focus:outline-none"
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
                        const updated = [...invLines];
                        updated[idx].qty = parseFloat(e.target.value) || 0;
                        setInvLines(updated);
                      }}
                      className="w-20 px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono"
                    />
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      placeholder="السعر"
                      value={line.unitPrice}
                      onChange={(e) => {
                        const updated = [...invLines];
                        updated[idx].unitPrice = parseFloat(e.target.value) || 0;
                        setInvLines(updated);
                      }}
                      className="w-24 px-2 py-1.5 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono"
                    />
                    {invLines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setInvLines(invLines.filter((_, i) => i !== idx))}
                        className="text-slate-500 hover:text-rose-400 p-1"
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
                  onClick={() => setShowInvoiceModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading || !invCustomerId}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-indigo-600/20 disabled:opacity-50 cursor-pointer"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ كمسودة فاتورة'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Collection Modal */}
      {showCollectionModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl max-h-[92vh] overflow-y-auto shadow-2xl p-6 flex flex-col gap-4" data-testid="collection-modal">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إنشاء سند تحصيل نقدي من عميل</h4>
              <button onClick={() => setShowCollectionModal(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateCollection} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">العميل *</label>
                <select
                  required
                  value={colCustomerId}
                  onChange={(e) => {
                    setColCustomerId(e.target.value);
                    setColLines([{ invoiceId: '', amount: '' }]);
                  }}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none cursor-pointer"
                >
                  <option value="">-- اختر العميل --</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nameAr} ({c.code})
                    </option>
                  ))}
                </select>
              </div>

              <div data-testid="collection-lines-section" className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-semibold text-slate-300">فواتير المبيعات المراد تحصيلها * (حتى 100 فاتورة)</label>
                  <span data-testid="collection-lines-total" className="text-[11px] font-mono text-emerald-400">
                    {colLines.length} / 100 | الإجمالي: {sumCollectionLines(colLines).toFixed(2)}
                  </span>
                </div>
                <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
                  {colLines.map((line, idx) => (
                    <CollectionLineRow
                      key={idx}
                      line={line}
                      idx={idx}
                      opts={colBaseOpts}
                      canRemove={colLines.length > 1}
                      onInvoice={onColInvoice}
                      onAmount={onColAmount}
                      onRemove={onColRemove}
                    />
                  ))}
                </div>
                {colHasDuplicate && (
                  <p data-testid="collection-duplicate-warning" className="text-xs text-rose-400">نفس الفاتورة مكررة في أكثر من سطر. اختر كل فاتورة مرة واحدة.</p>
                )}
                <button
                  type="button"
                  data-testid="collection-add-line"
                  disabled={colLines.length >= 100}
                  onClick={() => setColLines((prev) => (prev.length >= 100 ? prev : [...prev, { invoiceId: '', amount: '' }]))}
                  className="self-start px-3 py-1.5 bg-slate-800 text-slate-200 rounded-lg text-xs font-semibold disabled:opacity-40 cursor-pointer"
                >
                  + سطر
                </button>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">صندوق النقدية المستلم *</label>
                <select
                  required
                  value={colRegisterId}
                  onChange={(e) => setColRegisterId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none cursor-pointer"
                >
                  <option value="">-- اختر الصندوق --</option>
                  {cashRegisters.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.nameAr || r.name} ({r.code})
                    </option>
                  ))}
                </select>
                {cashRegisters.length === 0 && (
                  <p data-testid="collection-no-registers" className="mt-1 text-[11px] text-amber-300">
                    {registersDenied
                      ? 'ليست لديك صلاحية على أي صندوق نقدية، لذلك لا يمكن حفظ سند تحصيل. اطلب من مدير الخزينة منحك صلاحية قراءة الصناديق، أو سجّل التحصيل من شاشة الخزينة.'
                      : 'لا توجد صناديق نقدية نشطة في هذه الشركة. أنشئ صندوقاً من شاشة الخزينة أولاً.'}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">رقم الإيصال</label>
                  <input
                    type="text"
                    placeholder="رقم مرجعي اختياري"
                    value={colRef}
                    onChange={(e) => setColRef(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowCollectionModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading || colHasDuplicate || !colCustomerId || !colRegisterId || colLines.some((l) => !l.invoiceId || !l.amount)}
                  className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-emerald-600/20 disabled:opacity-50 cursor-pointer"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ كمسودة تحصيل'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
