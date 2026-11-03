import React, { useState, useEffect } from 'react';
import { Building2, Plus, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';
import { apiFetch } from '../lib/apiClient.js';

export interface CompanyItem {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string;
  isActive: boolean;
  createdAt: string;
}

interface CompaniesPanelProps {
  userRole: string;
}

export function CompaniesPanel({ userRole }: CompaniesPanelProps) {
  const [companies, setCompanies] = useState<CompanyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New company form state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isPlatformAdmin = userRole === 'platform_admin';

  const fetchCompanies = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/companies');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setCompanies(data.companies || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'فشل جلب قائمة الشركات');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCompanies();
  }, []);

  const handleCreateCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);

    try {
      const res = await apiFetch('/api/companies', {
        method: 'POST',
        body: JSON.stringify({
          code: code.trim(),
          nameAr: nameAr.trim(),
          nameEn: nameEn.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'فشل إنشاء الشركة');
      }

      setCode('');
      setNameAr('');
      setNameEn('');
      setShowCreateModal(false);
      fetchCompanies();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'خطأ أثناء الإنشاء');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <Building2 className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white">إدارة الشركات والمستأجرين</h3>
            <p className="text-xs text-slate-400">عزل سياق الشركات والأدوار (P04 Org RBAC)</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchCompanies}
            disabled={loading}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition cursor-pointer"
            title="تحديث"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {isPlatformAdmin && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition shadow-md shadow-indigo-600/20 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>إضافة شركة جديدة</span>
            </button>
          )}
        </div>
      </div>

      {/* Errors */}
      {error && (
        <div className="mt-4 p-3 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      {/* Companies List */}
      <div className="mt-5">
        {loading && companies.length === 0 ? (
          <div className="text-center py-8 text-slate-500 text-xs font-mono">
            جاري استرجاع الشركات المصرح بها...
          </div>
        ) : companies.length === 0 ? (
          <div className="text-center py-8 border border-dashed border-slate-800 rounded-xl text-slate-500 text-xs">
            لا توجد شركات مسجلة حتى الآن.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {companies.map((comp) => (
              <div
                key={comp.id}
                className="bg-slate-950/70 border border-slate-800 rounded-xl p-4 flex items-start justify-between gap-3 hover:border-slate-700 transition"
              >
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                      {comp.code}
                    </span>
                    <span className="text-sm font-semibold text-white">{comp.nameAr}</span>
                  </div>
                  {comp.nameEn && <p className="text-xs text-slate-400">{comp.nameEn}</p>}
                </div>

                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <CheckCircle2 className="w-3 h-3" />
                  نشطة
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Company Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
            <h4 className="text-base font-bold text-white mb-4">إنشاء شركة / مستأجر جديد</h4>

            {formError && (
              <div className="mb-4 p-3 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs">
                {formError}
              </div>
            )}

            <form onSubmit={handleCreateCompany} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">رمز الشركة (Code)</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. COMP01"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">الاسم بالعربية</label>
                <input
                  type="text"
                  required
                  placeholder="شركة التقنية المتقدمة"
                  value={nameAr}
                  onChange={(e) => setNameAr(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">الاسم بالإنجليزية (اختياري)</label>
                <input
                  type="text"
                  placeholder="Advanced Tech Co"
                  value={nameEn}
                  onChange={(e) => setNameEn(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-medium hover:bg-slate-700 transition cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium transition cursor-pointer"
                >
                  {submitting ? 'جاري الحفظ...' : 'حفظ وإنشاء'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
