import React, { useEffect, useState, useCallback } from 'react';
import {
  Shield,
  Plus,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Building2,
  Edit3,
  Power,
  KeyRound,
  ShieldAlert,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { DynamicRole, PermissionMatrix } from './PermissionMatrix.js';

interface Company {
  id: string;
  code: string;
  nameAr: string;
}

interface RolesPanelProps {
  userRole?: string;
}

function suggestCodeFromName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned && /^[a-z]/.test(cleaned)) return cleaned;
  return '';
}

const ORG_LEVEL_LABELS: Record<string, string> = {
  company: 'على مستوى الشركة',
  branch: 'على مستوى الفرع',
  department: 'على مستوى الإدارة',
};

export function RolesPanel({ userRole }: RolesPanelProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [loadingCompanies, setLoadingCompanies] = useState(true);

  const [roles, setRoles] = useState<DynamicRole[]>([]);
  const [loadingRoles, setLoadingRoles] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'roles' | 'matrix'>('roles');
  const [matrixRoleId, setMatrixRoleId] = useState<string>('');

  // Create Modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newNameAr, setNewNameAr] = useState('');
  const [newCode, setNewCode] = useState('');
  const [codeEditedManually, setCodeEditedManually] = useState(false);
  const [newDescription, setNewDescription] = useState('');
  const [newOrgLevel, setNewOrgLevel] = useState<'company' | 'branch' | 'department'>('company');
  const [cloneFromCode, setCloneFromCode] = useState('');
  const [saving, setSaving] = useState(false);

  // Edit Modal state
  const [editingRole, setEditingRole] = useState<DynamicRole | null>(null);
  const [editNameAr, setEditNameAr] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editOrgLevel, setEditOrgLevel] = useState<'company' | 'branch' | 'department'>('company');

  const canManageRoles = userRole === 'platform_admin' || userRole === 'company_admin';

  // Load companies
  useEffect(() => {
    async function loadCompanies() {
      setLoadingCompanies(true);
      setError(null);
      try {
        const res = await apiFetch('/api/companies');
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.message || body.error || 'تعذر تحميل قائمة الشركات');
        }
        const list: Company[] = body.companies || [];
        setCompanies(list);
        if (list.length > 0) {
          setSelectedCompanyId(list[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'خطأ في جلب الشركات');
      } finally {
        setLoadingCompanies(false);
      }
    }
    if (canManageRoles) {
      loadCompanies();
    } else {
      setLoadingCompanies(false);
    }
  }, [canManageRoles]);

  const loadRoles = useCallback(async () => {
    if (!selectedCompanyId) return;
    setLoadingRoles(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/roles`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || body.error || 'تعذر جلب الأدوار');
      }
      const list: DynamicRole[] = body.roles || [];
      setRoles(list);
      if (list.length > 0 && (!matrixRoleId || !list.some((r) => r.id === matrixRoleId))) {
        setMatrixRoleId(list[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في جلب الأدوار');
    } finally {
      setLoadingRoles(false);
    }
  }, [selectedCompanyId, matrixRoleId]);

  useEffect(() => {
    if (selectedCompanyId && canManageRoles) {
      loadRoles();
    }
  }, [selectedCompanyId, canManageRoles, loadRoles]);

  if (!canManageRoles) {
    return (
      <div className="w-full bg-slate-900 border border-slate-800 rounded-2xl p-12 text-center flex flex-col items-center gap-3 text-slate-300" dir="rtl">
        <ShieldAlert className="w-10 h-10 text-amber-400" />
        <h3 className="text-base font-bold text-white">غير مصرح لك بالوصول</h3>
        <p className="text-xs text-slate-400">إدارة الأدوار ومصفوفة الصلاحيات متاحة لمدير الشركة أو مدير المنصة فقط.</p>
      </div>
    );
  }

  const handleCreateRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/roles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: newCode,
          nameAr: newNameAr,
          description: newDescription || null,
          orgLevel: newOrgLevel,
          ...(cloneFromCode ? { cloneFromCode } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || body.error || 'تعذر إنشاء الدور');
      }
      setSuccess(`تم إنشاء الدور "${body.role?.nameAr}" بنجاح`);
      setShowCreateModal(false);
      setNewNameAr('');
      setNewCode('');
      setCodeEditedManually(false);
      setNewDescription('');
      setCloneFromCode('');
      await loadRoles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في إنشاء الدور');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId || !editingRole) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/roles/${editingRole.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nameAr: editNameAr,
          description: editDescription || null,
          orgLevel: editOrgLevel,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || body.error || 'تعذر تحديث الدور');
      }
      setSuccess(`تم تحديث الدور "${editNameAr}" بنجاح`);
      setEditingRole(null);
      await loadRoles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في تحديث الدور');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (role: DynamicRole) => {
    if (!selectedCompanyId) return;
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/roles/${role.id}/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !role.isActive }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || body.error || 'تعذر تغيير حالة الدور');
      }
      setSuccess(!role.isActive ? `تم تفعيل الدور "${role.nameAr}"` : `تم تعطيل الدور "${role.nameAr}"`);
      await loadRoles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في تغيير حالة الدور');
    }
  };

  return (
    <div className="w-full flex flex-col gap-6" dir="rtl">
      {/* Header & Company selector + Tabs */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl flex flex-col gap-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">الأدوار والصلاحيات (Dynamic RBAC)</h3>
              <p className="text-xs text-slate-400">إدارة أدوار الشركة ومصفوفة الصلاحيات التفصيلية</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <Building2 className="w-4 h-4 text-indigo-400" />
              الشركة:
            </label>
            {loadingCompanies ? (
              <span className="text-xs text-slate-400">جاري التحميل...</span>
            ) : (
              <select
                value={selectedCompanyId}
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-xl px-3.5 py-2 focus:outline-none focus:border-indigo-500"
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} - {c.nameAr}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              disabled={!selectedCompanyId}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-indigo-600/20 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>دور جديد</span>
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('roles')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeTab === 'roles'
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            الأدوار ({roles.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('matrix')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeTab === 'matrix'
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            مصفوفة الصلاحيات
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={loadRoles}
            className="px-3 py-1 bg-red-900/50 hover:bg-red-800/60 rounded-lg font-semibold cursor-pointer"
          >
            إعادة محاولة
          </button>
        </div>
      )}

      {success && (
        <div className="p-4 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          <span>{success}</span>
        </div>
      )}

      {activeTab === 'roles' ? (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
          {loadingRoles ? (
            <div className="p-12 text-center flex flex-col items-center gap-3 text-slate-400 text-xs">
              <RefreshCw className="w-6 h-6 animate-spin text-indigo-400" />
              <span>جاري تحميل الأدوار...</span>
            </div>
          ) : roles.length === 0 ? (
            <div className="p-12 text-center flex flex-col items-center gap-3 text-slate-400 text-xs">
              <Shield className="w-8 h-8 text-slate-600" />
              <span>لا توجد أدوار — أنشئ دورًا</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/50 text-slate-400 font-semibold">
                    <th className="py-3 px-4">الاسم</th>
                    <th className="py-3 px-4">الكود</th>
                    <th className="py-3 px-4">المستوى التنظيمي</th>
                    <th className="py-3 px-4">عدد الصلاحيات</th>
                    <th className="py-3 px-4">عدد المستخدمين</th>
                    <th className="py-3 px-4">الحالة</th>
                    <th className="py-3 px-4 text-left">الإجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {roles.map((role) => (
                    <tr key={role.id} className="hover:bg-slate-800/30">
                      <td className="py-3 px-4">
                        <div className="font-bold text-white flex items-center gap-2">
                          <span>{role.nameAr}</span>
                          {role.isSystem && (
                            <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 text-[10px]">
                              نظامي
                            </span>
                          )}
                        </div>
                        {role.description && (
                          <div className="text-[11px] text-slate-400 mt-0.5">{role.description}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-indigo-300">{role.code}</td>
                      <td className="py-3 px-4 text-slate-300">{ORG_LEVEL_LABELS[role.orgLevel] || role.orgLevel}</td>
                      <td className="py-3 px-4 font-mono font-bold text-slate-200">
                        {role.permissionsCount ?? role.permissions?.length ?? 0}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-300">{role.usersCount ?? 0}</td>
                      <td className="py-3 px-4">
                        {role.isActive ? (
                          <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[11px] font-bold">
                            نشط
                          </span>
                        ) : (
                          <span className="px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 text-[11px]">
                            معطل
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingRole(role);
                              setEditNameAr(role.nameAr);
                              setEditDescription(role.description || '');
                              setEditOrgLevel(role.orgLevel);
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-[11px] font-semibold cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>تعديل</span>
                          </button>

                          {!role.isSystem && (
                            <button
                              type="button"
                              onClick={() => handleToggleActive(role)}
                              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer ${
                                role.isActive
                                  ? 'bg-amber-950/50 hover:bg-amber-900/50 text-amber-300 border border-amber-800/40'
                                  : 'bg-emerald-950/50 hover:bg-emerald-900/50 text-emerald-300 border border-emerald-800/40'
                              }`}
                            >
                              <Power className="w-3.5 h-3.5" />
                              <span>{role.isActive ? 'تعطيل' : 'تفعيل'}</span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => {
                              setMatrixRoleId(role.id);
                              setActiveTab('matrix');
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 rounded-lg text-[11px] font-semibold cursor-pointer"
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                            <span>تعديل الصلاحيات</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl">
          <PermissionMatrix
            companyId={selectedCompanyId}
            roles={roles}
            selectedRoleId={matrixRoleId}
            onSelectRoleId={setMatrixRoleId}
            userRole={userRole}
            onSaved={loadRoles}
          />
        </div>
      )}

      {/* Create Role Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg p-6 shadow-2xl flex flex-col gap-4" dir="rtl">
            <h4 className="text-sm font-bold text-white border-b border-slate-800 pb-3">إنشاء دور جديد</h4>
            <form onSubmit={handleCreateRole} className="flex flex-col gap-4 text-xs">
              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">الاسم العربي:</label>
                <input
                  type="text"
                  required
                  value={newNameAr}
                  onChange={(e) => {
                    const val = e.target.value;
                    setNewNameAr(val);
                    if (!codeEditedManually) {
                      const suggested = suggestCodeFromName(val);
                      if (suggested) setNewCode(suggested);
                    }
                  }}
                  placeholder="مثال: محاسب المشتريات"
                  className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">كود الدور (Code):</label>
                <input
                  type="text"
                  required
                  value={newCode}
                  onChange={(e) => {
                    setCodeEditedManually(true);
                    setNewCode(e.target.value);
                  }}
                  placeholder="e.g. purchasing_accountant"
                  className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2 font-mono"
                />
                <span className="text-[10px] text-slate-500">يبدأ بحرف صغير (أحرف صغيرة، أرقام، أو _ فقط)</span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">الوصف:</label>
                <input
                  type="text"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="وصف اختياري للدور..."
                  className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="font-semibold text-slate-300">المستوى التنظيمي:</label>
                  <select
                    value={newOrgLevel}
                    onChange={(e) => setNewOrgLevel(e.target.value as 'company' | 'branch' | 'department')}
                    className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2"
                  >
                    <option value="company">على مستوى الشركة (company)</option>
                    <option value="branch">على مستوى الفرع (branch)</option>
                    <option value="department">على مستوى الإدارة (department)</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="font-semibold text-slate-300">نسخ صلاحيات من:</label>
                  <select
                    value={cloneFromCode}
                    onChange={(e) => setCloneFromCode(e.target.value)}
                    className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2"
                  >
                    <option value="">— دور فارغ —</option>
                    {roles
                      .filter((r) => r.code !== 'platform_admin')
                      .map((r) => (
                        <option key={r.id} value={r.code}>
                          {r.nameAr} ({r.code})
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-bold cursor-pointer"
                >
                  {saving ? 'جاري الإنشاء...' : 'حفظ الدور'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Role Modal */}
      {editingRole && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl flex flex-col gap-4" dir="rtl">
            <h4 className="text-sm font-bold text-white border-b border-slate-800 pb-3">
              تعديل الدور: <span className="font-mono text-indigo-300">{editingRole.code}</span>
            </h4>
            <form onSubmit={handleUpdateRole} className="flex flex-col gap-4 text-xs">
              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">الكود (غير قابل للتعديل):</label>
                <input
                  type="text"
                  disabled
                  value={editingRole.code}
                  className="bg-slate-950/50 border border-slate-800 text-slate-500 rounded-xl px-3 py-2 font-mono cursor-not-allowed"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">الاسم العربي:</label>
                <input
                  type="text"
                  required
                  value={editNameAr}
                  onChange={(e) => setEditNameAr(e.target.value)}
                  className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">الوصف:</label>
                <input
                  type="text"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">المستوى التنظيمي:</label>
                <select
                  value={editOrgLevel}
                  onChange={(e) => setEditOrgLevel(e.target.value as 'company' | 'branch' | 'department')}
                  className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2"
                >
                  <option value="company">على مستوى الشركة (company)</option>
                  <option value="branch">على مستوى الفرع (branch)</option>
                  <option value="department">على مستوى الإدارة (department)</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditingRole(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-bold cursor-pointer"
                >
                  {saving ? 'جاري التحديث...' : 'حفظ التعديلات'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
