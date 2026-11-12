import React, { useEffect, useMemo, useState } from 'react';
import { Save, CheckSquare, Square, AlertCircle, CheckCircle2, ShieldAlert, Lock } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

export interface PermissionCatalogItem {
  code: string;
  labelAr: string;
  group: string;
}

export interface DynamicRole {
  id: string;
  companyId: string;
  code: string;
  nameAr: string;
  description: string | null;
  orgLevel: 'company' | 'branch' | 'department';
  isSystem: boolean;
  isActive: boolean;
  permissions?: string[];
  permissionsCount?: number;
  usersCount?: number;
}

/**
 * قائمة الصلاحيات المعرّفة في الكتالوج بلا فرض خادمي فعلي في مسار إنتاجي بهذه النسخة.
 * تُعرض بوسم صريح «غير مفعّلة في هذه النسخة» لمنع الإيهام بوجود حماية غير مطبّقة.
 */
const UNENFORCED_PERMISSIONS = new Set<string>(['audit:read']);

interface PermissionMatrixProps {
  companyId: string;
  roles: DynamicRole[];
  selectedRoleId: string;
  onSelectRoleId: (roleId: string) => void;
  userRole?: string;
  onSaved: () => Promise<void> | void;
}

export function PermissionMatrix({
  companyId,
  roles,
  selectedRoleId,
  onSelectRoleId,
  userRole,
  onSaved,
}: PermissionMatrixProps) {
  const [catalog, setCatalog] = useState<PermissionCatalogItem[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set());
  const [initialPerms, setInitialPerms] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const currentRole = useMemo(
    () => roles.find((r) => r.id === selectedRoleId) || null,
    [roles, selectedRoleId]
  );

  const canEditSelectedRole =
    Boolean(currentRole) && (!currentRole?.isSystem || userRole === 'platform_admin');

  const isDirty = useMemo(() => {
    if (selectedPerms.size !== initialPerms.size) return true;
    for (const p of selectedPerms) {
      if (!initialPerms.has(p)) return true;
    }
    return false;
  }, [selectedPerms, initialPerms]);

  const loadCatalog = async () => {
    setLoadingCatalog(true);
    setCatalogError(null);
    try {
      const res = await apiFetch('/api/rbac/permissions');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || body.error || 'تعذر تحميل كتالوج الصلاحيات');
      }
      setCatalog(body.permissions || []);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : 'خطأ في تحميل الكتالوج');
    } finally {
      setLoadingCatalog(false);
    }
  };

  useEffect(() => {
    loadCatalog();
  }, []);

  useEffect(() => {
    const perms = new Set<string>(currentRole?.permissions || []);
    setSelectedPerms(new Set(perms));
    setInitialPerms(new Set(perms));
    setError(null);
    setSuccess(null);
  }, [currentRole]);

  const groupedCatalog = useMemo(() => {
    return catalog.reduce<Record<string, PermissionCatalogItem[]>>((acc, item) => {
      if (!acc[item.group]) acc[item.group] = [];
      acc[item.group].push(item);
      return acc;
    }, {});
  }, [catalog]);

  const togglePermission = (code: string) => {
    if (!canEditSelectedRole) return;
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
    setSuccess(null);
  };

  const selectAll = () => {
    if (!canEditSelectedRole) return;
    setSelectedPerms(new Set(catalog.map((c) => c.code)));
    setSuccess(null);
  };

  const clearAll = () => {
    if (!canEditSelectedRole) return;
    setSelectedPerms(new Set());
    setSuccess(null);
  };

  const handleSave = async () => {
    if (!companyId || !currentRole || !canEditSelectedRole) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(
        `/api/companies/${companyId}/roles/${currentRole.id}/permissions`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permissions: Array.from(selectedPerms) }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || body.error || 'تعذر حفظ مصفوفة الصلاحيات');
      }
      const savedSet = new Set<string>(body.permissions || Array.from(selectedPerms));
      setSelectedPerms(savedSet);
      setInitialPerms(new Set(savedSet));
      setSuccess(`تم حفظ صلاحيات الدور "${currentRole.nameAr}" (${savedSet.size} صلاحية)`);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشل حفظ الصلاحيات');
    } finally {
      setSaving(false);
    }
  };

  if (loadingCatalog) {
    return (
      <div className="p-10 text-center text-xs text-slate-400">
        جاري تحميل كتالوج الصلاحيات من الخادم...
      </div>
    );
  }

  if (catalogError) {
    return (
      <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          <span>{catalogError}</span>
        </div>
        <button
          type="button"
          onClick={loadCatalog}
          className="px-3 py-1 bg-red-900/50 hover:bg-red-800/60 rounded-lg font-semibold cursor-pointer"
        >
          إعادة محاولة
        </button>
      </div>
    );
  }

  if (roles.length === 0) {
    return (
      <div className="p-10 text-center text-xs text-slate-400">
        لا توجد أدوار متاحة لتعديل مصفوفة صلاحياتها.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5" dir="rtl">
      {/* Controls Header */}
      <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs font-semibold text-slate-300">الدور المستهدف:</label>
          <select
            value={selectedRoleId}
            onChange={(e) => onSelectRoleId(e.target.value)}
            className="bg-slate-900 border border-slate-700 text-slate-100 text-xs rounded-xl px-3.5 py-2 focus:outline-none focus:border-indigo-500"
          >
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.nameAr} ({r.code}){r.isSystem ? ' [نظامي]' : ''}
              </option>
            ))}
          </select>

          <span className="px-3 py-1 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-xs font-bold">
            محدد {selectedPerms.size} من {catalog.length}
          </span>

          {isDirty && (
            <span className="px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px] font-bold">
              تغييرات غير محفوظة
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={selectAll}
            disabled={!canEditSelectedRole}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-semibold transition cursor-pointer"
          >
            <CheckSquare className="w-3.5 h-3.5" />
            <span>تحديد الكل</span>
          </button>
          <button
            type="button"
            onClick={clearAll}
            disabled={!canEditSelectedRole}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-semibold transition cursor-pointer"
          >
            <Square className="w-3.5 h-3.5" />
            <span>إلغاء الكل</span>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canEditSelectedRole || saving || !isDirty}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-bold transition shadow-lg shadow-indigo-600/20 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{saving ? 'جاري الحفظ...' : 'حفظ المصفوفة'}</span>
          </button>
        </div>
      </div>

      {currentRole?.isSystem && userRole !== 'platform_admin' && (
        <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded-xl text-amber-300 text-xs flex items-center gap-2">
          <Lock className="w-4 h-4 shrink-0 text-amber-400" />
          <span>الأدوار النظامية ({currentRole.code}) محمية — تعديل صلاحياتها متاح لمدير المنصة (platform_admin) فقط.</span>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="p-3 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          <span>{success}</span>
        </div>
      )}

      {/* Matrix Rows by Group */}
      <div className="space-y-4">
        {Object.entries(groupedCatalog).map(([group, items]) => (
          <div key={group} className="bg-slate-950/60 border border-slate-800 rounded-2xl overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between">
              <h5 className="text-xs font-bold text-indigo-300">{group}</h5>
              <span className="text-[11px] text-slate-400">
                {items.filter((i) => selectedPerms.has(i.code)).length} / {items.length}
              </span>
            </div>
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {items.map((item) => {
                const checked = selectedPerms.has(item.code);
                const isUnenforced = UNENFORCED_PERMISSIONS.has(item.code);
                const scopeTag = item.code.startsWith('org:')
                  ? 'وحدة تنظيمية'
                  : item.code.endsWith(':write') || item.code.endsWith('.write') || item.code.endsWith(':post') || item.code.endsWith('.post') || item.code.endsWith('.create')
                  ? 'عملية تعديل/ترحيل'
                  : 'قراءة/وحدة';

                return (
                  <label
                    key={item.code}
                    title={item.code}
                    className={`flex items-start gap-3 p-3 rounded-xl border transition ${
                      checked
                        ? 'bg-indigo-950/30 border-indigo-500/40 text-white'
                        : 'bg-slate-900/40 border-slate-800 text-slate-300'
                    } ${canEditSelectedRole ? 'cursor-pointer hover:border-slate-700' : 'opacity-70 cursor-not-allowed'}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!canEditSelectedRole}
                      onChange={() => togglePermission(item.code)}
                      className="mt-0.5 rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="text-xs font-semibold leading-snug">{item.labelAr}</div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[10px] text-slate-400">{item.code}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                          {scopeTag}
                        </span>
                        {isUnenforced && (
                          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                            <ShieldAlert className="w-3 h-3" />
                            غير مفعّلة في هذه النسخة
                          </span>
                        )}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
