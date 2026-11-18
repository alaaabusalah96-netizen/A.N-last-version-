import React, { useState, useEffect, useCallback } from 'react';
import {
  Layers,
  ShieldCheck,
  RefreshCw,
  AlertCircle,
  Plus,
  CheckCircle2,
  X,
  AlertTriangle,
  FileSearch,
  Scale,
  ArrowRightLeft,
  Check,
  Ban,
  Eye,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface ValuationBalance {
  warehouseId: string;
  warehouseCode: string;
  warehouseNameAr: string;
  itemId: string;
  itemCode: string;
  itemNameAr: string;
  itemUom: string;
  costingMethod?: string | null;
  quantity: number;
  totalCost: number;
  unitCost: number;
  updatedAt: string;
}

interface CostingProfile {
  id: string;
  name: string;
  costingMethod: 'FIFO' | 'PERPETUAL_MOVING_AVERAGE';
  isDefault: boolean;
  isActive: boolean;
}

interface ItemCostingAssignment {
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  profileId: string;
  profileName?: string;
  costingMethod?: string;
  assignedAt: string;
}

interface UnassignedItem {
  itemId: string;
  itemCode: string;
  itemNameAr: string;
  hasStock: boolean;
}

interface ValuationSetupStatusItem {
  warehouseId: string;
  warehouseCode: string;
  warehouseNameAr: string;
  itemId: string;
  itemCode: string;
  itemNameAr: string;
  costingMethod: string | null;
  profileName: string | null;
  stockQty: number;
  valuationQty: number;
  valuationTotalCost: number;
  openingStatus: 'not_created' | 'pending_setup' | 'approved' | 'rejected';
  isReady: boolean;
  issueReason: string | null;
}

interface ValuationSetupStatusSummary {
  companyId: string;
  unassignedItems: UnassignedItem[];
  warehouseItemStatuses: ValuationSetupStatusItem[];
  readyCount: number;
  blockedCount: number;
}

interface CostLayer {
  id: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  originalQty: number;
  remainingQty: number;
  unitCost: number;
  totalCost: number;
  sourceType: string;
  sourceId: string;
  originLayerId?: string | null;
  originSourceType?: string | null;
  originSourceId?: string | null;
  effectiveDate: string;
  isExhausted: boolean;
}

interface ValuationMovement {
  id: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  movementType: string;
  qty: number;
  unitCost: number;
  totalCost: number;
  sourceType: string;
  sourceId: string;
  journalEntryId?: string | null;
  reason?: string | null;
  costSource?: string | null;
  costingMethod?: string | null;
  createdAt: string;
}

interface CostAllocation {
  id: string;
  costLayerId?: string | null;
  allocatedQty: number;
  unitCost: number;
  allocatedCost: number;
}

interface CostAdjustment {
  id: string;
  sourceType: string;
  invoiceId?: string | null;
  grnId?: string | null;
  itemCode?: string;
  itemNameAr?: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  costingMethod?: string | null;
  qtyBasis: number;
  originalUnitCost: number;
  finalUnitCost: number;
  unitVariance: number;
  adjustmentAmount: number;
  remainingAllocation: number;
  consumedAllocation: number;
  status: string;
  reason?: string | null;
  journalEntryId?: string | null;
  createdAt: string;
}

interface OpeningValuation {
  id: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  itemId: string;
  itemCode?: string;
  itemNameAr?: string;
  costingMethod?: string | null;
  quantity: number;
  totalCost: number;
  unitCost: number;
  status: 'pending_setup' | 'approved' | 'rejected';
  reason?: string | null;
  evidenceRef?: string | null;
  rejectionReason?: string | null;
  journalEntryId?: string | null;
  createdAt: string;
}

interface ValuationReconciliation {
  id: string;
  warehouseId?: string | null;
  warehouseNameAr?: string | null;
  itemId?: string | null;
  itemNameAr?: string | null;
  costingMethod?: string | null;
  subledgerTotal: number;
  glControlTotal: number;
  variance: number;
  status: 'reconciled' | 'discrepancy_detected';
  unmatchedMovementsCount: number;
  unbalancedAdjustmentsCount: number;
  duplicateJournalLinksCount: number;
  qtyValuationMismatchesCount: number;
  openingDiff: number;
  notes?: string | null;
  reconciledAt: string;
}

interface SimpleRef {
  id: string;
  code: string;
  nameAr: string;
}

interface InventoryValuationPanelProps {
  companyId: string;
  userRole: string;
}

type ValuationSubTab =
  | 'readiness'
  | 'policies'
  | 'balances_layers'
  | 'movements'
  | 'adjustments'
  | 'opening'
  | 'reconciliation';

export function InventoryValuationPanel({ companyId, userRole }: InventoryValuationPanelProps) {
  const [activeSubTab, setActiveSubTab] = useState<ValuationSubTab>('readiness');
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [profiles, setProfiles] = useState<CostingProfile[]>([]);
  const [assignments, setAssignments] = useState<ItemCostingAssignment[]>([]);
  const [setupStatus, setSetupStatus] = useState<ValuationSetupStatusSummary | null>(null);
  const [balances, setBalances] = useState<ValuationBalance[]>([]);
  const [layers, setLayers] = useState<CostLayer[]>([]);
  const [movements, setMovements] = useState<ValuationMovement[]>([]);
  const [adjustments, setAdjustments] = useState<CostAdjustment[]>([]);
  const [openings, setOpenings] = useState<OpeningValuation[]>([]);
  const [reconciliations, setReconciliations] = useState<ValuationReconciliation[]>([]);
  const [warehouses, setWarehouses] = useState<SimpleRef[]>([]);
  const [items, setItems] = useState<SimpleRef[]>([]);

  // Inline item-profile assignment selections
  const [inlineAssignProfile, setInlineAssignProfile] = useState<Record<string, string>>({});
  const [assignItemId, setAssignItemId] = useState('');
  const [assignProfileId, setAssignProfileId] = useState('');

  // Create Profile modal
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [costingMethod, setCostingMethod] = useState<'FIFO' | 'PERPETUAL_MOVING_AVERAGE'>('FIFO');
  const [isDefault, setIsDefault] = useState(false);

  // Filters for layers / movements
  const [filterWhId, setFilterWhId] = useState('');
  const [filterItemId, setFilterItemId] = useState('');
  const [includeExhausted, setIncludeExhausted] = useState(false);

  // Allocations drawer/modal
  const [selectedMovement, setSelectedMovement] = useState<ValuationMovement | null>(null);
  const [movementAllocations, setMovementAllocations] = useState<CostAllocation[]>([]);

  // Opening valuation modal
  const [showOpeningModal, setShowOpeningModal] = useState(false);
  const [openWhId, setOpenWhId] = useState('');
  const [openItemId, setOpenItemId] = useState('');
  const [openQty, setOpenQty] = useState('');
  const [openUnitCost, setOpenUnitCost] = useState('');
  const [openReason, setOpenReason] = useState('');
  const [openEvidence, setOpenEvidence] = useState('');

  // Reject opening modal
  const [rejectOpeningId, setRejectOpeningId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');

  // Reconciliation form
  const [recWhId, setRecWhId] = useState('');
  const [recMethod, setRecMethod] = useState('');
  const [recNotes, setRecNotes] = useState('');

  const canManageValuation = userRole === 'platform_admin' || userRole === 'company_admin';

  const loadAll = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const layerParams = new URLSearchParams({ companyId });
      if (filterWhId) layerParams.set('warehouseId', filterWhId);
      if (filterItemId) layerParams.set('itemId', filterItemId);
      if (includeExhausted) layerParams.set('includeExhausted', 'true');

      const movParams = new URLSearchParams({ companyId, limit: '100' });
      if (filterWhId) movParams.set('warehouseId', filterWhId);
      if (filterItemId) movParams.set('itemId', filterItemId);

      const [
        profRes,
        assignRes,
        setupRes,
        valRes,
        layerRes,
        movRes,
        adjRes,
        openRes,
        recRes,
        whRes,
        itemRes,
      ] = await Promise.all([
        apiFetch(`/api/inventory/costing-profiles?companyId=${companyId}`),
        apiFetch(`/api/inventory/costing-assignments?companyId=${companyId}`),
        apiFetch(`/api/inventory/valuation-setup-status?companyId=${companyId}`),
        apiFetch(`/api/inventory/warehouse-valuations?companyId=${companyId}`),
        apiFetch(`/api/inventory/cost-layers?${layerParams.toString()}`),
        apiFetch(`/api/inventory/valuation-movements?${movParams.toString()}`),
        apiFetch(`/api/inventory/cost-adjustments?companyId=${companyId}`),
        apiFetch(`/api/inventory/opening-valuations?companyId=${companyId}`),
        apiFetch(`/api/inventory/valuation-reconciliations?companyId=${companyId}`),
        apiFetch(`/api/inventory/warehouses?companyId=${companyId}`),
        apiFetch(`/api/inventory/items?companyId=${companyId}`),
      ]);

      if (profRes.ok) setProfiles((await profRes.json()).profiles || []);
      if (assignRes.ok) setAssignments((await assignRes.json()).assignments || []);
      if (setupRes.ok) setSetupStatus((await setupRes.json()).summary || null);
      if (valRes.ok) setBalances((await valRes.json()).balances || []);
      if (layerRes.ok) setLayers((await layerRes.json()).layers || []);
      if (movRes.ok) setMovements((await movRes.json()).movements || []);
      if (adjRes.ok) setAdjustments((await adjRes.json()).adjustments || []);
      if (openRes.ok) setOpenings((await openRes.json()).openings || []);
      if (recRes.ok) setReconciliations((await recRes.json()).reconciliations || []);
      if (whRes.ok) setWarehouses((await whRes.json()).warehouses || []);
      if (itemRes.ok) setItems((await itemRes.json()).items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تحميل بيانات تقييم المخزون');
    } finally {
      setLoading(false);
    }
  }, [companyId, filterWhId, filterItemId, includeExhausted]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageValuation) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch('/api/inventory/costing-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, name: profileName, costingMethod, isDefault }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل إنشاء ملف التكلفة');

      setSuccess(`تم إنشاء ملف التكلفة (${data.profile.name}) بنجاح`);
      setShowProfileModal(false);
      setProfileName('');
      setCostingMethod('FIFO');
      setIsDefault(false);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء إنشاء ملف التكلفة');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAssignItemProfile = async (itemId: string, profileId: string) => {
    if (!canManageValuation || !itemId || !profileId) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/inventory/items/${itemId}/costing-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, profileId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل تعيين ملف التكلفة للصنف');

      setSuccess(`تم ربط الصنف (${data.assignment.itemCode || itemId}) بطريقة ${data.assignment.costingMethod} بنجاح`);
      setAssignItemId('');
      setAssignProfileId('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء ربط الصنف بملف التكلفة');
    } finally {
      setActionLoading(false);
    }
  };

  const openMovementAllocations = async (m: ValuationMovement) => {
    setSelectedMovement(m);
    setMovementAllocations([]);
    try {
      const res = await apiFetch(`/api/inventory/valuation-movements/${m.id}/allocations?companyId=${companyId}`);
      if (res.ok) {
        const data = await res.json();
        setMovementAllocations(data.allocations || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل تفاصيل تخصيص التكلفة');
    }
  };

  const handleCreateOpening = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageValuation) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch('/api/inventory/opening-valuations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          warehouseId: openWhId,
          itemId: openItemId,
          quantity: Number(openQty),
          unitCost: Number(openUnitCost),
          reason: openReason,
          evidenceRef: openEvidence || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل تسجيل التقييم الافتتاحي');

      setSuccess('تم إنشاء طلب التقييم الافتتاحي بحالة pending_setup وهو بانتظار الاعتماد الإداري.');
      setShowOpeningModal(false);
      setOpenWhId('');
      setOpenItemId('');
      setOpenQty('');
      setOpenUnitCost('');
      setOpenReason('');
      setOpenEvidence('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تسجيل التقييم الافتتاحي');
    } finally {
      setActionLoading(false);
    }
  };

  const handleApproveOpening = async (openingId: string) => {
    if (!canManageValuation) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/inventory/opening-valuations/${openingId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل اعتماد التقييم الافتتاحي');

      setSuccess(`تم اعتماد التقييم الافتتاحي وترحيل القيد المحاسبي (${data.opening.journalEntryId || '—'})`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء اعتماد التقييم الافتتاحي');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRejectOpening = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageValuation || !rejectOpeningId) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/inventory/opening-valuations/${rejectOpeningId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, rejectionReason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل رفض التقييم الافتتاحي');

      setSuccess('تم رفض سجل التقييم الافتتاحي وتوثيق السبب في سجل المراجعة.');
      setRejectOpeningId(null);
      setRejectionReason('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء رفض التقييم الافتتاحي');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRunReconciliation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageValuation) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch('/api/inventory/valuation-reconciliations/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          warehouseId: recWhId || undefined,
          costingMethod: recMethod || undefined,
          notes: recNotes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل تشغيل مطابقة المخزون مع الأستاذ العام');

      const rec: ValuationReconciliation = data.reconciliation;
      setSuccess(
        rec.status === 'reconciled'
          ? 'تمت المطابقة بنجاح: دفتر التقييم الفرعي متطابق تماماً مع حساب المخزون في الأستاذ العام.'
          : `تم رصد فروقات أو استثناءات بالمطابقة (الفرق: ${rec.variance}). راجع تفاصيل الفروقات أدناه.`
      );
      setRecNotes('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تشغيل المطابقة');
    } finally {
      setActionLoading(false);
    }
  };

  const subTabs: Array<{ id: ValuationSubTab; label: string; badge?: number }> = [
    {
      id: 'readiness',
      label: 'الجاهزية والأصناف غير المربوطة',
      badge: (setupStatus?.unassignedItems.length || 0) + (setupStatus?.blockedCount || 0) || undefined,
    },
    { id: 'policies', label: 'سياسات التكلفة والربط', badge: profiles.length || undefined },
    { id: 'balances_layers', label: 'الأرصدة المقيّمة وطبقات FIFO' },
    { id: 'movements', label: 'حركات التقييم والتخصيصات' },
    { id: 'adjustments', label: 'فروقات أسعار الموردين (PPV)', badge: adjustments.length || undefined },
    { id: 'opening', label: 'اعتماد الرصيد الافتتاحي', badge: openings.filter((o) => o.status === 'pending_setup').length || undefined },
    { id: 'reconciliation', label: 'المطابقة مع الأستاذ العام (GL)' },
  ];

  const latestRec = reconciliations[0] || null;

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-purple-600/20 border border-purple-500/30 flex items-center justify-center text-purple-400 shrink-0">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">محرك تقييم المخزون والرقابة المالية (Inventory Valuation Engine)</h3>
            <p className="text-xs text-slate-400">
              تقييم دقيق بنظام FIFO وطبقاته أو المتوسط المتحرك المستمر (Perpetual Moving Average) — بلا أي افتراض صامت
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={loadAll}
            disabled={loading || actionLoading}
            className="p-2.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer"
            title="تحديث البيانات"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {canManageValuation && (
            <button
              onClick={() => setShowProfileModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>ملف تكلفة جديد</span>
            </button>
          )}
        </div>
      </div>

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

      {/* Sub-navigation */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
        {subTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveSubTab(t.id)}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeSubTab === t.id
                ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/20'
                : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            <span>{t.label}</span>
            {t.badge !== undefined && t.badge > 0 && (
              <span className="px-1.5 py-0.5 rounded-md bg-black/30 text-[10px] font-mono">{t.badge}</span>
            )}
          </button>
        ))}
      </div>

      {/* 1. Readiness & Unassigned Items */}
      {activeSubTab === 'readiness' && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5">
              <div className="text-xs text-slate-400 mb-1">أرصدة مستودع/صنف جاهزة</div>
              <div className="text-2xl font-mono font-bold text-emerald-400">{setupStatus?.readyCount ?? 0}</div>
            </div>
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5">
              <div className="text-xs text-slate-400 mb-1">أرصدة محظورة / تحتاج إعداد</div>
              <div className="text-2xl font-mono font-bold text-amber-400">{setupStatus?.blockedCount ?? 0}</div>
            </div>
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5">
              <div className="text-xs text-slate-400 mb-1">أصناف بدون ملف تكلفة</div>
              <div className="text-2xl font-mono font-bold text-rose-400">{setupStatus?.unassignedItems.length ?? 0}</div>
            </div>
          </div>

          {setupStatus && setupStatus.unassignedItems.length > 0 && (
            <div className="bg-amber-950/20 border border-amber-800/60 rounded-2xl p-6 flex flex-col gap-4">
              <div className="flex items-center gap-2 text-amber-300 font-bold text-sm">
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
                <span>تنبيه إلزامي: الأصناف التالية غير مربوطة بملف تكلفة وموقوفة عن أي حركات مالية</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="border-b border-amber-900/50 text-amber-200/80">
                      <th className="py-2.5 px-3">الكود</th>
                      <th className="py-2.5 px-3">اسم الصنف</th>
                      <th className="py-2.5 px-3 text-center">له كمية مخزون؟</th>
                      <th className="py-2.5 px-3">ربط سريع بملف تكلفة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-900/30 text-slate-200">
                    {setupStatus.unassignedItems.map((u) => (
                      <tr key={u.itemId}>
                        <td className="py-2.5 px-3 font-mono font-bold text-indigo-300">{u.itemCode}</td>
                        <td className="py-2.5 px-3">{u.itemNameAr}</td>
                        <td className="py-2.5 px-3 text-center">
                          {u.hasStock ? (
                            <span className="text-amber-300 font-bold">نعم — يلزم تقييم افتتاحي بعد الربط</span>
                          ) : (
                            <span className="text-slate-400">لا</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3">
                          {canManageValuation ? (
                            <div className="flex items-center gap-2">
                              <select
                                value={inlineAssignProfile[u.itemId] || ''}
                                onChange={(e) =>
                                  setInlineAssignProfile((prev) => ({ ...prev, [u.itemId]: e.target.value }))
                                }
                                className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white"
                              >
                                <option value="">-- اختر سياسة التكلفة --</option>
                                {profiles.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name} ({p.costingMethod})
                                  </option>
                                ))}
                              </select>
                              <button
                                onClick={() => handleAssignItemProfile(u.itemId, inlineAssignProfile[u.itemId] || '')}
                                disabled={!inlineAssignProfile[u.itemId] || actionLoading}
                                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold disabled:opacity-40 cursor-pointer"
                              >
                                ربط
                              </button>
                            </div>
                          ) : (
                            <span className="text-slate-500">تحتاج صلاحية مسؤول</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-4 bg-slate-950/60 border-b border-slate-800">
              <h4 className="text-sm font-bold text-white">حالة التقييم حسب المستودع والصنف</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-950/40 border-b border-slate-800 text-slate-400">
                    <th className="py-3 px-4">المستودع</th>
                    <th className="py-3 px-4">الصنف</th>
                    <th className="py-3 px-4">طريقة التكلفة</th>
                    <th className="py-3 px-4 text-center">كمية المخزون</th>
                    <th className="py-3 px-4 text-center">كمية التقييم</th>
                    <th className="py-3 px-4 text-center">الرصيد الافتتاحي</th>
                    <th className="py-3 px-4">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {!setupStatus || setupStatus.warehouseItemStatuses.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        لا توجد أرصدة مستودعات/أصناف مسجلة حتى الآن.
                      </td>
                    </tr>
                  ) : (
                    setupStatus.warehouseItemStatuses.map((s) => (
                      <tr key={`${s.warehouseId}-${s.itemId}`} className="hover:bg-slate-800/30">
                        <td className="py-3 px-4">
                          {s.warehouseNameAr} ({s.warehouseCode})
                        </td>
                        <td className="py-3 px-4 font-mono">
                          {s.itemCode} — {s.itemNameAr}
                        </td>
                        <td className="py-3 px-4 font-mono text-indigo-300">{s.costingMethod || 'غير معيّن'}</td>
                        <td className="py-3 px-4 text-center font-mono">{s.stockQty}</td>
                        <td className="py-3 px-4 text-center font-mono">{s.valuationQty}</td>
                        <td className="py-3 px-4 text-center font-mono">{s.openingStatus}</td>
                        <td className="py-3 px-4">
                          {s.isReady ? (
                            <span className="text-emerald-400 font-bold">جاهز</span>
                          ) : (
                            <span className="text-rose-300">{s.issueReason}</span>
                          )}
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

      {/* 2. Costing Profiles & Item Assignments */}
      {activeSubTab === 'policies' && (
        <div className="flex flex-col gap-6">
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col gap-4">
            <h4 className="text-sm font-bold text-white flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-indigo-400" />
              <span>ملفات سياسات التكلفة المعرّفة للشركة</span>
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {profiles.length === 0 ? (
                <p className="text-xs text-amber-300 col-span-full py-4 text-center">
                  لا توجد ملفات تكلفة معرّفة. يجب إنشاء ملف تكلفة وربط كل صنف به صراحةً قبل تسجيل أي حركة مالية.
                </p>
              ) : (
                profiles.map((p) => (
                  <div key={p.id} className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-white text-xs">{p.name}</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-indigo-950 text-indigo-300 border border-indigo-800">
                        {p.costingMethod}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-slate-400">
                      <span>المرجعي: {p.isDefault ? 'نعم' : 'لا'}</span>
                      <span>•</span>
                      <span>الحالة: {p.isActive ? 'نشط' : 'موقوف'}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {canManageValuation && (
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 flex flex-col gap-4">
              <h4 className="text-sm font-bold text-white">تعيين / ربط صنف بملف تكلفة</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">الصنف</label>
                  <select
                    value={assignItemId}
                    onChange={(e) => setAssignItemId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white"
                  >
                    <option value="">-- اختر الصنف --</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.code} - {it.nameAr}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">ملف التكلفة</label>
                  <select
                    value={assignProfileId}
                    onChange={(e) => setAssignProfileId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white"
                  >
                    <option value="">-- اختر ملف التكلفة --</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.costingMethod})
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  disabled={!assignItemId || !assignProfileId || actionLoading}
                  onClick={() => handleAssignItemProfile(assignItemId, assignProfileId)}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold disabled:opacity-40 cursor-pointer"
                >
                  حفظ ربط الصنف
                </button>
              </div>
              <p className="text-[11px] text-slate-400">
                ملاحظة أمنية ومحاسبية: يُقفل تغيير طريقة التكلفة تلقائياً لأي صنف لديه حركات أو أرصدة تقييم مالية مسجلة.
              </p>
            </div>
          )}

          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden">
            <div className="p-4 bg-slate-950/60 border-b border-slate-800">
              <h4 className="text-sm font-bold text-white">جدول ربط الأصناف بسياسات التكلفة ({assignments.length})</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-950/40 border-b border-slate-800 text-slate-400">
                    <th className="py-3 px-4">كود الصنف</th>
                    <th className="py-3 px-4">اسم الصنف</th>
                    <th className="py-3 px-4">ملف التكلفة</th>
                    <th className="py-3 px-4">الطريقة</th>
                    <th className="py-3 px-4">تاريخ التعيين</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {assignments.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-500">
                        لم يتم ربط أي صنف بملف تكلفة حتى الآن.
                      </td>
                    </tr>
                  ) : (
                    assignments.map((a) => (
                      <tr key={a.itemId} className="hover:bg-slate-800/30">
                        <td className="py-3 px-4 font-mono font-bold text-indigo-300">{a.itemCode}</td>
                        <td className="py-3 px-4">{a.itemNameAr}</td>
                        <td className="py-3 px-4">{a.profileName}</td>
                        <td className="py-3 px-4 font-mono text-purple-300">{a.costingMethod}</td>
                        <td className="py-3 px-4 font-mono text-slate-400">
                          {new Date(a.assignedAt).toLocaleString('ar-EG')}
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

      {/* 3. Warehouse Balances & FIFO Cost Layers */}
      {activeSubTab === 'balances_layers' && (
        <div className="flex flex-col gap-6">
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-4 bg-slate-950/60 border-b border-slate-800">
              <h4 className="text-sm font-bold text-white">أرصدة وتقييم المخزون المالي حسب المستودع</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-950/40 border-b border-slate-800 text-slate-400 font-semibold">
                    <th className="py-3.5 px-4">المستودع</th>
                    <th className="py-3.5 px-4">كود الصنف</th>
                    <th className="py-3.5 px-4">اسم الصنف</th>
                    <th className="py-3.5 px-4">الطريقة</th>
                    <th className="py-3.5 px-4 text-center">الكمية</th>
                    <th className="py-3.5 px-4 text-center">متوسط/تكلفة الوحدة</th>
                    <th className="py-3.5 px-4 text-center">إجمالي التكلفة الدفترية</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {balances.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        لا توجد تقييمات مالية مسجلة للأصناف حتى الآن.
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
                        <td className="py-3.5 px-4 font-mono text-purple-300">{b.costingMethod || '—'}</td>
                        <td className="py-3.5 px-4 text-center font-mono font-bold text-emerald-400">{b.quantity}</td>
                        <td className="py-3.5 px-4 text-center font-mono text-slate-300">{b.unitCost}</td>
                        <td className="py-3.5 px-4 text-center font-mono font-bold text-white">{b.totalCost}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-4 bg-slate-950/60 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-sm font-bold text-white flex items-center gap-2">
                <FileSearch className="w-4 h-4 text-indigo-400" />
                <span>مفتش طبقات التكلفة (FIFO Cost Layers)</span>
              </h4>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <select
                  value={filterWhId}
                  onChange={(e) => setFilterWhId(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white"
                >
                  <option value="">كل المستودعات</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.nameAr}
                    </option>
                  ))}
                </select>
                <select
                  value={filterItemId}
                  onChange={(e) => setFilterItemId(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white"
                >
                  <option value="">كل الأصناف</option>
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.code} - {it.nameAr}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer px-2">
                  <input
                    type="checkbox"
                    checked={includeExhausted}
                    onChange={(e) => setIncludeExhausted(e.target.checked)}
                  />
                  <span>إظهار الطبقات المستنفدة</span>
                </label>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-950/40 border-b border-slate-800 text-slate-400">
                    <th className="py-3 px-4">المستودع</th>
                    <th className="py-3 px-4">الصنف</th>
                    <th className="py-3 px-4">المصدر المباشر</th>
                    <th className="py-3 px-4">الأصل التاريخي (Lineage)</th>
                    <th className="py-3 px-4 text-center">الأصلية</th>
                    <th className="py-3 px-4 text-center">المتبقية</th>
                    <th className="py-3 px-4 text-center">تكلفة الوحدة</th>
                    <th className="py-3 px-4 text-center">القيمة المتبقية</th>
                    <th className="py-3 px-4 text-center">الحالة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {layers.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-10 text-center text-slate-500">
                        لا توجد طبقات FIFO مطابقة لمعايير العرض الحالية.
                      </td>
                    </tr>
                  ) : (
                    layers.map((l) => (
                      <tr key={l.id} className="hover:bg-slate-800/30">
                        <td className="py-3 px-4">{l.warehouseNameAr}</td>
                        <td className="py-3 px-4 font-mono">{l.itemCode}</td>
                        <td className="py-3 px-4 font-mono text-[11px] text-slate-300">
                          {l.sourceType}:{l.sourceId.slice(0, 8)}
                        </td>
                        <td className="py-3 px-4 font-mono text-[11px] text-purple-300">
                          {l.originSourceType || l.sourceType}:{(l.originSourceId || l.sourceId).slice(0, 8)}
                        </td>
                        <td className="py-3 px-4 text-center font-mono">{l.originalQty}</td>
                        <td className="py-3 px-4 text-center font-mono font-bold text-emerald-400">{l.remainingQty}</td>
                        <td className="py-3 px-4 text-center font-mono">{l.unitCost}</td>
                        <td className="py-3 px-4 text-center font-mono font-bold text-white">{l.totalCost}</td>
                        <td className="py-3 px-4 text-center">
                          {l.isExhausted ? (
                            <span className="text-slate-500">مستنفدة</span>
                          ) : (
                            <span className="text-emerald-400">نشطة</span>
                          )}
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

      {/* 4. Valuation Movements & Allocations */}
      {activeSubTab === 'movements' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
          <div className="p-4 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between">
            <h4 className="text-sm font-bold text-white flex items-center gap-2">
              <ArrowRightLeft className="w-4 h-4 text-indigo-400" />
              <span>سجل حركات التقييم المالي والتتبع للمستندات والقيود</span>
            </h4>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/40 border-b border-slate-800 text-slate-400">
                  <th className="py-3 px-4">التاريخ</th>
                  <th className="py-3 px-4">النوع</th>
                  <th className="py-3 px-4">المستودع</th>
                  <th className="py-3 px-4">الصنف</th>
                  <th className="py-3 px-4 text-center">الكمية</th>
                  <th className="py-3 px-4 text-center">التكلفة</th>
                  <th className="py-3 px-4">المصدر المحاسبي</th>
                  <th className="py-3 px-4">القيد (JE)</th>
                  <th className="py-3 px-4">التفاصيل</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {movements.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-10 text-center text-slate-500">
                      لا توجد حركات تقييم مسجلة بعد.
                    </td>
                  </tr>
                ) : (
                  movements.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-800/30">
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-400">
                        {new Date(m.createdAt).toLocaleString('ar-EG')}
                      </td>
                      <td className="py-3 px-4 font-mono font-bold text-indigo-300">{m.movementType}</td>
                      <td className="py-3 px-4">{m.warehouseNameAr}</td>
                      <td className="py-3 px-4 font-mono">{m.itemCode}</td>
                      <td className="py-3 px-4 text-center font-mono">{m.qty}</td>
                      <td className="py-3 px-4 text-center font-mono font-bold text-white">{m.totalCost}</td>
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-300">
                        {m.sourceType}:{m.sourceId.slice(0, 8)}
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px]">
                        {m.journalEntryId ? (
                          <span className="text-emerald-400">{m.journalEntryId.slice(0, 8)}</span>
                        ) : m.movementType === 'TRANSFER_IN' || m.movementType === 'TRANSFER_OUT' ? (
                          <span className="text-slate-500">تحويل داخلي</span>
                        ) : (
                          <span className="text-rose-400">غير مربوط</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <button
                          onClick={() => openMovementAllocations(m)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-[11px] cursor-pointer"
                        >
                          <Eye className="w-3 h-3" />
                          <span>الطبقات / السبب</span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 5. Supplier Invoice Price Variance / Cost Adjustments */}
      {activeSubTab === 'adjustments' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
          <div className="p-4 bg-slate-950/60 border-b border-slate-800">
            <h4 className="text-sm font-bold text-white">تسويات فروق أسعار فواتير الموردين (Purchase Price Variance)</h4>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/40 border-b border-slate-800 text-slate-400">
                  <th className="py-3 px-4">المستودع</th>
                  <th className="py-3 px-4">الصنف</th>
                  <th className="py-3 px-4">الطريقة</th>
                  <th className="py-3 px-4 text-center">سعر الاستلام</th>
                  <th className="py-3 px-4 text-center">سعر الفاتورة</th>
                  <th className="py-3 px-4 text-center">إجمالي الفرق</th>
                  <th className="py-3 px-4 text-center">حصّة المخزون الباقي</th>
                  <th className="py-3 px-4 text-center">حصّة المباع (COGS)</th>
                  <th className="py-3 px-4">القيد المحاسبي</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {adjustments.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-10 text-center text-slate-500">
                      لا توجد تسويات فروق أسعار مسجلة بعد.
                    </td>
                  </tr>
                ) : (
                  adjustments.map((adj) => (
                    <tr key={adj.id} className="hover:bg-slate-800/30">
                      <td className="py-3 px-4">{adj.warehouseNameAr}</td>
                      <td className="py-3 px-4 font-mono">{adj.itemCode}</td>
                      <td className="py-3 px-4 font-mono text-purple-300">{adj.costingMethod}</td>
                      <td className="py-3 px-4 text-center font-mono">{adj.originalUnitCost}</td>
                      <td className="py-3 px-4 text-center font-mono">{adj.finalUnitCost}</td>
                      <td className="py-3 px-4 text-center font-mono font-bold text-white">{adj.adjustmentAmount}</td>
                      <td className="py-3 px-4 text-center font-mono text-indigo-300">{adj.remainingAllocation}</td>
                      <td className="py-3 px-4 text-center font-mono text-amber-300">{adj.consumedAllocation}</td>
                      <td className="py-3 px-4 font-mono text-[11px] text-emerald-400">
                        {adj.journalEntryId ? adj.journalEntryId.slice(0, 8) : 'غير مربوط'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 6. Opening Valuations */}
      {activeSubTab === 'opening' && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400">
              يُمنع استحداث قيم افتتاحية تلقائياً بدون مراجعة؛ كل سجل يدخل بحالة pending_setup ويُرحّل للأستاذ العام عند الاعتماد الإداري فقط.
            </p>
            {canManageValuation && (
              <button
                onClick={() => setShowOpeningModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>تسجيل رصيد افتتاحي مقيّم</span>
              </button>
            )}
          </div>

          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-950/40 border-b border-slate-800 text-slate-400">
                    <th className="py-3 px-4">المستودع</th>
                    <th className="py-3 px-4">الصنف</th>
                    <th className="py-3 px-4">الطريقة</th>
                    <th className="py-3 px-4 text-center">الكمية</th>
                    <th className="py-3 px-4 text-center">تكلفة الوحدة</th>
                    <th className="py-3 px-4 text-center">الإجمالي</th>
                    <th className="py-3 px-4 text-center">الحالة</th>
                    <th className="py-3 px-4">الإجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {openings.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-slate-500">
                        لا توجد سجلات أرصدة افتتاحية مقيّمة.
                      </td>
                    </tr>
                  ) : (
                    openings.map((o) => (
                      <tr key={o.id} className="hover:bg-slate-800/30">
                        <td className="py-3 px-4">{o.warehouseNameAr}</td>
                        <td className="py-3 px-4 font-mono">{o.itemCode}</td>
                        <td className="py-3 px-4 font-mono text-purple-300">{o.costingMethod}</td>
                        <td className="py-3 px-4 text-center font-mono">{o.quantity}</td>
                        <td className="py-3 px-4 text-center font-mono">{o.unitCost}</td>
                        <td className="py-3 px-4 text-center font-mono font-bold text-white">{o.totalCost}</td>
                        <td className="py-3 px-4 text-center">
                          {o.status === 'approved' ? (
                            <span className="text-emerald-400 font-bold">معتمد</span>
                          ) : o.status === 'rejected' ? (
                            <span className="text-rose-400 font-bold">مرفوض ({o.rejectionReason})</span>
                          ) : (
                            <span className="text-amber-300 font-bold">بانتظار الاعتماد</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          {o.status === 'pending_setup' && canManageValuation ? (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleApproveOpening(o.id)}
                                disabled={actionLoading}
                                className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold cursor-pointer"
                              >
                                <Check className="w-3 h-3" />
                                <span>اعتماد</span>
                              </button>
                              <button
                                onClick={() => setRejectOpeningId(o.id)}
                                disabled={actionLoading}
                                className="inline-flex items-center gap-1 px-2.5 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-[11px] font-bold cursor-pointer"
                              >
                                <Ban className="w-3 h-3" />
                                <span>رفض</span>
                              </button>
                            </div>
                          ) : (
                            <span className="font-mono text-[11px] text-slate-400">
                              {o.journalEntryId ? `JE: ${o.journalEntryId.slice(0, 8)}` : '—'}
                            </span>
                          )}
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

      {/* 7. Inventory-to-GL Reconciliation */}
      {activeSubTab === 'reconciliation' && (
        <div className="flex flex-col gap-6">
          {canManageValuation && (
            <form
              onSubmit={handleRunReconciliation}
              className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 flex flex-col gap-4"
            >
              <div className="flex items-center gap-2 text-white font-bold text-sm">
                <Scale className="w-4 h-4 text-indigo-400" />
                <span>تشغيل مطابقة دفتر تقييم المخزون مع الأستاذ العام (GL)</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <select
                  value={recWhId}
                  onChange={(e) => setRecWhId(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white"
                >
                  <option value="">كل المستودعات (الشركة كاملة)</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.nameAr}
                    </option>
                  ))}
                </select>
                <select
                  value={recMethod}
                  onChange={(e) => setRecMethod(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white"
                >
                  <option value="">كل طرق التكلفة</option>
                  <option value="FIFO">FIFO</option>
                  <option value="PERPETUAL_MOVING_AVERAGE">PERPETUAL_MOVING_AVERAGE</option>
                </select>
                <input
                  type="text"
                  placeholder="ملاحظات المراجعة (اختياري)"
                  value={recNotes}
                  onChange={(e) => setRecNotes(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white"
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slate-400">
                  تنبيه رقابي: هذا الفحص يكتشف الفروقات ويوثقها فقط ولا ينشئ قيود تسوية تلقائية لإخفاء أي خلل.
                </span>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold cursor-pointer disabled:opacity-40"
                >
                  {actionLoading ? 'جاري الفحص...' : 'تشغيل المطابقة الآن'}
                </button>
              </div>
            </form>
          )}

          {latestRec && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4">
                <div className="text-xs text-slate-400">إجمالي دفتر التقييم الفرعي</div>
                <div className="text-lg font-mono font-bold text-white">{latestRec.subledgerTotal}</div>
              </div>
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4">
                <div className="text-xs text-slate-400">رصيد حساب المخزون بالأستاذ العام</div>
                <div className="text-lg font-mono font-bold text-white">{latestRec.glControlTotal}</div>
              </div>
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4">
                <div className="text-xs text-slate-400">الفرق المحاسبي (Variance)</div>
                <div
                  className={`text-lg font-mono font-bold ${
                    Number(latestRec.variance) === 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {latestRec.variance}
                </div>
              </div>
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4">
                <div className="text-xs text-slate-400">أخطاء التكامل / الكمية / القيود</div>
                <div className="text-xs font-mono text-amber-300 mt-1">
                  حركات غير مربوطة: {latestRec.unmatchedMovementsCount} | عدم تطابق كمي: {latestRec.qtyValuationMismatchesCount}
                </div>
              </div>
            </div>
          )}

          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-4 bg-slate-950/60 border-b border-slate-800">
              <h4 className="text-sm font-bold text-white">سجل مطابقات المخزون مع الأستاذ العام</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-950/40 border-b border-slate-800 text-slate-400">
                    <th className="py-3 px-4">التاريخ</th>
                    <th className="py-3 px-4 text-center">الحالة</th>
                    <th className="py-3 px-4 text-center">الدفتر الفرعي</th>
                    <th className="py-3 px-4 text-center">الأستاذ العام</th>
                    <th className="py-3 px-4 text-center">الفرق</th>
                    <th className="py-3 px-4 text-center">حركات بلا قيد</th>
                    <th className="py-3 px-4 text-center">فروقات كمية</th>
                    <th className="py-3 px-4 text-center">فروقات افتتاحي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {reconciliations.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-slate-500">
                        لم يتم تشغيل أي مطابقة بعد.
                      </td>
                    </tr>
                  ) : (
                    reconciliations.map((r) => (
                      <tr key={r.id} className="hover:bg-slate-800/30">
                        <td className="py-3 px-4 font-mono text-[11px] text-slate-400">
                          {new Date(r.reconciledAt).toLocaleString('ar-EG')}
                        </td>
                        <td className="py-3 px-4 text-center">
                          {r.status === 'reconciled' ? (
                            <span className="text-emerald-400 font-bold">متطابق</span>
                          ) : (
                            <span className="text-rose-400 font-bold">توجد فروقات</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-center font-mono">{r.subledgerTotal}</td>
                        <td className="py-3 px-4 text-center font-mono">{r.glControlTotal}</td>
                        <td className="py-3 px-4 text-center font-mono font-bold text-white">{r.variance}</td>
                        <td className="py-3 px-4 text-center font-mono">{r.unmatchedMovementsCount}</td>
                        <td className="py-3 px-4 text-center font-mono">{r.qtyValuationMismatchesCount}</td>
                        <td className="py-3 px-4 text-center font-mono">{r.openingDiff}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Profile Creation Modal */}
      {showProfileModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إضافة ملف سياسة تكلفة جديد</h4>
              <button onClick={() => setShowProfileModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateProfile} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">اسم الملف *</label>
                <input
                  type="text"
                  required
                  placeholder="مثال: سياسة الوارد أولاً صادر أولاً"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">طريقة التكلفة *</label>
                <select
                  value={costingMethod}
                  onChange={(e) => setCostingMethod(e.target.value as any)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value="FIFO">FIFO (الوارد أولاً صادر أولاً)</option>
                  <option value="PERPETUAL_MOVING_AVERAGE">Perpetual Moving Average (المتوسط المتحرك المستمر)</option>
                </select>
              </div>
              <div className="flex items-center gap-2 pt-2">
                <input
                  type="checkbox"
                  id="isDefault"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                  className="rounded bg-slate-950 border-slate-800 text-indigo-600 focus:ring-0 cursor-pointer"
                />
                <label htmlFor="isDefault" className="text-xs text-slate-300 cursor-pointer">
                  تعيين كخيار مرجعي (لا يُطبّق تلقائياً على الأصناف غير المربوطة)
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowProfileModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-indigo-600/20"
                >
                  حفظ الملف
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Opening Valuation Creation Modal */}
      {showOpeningModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">تسجيل رصيد افتتاحي مقيّم (pending_setup)</h4>
              <button onClick={() => setShowOpeningModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateOpening} className="flex flex-col gap-3">
              <select
                required
                value={openWhId}
                onChange={(e) => setOpenWhId(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white"
              >
                <option value="">-- اختر المستودع * --</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.nameAr} ({w.code})
                  </option>
                ))}
              </select>
              <select
                required
                value={openItemId}
                onChange={(e) => setOpenItemId(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white"
              >
                <option value="">-- اختر الصنف * --</option>
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.code} - {it.nameAr}
                  </option>
                ))}
              </select>
              <input
                type="number"
                step="0.0001"
                min="0.0001"
                required
                placeholder="الكمية الفعلية بالمستودع *"
                value={openQty}
                onChange={(e) => setOpenQty(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono"
              />
              <input
                type="number"
                step="0.0001"
                min="0.0001"
                required
                placeholder="تكلفة الوحدة المعتمدة *"
                value={openUnitCost}
                onChange={(e) => setOpenUnitCost(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono"
              />
              <input
                type="text"
                required
                placeholder="السبب / المرجع المحاسبي *"
                value={openReason}
                onChange={(e) => setOpenReason(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white"
              />
              <input
                type="text"
                placeholder="مرجع مستند الجرد (اختياري)"
                value={openEvidence}
                onChange={(e) => setOpenEvidence(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white"
              />
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowOpeningModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold"
                >
                  تسجيل للمراجعة
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reject Opening Valuation Modal */}
      {rejectOpeningId && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 flex flex-col gap-4">
            <h4 className="font-bold text-white text-sm">رفض سجل التقييم الافتتاحي</h4>
            <form onSubmit={handleRejectOpening} className="flex flex-col gap-3">
              <textarea
                required
                rows={3}
                placeholder="أدخل سبب الرفض الإلزامي..."
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setRejectOpeningId(null);
                    setRejectionReason('');
                  }}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs"
                >
                  إلغاء
                </button>
                <button type="submit" disabled={actionLoading} className="px-4 py-2 bg-rose-600 text-white rounded-xl text-xs font-bold">
                  تأكيد الرفض
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Movement Allocations Inspection Modal */}
      {selectedMovement && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">
                تفاصيل حركة التقييم: {selectedMovement.movementType} ({selectedMovement.itemCode})
              </h4>
              <button onClick={() => setSelectedMovement(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs bg-slate-950/60 p-3 rounded-xl border border-slate-800">
              <div>مصدر التكلفة: {selectedMovement.costSource || '—'}</div>
              <div>الطريقة: {selectedMovement.costingMethod || '—'}</div>
              <div className="col-span-2">السبب / البيان: {selectedMovement.reason || '—'}</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2 px-3">معرّف الطبقة (Layer)</th>
                    <th className="py-2 px-3 text-center">الكمية المخصّصة</th>
                    <th className="py-2 px-3 text-center">تكلفة الوحدة</th>
                    <th className="py-2 px-3 text-center">التكلفة المخصّصة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-200">
                  {movementAllocations.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-slate-500">
                        لا توجد تخصيصات صرف طبقات مرتبطة بهذه الحركة (حركة إضافة أو استلام).
                      </td>
                    </tr>
                  ) : (
                    movementAllocations.map((a) => (
                      <tr key={a.id}>
                        <td className="py-2 px-3 font-mono text-[11px]">{a.costLayerId || 'Moving Average Pool'}</td>
                        <td className="py-2 px-3 text-center font-mono">{a.allocatedQty}</td>
                        <td className="py-2 px-3 text-center font-mono">{a.unitCost}</td>
                        <td className="py-2 px-3 text-center font-mono font-bold text-white">{a.allocatedCost}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
