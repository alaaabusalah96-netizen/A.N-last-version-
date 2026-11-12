import React, { useState, useEffect } from 'react';
import {
  Network,
  Plus,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Building2,
  GitFork,
  X,
  Layers,
  Check,
  Shield,
  ShieldCheck,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { UserScopesPanel, ScopeRecord } from './UserScopesPanel.js';

interface OrgUnit {
  id: string;
  companyId: string;
  parentId?: string | null;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  unitType: 'branch' | 'department' | 'cost_center' | 'division';
  isActive: boolean;
  path: string;
  createdAt: string;
}

interface Company {
  id: string;
  code: string;
  nameAr: string;
}

interface OrgUnitsPanelProps {
  userRole?: string;
}

const unitTypeLabels: Record<OrgUnit['unitType'], string> = {
  branch: 'فرع تشغيلي',
  department: 'إدارة / قسم',
  cost_center: 'مركز تكلفة',
  division: 'قطاع أعمال',
};

export function OrgUnitsPanel({ userRole }: OrgUnitsPanelProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'units' | 'scopes'>('units');

  // Dynamic RBAC permissions loaded from /api/auth/me (initialized from userRole fallback)
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);
  const [userPermissions, setUserPermissions] = useState<string[]>([]);

  // Self effective scopes banner state (/me/scopes)
  const [myScopes, setMyScopes] = useState<ScopeRecord[]>([]);
  const [myIsCompanyWide, setMyIsCompanyWide] = useState<boolean | null>(null);
  const [loadingMyScopes, setLoadingMyScopes] = useState(false);
  const [myScopesError, setMyScopesError] = useState<string | null>(null);

  // Modal create
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Form states
  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [unitType, setUnitType] = useState<OrgUnit['unitType']>('branch');
  const [parentId, setParentId] = useState<string>('');

  const fallbackWrite = userRole === 'platform_admin' || userRole === 'company_admin';
  const fallbackRead = fallbackWrite || userRole === 'company_user';

  const canWrite = permissionsLoaded
    ? userPermissions.includes('org:units:write')
    : fallbackWrite;
  const canReadScopes = permissionsLoaded
    ? userPermissions.includes('org:units:read') || userPermissions.includes('org:units:write')
    : fallbackRead;

  // Load current user's effective permissions from /api/auth/me
  useEffect(() => {
    let cancelled = false;
    async function loadPermissions() {
      try {
        const res = await apiFetch('/api/auth/me');
        if (res.ok && !cancelled) {
          const data = await res.json();
          if (Array.isArray(data.permissions)) {
            setUserPermissions(data.permissions);
            setPermissionsLoaded(true);
          }
        }
      } catch {
        // Fallback to userRole prop
      }
    }
    loadPermissions();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load companies
  useEffect(() => {
    async function loadCompanies() {
      setLoading(true);
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
        setError(err instanceof Error ? err.message : 'تعذر تحميل قائمة الشركات');
      } finally {
        setLoading(false);
      }
    }
    loadCompanies();
  }, []);

  // Load org units when company selected
  const loadUnits = async () => {
    if (!selectedCompanyId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/org-units`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'تعذر تحميل الوحدات التنظيمية');
      }
      const data = await res.json();
      setUnits(data.units || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في جلب الوحدات التنظيمية');
    } finally {
      setLoading(false);
    }
  };

  // Load caller's own effective scopes banner from /api/companies/:companyId/me/scopes
  const loadMyScopes = async () => {
    if (!selectedCompanyId) return;
    setLoadingMyScopes(true);
    setMyScopesError(null);
    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/me/scopes`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || 'تعذر تحميل نطاقك الفعّال');
      }
      const data = await res.json();
      setMyScopes(data.scopes || []);
      setMyIsCompanyWide(Boolean(data.isCompanyWide));
    } catch (err) {
      setMyScopesError(err instanceof Error ? err.message : 'تعذر تحميل نطاقك الفعّال');
    } finally {
      setLoadingMyScopes(false);
    }
  };

  useEffect(() => {
    if (selectedCompanyId) {
      loadUnits();
      if (canReadScopes) {
        loadMyScopes();
      }
    }
  }, [selectedCompanyId, canReadScopes]);

  const handleCreateUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/org-units`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim(),
          nameAr: nameAr.trim(),
          nameEn: nameEn.trim() || undefined,
          unitType,
          parentId: parentId || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'فشل في إنشاء الوحدة التنظيمية');
      }

      setSuccess('تم إنشاء الوحدة التنظيمية وتوليد مسار الهيكل بنجاح');
      setShowCreateModal(false);
      setCode('');
      setNameAr('');
      setNameEn('');
      setParentId('');
      setUnitType('branch');
      await loadUnits();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء إنشاء الوحدة');
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleActive = async (unit: OrgUnit) => {
    if (!canWrite) return;
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/org-units/${unit.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isActive: !unit.isActive,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'تعذر تغيير حالة الوحدة');
      }

      setSuccess(`تم تحديث حالة الوحدة ${unit.code} بنجاح`);
      await loadUnits();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في التحديث');
    } finally {
      setActionLoading(false);
    }
  };

  // Helper to compute tree indentation based on path depth
  const getDepth = (path: string) => {
    const parts = path.split('/').filter(Boolean);
    return Math.max(0, parts.length - 1);
  };

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      {/* Top Effective Self-Scope Summary Strip */}
      {selectedCompanyId && canReadScopes && (
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-slate-200 flex-wrap">
            <Shield className="w-4 h-4 text-indigo-400 shrink-0" />
            <span className="font-bold text-white">نطاقك الفعّال:</span>
            {loadingMyScopes ? (
              <span className="text-slate-400">جاري التحقق من نطاقك الفعّال...</span>
            ) : myScopesError ? (
              <span className="text-red-400">{myScopesError}</span>
            ) : myIsCompanyWide ? (
              <span className="px-2.5 py-0.5 rounded-lg bg-emerald-950/60 border border-emerald-800/60 text-emerald-300 font-semibold">
                الشركة كاملة (بلا نطاقات مقيّدة)
              </span>
            ) : myScopes.length === 0 ? (
              <span className="px-2.5 py-0.5 rounded-lg bg-amber-950/60 border border-amber-800/60 text-amber-300 font-semibold">
                لا توجد نطاقات سارية اليوم
              </span>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                {myScopes.map((sc) => (
                  <span
                    key={sc.orgUnitId}
                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg bg-indigo-950/60 border border-indigo-800/60 text-indigo-200 font-medium"
                  >
                    <span className="font-mono text-indigo-300">{sc.code}</span>
                    <span>— {sc.nameAr}</span>
                    <span className="text-[10px] text-slate-400">({sc.accessLevel})</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Top Banner */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl backdrop-blur-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Network className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">الهيكل والوحدات التنظيمية (Organizational Units)</h2>
              <p className="text-xs text-slate-400">
                إدارة الفروع الإقليمية، الإدارات، مراكز التكلفة، ونطاقات وصول المستخدمين داخل الشركة
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5 shrink-0">
              <Building2 className="w-4 h-4 text-indigo-400" />
              الشركة المختارة:
            </label>
            <select
              value={selectedCompanyId}
              onChange={(e) => setSelectedCompanyId(e.target.value)}
              className="px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-semibold text-white focus:outline-none focus:border-indigo-500 transition min-w-[200px]"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nameAr} ({c.code})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Sub-Navigation Tabs inside OrgUnitsPanel */}
        {selectedCompanyId && (
          <div className="flex flex-wrap items-center justify-between gap-4 mt-6 pt-4 border-t border-slate-800/80">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('units')}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                  activeTab === 'units'
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                    : 'bg-slate-950 text-slate-400 border border-slate-800 hover:text-white'
                }`}
              >
                <Layers className="w-4 h-4" />
                <span>الهيكل والوحدات</span>
              </button>

              {canReadScopes && (
                <button
                  type="button"
                  onClick={() => setActiveTab('scopes')}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                    activeTab === 'scopes'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                      : 'bg-slate-950 text-slate-400 border border-slate-800 hover:text-white'
                  }`}
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>نطاقات المستخدمين</span>
                </button>
              )}
            </div>

            {activeTab === 'units' && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-400">
                  إجمالي الوحدات: <span className="font-bold text-white">{units.length}</span>
                </span>

                <button
                  onClick={loadUnits}
                  disabled={loading}
                  className="p-2 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer"
                  title="تحديث"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>

                {canWrite && (
                  <button
                    onClick={() => setShowCreateModal(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>إضافة وحدة تنظيمية</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tab Content */}
      {activeTab === 'scopes' && selectedCompanyId && canReadScopes ? (
        <UserScopesPanel
          companyId={selectedCompanyId}
          units={units}
          unitsLoading={loading}
          canWrite={canWrite}
          onGoToUnitsTab={() => setActiveTab('units')}
          onScopesSaved={loadMyScopes}
        />
      ) : (
        <>
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

          {/* Units List */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                    <th className="py-3.5 px-4">كود الوحدة</th>
                    <th className="py-3.5 px-4">اسم الوحدة</th>
                    <th className="py-3.5 px-4">النوع التنظيمي</th>
                    <th className="py-3.5 px-4">المسار الهيكلي</th>
                    <th className="py-3.5 px-4 text-center">الحالة</th>
                    {canWrite && <th className="py-3.5 px-4 text-center">الإجراءات</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {loading ? (
                    <tr>
                      <td colSpan={canWrite ? 6 : 5} className="py-12 text-center text-slate-500">
                        <div className="flex items-center justify-center gap-2">
                          <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                          <span>جاري تحميل الهيكل التنظيمي...</span>
                        </div>
                      </td>
                    </tr>
                  ) : units.length === 0 ? (
                    <tr>
                      <td colSpan={canWrite ? 6 : 5} className="py-12 text-center text-slate-500">
                        لم يتم تعريف أي وحدات تنظيمية لهذه الشركة بعد
                      </td>
                    </tr>
                  ) : (
                    units.map((unit) => {
                      const depth = getDepth(unit.path);
                      return (
                        <tr key={unit.id} className="hover:bg-slate-800/30 transition">
                          <td className="py-3.5 px-4 font-mono font-bold text-indigo-300">
                            <div className="flex items-center gap-1.5" style={{ paddingRight: `${depth * 20}px` }}>
                              {depth > 0 && <GitFork className="w-3.5 h-3.5 text-slate-600 rotate-180 shrink-0" />}
                              <span>{unit.code}</span>
                            </div>
                          </td>
                          <td className="py-3.5 px-4 font-semibold text-white">
                            {unit.nameAr}
                            {unit.nameEn && <span className="text-slate-500 text-[11px] block">{unit.nameEn}</span>}
                          </td>
                          <td className="py-3.5 px-4">
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-slate-950 border border-slate-800 text-slate-300">
                              {unitTypeLabels[unit.unitType]}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 font-mono text-[11px] text-slate-400">
                            {unit.path}
                          </td>
                          <td className="py-3.5 px-4 text-center">
                            {unit.isActive ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-950/60 border border-emerald-800/80 text-emerald-400">
                                <Check className="w-3 h-3" />
                                <span>نشط</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-slate-800 border border-slate-700 text-slate-400">
                                <span>معطل</span>
                              </span>
                            )}
                          </td>
                          {canWrite && (
                            <td className="py-3.5 px-4 text-center">
                              <button
                                onClick={() => handleToggleActive(unit)}
                                disabled={actionLoading}
                                className={`px-3 py-1.5 rounded-lg text-[11px] font-medium transition cursor-pointer border ${
                                  unit.isActive
                                    ? 'bg-slate-950 border-slate-800 text-slate-400 hover:text-red-400 hover:border-red-800'
                                    : 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300 hover:bg-emerald-900/60'
                                }`}
                              >
                                {unit.isActive ? 'تعطيل' : 'تفعيل'}
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Network className="w-5 h-5 text-indigo-400" />
                <h4 className="font-bold text-white text-sm">إضافة وحدة تنظيمية جديدة</h4>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateUnit} className="p-6 flex flex-col gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    كود الوحدة <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="مثال: BR-CAI-01"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    النوع التنظيمي <span className="text-red-400">*</span>
                  </label>
                  <select
                    value={unitType}
                    onChange={(e) => setUnitType(e.target.value as OrgUnit['unitType'])}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="branch">فرع تشغيلي (Branch)</option>
                    <option value="department">إدارة / قسم (Department)</option>
                    <option value="cost_center">مركز تكلفة (Cost Center)</option>
                    <option value="division">قطاع أعمال (Division)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  الاسم بالعربية <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="مثال: فرع القاهرة الرئيسي"
                  value={nameAr}
                  onChange={(e) => setNameAr(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  الاسم بالإنجليزية (اختياري)
                </label>
                <input
                  type="text"
                  placeholder="Example: Cairo Main Branch"
                  value={nameEn}
                  onChange={(e) => setNameEn(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  الوحدة الرئيسية (الأصل في الشجرة)
                </label>
                <select
                  value={parentId}
                  onChange={(e) => setParentId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="">بدون أصل (مستوى قمة في الشركة)</option>
                  {units
                    .filter((u) => u.isActive)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.path} — {u.nameAr} ({u.code})
                      </option>
                    ))}
                </select>
                <span className="text-[11px] text-slate-500 block mt-1">
                  تحديد الأصل يبني المسار الهيكلي التراكمي تلقائياً
                </span>
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
                  {actionLoading ? 'جاري الحفظ...' : 'إنشاء الوحدة'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
