import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../../lib/apiClient.js';

interface Props { companyId: string; canWrite: boolean; isPlatformAdmin: boolean }
interface Framework { code: string; nameAr: string; nameEn: string; kind: string; countryCode: string | null }
interface Profile { id: string; frameworkCode: string; countryCode: string; validFrom: string; note: string | null }
interface Policy { id: string; policyKey: string; frameworkCode: string; countryCode: string | null; standardRef: string; version: number; validFrom: string | null; validTo: string | null; status: string; sourceReference: string | null; sourceVerified: boolean; value?: { title?: string | null; verificationStatus?: string | null; legalInForceDate?: string | null; legalInForceSource?: string | null } }

const VERIF_AR: Record<string, string> = { OPENED: 'تم فتح المصدر الرسمي', OFFICIAL_URL_EXCERPT_ONLY: 'رابط رسمي (مقتطف فقط)', SECONDARY_ONLY: 'مصدر ثانوي فقط', NOT_VERIFIED: 'غير موثق' };
const STATUS_AR: Record<string, string> = { DRAFT: 'مسودة (لا تُطبَّق)', ACTIVE: 'ساري', SUPERSEDED: 'مُستبدَل', RETIRED: 'ملغى' };

async function call(path: string, method = 'GET', body?: unknown) {
  const res = await apiFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'تعذر تنفيذ العملية');
  return data;
}

/** Accounting standards: the company's framework and country by effective date, and the versioned policy catalog. */
export function StandardsPanel({ companyId, canWrite, isPlatformAdmin }: Props) {
  const [fws, setFws] = useState<Framework[]>([]);
  const [current, setCurrent] = useState<Profile | null>(null);
  const [history, setHistory] = useState<Profile[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [fw, setFw] = useState('');
  const [country, setCountry] = useState('EG');
  const [from, setFrom] = useState('');
  const [pNote, setPNote] = useState('');
  const [pol, setPol] = useState({ policyKey: '', frameworkCode: '', countryCode: '', standardRef: '', validFrom: '', sourceReference: '', verified: false });
  const inputCls = 'px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500';
  const btnCls = 'px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold disabled:opacity-50';
  const q = encodeURIComponent(companyId);

  const load = useCallback(async () => {
    if (!companyId) return;
    setError(null);
    try {
      const [f, p, l] = await Promise.all([call('/api/standards/frameworks'), call(`/api/standards/profile?companyId=${q}`), call('/api/standards/policies')]);
      setFws(f.frameworks || []); setCurrent(p.current); setHistory(p.history || []); setPolicies(l.policies || []);
    } catch (e: any) { setError(e.message); }
  }, [companyId, q]);
  useEffect(() => { load(); }, [load]);

  const saveProfile = async () => {
    setError(null); setNote(null);
    try {
      await call('/api/standards/profile', 'PUT', { companyId, frameworkCode: fw, countryCode: country, validFrom: from, note: pNote });
      setNote('تم حفظ الإطار المحاسبي. السجل السابق يبقى كما هو.'); setFrom(''); setPNote(''); await load();
    } catch (e: any) { setError(e.message); }
  };
  const savePolicy = async () => {
    setError(null); setNote(null);
    try {
      await call('/api/standards/policies', 'POST', {
        policyKey: pol.policyKey, frameworkCode: pol.frameworkCode, countryCode: pol.countryCode || null, standardRef: pol.standardRef, validFrom: pol.validFrom,
        sourceReference: pol.sourceReference || null, sourceVerified: pol.verified, status: pol.verified && pol.sourceReference ? 'ACTIVE' : 'DRAFT',
      });
      setNote('تم إضافة إصدار السياسة.'); await load();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col gap-4" dir="rtl" data-testid="standards-panel">
      <h3 className="text-lg font-bold text-white">المعايير المحاسبية</h3>
      <p className="text-xs text-slate-400">الإطار المحاسبي ودولة الشركة بتاريخ سريان. السجلات تُضاف ولا تُعدَّل. السياسة المسودة لا تؤثر على أي قيد.</p>
      {error && <div className="text-xs text-red-400" data-testid="std-error">{error}</div>}
      {note && <div className="text-xs text-emerald-400" data-testid="std-note">{note}</div>}
      <div className="text-sm text-slate-200" data-testid="std-current">
        {current ? `الإطار الحالي: ${current.frameworkCode} (${current.countryCode}) منذ ${current.validFrom}` : 'لم يُحدَّد إطار محاسبي لهذه الشركة بعد'}
      </div>
      {canWrite && (
        <div className="flex flex-wrap gap-2 items-end">
          <select value={fw} onChange={(e) => setFw(e.target.value)} className={inputCls} data-testid="std-fw">
            <option value="">الإطار</option>
            {fws.map((f) => <option key={f.code} value={f.code}>{f.nameAr} ({f.code})</option>)}
          </select>
          <input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} maxLength={2} placeholder="EG" className={inputCls + ' w-16'} data-testid="std-country" />
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} data-testid="std-from" />
          <input value={pNote} onChange={(e) => setPNote(e.target.value)} placeholder="ملاحظة" className={inputCls} />
          <button onClick={saveProfile} disabled={!fw || !country || !from} className={btnCls} data-testid="std-save-profile">حفظ</button>
        </div>
      )}
      <table className="w-full text-xs text-slate-300" data-testid="std-history">
        <thead><tr className="text-slate-500"><th className="text-right">من تاريخ</th><th className="text-right">الإطار</th><th className="text-right">الدولة</th><th className="text-right">ملاحظة</th></tr></thead>
        <tbody>{history.map((h) => <tr key={h.id} data-testid="std-history-row"><td>{h.validFrom}</td><td>{h.frameworkCode}</td><td>{h.countryCode}</td><td>{h.note || ''}</td></tr>)}</tbody>
      </table>
      <h4 className="text-sm font-bold text-white">كتالوج السياسات (إصدارات بتواريخ سريان)</h4>
      <table className="w-full text-xs text-slate-300" data-testid="std-policies">
        <thead><tr className="text-slate-500"><th className="text-right">المفتاح</th><th className="text-right">المعيار</th><th className="text-right">الإطار</th><th className="text-right">إصدار</th><th className="text-right">من</th><th className="text-right">إلى</th><th className="text-right">الحالة</th><th className="text-right">حالة التوثيق</th><th className="text-right">المصدر</th></tr></thead>
        <tbody>
          {policies.length === 0 && <tr><td colSpan={9} className="text-slate-500">لا توجد سياسات مسجلة بعد</td></tr>}
          {policies.map((p) => (
            <tr key={p.id} data-testid="std-policy-row"><td>{p.policyKey}</td><td>{p.value?.title || p.standardRef}</td><td>{p.frameworkCode}{p.countryCode ? ` / ${p.countryCode}` : ''}</td><td>{p.version}</td><td>{p.validFrom || 'غير محدد'}{p.value?.legalInForceDate && <div className="text-amber-300" data-testid="std-legal-date">تاريخ النفاذ القانوني (ليس تاريخ تطبيق المعيار): {p.value.legalInForceDate}{p.value.legalInForceSource ? ` — ${p.value.legalInForceSource}` : ''}</div>}</td><td>{p.validTo || '-'}</td><td data-testid="std-policy-status">{STATUS_AR[p.status] || p.status}</td><td data-testid="std-policy-verif">{VERIF_AR[p.value?.verificationStatus || ''] || (p.sourceVerified ? 'موثق' : 'غير موثق')}</td><td>{p.sourceReference ? <a href={p.sourceReference} target="_blank" rel="noreferrer" className="text-indigo-300 underline">رابط</a> : '-'}</td></tr>
          ))}
        </tbody>
      </table>
      {isPlatformAdmin && (
        <div className="flex flex-wrap gap-2 items-end" data-testid="std-policy-form">
          <input value={pol.policyKey} onChange={(e) => setPol({ ...pol, policyKey: e.target.value })} placeholder="مفتاح السياسة" className={inputCls} data-testid="std-pol-key" />
          <select value={pol.frameworkCode} onChange={(e) => setPol({ ...pol, frameworkCode: e.target.value })} className={inputCls} data-testid="std-pol-fw">
            <option value="">الإطار</option>{fws.map((f) => <option key={f.code} value={f.code}>{f.code}</option>)}
          </select>
          <input value={pol.countryCode} onChange={(e) => setPol({ ...pol, countryCode: e.target.value.toUpperCase() })} maxLength={2} placeholder="دولة (اختياري)" className={inputCls + ' w-24'} />
          <input value={pol.standardRef} onChange={(e) => setPol({ ...pol, standardRef: e.target.value })} placeholder="المعيار مثل IAS 2" className={inputCls} data-testid="std-pol-ref" />
          <input type="date" value={pol.validFrom} onChange={(e) => setPol({ ...pol, validFrom: e.target.value })} className={inputCls} data-testid="std-pol-from" />
          <input value={pol.sourceReference} onChange={(e) => setPol({ ...pol, sourceReference: e.target.value })} placeholder="مرجع المصدر الرسمي" className={inputCls} />
          <label className="text-xs text-slate-300 flex items-center gap-1"><input type="checkbox" checked={pol.verified} onChange={(e) => setPol({ ...pol, verified: e.target.checked })} />تمت مراجعة المصدر</label>
          <button onClick={savePolicy} disabled={!pol.policyKey || !pol.frameworkCode || !pol.standardRef || !pol.validFrom} className={btnCls} data-testid="std-pol-save">إضافة إصدار</button>
        </div>
      )}
    </div>
  );
}
