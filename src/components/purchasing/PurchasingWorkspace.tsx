import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  RotateCcw,
  CreditCard,
  Scale,
  Receipt,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { useConfirm } from '../ui/useConfirm.js';
import { PriceVarianceExceptionPanel } from './PriceVarianceExceptionPanel.js';
import {
  MatchReportController,
  MatchReportState,
  createInitialMatchReportState,
  resolveTrustedMatchInvoice,
} from './matchReportController.js';


async function apiCall(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    let data: any = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    throw new Error(data.message || data.error || `فشل تنفيذ الطلب (${res.status})`);
  }
  return res;
}

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

export type SupplierInvoiceStatus = 'draft' | 'posted' | 'cancelled';
export interface SupplierInvoiceLine {
  id: string;
  invoiceId: string;
  companyId: string;
  grnLineId: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  itemUom?: string;
  qty: number;
  unitCost: number;
  lineNo: number;
}
export interface SupplierInvoice {
  id: string;
  companyId: string;
  supplierId: string;
  supplierCode?: string;
  supplierNameAr?: string;
  status: SupplierInvoiceStatus;
  invoiceNo?: string | null;
  supplierInvoiceNo: string;
  invoiceDate: string;
  dueDate?: string | null;
  memo?: string | null;
  journalEntryId?: string | null;
  journalEntryNo?: string | null;
  postedAt?: string | null;
  postedBy?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: SupplierInvoiceLine[];
}
export interface OutstandingGrnLineRow {
  grnLineId: string;
  grnId: string;
  grnNo: string | null;
  supplierId: string;
  itemId: string;
  itemCode: string;
  itemNameAr: string;
  itemUom: string;
  grnQty: number;
  unitCost: number;
  invoicedQty: number;
  remainingQty: number;
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
  const [askConfirm, confirmDialog] = useConfirm();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'suppliers' | 'po' | 'grn' | 'invoices' | 'match' | 'returns' | 'ap' | 'payments'>('suppliers');

  const [userPermissions, setUserPermissions] = useState<string[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
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
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [invoicesCompanyId, setInvoicesCompanyId] = useState<string>('');
  const [invSupplierId, setInvSupplierId] = useState('');
  const [invSupplierInvoiceNo, setInvSupplierInvoiceNo] = useState('');
  const [invDate, setInvDate] = useState('');
  const [invDueDate, setInvDueDate] = useState('');
  const [invMemo, setInvMemo] = useState('');
  const [outstandingLines, setOutstandingLines] = useState<OutstandingGrnLineRow[]>([]);
  const [selectedOutstandingLines, setSelectedOutstandingLines] = useState<{
    grnLineId: string;
    qty: number;
    unitCost: number;
    maxQty: number;
    itemId: string;
    itemCode: string;
    itemNameAr: string;
    itemUom: string;
    grnNo: string;
  }[]>([]);

  // 3-Way Match & Policy state
  const [matchPolicy, setMatchPolicy] = useState<any>(null);
  const selectedCompanyIdRef = useRef('');
  const loadDataSeqRef = useRef(0);
  const loadAbortControllerRef = useRef<AbortController | null>(null);
  const [matchState, setMatchState] = useState<MatchReportState>(() => createInitialMatchReportState(''));
  const matchControllerRef = useRef<MatchReportController | null>(null);
  if (!matchControllerRef.current) {
    matchControllerRef.current = new MatchReportController(
      apiFetch,
      (msg) => setError(msg),
      selectedCompanyId,
      {
        matchUrl: (invId, compId) =>
          `/api/purchasing/supplier-invoices/${invId}/three-way-match?companyId=${compId}`,
        exceptionsUrl: (invId, compId) =>
          `/api/purchasing/supplier-invoices/${invId}/price-exceptions?companyId=${compId}`,
      }
    );
  }

  useEffect(() => {
    const controller = matchControllerRef.current!;
    setMatchState(controller.getState());
    return controller.subscribe((next) => {
      setMatchState(next);
    });
  }, []);

  const selectedMatchInvoiceId = matchState.selectedInvoiceId;
  const matchReport = matchState.reportCompanyId === selectedCompanyId ? matchState.matchReport : null;
  const priceExceptions = matchState.reportCompanyId === selectedCompanyId ? matchState.priceExceptions : [];
  const exceptionsLoading = matchState.loading;
  const trustedMatchInvoice = resolveTrustedMatchInvoice({
    selectedCompanyId,
    selectedInvoiceId: selectedMatchInvoiceId,
    matchReport,
    reportCompanyId: matchState.reportCompanyId,
    invoicesCompanyId,
    invoices,
  });

  // Returns state
  const [returnsList, setReturnsList] = useState<any[]>([]);
  const [returnableLines, setReturnableLines] = useState<any[]>([]);
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [returnSupplierId, setReturnSupplierId] = useState('');
  const [returnWarehouseId, setReturnWarehouseId] = useState('');
  const [returnGrnId, setReturnGrnId] = useState('');
  const [returnInvoiceId, setReturnInvoiceId] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [returnMemo, setReturnMemo] = useState('');
  const [selectedReturnLines, setSelectedReturnLines] = useState<{
    grnLineId: string;
    qty: number;
    unitCost: number;
    maxQty: number;
    itemId: string;
    itemNameAr: string;
  }[]>([]);

  // AP Open Items state
  const [apOpenItems, setApOpenItems] = useState<any[]>([]);

  // Supplier Payments state
  const [supplierPayments, setSupplierPayments] = useState<any[]>([]);
  const [cashRegisters, setCashRegisters] = useState<any[]>([]);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paySupplierId, setPaySupplierId] = useState('');
  const [payInvoiceId, setPayInvoiceId] = useState('');
  const [payRegisterId, setPayRegisterId] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payReference, setPayReference] = useState('');
  const [payMemo, setPayMemo] = useState('');

  const fetchMatchReport = useCallback(
    async (invId: string, targetCompanyId?: string) => {
      const companyId = targetCompanyId ?? selectedCompanyIdRef.current ?? selectedCompanyId;
      await matchControllerRef.current!.fetchMatchReport(invId, companyId);
    },
    [selectedCompanyId]
  );

  const fetchReturnableLines = async (supplierId: string) => {
    setReturnGrnId('');
    setReturnWarehouseId('');
    setSelectedReturnLines([]);
    if (!supplierId || !selectedCompanyId) {
      setReturnableLines([]);
      return;
    }
    try {
      const res = await apiFetch(`/api/purchasing/returns/returnable?companyId=${selectedCompanyId}&supplierId=${supplierId}`);
      if (res.ok) {
        const data = await res.json();
        const rows = data.returnableLines || [];
        setReturnableLines(rows);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.message || data.error || 'تعذر تحميل بنود الاستلام القابلة للإرجاع');
      }
    } catch (err: any) {
      setError(err.message || 'فشل تحميل بنود المرتجعات المتاحة');
    }
  };

  // A return is made against ONE goods receipt (the server requires every line to belong to it).
  // Picking the receipt also fixes the warehouse and loads only that receipt's lines.
  const selectReturnGrn = (grnId: string) => {
    setReturnGrnId(grnId);
    const lines = (returnableLines as any[]).filter((l) => l.grnId === grnId);
    setReturnWarehouseId(lines[0]?.warehouseId || '');
    setSelectedReturnLines(
      lines.map((l: any) => ({
        grnLineId: l.grnLineId,
        qty: l.returnableQty,
        unitCost: l.unitCost,
        maxQty: l.returnableQty,
        itemId: l.itemId,
        itemNameAr: l.itemNameAr,
      }))
    );
  };

  const handleCreateReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId) return;
    const validLines = selectedReturnLines.filter((l) => l.qty > 0);
    if (validLines.length === 0) {
      setError('يرجى تحديد بند واحد على الأقل بكمية صالحة للإرجاع');
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      await apiCall('/api/purchasing/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          supplierId: returnSupplierId,
          warehouseId: returnWarehouseId,
          grnId: returnGrnId,
          invoiceId: returnInvoiceId || undefined,
          reason: returnReason || undefined,
          memo: returnMemo || undefined,
          lines: validLines.map((l) => ({
            grnLineId: l.grnLineId,
            qty: l.qty,
            unitCost: l.unitCost,
          })),
        }),
      });
      setSuccess('تم إنشاء مسودة مرتجع المشتريات بنجاح');
      setShowReturnModal(false);
      setReturnReason('');
      setReturnMemo('');
      setSelectedReturnLines([]);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل إنشاء مرتجع المشتريات');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePostReturn = async (id: string) => {
    if (!(await askConfirm('هل أنت متأكد من ترحيل مرتجع المشتريات وخصم المخزون؟'))) return;
    setActionLoading(true);
    setError(null);
    try {
      await apiCall(`/api/purchasing/returns/${id}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId }),
      });
      setSuccess('تم ترحيل مرتجع المشتريات بنجاح');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل ترحيل المرتجع');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteReturn = async (id: string) => {
    if (!(await askConfirm('هل أنت متأكد من حذف مسودة المرتجع؟'))) return;
    setActionLoading(true);
    setError(null);
    try {
      await apiCall(`/api/purchasing/returns/${id}?companyId=${selectedCompanyId}`, {
        method: 'DELETE',
      });
      setSuccess('تم حذف مسودة المرتجع بنجاح');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل حذف مسودة المرتجع');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCreatePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId) return;
    setActionLoading(true);
    setError(null);
    try {
      await apiCall('/api/purchasing/supplier-payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          supplierId: paySupplierId,
          invoiceId: payInvoiceId,
          registerId: payRegisterId,
          amount: Number(payAmount),
          reference: payReference || undefined,
          memo: payMemo || undefined,
        }),
      });
      setSuccess('تم إنشاء مسودة سند السداد النقدي بنجاح');
      setShowPaymentModal(false);
      setPayAmount('');
      setPayReference('');
      setPayMemo('');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل إنشاء سند السداد');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePostPayment = async (id: string) => {
    if (!(await askConfirm('هل أنت متأكد من ترحيل سند السداد من الصندوق؟'))) return;
    setActionLoading(true);
    setError(null);
    try {
      await apiCall(`/api/purchasing/supplier-payments/${id}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: selectedCompanyId }),
      });
      setSuccess('تم ترحيل سند السداد النقدي بنجاح');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل ترحيل سند السداد (رصيد الصندوق قد يكون غير كافٍ)');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeletePayment = async (id: string) => {
    if (!(await askConfirm('هل أنت متأكد من حذف مسودة سند السداد؟'))) return;
    setActionLoading(true);
    setError(null);
    try {
      await apiCall(`/api/purchasing/supplier-payments/${id}?companyId=${selectedCompanyId}`, {
        method: 'DELETE',
      });
      setSuccess('تم حذف مسودة سند السداد بنجاح');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل حذف مسودة سند السداد');
    } finally {
      setActionLoading(false);
    }
  };

  const fetchOutstandingLines = async (supplierId: string) => {
    if (!supplierId || !selectedCompanyId) {
      setOutstandingLines([]);
      setSelectedOutstandingLines([]);
      return;
    }
    try {
      const res = await apiFetch(
        `/api/purchasing/supplier-invoices/outstanding?companyId=${selectedCompanyId}&supplierId=${supplierId}`
      );
      if (res.ok) {
        const data = await res.json();
        const rows: OutstandingGrnLineRow[] = data.outstandingLines || [];
        setOutstandingLines(rows);
        setSelectedOutstandingLines(
          rows.map((l: OutstandingGrnLineRow) => ({
            grnLineId: l.grnLineId,
            qty: l.remainingQty,
            unitCost: l.unitCost,
            maxQty: l.remainingQty,
            itemId: l.itemId,
            itemCode: l.itemCode,
            itemNameAr: l.itemNameAr,
            itemUom: l.itemUom,
            grnNo: l.grnNo || '',
          }))
        );
      }
    } catch (err: any) {
      setError(err.message || 'فشل تحميل البنود المتبقية');
    }
  };

  const handleCreateInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId) return;
    const validLines = selectedOutstandingLines.filter((l) => l.qty > 0);
    if (validLines.length === 0) {
      setError('يرجى تحديد بند واحد على الأقل بكمية صالحة للفوترة');
      return;
    }
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch('/api/purchasing/supplier-invoices', {
        method: 'POST',
        body: JSON.stringify({
          companyId: selectedCompanyId,
          supplierId: invSupplierId,
          supplierInvoiceNo: invSupplierInvoiceNo,
          invoiceDate: invDate || undefined,
          dueDate: invDueDate || undefined,
          memo: invMemo || undefined,
          lines: validLines.map((l) => ({
            grnLineId: l.grnLineId,
            qty: l.qty,
            unitCost: l.unitCost,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || 'فشل إنشاء فاتورة المورد');
      }
      setSuccess('تم إنشاء فاتورة المورد كمسودة بنجاح');
      setShowInvoiceModal(false);
      setInvSupplierInvoiceNo('');
      setInvMemo('');
      setSelectedOutstandingLines([]);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'فشل إنشاء فاتورة المورد');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePostInvoice = async (id: string) => {
    if (!(await askConfirm('هل أنت متأكد من ترحيل هذه الفاتورة وتوليد القيد المحاسبي؟'))) return;
    const targetCompanyId = selectedCompanyId;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/purchasing/supplier-invoices/${id}/post`, {
        method: 'POST',
        body: JSON.stringify({ companyId: targetCompanyId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || 'فشل ترحيل الفاتورة');
      }
      if (selectedCompanyIdRef.current === targetCompanyId) {
        setSuccess('تم ترحيل فاتورة المورد بنجاح وتوليد قيد الدائنين');
        await loadData();
      }
    } catch (err: any) {
      if (selectedCompanyIdRef.current === targetCompanyId) {
        setError(err.message || 'فشل ترحيل الفاتورة');
      }
    } finally {
      if (selectedCompanyIdRef.current === targetCompanyId) {
        setActionLoading(false);
        const currentMatch = matchControllerRef.current!.getState();
        if (currentMatch.companyId === targetCompanyId && currentMatch.selectedInvoiceId === id) {
          await fetchMatchReport(id, targetCompanyId);
        }
      } else {
        setActionLoading(false);
      }
    }
  };

  const handleDeleteInvoice = async (id: string) => {
    if (!(await askConfirm('هل أنت متأكد من حذف هذه المسودة؟'))) return;
    const targetCompanyId = selectedCompanyId;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/purchasing/supplier-invoices/${id}?companyId=${targetCompanyId}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || 'فشل حذف مسودة الفاتورة');
      }
      const currentMatch = matchControllerRef.current!.getState();
      if (currentMatch.companyId === targetCompanyId && currentMatch.selectedInvoiceId === id) {
        matchControllerRef.current!.clearSelection();
      }
      if (selectedCompanyIdRef.current === targetCompanyId) {
        setSuccess('تم حذف مسودة الفاتورة بنجاح');
        await loadData();
      }
    } catch (err: any) {
      if (selectedCompanyIdRef.current === targetCompanyId) {
        setError(err.message || 'فشل حذف مسودة الفاتورة');
      }
    } finally {
      setActionLoading(false);
    }
  };

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
  const [grnPoId, setGrnPoId] = useState('');
  const [grnSupplierId, setGrnSupplierId] = useState('');
  const [grnWarehouseId, setGrnWarehouseId] = useState('');
  const [grnMemo, setGrnMemo] = useState('');
  const [grnLines, setGrnLines] = useState<{ itemId: string; qty: string; unitCost: string; poLineId?: string }[]>([
    { itemId: '', qty: '1', unitCost: '' },
  ]);

  const isPlatformAdmin = userRole === 'platform_admin';
  const canReadPo = isPlatformAdmin || userPermissions.includes('purchasing:read');
  const canWritePo = isPlatformAdmin || userPermissions.includes('purchasing:write');
  const canPostPo = isPlatformAdmin || userPermissions.includes('purchasing:post');
  const canPostInvoice = isPlatformAdmin || userRole === 'company_admin' || userPermissions.includes('purchasing:post');
  const canWrite = isPlatformAdmin || userRole === 'company_admin' || userPermissions.includes('purchasing:write');
  const canRequestVariance =
    authMeLoaded && (isPlatformAdmin || userPermissions.includes('purchasing:variance:request'));
  const canApproveVariance =
    authMeLoaded && (isPlatformAdmin || userPermissions.includes('purchasing:variance:approve'));

  const handleCompanyChange = useCallback((nextCompanyId: string) => {
    selectedCompanyIdRef.current = nextCompanyId;
    setSelectedCompanyId(nextCompanyId);
    loadAbortControllerRef.current?.abort();
    loadDataSeqRef.current += 1;
    setLoading(false);
    setError(null);
    setSuccess(null);
    setSuppliers([]);
    setPurchaseOrders([]);
    setGrns([]);
    setInvoices([]);
    setInvoicesCompanyId('');
    setWarehouses([]);
    setItems([]);
    setMatchPolicy(null);
    setReturnsList([]);
    setApOpenItems([]);
    setSupplierPayments([]);
    setCashRegisters([]);
    matchControllerRef.current!.setCompanyContext(nextCompanyId);
  }, []);

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
          if (list.length > 0) {
            selectedCompanyIdRef.current = list[0].id;
            matchControllerRef.current!.setCompanyContext(list[0].id);
            setSelectedCompanyId(list[0].id);
          }
        }

        if (meRes.ok) {
          const meData = await meRes.json();
          if (Array.isArray(meData.permissions)) {
            setUserPermissions(meData.permissions);
          }
          if (meData.user?.id) {
            setCurrentUserId(meData.user.id);
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
    const targetCompanyId = selectedCompanyId;
    if (!targetCompanyId) return;
    selectedCompanyIdRef.current = targetCompanyId;
    loadAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    loadAbortControllerRef.current = abortController;
    const reqSeq = ++loadDataSeqRef.current;
    const isCurrentLoad = () =>
      loadDataSeqRef.current === reqSeq && selectedCompanyIdRef.current === targetCompanyId;

    setLoading(true);
    setError(null);
    try {
      const reqInit: RequestInit = { signal: abortController.signal };
      const requests: Promise<Response>[] = [
        apiFetch(`/api/purchasing/suppliers?companyId=${targetCompanyId}`, reqInit),
        apiFetch(`/api/purchasing/grn?companyId=${targetCompanyId}`, reqInit),
        apiFetch(`/api/purchasing/supplier-invoices?companyId=${targetCompanyId}`, reqInit),
        apiFetch(`/api/inventory/warehouses?companyId=${targetCompanyId}`, reqInit),
        apiFetch(`/api/inventory/items?companyId=${targetCompanyId}`, reqInit),
        apiFetch(`/api/purchasing/three-way-match/policy?companyId=${targetCompanyId}`, reqInit),
        apiFetch(`/api/purchasing/returns?companyId=${targetCompanyId}`, reqInit),
        apiFetch(`/api/purchasing/ap/open-items?companyId=${targetCompanyId}`, reqInit),
        apiFetch(`/api/purchasing/supplier-payments?companyId=${targetCompanyId}`, reqInit),
        apiFetch(`/api/cash/registers?companyId=${targetCompanyId}`, reqInit),
      ];

      if (canReadPo) {
        requests.push(apiFetch(`/api/purchasing/purchase-orders?companyId=${targetCompanyId}`, reqInit));
      }

      const results = await Promise.all(requests);
      if (!isCurrentLoad()) return;

      const [
        suppJson,
        grnJson,
        invJson,
        whJson,
        itemJson,
        policyJson,
        retJson,
        apJson,
        payJson,
        regJson,
        poJson,
      ] = await Promise.all([
        results[0].ok ? results[0].json().catch(() => null) : null,
        results[1].ok ? results[1].json().catch(() => null) : null,
        results[2].ok ? results[2].json().catch(() => null) : null,
        results[3].ok ? results[3].json().catch(() => null) : null,
        results[4].ok ? results[4].json().catch(() => null) : null,
        results[5].ok ? results[5].json().catch(() => null) : null,
        results[6].ok ? results[6].json().catch(() => null) : null,
        results[7].ok ? results[7].json().catch(() => null) : null,
        results[8].ok ? results[8].json().catch(() => null) : null,
        results[9].ok ? results[9].json().catch(() => null) : null,
        results[10] && results[10].ok ? results[10].json().catch(() => null) : null,
      ]);

      if (!isCurrentLoad()) return;

      if (suppJson) setSuppliers(suppJson.suppliers || []);
      if (grnJson) setGrns(grnJson.grns || []);
      if (invJson && Array.isArray(invJson.invoices)) {
        setInvoices(invJson.invoices);
        setInvoicesCompanyId(targetCompanyId);
      } else {
        setInvoices([]);
        setInvoicesCompanyId('');
      }
      if (whJson) setWarehouses(whJson.warehouses || []);
      if (itemJson) setItems(itemJson.items || []);
      if (policyJson) setMatchPolicy(policyJson.policy || null);
      if (retJson) setReturnsList(retJson.returns || []);
      if (apJson) setApOpenItems(apJson.openItems || []);
      if (payJson) setSupplierPayments(payJson.payments || []);
      if (regJson) setCashRegisters(regJson.registers || []);

      if (poJson) {
        setPurchaseOrders(poJson.purchaseOrders || []);
      } else if (!canReadPo) {
        setPurchaseOrders([]);
      }

      const currentMatch = matchControllerRef.current!.getState();
      if (currentMatch.selectedInvoiceId && currentMatch.companyId === targetCompanyId) {
        await fetchMatchReport(currentMatch.selectedInvoiceId, targetCompanyId);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || !isCurrentLoad()) return;
      setError(err instanceof Error ? err.message : 'خطأ أثناء تحميل بيانات المشتريات');
    } finally {
      if (loadDataSeqRef.current === reqSeq && selectedCompanyIdRef.current === targetCompanyId) {
        setLoading(false);
      }
    }
  }, [selectedCompanyId, canReadPo, fetchMatchReport]);

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

  const handleGrnPoChange = async (selectedPoId: string) => {
    setGrnPoId(selectedPoId);
    if (!selectedPoId) return;

    try {
      const res = await apiFetch(`/api/purchasing/purchase-orders/${selectedPoId}/remaining?companyId=${selectedCompanyId}`);
      if (res.ok) {
        const data = await res.json();
        const po = data.purchaseOrder;
        if (po && po.supplierId) {
          setGrnSupplierId(po.supplierId);
        }
        if (Array.isArray(data.lines)) {
          const mappedLines = data.lines.map((l: any) => ({
            itemId: l.itemId,
            qty: String(l.remainingQty > 0 ? l.remainingQty : l.qty),
            unitCost: l.unitCost ? String(l.unitCost) : '',
            poLineId: l.id,
          }));
          if (mappedLines.length > 0) {
            setGrnLines(mappedLines);
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch PO remaining lines:', err);
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
        poLineId: l.poLineId || undefined,
      }));

      const res = await apiFetch('/api/purchasing/grn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          supplierId: grnSupplierId,
          warehouseId: grnWarehouseId,
          memo: grnMemo,
          poId: grnPoId || undefined,
          lines: formattedLines,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل إنشاء مسودة سند الاستلام');

      setSuccess('تم إنشاء مسودة سند استلام البضائع (GRN) بنجاح');
      setShowGrnModal(false);
      setGrnPoId('');
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
      {confirmDialog}
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
              onChange={(e) => handleCompanyChange(e.target.value)}
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
          {canWrite && (
            <button
              onClick={() => {
                setShowInvoiceModal(true);
                setInvSupplierId('');
                setOutstandingLines([]);
                setSelectedOutstandingLines([]);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-violet-600/20 transition cursor-pointer whitespace-nowrap shrink-0"
            >
              <ShoppingBag className="w-3.5 h-3.5" />
              <span>فاتورة مورد جديدة</span>
            </button>
          )}

          {canWrite && (
            <button
              onClick={() => {
                setShowReturnModal(true);
                setError(null);
                setReturnSupplierId('');
                setReturnGrnId('');
                setReturnWarehouseId('');
                setReturnInvoiceId('');
                setReturnableLines([]);
                setSelectedReturnLines([]);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-rose-600/20 transition cursor-pointer whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>مرتجع مشتريات جديد</span>
            </button>
          )}

          {canWrite && (
            <button
              onClick={() => {
                setShowPaymentModal(true);
                setPaySupplierId('');
                setPayInvoiceId('');
                setPayRegisterId('');
                setPayAmount('');
                setPayReference('');
                setPayMemo('');
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-emerald-600/20 transition cursor-pointer whitespace-nowrap shrink-0"
            >
              <CreditCard className="w-3.5 h-3.5" />
              <span>سداد مورد نقداً</span>
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

        <button
          onClick={() => setActiveTab('invoices')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
            activeTab === 'invoices'
              ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <ShoppingBag className="w-4 h-4" />
          <span>فواتير الموردين ({invoices.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('match')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
            activeTab === 'match'
              ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <Scale className="w-4 h-4" />
          <span>المطابقة الثلاثية (3-Way)</span>
        </button>

        <button
          onClick={() => setActiveTab('returns')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
            activeTab === 'returns'
              ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <RotateCcw className="w-4 h-4" />
          <span>مردودات المشتريات ({returnsList.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('ap')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
            activeTab === 'ap'
              ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <Receipt className="w-4 h-4" />
          <span>المستحقات المفتوحة (AP) ({apOpenItems.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('payments')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
            activeTab === 'payments'
              ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <CreditCard className="w-4 h-4" />
          <span>سداد الموردين نقداً ({supplierPayments.length})</span>
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

      {/* Tab 4: Supplier Invoices (AP) */}
      {activeTab === 'invoices' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">رقم النظام</th>
                  <th className="py-3.5 px-4">رقم فاتورة المورد</th>
                  <th className="py-3.5 px-4">المورد</th>
                  <th className="py-3.5 px-4 text-center">التاريخ</th>
                  <th className="py-3.5 px-4 text-center">الحالة</th>
                  <th className="py-3.5 px-4 text-center">قيد اليومية</th>
                  <th className="py-3.5 px-4 text-left">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {invoices.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-500">
                      لا توجد فواتير موردين مسجلة حتى الآن.
                    </td>
                  </tr>
                ) : (
                  invoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-mono font-bold text-white">{inv.invoiceNo || inv.id.slice(0, 8)}</td>
                      <td className="py-3.5 px-4 font-mono font-bold text-violet-400">{inv.supplierInvoiceNo}</td>
                      <td className="py-3.5 px-4 font-semibold">{inv.supplierNameAr || inv.supplierId.slice(0, 8)}</td>
                      <td className="py-3.5 px-4 text-center font-mono">{inv.invoiceDate?.slice(0, 10)}</td>
                      <td className="py-3.5 px-4 text-center">
                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                          inv.status === 'posted'
                            ? 'bg-emerald-950/60 border border-emerald-800/80 text-emerald-300'
                            : inv.status === 'cancelled'
                            ? 'bg-slate-800 border border-slate-700 text-slate-300'
                            : 'bg-amber-950/60 border border-amber-800/80 text-amber-300'
                        }`}>
                          {inv.status === 'posted' ? 'مرحّلة' : inv.status === 'cancelled' ? 'ملغاة' : 'مسودة'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-center font-mono text-indigo-300">
                        {inv.journalEntryNo || inv.journalEntryId?.slice(0, 8) || '—'}
                      </td>
                      <td className="py-3.5 px-4 text-left flex items-center justify-end gap-2">
                        <button
                          onClick={() => {
                            setActiveTab('match');
                            fetchMatchReport(inv.id);
                          }}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                          title="فحص المطابقة الثلاثية"
                        >
                          <Scale className="w-3 h-3" />
                          <span>المطابقة</span>
                        </button>
                        {inv.status === 'draft' && canPostInvoice && (
                          <button
                            onClick={() => handlePostInvoice(inv.id)}
                            disabled={actionLoading}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                          >
                            <Check className="w-3 h-3" />
                            <span>ترحيل</span>
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

      {/* Tab 5: 3-Way Matching */}
      {activeTab === 'match' && (
        <div className="flex flex-col gap-4">
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-600/20 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
                <Scale className="w-5 h-5" />
              </div>
              <div>
                <h4 className="font-bold text-white text-sm">سياسة المطابقة الثلاثية (3-Way Matching Policy)</h4>
                <p className="text-xs text-slate-400">
                  تسامح الكمية: <span className="font-mono font-bold text-amber-400">{matchPolicy?.qtyTolerancePct ?? 0}%</span> (مطابقة صارمة) |
                  تسامح السعر: <span className="font-mono font-bold text-amber-400">{matchPolicy?.priceTolerancePct ?? 5}%</span> |
                  تقريب الفروقات: <span className="font-mono font-bold text-amber-400">{matchPolicy?.priceRoundingAbs ?? 0.01}</span>
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-slate-300 shrink-0">اختر فاتورة مورد:</label>
              <select
                value={selectedMatchInvoiceId}
                onChange={(e) => fetchMatchReport(e.target.value)}
                className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-500 cursor-pointer"
              >
                <option value="">-- اختر الفاتورة للفحص --</option>
                {invoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.supplierInvoiceNo} ({inv.supplierNameAr || inv.supplierCode || 'مورد'}) -{' '}
                    {inv.status === 'posted' ? 'مرحّلة' : inv.status === 'cancelled' ? 'ملغاة' : 'مسودة'}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {!matchReport ? (
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-12 text-center text-slate-400 text-xs shadow-2xl">
              {exceptionsLoading
                ? 'جاري تحميل تقرير المطابقة الثلاثية وسجل الاستثناءات...'
                : matchState.loadError
                ? matchState.loadError
                : 'يرجى اختيار فاتورة مورد من القائمة أعلاه لعرض نتيجة المطابقة الثلاثية التفصيلية بين أمر الشراء وسند الاستلام والفاتورة.'}
            </div>
          ) : (
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
              <div className="p-4 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">فاتورة رقم:</span>
                  <span className="font-mono font-bold text-white text-sm">{matchReport.supplierInvoiceNo}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">الحالة العامة للمطابقة:</span>
                  <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                    matchReport.overallStatus === 'matched'
                      ? 'bg-emerald-950/60 border border-emerald-800 text-emerald-300'
                      : matchReport.overallStatus === 'within_tolerance'
                      ? 'bg-amber-950/60 border border-amber-800 text-amber-300'
                      : matchReport.overallStatus === 'grn_only'
                      ? 'bg-blue-950/60 border border-blue-800 text-blue-300'
                      : 'bg-rose-950/60 border border-rose-800 text-rose-300'
                  }`}>
                    {matchReport.overallStatus === 'matched' && 'مطابق تماماً (3-Way Match)'}
                    {matchReport.overallStatus === 'within_tolerance' && 'ضمن نسبة التسامح المسموح بها'}
                    {matchReport.overallStatus === 'grn_only' && 'مطابقة ثنائية (استلام مباشر بلا أمر شراء)'}
                    {matchReport.overallStatus === 'variance_exceeded' && 'تجاوز حد التسامح المسموح به'}
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="bg-slate-950/40 border-b border-slate-800 text-slate-400 font-semibold">
                      <th className="py-3 px-4">الصنف</th>
                      <th className="py-3 px-4 text-center">أمر الشراء (PO)</th>
                      <th className="py-3 px-4 text-center">الاستلام (GRN)</th>
                      <th className="py-3 px-4 text-center">الفاتورة (Invoice)</th>
                      <th className="py-3 px-4 text-center">فارق السعر (%)</th>
                      <th className="py-3 px-4 text-center">فارق الكمية</th>
                      <th className="py-3 px-4 text-center">حالة البند والبيان</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-200">
                    {matchReport.lines.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-500">
                          لا توجد بنود في هذه الفاتورة.
                        </td>
                      </tr>
                    ) : (
                      matchReport.lines.map((l: any, idx: number) => (
                        <tr key={idx} className="hover:bg-slate-800/30 transition">
                          <td className="py-3 px-4 font-semibold text-white">
                            <div>{l.itemNameAr || 'صنف'}</div>
                            <div className="text-[10px] text-slate-400 font-mono">{l.itemCode}</div>
                          </td>
                          <td className="py-3 px-4 text-center font-mono">
                            {l.poLineId ? (
                              <span>كمية: {l.poQty ?? '—'} | سعر: {l.poUnitCost ?? '—'}</span>
                            ) : (
                              <span className="text-slate-500">بلا أمر شراء</span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-center font-mono">
                            <span>كمية: {l.grnQty} | سعر: {l.grnUnitCost}</span>
                          </td>
                          <td className="py-3 px-4 text-center font-mono font-bold text-amber-300">
                            <span>كمية: {l.invoiceQty} | سعر: {l.invoiceUnitCost}</span>
                          </td>
                          <td className="py-3 px-4 text-center font-mono font-bold">
                            <span className={l.priceVariancePct > 5 ? 'text-rose-400' : l.priceVariancePct > 0 ? 'text-amber-400' : 'text-emerald-400'}>
                              {l.priceVariancePct}%
                            </span>
                          </td>
                          <td className="py-3 px-4 text-center font-mono">
                            <span className={l.qtyVariance !== 0 ? 'text-rose-400' : 'text-emerald-400'}>
                              {l.qtyVariance}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-center">
                            <div className="flex flex-col items-center gap-1">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                l.status === 'matched'
                                  ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/60'
                                  : l.status === 'within_tolerance'
                                  ? 'bg-amber-950/60 text-amber-300 border border-amber-800/60'
                                  : l.status === 'grn_only'
                                  ? 'bg-blue-950/60 text-blue-300 border border-blue-800/60'
                                  : 'bg-rose-950/60 text-rose-300 border border-rose-800/60'
                              }`}>
                                {l.status === 'matched' && 'مطابق'}
                                {l.status === 'within_tolerance' && 'ضمن التسامح'}
                                {l.status === 'grn_only' && 'استلام مباشر'}
                                {l.status === 'variance_exceeded' && 'تجاوز التسامح'}
                              </span>
                              <span className="text-[10px] text-slate-400">{l.messageAr}</span>
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

          {matchReport && matchState.reportCompanyId === selectedCompanyId && (
            <PriceVarianceExceptionPanel
              companyId={selectedCompanyId}
              invoice={trustedMatchInvoice}
              matchReport={matchReport}
              exceptions={priceExceptions}
              loading={exceptionsLoading}
              loadError={matchState.loadError}
              currentUserId={currentUserId}
              canRequestVariance={canRequestVariance}
              canApproveVariance={canApproveVariance}
              canPostInvoice={canPostInvoice}
              actionLoading={actionLoading}
              onRefresh={async () => {
                if (selectedMatchInvoiceId && selectedCompanyId) {
                  await fetchMatchReport(selectedMatchInvoiceId, selectedCompanyId);
                }
              }}
              onPostInvoice={handlePostInvoice}
              onError={setError}
              onSuccess={setSuccess}
            />
          )}
        </div>
      )}

      {/* Tab 6: Purchase Returns */}
      {activeTab === 'returns' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">رقم المرتجع</th>
                  <th className="py-3.5 px-4">المورد</th>
                  <th className="py-3.5 px-4">المستودع</th>
                  <th className="py-3.5 px-4">سند الاستلام</th>
                  <th className="py-3.5 px-4 text-center">التاريخ</th>
                  <th className="py-3.5 px-4 text-center">الحالة</th>
                  <th className="py-3.5 px-4 text-center">قيد اليومية</th>
                  <th className="py-3.5 px-4 text-left">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {returnsList.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-500">
                      لا توجد مردودات مشتريات مسجلة حتى الآن.
                    </td>
                  </tr>
                ) : (
                  returnsList.map((ret) => (
                    <tr key={ret.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-mono font-bold text-white">{ret.returnNo || ret.id.slice(0, 8)}</td>
                      <td className="py-3.5 px-4 font-semibold">{ret.supplierNameAr || ret.supplierCode || ret.supplierId.slice(0, 8)}</td>
                      <td className="py-3.5 px-4">{ret.warehouseNameAr || ret.warehouseCode || 'مستودع'}</td>
                      <td className="py-3.5 px-4 font-mono text-amber-300">{ret.grnNo || ret.grnId.slice(0, 8)}</td>
                      <td className="py-3.5 px-4 text-center font-mono">{ret.returnDate?.slice(0, 10)}</td>
                      <td className="py-3.5 px-4 text-center">
                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                          ret.status === 'posted'
                            ? 'bg-emerald-950/60 border border-emerald-800/80 text-emerald-300'
                            : 'bg-amber-950/60 border border-amber-800/80 text-amber-300'
                        }`}>
                          {ret.status === 'posted' ? 'مرحّل' : 'مسودة'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-center font-mono text-indigo-300">
                        {ret.journalEntryNo || ret.journalEntryId?.slice(0, 8) || '—'}
                      </td>
                      <td className="py-3.5 px-4 text-left flex items-center justify-end gap-2">
                        {ret.status === 'draft' && canWrite && (
                          <button
                            onClick={() => handlePostReturn(ret.id)}
                            disabled={actionLoading}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                          >
                            <Check className="w-3 h-3" />
                            <span>ترحيل</span>
                          </button>
                        )}
                        {ret.status === 'draft' && canWrite && (
                          <button
                            onClick={() => handleDeleteReturn(ret.id)}
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

      {/* Tab 7: AP Open Items */}
      {activeTab === 'ap' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">المورد</th>
                  <th className="py-3.5 px-4">رقم فاتورة المورد</th>
                  <th className="py-3.5 px-4">رقم النظام</th>
                  <th className="py-3.5 px-4 text-center">تاريخ الفاتورة</th>
                  <th className="py-3.5 px-4 text-center">الاستحقاق</th>
                  <th className="py-3.5 px-4 text-center">إجمالي الفاتورة</th>
                  <th className="py-3.5 px-4 text-center">المردودات</th>
                  <th className="py-3.5 px-4 text-center">المدفوع</th>
                  <th className="py-3.5 px-4 text-center font-bold text-amber-300">الرصيد المفتوح</th>
                  <th className="py-3.5 px-4 text-center">الحالة</th>
                  <th className="py-3.5 px-4 text-center">عمر الدين</th>
                  <th className="py-3.5 px-4 text-left">إجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {apOpenItems.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="py-12 text-center text-slate-500">
                      لا توجد مستحقات أو ذمم دائنة مفتوحة حالياً.
                    </td>
                  </tr>
                ) : (
                  apOpenItems.map((item) => (
                    <tr key={item.invoiceId} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-semibold text-white">
                        {item.supplierNameAr} <span className="font-mono text-slate-400">({item.supplierCode})</span>
                      </td>
                      <td className="py-3.5 px-4 font-mono font-bold text-violet-400">{item.supplierInvoiceNo}</td>
                      <td className="py-3.5 px-4 font-mono text-slate-400">{item.invoiceNo || item.invoiceId.slice(0, 8)}</td>
                      <td className="py-3.5 px-4 text-center font-mono">{item.invoiceDate}</td>
                      <td className="py-3.5 px-4 text-center font-mono text-slate-400">{item.dueDate || '—'}</td>
                      <td className="py-3.5 px-4 text-center font-mono tabular-nums">{item.invoiceTotal.toFixed(2)}</td>
                      <td className="py-3.5 px-4 text-center font-mono tabular-nums text-rose-400">{item.creditedReturnTotal.toFixed(2)}</td>
                      <td className="py-3.5 px-4 text-center font-mono tabular-nums text-emerald-400">{item.paidPaymentTotal.toFixed(2)}</td>
                      <td className="py-3.5 px-4 text-center font-mono tabular-nums font-bold text-amber-300 text-sm">
                        {item.remainingOpenAmount.toFixed(2)}
                        {item.supplierCreditAmount > 0 && (
                          <div className="text-[10px] font-normal text-sky-300">
                            رصيد دائن للمورد: {item.supplierCreditAmount.toFixed(2)}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                          item.paymentStatus === 'paid'
                            ? 'bg-emerald-950/60 border border-emerald-800/80 text-emerald-300'
                            : item.paymentStatus === 'partial'
                            ? 'bg-amber-950/60 border border-amber-800/80 text-amber-300'
                            : 'bg-rose-950/60 border border-rose-800/80 text-rose-300'
                        }`}>
                          {item.paymentStatus === 'paid' && 'مسدد بالكامل'}
                          {item.paymentStatus === 'partial' && 'مسدد جزئياً'}
                          {item.paymentStatus === 'open' && 'مفتوح بالكامل'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-center font-mono">
                        <span className={item.agingDays > 60 ? 'text-rose-400 font-bold' : item.agingDays > 30 ? 'text-amber-400' : 'text-slate-300'}>
                          {item.agingDays} يوم
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-left">
                        {item.remainingOpenAmount > 0 && canWrite && (
                          <button
                            onClick={() => {
                              setShowPaymentModal(true);
                              setPaySupplierId(item.supplierId);
                              setPayInvoiceId(item.invoiceId);
                              setPayAmount(String(item.remainingOpenAmount));
                            }}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer whitespace-nowrap"
                          >
                            <CreditCard className="w-3 h-3" />
                            <span>سداد</span>
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

      {/* Tab 8: Supplier Payments */}
      {activeTab === 'payments' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">رقم السند</th>
                  <th className="py-3.5 px-4">المورد</th>
                  <th className="py-3.5 px-4">فاتورة المورد</th>
                  <th className="py-3.5 px-4">الصندوق / الخزينة</th>
                  <th className="py-3.5 px-4 text-center">التاريخ</th>
                  <th className="py-3.5 px-4 text-center font-bold text-emerald-400">المبلغ</th>
                  <th className="py-3.5 px-4 text-center">الحالة</th>
                  <th className="py-3.5 px-4 text-center">قيد اليومية</th>
                  <th className="py-3.5 px-4 text-left">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {supplierPayments.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-slate-500">
                      لا توجد سندات سداد نقدية مسجلة حتى الآن.
                    </td>
                  </tr>
                ) : (
                  supplierPayments.map((pay) => (
                    <tr key={pay.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 font-mono font-bold text-white">{pay.paymentNo || pay.id.slice(0, 8)}</td>
                      <td className="py-3.5 px-4 font-semibold">{pay.supplierNameAr || pay.supplierCode || 'مورد'}</td>
                      <td className="py-3.5 px-4 font-mono text-violet-400">{pay.supplierInvoiceNo || pay.invoiceId.slice(0, 8)}</td>
                      <td className="py-3.5 px-4 font-medium text-amber-300">{pay.registerNameAr || pay.registerCode || 'صندوق'}</td>
                      <td className="py-3.5 px-4 text-center font-mono">{pay.paymentDate?.slice(0, 10)}</td>
                      <td className="py-3.5 px-4 text-center font-mono font-bold text-emerald-400 text-sm">
                        {pay.amount.toFixed(2)}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                          pay.status === 'posted'
                            ? 'bg-emerald-950/60 border border-emerald-800/80 text-emerald-300'
                            : 'bg-amber-950/60 border border-amber-800/80 text-amber-300'
                        }`}>
                          {pay.status === 'posted' ? 'مرحّل' : 'مسودة'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-center font-mono text-indigo-300">
                        {pay.journalEntryNo || pay.journalEntryId?.slice(0, 8) || '—'}
                      </td>
                      <td className="py-3.5 px-4 text-left flex items-center justify-end gap-2">
                        {pay.status === 'draft' && canWrite && (
                          <button
                            onClick={() => handlePostPayment(pay.id)}
                            disabled={actionLoading}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                          >
                            <Check className="w-3 h-3" />
                            <span>ترحيل</span>
                          </button>
                        )}
                        {pay.status === 'draft' && canWrite && (
                          <button
                            onClick={() => handleDeletePayment(pay.id)}
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
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الربط بأمر شراء معتمد (اختياري)</label>
                <select
                  value={grnPoId}
                  onChange={(e) => handleGrnPoChange(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value="">-- بدون أمر شراء (استلام مباشر) --</option>
                  {purchaseOrders
                    .filter((p) => p.status === 'approved')
                    .map((po) => (
                      <option key={po.id} value={po.id}>
                        {po.poNo || po.id.slice(0, 8)} - {po.supplierNameAr}
                      </option>
                    ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">المورد *</label>
                  <select
                    required
                    value={grnSupplierId}
                    onChange={(e) => setGrnSupplierId(e.target.value)}
                    disabled={Boolean(grnPoId)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer disabled:opacity-60"
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
                  {!grnPoId && (
                    <button
                      type="button"
                      onClick={handleAddGrnLine}
                      className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-indigo-300 rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                      <span>إضافة بند</span>
                    </button>
                  )}
                </div>

                {grnLines.map((line, idx) => (
                  <div key={idx} className="flex flex-wrap sm:flex-nowrap items-center gap-2 bg-slate-900 p-2 rounded-lg border border-slate-800">
                    <select
                      required
                      disabled={Boolean(grnPoId)}
                      value={line.itemId}
                      onChange={(e) => {
                        const newLines = [...grnLines];
                        newLines[idx].itemId = e.target.value;
                        setGrnLines(newLines);
                      }}
                      className="flex-1 px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white focus:outline-none disabled:opacity-60"
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

                    {!grnPoId && grnLines.length > 1 && (
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

      {/* Supplier Invoice Modal */}
      {showInvoiceModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إنشاء فاتورة مورد جديدة (AP Invoice)</h4>
              <button onClick={() => setShowInvoiceModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateInvoice} className="flex flex-col gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">المورد *</label>
                  <select
                    required
                    value={invSupplierId}
                    onChange={(e) => {
                      setInvSupplierId(e.target.value);
                      fetchOutstandingLines(e.target.value);
                    }}
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
                  <label className="block text-xs font-semibold text-slate-300 mb-1">رقم فاتورة المورد *</label>
                  <input
                    type="text"
                    required
                    placeholder="مثل: INV-2026-001"
                    value={invSupplierInvoiceNo}
                    onChange={(e) => setInvSupplierInvoiceNo(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">تاريخ الفاتورة</label>
                  <input
                    type="date"
                    value={invDate}
                    onChange={(e) => setInvDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">تاريخ الاستحقاق (Due Date)</label>
                  <input
                    type="date"
                    value={invDueDate}
                    onChange={(e) => setInvDueDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">ملاحظات / بيان</label>
                  <input
                    type="text"
                    placeholder="ملاحظات اختيارية"
                    value={invMemo}
                    onChange={(e) => setInvMemo(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Outstanding GRN lines */}
              <div className="border border-slate-800 rounded-xl p-3 bg-slate-950/60 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300">بنود استلام البضائع غير المفوترة (المتبقية)</span>
                  <span className="text-[11px] text-slate-400">حدد الكميات المراد فوترتها</span>
                </div>
                {outstandingLines.length === 0 ? (
                  <div className="py-6 text-center text-slate-500 text-xs">
                    {invSupplierId ? 'لا توجد بنود استلام مرحّلة ومتبقية لهذا المورد' : 'يرجى اختيار المورد أولاً لعرض البنود المتبقية'}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {selectedOutstandingLines.map((line, idx) => (
                      <div key={line.grnLineId} className="flex flex-wrap sm:flex-nowrap items-center gap-3 bg-slate-900 p-2.5 rounded-lg border border-slate-800 text-xs">
                        <div className="flex-1">
                          <div className="font-bold text-white">{line.itemNameAr} ({line.itemCode})</div>
                          <div className="text-[11px] text-slate-400">سند استلام: {line.grnNo || 'GRN'} | متبقي: {line.maxQty} {line.itemUom}</div>
                        </div>
                        <div className="w-24">
                          <label className="block text-[10px] text-slate-400 mb-0.5">الكمية</label>
                          <input
                            type="number"
                            step="0.0001"
                            min="0"
                            max={line.maxQty}
                            value={line.qty}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value) || 0;
                              const updated = [...selectedOutstandingLines];
                              updated[idx].qty = Math.min(Math.max(0, val), line.maxQty);
                              setSelectedOutstandingLines(updated);
                            }}
                            className="w-full px-2 py-1 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono tabular-nums focus:outline-none"
                          />
                        </div>
                        <div className="w-28">
                          <label className="block text-[10px] text-slate-400 mb-0.5">سعر الوحدة</label>
                          <input
                            type="number"
                            step="0.0001"
                            min="0"
                            value={line.unitCost}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value) || 0;
                              const updated = [...selectedOutstandingLines];
                              updated[idx].unitCost = val;
                              setSelectedOutstandingLines(updated);
                            }}
                            className="w-full px-2 py-1 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono tabular-nums focus:outline-none"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowInvoiceModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading || selectedOutstandingLines.filter(l => l.qty > 0).length === 0}
                  className="px-5 py-2 bg-violet-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-violet-600/20 disabled:opacity-50"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ كمسودة'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Purchase Return Modal */}
      {showReturnModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <RotateCcw className="w-5 h-5 text-rose-400" />
                <h4 className="font-bold text-white text-sm">إنشاء مسودة مرتجع مشتريات (Purchase Return)</h4>
              </div>
              <button onClick={() => setShowReturnModal(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateReturn} className="flex flex-col gap-4">
              {error && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200" role="alert" data-testid="return-modal-error">
                  {error}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">المورد *</label>
                  <select
                    required
                    value={returnSupplierId}
                    onChange={(e) => {
                      setReturnSupplierId(e.target.value);
                      fetchReturnableLines(e.target.value);
                    }}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-rose-500 cursor-pointer"
                  >
                    <option value="">-- اختر المورد لجلب البنود المتاحة --</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nameAr} ({s.code})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">سند الاستلام (GRN) المردود منه *</label>
                  <select
                    required
                    value={returnGrnId}
                    onChange={(e) => selectReturnGrn(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-rose-500 cursor-pointer"
                    data-testid="return-grn-select"
                  >
                    <option value="">-- اختر سند الاستلام --</option>
                    {Array.from(new Map((returnableLines as any[]).map((l) => [l.grnId, l])).values()).map((l: any) => {
                      const wh = warehouses.find((w) => w.id === l.warehouseId);
                      return (
                        <option key={l.grnId} value={l.grnId}>
                          {l.grnNo || l.grnId}
                          {wh ? ` - ${wh.nameAr}` : ''}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">سبب الإرجاع</label>
                  <input
                    type="text"
                    placeholder="مثال: تلف في البضاعة / مخالفة المواصفات"
                    value={returnReason}
                    onChange={(e) => setReturnReason(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-rose-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">ملاحظات / بيان إضافي</label>
                  <input
                    type="text"
                    placeholder="ملاحظات اختيارية"
                    value={returnMemo}
                    onChange={(e) => setReturnMemo(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-rose-500"
                  />
                </div>
              </div>

              {/* Returnable Lines Table */}
              <div className="border border-slate-800 rounded-xl p-3 bg-slate-950/60 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300">بنود استلام البضائع القابلة للإرجاع</span>
                  <span className="text-[11px] text-slate-400">حدد الكميات المراد إرجاعها إلى المورد</span>
                </div>
                {selectedReturnLines.length === 0 ? (
                  <div className="py-6 text-center text-slate-500 text-xs">
                    {!returnSupplierId
                      ? 'يرجى اختيار المورد أولاً لعرض البنود المتاحة للإرجاع'
                      : returnableLines.length === 0
                        ? 'لا توجد بنود استلام مرحّلة وقابلة للإرجاع لهذا المورد'
                        : 'اختر سند الاستلام لعرض بنوده'}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {selectedReturnLines.map((line, idx) => (
                      <div key={line.grnLineId} className="flex flex-wrap sm:flex-nowrap items-center gap-3 bg-slate-900 p-2.5 rounded-lg border border-slate-800 text-xs">
                        <div className="flex-1">
                          <div className="font-bold text-white">{line.itemNameAr}</div>
                          <div className="text-[11px] text-slate-400">الحد الأقصى للإرجاع: <span className="font-mono text-amber-300">{line.maxQty}</span> | التكلفة: <span className="font-mono">{line.unitCost.toFixed(2)}</span></div>
                        </div>
                        <div className="w-32">
                          <label className="block text-[10px] text-slate-400 mb-0.5">كمية المرتجع</label>
                          <input
                            type="number"
                            step="0.0001"
                            min="0"
                            max={line.maxQty}
                            value={line.qty}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value) || 0;
                              const updated = [...selectedReturnLines];
                              updated[idx].qty = Math.min(Math.max(0, val), line.maxQty);
                              setSelectedReturnLines(updated);
                            }}
                            className="w-full px-2 py-1 bg-slate-950 border border-slate-800 rounded text-xs text-white font-mono tabular-nums focus:outline-none focus:border-rose-500"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowReturnModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading || !returnGrnId || !returnWarehouseId || selectedReturnLines.filter((l) => l.qty > 0).length === 0}
                  className="px-5 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-rose-600/20 disabled:opacity-50 cursor-pointer"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ كمسودة مرتجع'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Supplier Cash Payment Modal */}
      {showPaymentModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-emerald-400" />
                <h4 className="font-bold text-white text-sm">سداد مورد نقداً من الصندوق (Cash Payment)</h4>
              </div>
              <button onClick={() => setShowPaymentModal(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreatePayment} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">المورد *</label>
                <select
                  required
                  value={paySupplierId}
                  onChange={(e) => {
                    const suppId = e.target.value;
                    setPaySupplierId(suppId);
                    setPayInvoiceId('');
                  }}
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
                <label className="block text-xs font-semibold text-slate-300 mb-1">فاتورة المورد المراد سدادها *</label>
                <select
                  required
                  value={payInvoiceId}
                  onChange={(e) => {
                    const invId = e.target.value;
                    setPayInvoiceId(invId);
                    const openItem = apOpenItems.find((item) => item.invoiceId === invId);
                    if (openItem) {
                      setPayAmount(String(openItem.remainingOpenAmount));
                    }
                  }}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
                >
                  <option value="">-- اختر فاتورة المورد --</option>
                  {(paySupplierId
                    ? apOpenItems.filter((i) => i.supplierId === paySupplierId && i.remainingOpenAmount > 0)
                    : apOpenItems.filter((i) => i.remainingOpenAmount > 0)
                  ).map((item) => (
                    <option key={item.invoiceId} value={item.invoiceId}>
                      فاتورة: {item.supplierInvoiceNo} | الرصيد المتبقي: {item.remainingOpenAmount.toFixed(2)}
                    </option>
                  ))}
                  {/* Fallback to posted invoices if apOpenItems is empty or doesn't have it */}
                  {invoices
                    .filter(
                      (inv) =>
                        inv.status === 'posted' &&
                        (!paySupplierId || inv.supplierId === paySupplierId) &&
                        !apOpenItems.some((aoi) => aoi.invoiceId === inv.id)
                    )
                    .map((inv) => (
                      <option key={inv.id} value={inv.id}>
                        فاتورة: {inv.supplierInvoiceNo} ({inv.invoiceNo || inv.id.slice(0, 8)})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">صندوق النقدية / الخزينة *</label>
                <select
                  required
                  value={payRegisterId}
                  onChange={(e) => setPayRegisterId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
                >
                  <option value="">-- اختر الصندوق المسدد منه --</option>
                  {cashRegisters.map((reg) => (
                    <option key={reg.id} value={reg.id}>
                      {reg.nameAr || reg.name} ({reg.code}) {Number.isFinite(Number(reg.currentBalance ?? reg.balance)) && (reg.currentBalance ?? reg.balance) !== null && (reg.currentBalance ?? reg.balance) !== undefined ? `| الرصيد: ${Number(reg.currentBalance ?? reg.balance).toFixed(2)}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">مبلغ السداد *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    placeholder="0.00"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500 font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">رقم الإيصال / السند المرجعي</label>
                  <input
                    type="text"
                    placeholder="مثل: RCPT-1234"
                    value={payReference}
                    onChange={(e) => setPayReference(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">البيان / ملاحظات السداد</label>
                <input
                  type="text"
                  placeholder="ملاحظات اختيارية"
                  value={payMemo}
                  onChange={(e) => setPayMemo(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowPaymentModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading || !paySupplierId || !payInvoiceId || !payRegisterId || !payAmount || Number(payAmount) <= 0}
                  className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-emerald-600/20 disabled:opacity-50 cursor-pointer"
                >
                  {actionLoading ? 'جاري الحفظ...' : 'حفظ كمسودة سند سداد'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
