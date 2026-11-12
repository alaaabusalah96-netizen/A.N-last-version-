import React, { useState, useEffect, useCallback } from 'react';
import { Users, Plus, RefreshCw, AlertCircle, CheckCircle, UserCheck, UserX, Key, Network, X } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { UserScopesPanel } from '../org/UserScopesPanel.js';

interface RoleOption {
  code: string;
  nameAr: string;
}

const STATIC_FALLBACK_ROLES: RoleOption[] = [
  { code: 'company_user', nameAr: 'مستخدم عادي' },
  { code: 'company_admin', nameAr: 'مدير شركة' },
  { code: 'platform_admin', nameAr: 'مدير منصة' },
];

export function UsersAdminWorkspace() {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [companies, setCompanies] = useState<Array<{ id: string; code: string; nameAr: string }>>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>(STATIC_FALLBACK_ROLES);
  const [rolesNotInitializedWarning, setRolesNotInitializedWarning] = useState<boolean>(false);

  // Modals & Drawers
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [targetUser, setTargetUser] = useState<any>(null);
  const [scopeDrawerUser, setScopeDrawerUser] = useState<any>(null);
  const [canReadScopes, setCanReadScopes] = useState(true);
  const [canWriteScopes, setCanWriteScopes] = useState(true);

  // Form states
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('company_user');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/users');
      if (!res.ok) throw new Error('تعذر جلب المستخدمين');
      const data = await res.json();
      setUsers(data.users || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    async function loadCompaniesAndPermissions() {
      try {
        const [compRes, meRes] = await Promise.all([
          apiFetch('/api/companies'),
          apiFetch('/api/auth/me'),
        ]);
        if (meRes.ok) {
          const meBody = await meRes.json();
          if (Array.isArray(meBody.permissions)) {
            const perms: string[] = meBody.permissions;
            setCanReadScopes(perms.includes('org:units:read') || perms.includes('org:units:write'));
            setCanWriteScopes(perms.includes('org:units:write'));
          }
        }
        if (!compRes.ok) return;
        const compBody = await compRes.json();
        const list = compBody.companies || [];
        setCompanies(list);
        if (list.length > 0 && !selectedCompanyId) {
          setSelectedCompanyId(list[0].id);
        }
      } catch {
        // fallback handled by static roles
      }
    }
    loadCompaniesAndPermissions();
  }, []);

  useEffect(() => {
    async function loadRolesForCompany() {
      if (!selectedCompanyId) {
        setRoleOptions(STATIC_FALLBACK_ROLES);
        return;
      }
      try {
        const res = await apiFetch(`/api/companies/${selectedCompanyId}/roles`);
        if (!res.ok) {
          setRoleOptions(STATIC_FALLBACK_ROLES);
          setRolesNotInitializedWarning(true);
          return;
        }
        const body = await res.json();
        const dynamicList: Array<{ code: string; nameAr: string; isActive?: boolean }> = (body.roles || []).filter(
          (r: any) => r.isActive !== false
        );
        if (dynamicList.length === 0) {
          setRoleOptions(STATIC_FALLBACK_ROLES);
          setRolesNotInitializedWarning(true);
        } else {
          const mapped: RoleOption[] = dynamicList.map((r) => ({ code: r.code, nameAr: r.nameAr }));
          if (!mapped.some((r) => r.code === 'company_admin')) {
            mapped.push({ code: 'company_admin', nameAr: 'مدير شركة' });
          }
          setRoleOptions(mapped);
          setRolesNotInitializedWarning(false);
        }
      } catch {
        setRoleOptions(STATIC_FALLBACK_ROLES);
        setRolesNotInitializedWarning(true);
      }
    }
    loadRolesForCompany();
  }, [selectedCompanyId]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
          role,
          ...(selectedCompanyId && role !== 'platform_admin' ? { companyId: selectedCompanyId } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'فشل إنشاء المستخدم');
      }
      setSuccess('تم إنشاء المستخدم بنجاح');
      setShowCreateModal(false);
      setUsername('');
      setPassword('');
      fetchUsers();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUser) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/users/${targetUser.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ newPassword }),
      });
      if (!res.ok) throw new Error('فشل إعادة تعيين كلمة المرور');
      setSuccess('تم تحديث كلمة المرور بنجاح');
      setShowResetModal(false);
      setNewPassword('');
      setTargetUser(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleUserActive = async (user: any) => {
    try {
      const res = await apiFetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !user.isActive }),
      });
      if (!res.ok) throw new Error('فشل تحديث حالة المستخدم');
      fetchUsers();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="w-full flex flex-col gap-5" dir="rtl">
      {/* Header */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">إدارة المستخدمين</h3>
            <p className="text-xs text-slate-400">إدارة حسابات المستخدمين وصلاحيات الوصول للمنصة</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchUsers}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
            title="تحديث"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition shadow-lg shadow-indigo-600/20"
          >
            <Plus className="w-4 h-4" />
            <span>مستخدم جديد</span>
          </button>
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
          <CheckCircle className="w-4 h-4 shrink-0 text-emerald-400" />
          <span>{success}</span>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        {loading && users.length === 0 ? (
          <div className="p-20 text-center text-slate-400 flex flex-col items-center gap-3">
            <RefreshCw className="w-8 h-8 animate-spin text-indigo-500" />
            <span>جاري تحميل بيانات المستخدمين...</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-medium">
                <tr>
                  <th className="py-3 px-4 text-right">اسم المستخدم</th>
                  <th className="py-3 px-4 text-right">الدور</th>
                  <th className="py-3 px-4 text-right">الحالة</th>
                  <th className="py-3 px-4 text-center">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-800/30 transition">
                    <td className="py-3 px-4 font-semibold text-white">{u.username}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold ${
                        u.role === 'platform_admin'
                          ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                          : u.role === 'company_admin'
                          ? 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20'
                          : 'bg-slate-800 text-slate-400'
                      }`}>
                        {u.role === 'platform_admin'
                          ? 'مدير منصة'
                          : u.role === 'company_admin'
                          ? 'مدير شركة'
                          : 'مستخدم'}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <button
                        onClick={() => toggleUserActive(u)}
                        className={`flex items-center gap-1.5 transition ${u.isActive ? 'text-emerald-400 hover:text-emerald-300' : 'text-red-400 hover:text-red-300'}`}
                      >
                        {u.isActive ? <UserCheck className="w-3.5 h-3.5" /> : <UserX className="w-3.5 h-3.5" />}
                        <span className="font-medium">{u.isActive ? 'نشط' : 'معطل'}</span>
                      </button>
                    </td>
                    <td className="py-3 px-4 flex items-center justify-center gap-2">
                      {canReadScopes && selectedCompanyId && (
                        <button
                          type="button"
                          onClick={() => setScopeDrawerUser(u)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-950/60 hover:bg-indigo-900/70 border border-indigo-800/60 text-indigo-300 text-[11px] font-semibold transition cursor-pointer"
                          title="إدارة النطاقات التنظيمية للمستخدم"
                        >
                          <Network className="w-3.5 h-3.5" />
                          <span>النطاقات</span>
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setTargetUser(u);
                          setShowResetModal(true);
                        }}
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-indigo-400 transition"
                        title="إعادة تعيين كلمة المرور"
                      >
                        <Key className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal: Create User */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4" dir="rtl">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Plus className="w-4 h-4 text-indigo-400" />
              إنشاء حساب مستخدم جديد
            </h3>
            <form onSubmit={handleCreateUser} className="space-y-4">
              <div>
                <label className="block text-[11px] font-bold text-slate-400 mb-1">اسم المستخدم</label>
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-400 mb-1">كلمة المرور الأولية</label>
                <input
                  type="password"
                  required
                  minLength={12}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              {companies.length > 0 && role !== 'platform_admin' && (
                <div>
                  <label className="block text-[11px] font-bold text-slate-400 mb-1">الشركة</label>
                  <select
                    value={selectedCompanyId}
                    onChange={(e) => setSelectedCompanyId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                  >
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} - {c.nameAr}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-[11px] font-bold text-slate-400 mb-1">نوع الحساب / الدور</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                >
                  {roleOptions.map((opt) => (
                    <option key={opt.code} value={opt.code}>
                      {opt.nameAr} ({opt.code})
                    </option>
                  ))}
                </select>
                {rolesNotInitializedWarning && (
                  <p className="mt-1.5 text-[11px] text-amber-400">
                    لم تُهيّأ الأدوار لهذه الشركة بعد — يتم عرض الأدوار الافتراضية مؤقتاً.
                  </p>
                )}
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition disabled:opacity-50"
                >
                  {submitting ? 'جاري الإنشاء...' : 'إنشاء المستخدم'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold"
                >
                  إلغاء
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Reset Password */}
      {showResetModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4" dir="rtl">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Key className="w-4 h-4 text-indigo-400" />
              إعادة تعيين كلمة المرور
            </h3>
            <p className="text-xs text-slate-400">تغيير كلمة المرور للمستخدم: <span className="text-white font-bold">{targetUser?.username}</span></p>
            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <label className="block text-[11px] font-bold text-slate-400 mb-1">كلمة المرور الجديدة</label>
                <input
                  type="password"
                  required
                  minLength={12}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition disabled:opacity-50"
                >
                  {submitting ? 'جاري التحديث...' : 'تحديث كلمة المرور'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowResetModal(false);
                    setTargetUser(null);
                  }}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold"
                >
                  إلغاء
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Drawer: User Org Scopes */}
      {scopeDrawerUser && selectedCompanyId && canReadScopes && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-sm flex justify-end" dir="rtl">
          <div className="w-full max-w-5xl bg-slate-950 border-r border-slate-800 h-full overflow-y-auto shadow-2xl flex flex-col">
            <div className="p-5 border-b border-slate-800 bg-slate-900/90 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-10">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                  <Network className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">
                    نطاقات المستخدم: {scopeDrawerUser.username}
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    تحديد الفروع والإدارات ومراكز التكلفة المصرّح بها للمستخدم داخل الشركة
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {companies.length > 1 && (
                  <select
                    value={selectedCompanyId}
                    onChange={(e) => setSelectedCompanyId(e.target.value)}
                    className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                  >
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nameAr} ({c.code})
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  onClick={() => setScopeDrawerUser(null)}
                  className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                  aria-label="إغلاق لوحة النطاقات"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="p-6">
              <UserScopesPanel
                companyId={selectedCompanyId}
                canWrite={canWriteScopes}
                lockedUserId={scopeDrawerUser.id}
                lockedUsername={scopeDrawerUser.username}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
