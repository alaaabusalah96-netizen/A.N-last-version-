import React, { useState, useEffect, useCallback } from 'react';
import { Network, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface Group { id: string; code: string; nameAr: string; nameEn: string | null; isActive: boolean; myRole?: string }
interface Detail extends Group {
  companies: { companyId: string; code: string; nameAr: string; isActive: boolean }[];
  users: { userId: string; username: string; role: string; isActive: boolean }[];
}
interface Props { userRole: string }

const ROLE_AR: Record<string, string> = { platform_admin: 'مدير المنصة', group_admin: 'مدير المجموعة', group_viewer: 'عرض فقط' };

async function call(path: string, method = 'GET', body?: unknown) {
  const res = await apiFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'تعذر تنفيذ العملية');
  return data;
}

export function CompanyGroupsPanel({ userRole }: Props) {
  const isPlatformAdmin = userRole === 'platform_admin';
  const [groups, setGroups] = useState<Group[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [allCompanies, setAllCompanies] = useState<{ id: string; code: string; nameAr: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [addCompanyId, setAddCompanyId] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState('group_viewer');

  const loadGroups = useCallback(async () => {
    try { setError(null); setGroups((await call('/api/groups')).groups); } catch (e: any) { setError(e.message); }
  }, []);
  const loadDetail = useCallback(async (id: string) => {
    try { setError(null); setDetail((await call(`/api/groups/${id}`)).group); } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { loadGroups(); }, [loadGroups]);
  useEffect(() => { if (sel) loadDetail(sel); else setDetail(null); }, [sel, loadDetail]);
  useEffect(() => {
    if (isPlatformAdmin) call('/api/companies').then((d) => setAllCompanies(d.companies || [])).catch(() => {});
  }, [isPlatformAdmin]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); if (sel) await loadDetail(sel); await loadGroups(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const canManageUsers = detail?.myRole === 'platform_admin' || detail?.myRole === 'group_admin';
  const free = allCompanies.filter((c) => !detail?.companies.some((m) => m.companyId === c.id));
  const inputCls = 'px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500';
  const btnCls = 'flex items-center gap-1 px-3 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold cursor-pointer disabled:opacity-40';

  return (
    <div className="flex flex-col gap-4" data-testid="groups-panel">
      {error && <div className="text-xs text-rose-400" role="alert" data-testid="groups-error">{error}</div>}
      <div className="grid md:grid-cols-3 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2"><Network className="w-4 h-4" /> المجموعات</h3>
            <button onClick={loadGroups} className="text-slate-400 cursor-pointer" aria-label="تحديث"><RefreshCw className="w-4 h-4" /></button>
          </div>
          {groups.length === 0 && <div className="text-xs text-slate-400" data-testid="groups-empty">لا توجد مجموعات متاحة لك</div>}
          {groups.map((g) => (
            <button key={g.id} onClick={() => setSel(g.id)} data-testid="group-item"
              className={`text-right text-xs px-3 py-2 rounded-xl cursor-pointer ${sel === g.id ? 'bg-indigo-600 text-white' : 'bg-slate-950 text-slate-200'}`}>
              {g.nameAr} ({g.code}){!g.isActive ? ' - موقوفة' : ''}
            </button>
          ))}
          {isPlatformAdmin && (
            <form className="flex flex-col gap-2 border-t border-slate-800 pt-2" onSubmit={(e) => { e.preventDefault(); act(async () => { await call('/api/groups', 'POST', { code, nameAr }); setCode(''); setNameAr(''); }); }}>
              <input required value={code} onChange={(e) => setCode(e.target.value)} placeholder="كود المجموعة" className={inputCls} data-testid="group-code" />
              <input required value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder="اسم المجموعة" className={inputCls} data-testid="group-name" />
              <button type="submit" disabled={busy} className={btnCls} data-testid="group-create"><Plus className="w-4 h-4" /> إنشاء مجموعة</button>
            </form>
          )}
        </div>
        <div className="md:col-span-2 flex flex-col gap-3">
          {!detail && <div className="text-xs text-slate-400">اختر مجموعة لعرض شركاتها ومستخدميها</div>}
          {detail && (
            <>
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3" data-testid="group-detail">
                <div className="text-sm font-bold text-white">{detail.nameAr} ({detail.code})</div>
                <div className="text-xs text-slate-400 mt-1">دورك: {ROLE_AR[detail.myRole || ''] || detail.myRole}. كل شركة تحتفظ بمستودعاتها وحساباتها وقوائمها المالية.</div>
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 flex flex-col gap-2">
                <h4 className="text-xs font-bold text-white">الشركات ({detail.companies.length})</h4>
                {detail.companies.length === 0 && <div className="text-xs text-slate-400">لا توجد شركات في المجموعة بعد</div>}
                {detail.companies.map((c) => (
                  <div key={c.companyId} className="flex items-center justify-between text-xs text-slate-200 bg-slate-950 rounded-xl px-3 py-2" data-testid="group-company">
                    <span>{c.nameAr} ({c.code})</span>
                    {isPlatformAdmin && (
                      <button disabled={busy} onClick={() => act(() => call(`/api/groups/${detail.id}/companies/${c.companyId}`, 'DELETE'))} className="text-rose-400 cursor-pointer" aria-label="إزالة" data-testid="group-company-remove"><Trash2 className="w-4 h-4" /></button>
                    )}
                  </div>
                ))}
                {isPlatformAdmin && (
                  <div className="flex gap-2">
                    <select value={addCompanyId} onChange={(e) => setAddCompanyId(e.target.value)} className={inputCls} data-testid="group-add-company-select">
                      <option value="">اختر شركة للإضافة</option>
                      {free.map((c) => <option key={c.id} value={c.id}>{c.nameAr} ({c.code})</option>)}
                    </select>
                    <button disabled={busy || !addCompanyId} onClick={() => act(async () => { await call(`/api/groups/${detail.id}/companies`, 'POST', { companyId: addCompanyId }); setAddCompanyId(''); })} className={btnCls} data-testid="group-add-company">إضافة</button>
                  </div>
                )}
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 flex flex-col gap-2">
                <h4 className="text-xs font-bold text-white">مستخدمو المجموعة ({detail.users.length})</h4>
                {detail.users.map((u) => (
                  <div key={u.userId} className="flex items-center justify-between text-xs text-slate-200 bg-slate-950 rounded-xl px-3 py-2" data-testid="group-user">
                    <span>{u.username} - {ROLE_AR[u.role] || u.role}</span>
                    {canManageUsers && (
                      <button disabled={busy} onClick={() => act(() => call(`/api/groups/${detail.id}/users/${u.userId}`, 'DELETE'))} className="text-rose-400 cursor-pointer" aria-label="إزالة" data-testid="group-user-remove"><Trash2 className="w-4 h-4" /></button>
                    )}
                  </div>
                ))}
                {canManageUsers && (
                  <div className="flex gap-2 flex-wrap">
                    <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="اسم المستخدم" className={inputCls} data-testid="group-user-name" />
                    <select value={role} onChange={(e) => setRole(e.target.value)} className={inputCls} data-testid="group-user-role">
                      <option value="group_viewer">عرض فقط</option>
                      <option value="group_admin">مدير المجموعة</option>
                    </select>
                    <button disabled={busy || !username.trim()} onClick={() => act(async () => { await call(`/api/groups/${detail.id}/users`, 'POST', { username, role }); setUsername(''); })} className={btnCls} data-testid="group-user-add">إضافة مستخدم</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
