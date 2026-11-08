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
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

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

  // Modal create
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Form states
  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [unitType, setUnitType] = useState<OrgUnit['unitType']>('branch');
  const [parentId, setParentId] = useState<string>('');

  const canWrite = userRole === 'platform_admin' || userRole === 'company_admin';

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

  useEffect(() => {
    if (selectedCompanyId) {
      loadUnits();
    }
  }, [selectedCompanyId]);

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
                إدارة الفروع الإقليمية، الإدارات، مراكز التكلفة، وقطاعات الأعمال المعزولة داخل الشركة
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

        {selectedCompanyId && (
          <div className="flex items-center justify-between mt-6 pt-4 border-t border-slate-800/80">
            <div className="text-xs text-slate-400">
              إجمالي الوحدات التنظيمية المسجلة: <span className="font-bold text-white">{units.length}</span>
            </div>

            <div className="flex items-center gap-2">
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
          </div>
        )}
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
