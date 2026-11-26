import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/apiClient.js';
import { AccountOption, usableAccounts } from '../../lib/accountRules.js';

interface CoreMappingCardProps {
  companyId: string;
}

const FIELDS: Array<{ key: string; rule: string; labelAr: string; hintAr: string }> = [
  { key: 'cogsAccountId', rule: 'cogs_account_id', labelAr: 'حساب تكلفة البضاعة المباعة', hintAr: 'مطلوب لترحيل فواتير البيع المرتبطة بتسليم مخزني (مصروف)' },
  { key: 'inventoryAccountId', rule: 'inventory_account_id', labelAr: 'حساب المخزون', hintAr: 'مطلوب لترحيل تكلفة البضاعة المباعة والاستلام (أصل)' },
];

/** Core account mapping (COGS + inventory). Saved through PUT /settings/mapping, gated by accounting.mapping.write. */
export function CoreMappingCard({ companyId }: CoreMappingCardProps) {
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [canWrite, setCanWrite] = useState<boolean>(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    setError(null);
    setSuccess(null);
    try {
      const [accRes, setRes, meRes] = await Promise.all([
        apiFetch(`/api/accounting/accounts?companyId=${encodeURIComponent(companyId)}`),
        apiFetch(`/api/companies/${companyId}/settings`),
        apiFetch('/api/auth/me'),
      ]);
      if (accRes.ok) {
        const d = await accRes.json();
        setAccounts(Array.isArray(d.accounts) ? d.accounts : Array.isArray(d) ? d : []);
      }
      if (setRes.ok) {
        const d = await setRes.json();
        const s = d.settings || {};
        setValues({ cogsAccountId: s.cogsAccountId || '', inventoryAccountId: s.inventoryAccountId || '' });
      }
      if (meRes.ok) {
        const d = await meRes.json();
        const perms: string[] = Array.isArray(d.permissions) ? d.permissions : [];
        setCanWrite(perms.includes('accounting.mapping.write'));
      }
    } catch {
      setError('تعذر تحميل إعدادات الربط الأساسي. أعد المحاولة.');
    }
  }, [companyId]);

  useEffect(() => {
    setValues({});
    setAccounts([]);
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const body: Record<string, string | null> = {};
      for (const f of FIELDS) body[f.key] = values[f.key] || null;
      const res = await apiFetch(`/api/companies/${companyId}/settings/mapping`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || data.error || 'تعذر حفظ الربط');
        return;
      }
      setSuccess('تم حفظ الربط الأساسي للشركة.');
    } catch {
      setError('تعذر الاتصال بالخادم أثناء الحفظ.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 flex flex-col gap-4" data-testid="core-mapping-card">
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-bold text-white">الربط الأساسي: المخزون وتكلفة البضاعة المباعة</h4>
        <p className="text-[11px] text-slate-400">بدون حساب تكلفة البضاعة المباعة لا يمكن ترحيل فاتورة بيع مرتبطة بتسليم.</p>
      </div>
      {error && <div role="alert" className="p-3 rounded-xl text-xs bg-red-950/40 border border-red-800/60 text-red-300">{error}</div>}
      {success && <div role="status" className="p-3 rounded-xl text-xs bg-emerald-950/40 border border-emerald-800/60 text-emerald-300">{success}</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {FIELDS.map((f) => {
          const eligible = usableAccounts(accounts, f.rule);
          return (
            <div key={f.key} className="bg-slate-950/70 border border-slate-800 rounded-xl p-4 flex flex-col gap-2">
              <label className="text-xs font-bold text-slate-200">{f.labelAr}</label>
              <select
                value={values[f.key] || ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                disabled={!canWrite || saving}
                className="bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2.5 disabled:opacity-60"
              >
                <option value="">— غير محدد —</option>
                {eligible.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} - {a.nameAr}</option>
                ))}
              </select>
              <span className="text-[10px] text-slate-400">{f.hintAr}</span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!canWrite || saving}
          className="self-start px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold cursor-pointer"
        >
          {saving ? 'جاري الحفظ...' : 'حفظ الربط الأساسي'}
        </button>
        {!canWrite && (
          <p className="text-[11px] text-amber-300">الحفظ معطل لأن حسابك لا يملك صلاحية «ضبط الربط المحاسبي» (accounting.mapping.write). اطلبها من مدير الشركة.</p>
        )}
      </div>
    </div>
  );
}
