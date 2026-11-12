import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ShieldCheck,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  GitFork,
  Save,
  RotateCcw,
  Users,
  Calendar,
  Building2,
  Info,
  ArrowRight,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

export interface OrgUnitItem {
  id: string;
  companyId: string;
  parentId?: string | null;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  unitType: 'branch' | 'department' | 'cost_center' | 'division';
  isActive: boolean;
  path: string;
}

export type AccessLevel = 'read' | 'write' | 'approve';

export interface ScopeRecord {
  orgUnitId: string;
  code: string;
  nameAr: string;
  unitType: OrgUnitItem['unitType'] | null;
  path: string;
  includeDescendants: boolean;
  accessLevel: AccessLevel;
  roleId?: string | null;
  roleCode?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  reason?: string | null;
}

interface DraftScopeEntry {
  orgUnitId: string;
  includeDescendants: boolean;
  accessLevel: AccessLevel;
  roleId: string;
  validFrom: string;
  validUntil: string;
  reason: string;
}

interface UserOption {
  id: string;
  username: string;
  role: string;
  isActive?: boolean;
}

interface RoleOption {
  id: string;
  code: string;
  nameAr: string;
  isActive: boolean;
}

export interface UserScopesPanelProps {
  companyId: string;
  units?: OrgUnitItem[];
  unitsLoading?: boolean;
  canWrite: boolean;
  lockedUserId?: string;
  lockedUsername?: string;
  onGoToUnitsTab?: () => void;
  onScopesSaved?: () => void;
}

const unitTypeLabels: Record<OrgUnitItem['unitType'], string> = {
  branch: 'فرع تشغيلي',
  department: 'إدارة / قسم',
  cost_center: 'مركز تكلفة',
  division: 'قطاع أعمال',
};

function getDepth(path: string): number {
  return Math.max(0, path.split('/').filter(Boolean).length - 1);
}

function buildDraftMap(scopes: ScopeRecord[]): Record<string, DraftScopeEntry> {
  const map: Record<string, DraftScopeEntry> = {};
  for (const sc of scopes) {
    map[sc.orgUnitId] = {
      orgUnitId: sc.orgUnitId,
      includeDescendants: Boolean(sc.includeDescendants),
      accessLevel: (sc.accessLevel || 'read') as AccessLevel,
      roleId: sc.roleId || '',
      validFrom: sc.validFrom ? String(sc.validFrom).slice(0, 10) : '',
      validUntil: sc.validUntil ? String(sc.validUntil).slice(0, 10) : '',
      reason: sc.reason || '',
    };
  }
  return map;
}

function serializeDraft(map: Record<string, DraftScopeEntry>): string {
  const keys = Object.keys(map).sort();
  return JSON.stringify(
    keys.map((k) => {
      const e = map[k];
      return {
        orgUnitId: e.orgUnitId,
        includeDescendants: e.includeDescendants,
        accessLevel: e.accessLevel,
        roleId: e.roleId || null,
        validFrom: e.validFrom || null,
        validUntil: e.validUntil || null,
        reason: e.reason.trim() || null,
      };
    })
  );
}

export function UserScopesPanel({
  companyId,
  units: externalUnits,
  unitsLoading: externalUnitsLoading = false,
  canWrite,
  lockedUserId,
  lockedUsername,
  onGoToUnitsTab,
  onScopesSaved,
}: UserScopesPanelProps) {
  // Reuse OrgUnitsPanel's units when supplied; only fetch /org-units directly when used standalone (e.g., Users drawer)
  const [internalUnits, setInternalUnits] = useState<OrgUnitItem[]>([]);
  const [internalUnitsLoading, setInternalUnitsLoading] = useState(false);

  const units = externalUnits !== undefined ? externalUnits : internalUnits;
  const isUnitsLoading = externalUnits !== undefined ? externalUnitsLoading : internalUnitsLoading;

  const [users, setUsers] = useState<UserOption[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(!lockedUserId);
  const [selectedUserId, setSelectedUserId] = useState<string>(lockedUserId || '');

  const [roles, setRoles] = useState<RoleOption[]>([]);

  const [loadedScopes, setLoadedScopes] = useState<ScopeRecord[]>([]);
  const [draftMap, setDraftMap] = useState<Record<string, DraftScopeEntry>>({});
  const [loadingScopes, setLoadingScopes] = useState<boolean>(true);
  const [saving, setSaving] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [unitErrors, setUnitErrors] = useState<Record<string, string>>({});
  const [focusedUnitId, setFocusedUnitId] = useState<string | null>(null);

  // Sync lockedUserId when switched in drawer
  useEffect(() => {
    if (lockedUserId) {
      setSelectedUserId(lockedUserId);
    }
  }, [lockedUserId]);

  // Load units only if externalUnits wasn't passed
  useEffect(() => {
    if (externalUnits !== undefined || !companyId) return;
    let cancelled = false;
    async function loadUnitsStandalone() {
      setInternalUnitsLoading(true);
      try {
        const res = await apiFetch(`/api/companies/${companyId}/org-units`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || data.error || 'تعذر تحميل الوحدات التنظيمية');
        }
        const data = await res.json();
        if (!cancelled) {
          setInternalUnits(data.units || []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'تعذر تحميل الوحدات التنظيمية');
        }
      } finally {
        if (!cancelled) {
          setInternalUnitsLoading(false);
        }
      }
    }
    loadUnitsStandalone();
    return () => {
      cancelled = true;
    };
  }, [companyId, externalUnits]);

  // Load users for company (unless lockedUserId provided)
  useEffect(() => {
    if (!companyId) return;
    if (lockedUserId) {
      setUsers([
        {
          id: lockedUserId,
          username: lockedUsername || lockedUserId,
          role: 'company_user',
          isActive: true,
        },
      ]);
      setLoadingUsers(false);
      return;
    }

    let cancelled = false;
    async function loadUsers() {
      setLoadingUsers(true);
      try {
        const res = await apiFetch(`/api/users?companyId=${encodeURIComponent(companyId)}`);
        if (res.ok) {
          const data = await res.json();
          const list: UserOption[] = (data.users || []).filter((u: UserOption) => u.isActive !== false);
          if (!cancelled) {
            setUsers(list);
            setSelectedUserId((prev) => (prev && list.some((u) => u.id === prev) ? prev : list[0]?.id || ''));
          }
        } else if (res.status === 403) {
          // Read-only user without USER_READ: fallback cleanly to self from /api/auth/me
          const meRes = await apiFetch('/api/auth/me');
          if (meRes.ok && !cancelled) {
            const meBody = await meRes.json();
            if (meBody.user) {
              setUsers([meBody.user]);
              setSelectedUserId(meBody.user.id);
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'تعذر تحميل قائمة المستخدمين');
        }
      } finally {
        if (!cancelled) {
          setLoadingUsers(false);
        }
      }
    }
    loadUsers();
    return () => {
      cancelled = true;
    };
  }, [companyId, lockedUserId, lockedUsername]);

  // Load active dynamic roles for company (for roleCode dropdown)
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    async function loadRoles() {
      try {
        const res = await apiFetch(`/api/companies/${companyId}/roles`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setRoles((data.roles || []).filter((r: RoleOption) => r.isActive !== false));
        }
      } catch {
        // Role linking is optional when ROLES_READ is unavailable
      }
    }
    loadRoles();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Load scopes for selectedUserId — ALWAYS start loading before showing controlled checkboxes
  const loadUserScopes = useCallback(async () => {
    if (!companyId || !selectedUserId) {
      setLoadedScopes([]);
      setDraftMap({});
      setLoadingScopes(false);
      return;
    }

    setLoadingScopes(true);
    setError(null);
    setUnitErrors({});
    try {
      const res = await apiFetch(`/api/companies/${companyId}/users/${selectedUserId}/scopes`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || 'تعذر تحميل نطاقات المستخدم');
      }
      const data = await res.json();
      const scopes: ScopeRecord[] = data.scopes || [];
      setLoadedScopes(scopes);
      setDraftMap(buildDraftMap(scopes));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في جلب نطاقات المستخدم');
      setLoadedScopes([]);
      setDraftMap({});
    } finally {
      setLoadingScopes(false);
    }
  }, [companyId, selectedUserId]);

  useEffect(() => {
    loadUserScopes();
  }, [loadUserScopes]);

  const isDirty = useMemo(() => {
    return serializeDraft(draftMap) !== serializeDraft(buildDraftMap(loadedScopes));
  }, [draftMap, loadedScopes]);

  const toggleUnit = (unit: OrgUnitItem, checked: boolean) => {
    if (!canWrite || loadingScopes) return;
    setSuccess(null);
    setError(null);
    setUnitErrors((prev) => {
      if (!prev[unit.id]) return prev;
      const copy = { ...prev };
      delete copy[unit.id];
      return copy;
    });
    setDraftMap((prev) => {
      const next = { ...prev };
      if (checked) {
        next[unit.id] = {
          orgUnitId: unit.id,
          includeDescendants: true,
          accessLevel: 'read',
          roleId: '',
          validFrom: '',
          validUntil: '',
          reason: '',
        };
      } else {
        delete next[unit.id];
      }
      return next;
    });
    setFocusedUnitId(unit.id);
  };

  const updateEntry = (unitId: string, patch: Partial<DraftScopeEntry>) => {
    if (!canWrite || loadingScopes) return;
    setSuccess(null);
    setError(null);
    setUnitErrors((prev) => {
      if (!prev[unitId]) return prev;
      const copy = { ...prev };
      delete copy[unitId];
      return copy;
    });
    setDraftMap((prev) => {
      const existing = prev[unitId];
      if (!existing) return prev;
      return {
        ...prev,
        [unitId]: { ...existing, ...patch },
      };
    });
  };

  const handleReset = () => {
    setDraftMap(buildDraftMap(loadedScopes));
    setUnitErrors({});
    setError(null);
    setSuccess(null);
  };

  const handleSave = async () => {
    if (!canWrite || !companyId || !selectedUserId || saving) return;

    // Client-side date sanity check mapped directly to unit field
    const localUnitErrors: Record<string, string> = {};
    for (const entry of Object.values(draftMap)) {
      if (entry.validFrom && entry.validUntil && entry.validUntil < entry.validFrom) {
        localUnitErrors[entry.orgUnitId] = `تاريخ الانتهاء (${entry.validUntil}) يجب أن يكون أكبر من أو يساوي تاريخ البداية (${entry.validFrom})`;
      }
    }
    if (Object.keys(localUnitErrors).length > 0) {
      setUnitErrors(localUnitErrors);
      setError('يرجى تصحيح تواريخ السريان المحددة على الوحدات أدناه');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);
    setUnitErrors({});

    try {
      const payload = {
        scopes: Object.values(draftMap).map((e) => ({
          userId: selectedUserId,
          orgUnitId: e.orgUnitId,
          includeDescendants: e.includeDescendants,
          accessLevel: e.accessLevel,
          roleId: e.roleId || null,
          validFrom: e.validFrom || null,
          validUntil: e.validUntil || null,
          reason: e.reason.trim() || null,
        })),
      };

      const res = await apiFetch(`/api/companies/${companyId}/users/${selectedUserId}/scopes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.message || data.error || 'تعذر حفظ نطاقات المستخدم';
        // Map server escalation / unit error directly onto the offending unit(s)
        const matchedErrors: Record<string, string> = {};
        for (const u of units) {
          if ((u.code && msg.includes(u.code)) || (u.nameAr && msg.includes(u.nameAr))) {
            matchedErrors[u.id] = msg;
          }
        }
        if (Object.keys(matchedErrors).length > 0) {
          setUnitErrors(matchedErrors);
        }
        setError(msg);
        return;
      }

      const saved: ScopeRecord[] = data.scopes || [];
      setLoadedScopes(saved);
      setDraftMap(buildDraftMap(saved));
      setSuccess(
        saved.length === 0
          ? 'تم حفظ النطاقات بنجاح — المستخدم الآن بلا نطاقات (يرى الشركة كاملة)'
          : `تم حفظ ${saved.length} نطاق تنظيمي للمستخدم بنجاح`
      );
      if (onScopesSaved) {
        onScopesSaved();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء حفظ النطاقات');
    } finally {
      setSaving(false);
    }
  };

  const selectedCount = Object.keys(draftMap).length;
  const isSavedCompanyWide = !loadingScopes && loadedScopes.length === 0;
  const isDraftCompanyWide = !loadingScopes && selectedCount === 0;

  // Empty state: no org units defined yet
  if (!isUnitsLoading && units.length === 0) {
    return (
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-10 text-center flex flex-col items-center gap-3">
        <Building2 className="w-10 h-10 text-slate-600" />
        <p className="text-sm font-semibold text-slate-200">
          لا توجد وحدات تنظيمية بعد — أنشئ وحدة أولًا
        </p>
        <p className="text-xs text-slate-400">
          تحديد نطاقات المستخدمين يعتمد على شجرة الفروع والإدارات ومراكز التكلفة في هذه الشركة.
        </p>
        {onGoToUnitsTab && (
          <button
            type="button"
            onClick={onGoToUnitsTab}
            className="mt-2 inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition cursor-pointer"
          >
            <ArrowRight className="w-4 h-4" />
            <span>الانتقال إلى تبويب الهيكل والوحدات</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5" dir="rtl">
      {/* Top User Selector & Actions Bar */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-indigo-400" />
            <label className="text-xs font-semibold text-slate-300">المستخدم المختار:</label>
            {lockedUserId ? (
              <span className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white">
                {lockedUsername || selectedUserId}
              </span>
            ) : (
              <select
                aria-label="اختيار المستخدم"
                value={selectedUserId}
                onChange={(e) => {
                  setSelectedUserId(e.target.value);
                  setSuccess(null);
                  setError(null);
                }}
                disabled={loadingUsers || saving}
                className="px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-semibold text-white focus:outline-none focus:border-indigo-500 transition min-w-[200px]"
              >
                {users.length === 0 ? (
                  <option value="">لا يوجد مستخدمون</option>
                ) : (
                  users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.username} ({u.role})
                    </option>
                  ))
                )}
              </select>
            )}
          </div>

          {/* Transparent behavior badge */}
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold border ${
              isDraftCompanyWide
                ? 'bg-amber-950/50 border-amber-700/60 text-amber-300'
                : 'bg-indigo-950/40 border-indigo-800/60 text-indigo-300'
            }`}
          >
            <Info className="w-3.5 h-3.5 shrink-0" />
            {loadingScopes
              ? 'جاري تحميل النطاقات...'
              : isDraftCompanyWide
              ? 'بلا نطاقات = يرى الشركة كاملة'
              : `نطاق مقيّد (${selectedCount} ${selectedCount === 1 ? 'وحدة' : 'وحدات'}) — ملاحظة: بلا نطاقات = يرى الشركة كاملة`}
          </span>

          {isSavedCompanyWide && !isDraftCompanyWide && (
            <span className="text-[11px] text-amber-400">
              (الحالة المحفوظة حالياً: يرى الشركة كاملة)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadUserScopes}
            disabled={loadingScopes || saving}
            className="p-2 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer disabled:opacity-50"
            title="تحديث النطاقات"
          >
            <RefreshCw className={`w-4 h-4 ${loadingScopes ? 'animate-spin' : ''}`} />
          </button>

          {canWrite && (
            <>
              <button
                type="button"
                onClick={handleReset}
                disabled={!isDirty || saving || loadingScopes}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>إعادة تعيين</span>
              </button>

              <button
                type="button"
                onClick={handleSave}
                disabled={!isDirty || saving || loadingScopes || !selectedUserId}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-indigo-600/20 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{saving ? 'جاري الحفظ...' : 'حفظ النطاقات'}</span>
              </button>
            </>
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

      {/* Loading State: strictly shown BEFORE any checkboxes become editable/visible so units never flash as allowed */}
      {isUnitsLoading || loadingScopes ? (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl py-16 text-center text-slate-400 flex flex-col items-center justify-center gap-3">
          <RefreshCw className="w-6 h-6 animate-spin text-indigo-400" />
          <span className="text-xs font-medium">جاري تحميل شجرة الوحدات ونطاقات المستخدم الفعلية...</span>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Right (in RTL) / Scope Assignment Details per Unit */}
          <div className="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-bold text-white">نطاقات المستخدم المختار</h3>
              </div>
              <span className="text-[11px] text-slate-400">
                اختر الوحدات وحدد مستوى الوصول، الدور المرتبط، وفترة السريان
              </span>
            </div>

            <div className="flex flex-col gap-3 max-h-[540px] overflow-y-auto pr-1">
              {units.map((unit) => {
                const entry = draftMap[unit.id];
                const isSelected = Boolean(entry);
                const unitErr = unitErrors[unit.id];
                const isFocused = focusedUnitId === unit.id;

                return (
                  <div
                    key={unit.id}
                    className={`rounded-xl border p-4 transition ${
                      unitErr
                        ? 'border-red-500/80 bg-red-950/20'
                        : isSelected
                        ? isFocused
                          ? 'border-indigo-500 bg-indigo-950/20'
                          : 'border-indigo-800/70 bg-slate-950/80'
                        : 'border-slate-800/80 bg-slate-950/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <label className="flex items-center gap-2.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={!canWrite || (!unit.isActive && !isSelected)}
                          onChange={(e) => toggleUnit(unit, e.target.checked)}
                          className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                        />
                        <div className="flex flex-col">
                          <span className="text-xs font-bold text-white">
                            {unit.nameAr}{' '}
                            <span className="font-mono text-[11px] text-indigo-300">({unit.code})</span>
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono">
                            {unitTypeLabels[unit.unitType]} • {unit.path}
                          </span>
                        </div>
                      </label>

                      {!unit.isActive && (
                        <span className="px-2 py-0.5 rounded text-[10px] bg-slate-800 text-slate-400 border border-slate-700">
                          وحدة معطّلة
                        </span>
                      )}
                    </div>

                    {isSelected && entry && (
                      <div className="mt-3 pt-3 border-t border-slate-800/70 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                            مستوى الصلاحية (Access Level)
                          </label>
                          <select
                            value={entry.accessLevel}
                            disabled={!canWrite}
                            onChange={(e) =>
                              updateEntry(unit.id, { accessLevel: e.target.value as AccessLevel })
                            }
                            className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-indigo-500"
                          >
                            <option value="read">قراءة فقط (read)</option>
                            <option value="write">قراءة وكتابة (write)</option>
                            <option value="approve">اعتماد (approve)</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                            الدور المرتبط (Role)
                          </label>
                          <select
                            value={entry.roleId}
                            disabled={!canWrite}
                            onChange={(e) => updateEntry(unit.id, { roleId: e.target.value })}
                            className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-indigo-500"
                          >
                            <option value="">بدون ربط بدور محدد</option>
                            {roles.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.nameAr} ({r.code})
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="flex items-end pb-1">
                          <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-200">
                            <input
                              type="checkbox"
                              checked={entry.includeDescendants}
                              disabled={!canWrite}
                              onChange={(e) =>
                                updateEntry(unit.id, { includeDescendants: e.target.checked })
                              }
                              className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-indigo-500"
                            />
                            <span>يشمل الوحدات التابعة</span>
                          </label>
                        </div>

                        <div>
                          <label className="block text-[10px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                            <Calendar className="w-3 h-3 text-slate-500" />
                            ساري من (validFrom)
                          </label>
                          <input
                            type="date"
                            value={entry.validFrom}
                            disabled={!canWrite}
                            onChange={(e) => updateEntry(unit.id, { validFrom: e.target.value })}
                            className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-indigo-500"
                          />
                        </div>

                        <div>
                          <label className="block text-[10px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                            <Calendar className="w-3 h-3 text-slate-500" />
                            ساري حتى (validUntil)
                          </label>
                          <input
                            type="date"
                            value={entry.validUntil}
                            disabled={!canWrite}
                            onChange={(e) => updateEntry(unit.id, { validUntil: e.target.value })}
                            className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-indigo-500"
                          />
                        </div>

                        <div>
                          <label className="block text-[10px] font-semibold text-slate-400 mb-1">
                            سبب المنح / التفويض (reason)
                          </label>
                          <input
                            type="text"
                            placeholder="مثال: مدير فرع القاهرة"
                            value={entry.reason}
                            disabled={!canWrite}
                            onChange={(e) => updateEntry(unit.id, { reason: e.target.value })}
                            className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-indigo-500"
                          />
                        </div>
                      </div>
                    )}

                    {/* Per-unit server escalation / field validation error */}
                    {unitErr && (
                      <div
                        role="alert"
                        className="mt-3 p-2.5 rounded-lg bg-red-950/70 border border-red-700/80 text-red-200 text-[11px] flex items-center gap-2"
                      >
                        <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                        <span>{unitErr}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Left (in RTL) / Interactive Org Units Tree */}
          <div className="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <GitFork className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-bold text-white">شجرة الوحدات</h3>
              </div>
              <span className="text-[11px] text-slate-400">{units.length} وحدة</span>
            </div>

            <div className="flex flex-col gap-1.5 max-h-[540px] overflow-y-auto pr-1">
              {units.map((unit) => {
                const depth = getDepth(unit.path);
                const checked = Boolean(draftMap[unit.id]);
                const hasError = Boolean(unitErrors[unit.id]);
                return (
                  <div
                    key={unit.id}
                    onClick={() => setFocusedUnitId(unit.id)}
                    style={{ paddingRight: `${12 + depth * 18}px` }}
                    className={`flex items-center justify-between gap-2 py-2 px-3 rounded-xl border text-xs cursor-pointer transition ${
                      hasError
                        ? 'border-red-500/80 bg-red-950/30 text-red-200'
                        : checked
                        ? 'border-indigo-600/60 bg-indigo-950/30 text-white'
                        : 'border-slate-800/60 bg-slate-950/40 text-slate-300 hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {depth > 0 && (
                        <GitFork className="w-3.5 h-3.5 text-slate-500 rotate-180 shrink-0" />
                      )}
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canWrite || (!unit.isActive && !checked)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => toggleUnit(unit, e.target.checked)}
                        className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-900 text-indigo-500 shrink-0"
                      />
                      <span className="font-mono text-[11px] text-indigo-300 shrink-0">{unit.code}</span>
                      <span className="truncate font-medium">{unit.nameAr}</span>
                    </div>
                    <span className="text-[10px] text-slate-400 shrink-0">
                      {unitTypeLabels[unit.unitType]}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
