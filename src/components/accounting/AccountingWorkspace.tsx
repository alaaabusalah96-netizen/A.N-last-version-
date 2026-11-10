import React, { useState, useEffect } from 'react';
import { Building2, BookOpen, FileText, AlertCircle, RefreshCw, Layers, Scale, Calendar } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import { AccountsPanel } from './AccountsPanel.js';
import { JournalWorkspace } from './JournalWorkspace.js';
import { TrialBalancePanel } from './TrialBalancePanel.js';
import { PeriodsPanel } from './PeriodsPanel.js';

interface Company {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
}

interface AccountingWorkspaceProps {
  userRole?: string;
}

export function AccountingWorkspace({ userRole }: AccountingWorkspaceProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [loadingCompanies, setLoadingCompanies] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'coa' | 'journal' | 'tb' | 'periods'>('coa');

  const canWrite = userRole === 'platform_admin' || userRole === 'company_admin';

  useEffect(() => {
    async function loadCompanies() {
      setLoadingCompanies(true);
      setError(null);
      try {
        const res = await apiFetch('/api/companies');
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.message || data.error || 'تعذر تحميل قائمة الشركات المتاحة');
        }
        const data = await res.json();
        const list: Company[] = data.companies || [];
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
    loadCompanies();
  }, []);

  return (
    <div className="w-full flex flex-col gap-6" dir="rtl">
      {/* Top Workspace Bar */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl backdrop-blur-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Layers className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">النظام المحاسبي الرئيسي (Accounting Core)</h2>
              <p className="text-xs text-slate-400">إدارة دليل الحسابات المالي والشجرة المحاسبية وميزان المراجعة لكل شركة معزولة</p>
            </div>
          </div>

          {/* Company Selector Dropdown */}
          <div className="flex items-center gap-3">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5 shrink-0">
              <Building2 className="w-4 h-4 text-indigo-400" />
              الشركة المختارة:
            </label>
            {loadingCompanies ? (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>جاري تحميل الشركات...</span>
              </div>
            ) : (
              <select
                value={selectedCompanyId}
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                className="px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-semibold text-white focus:outline-none focus:border-indigo-500 transition min-w-[200px]"
              >
                {companies.length === 0 ? (
                  <option value="">لا توجد شركات متاحة</option>
                ) : (
                  companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nameAr} ({c.code})
                    </option>
                  ))
                )}
              </select>
            )}
          </div>
        </div>

        {/* Workspace Navigation Tabs */}
        {selectedCompanyId && (
          <div className="flex items-center gap-2 mt-6 pt-4 border-t border-slate-800/80">
            <button
              onClick={() => setActiveTab('coa')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                activeTab === 'coa'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                  : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              <BookOpen className="w-4 h-4" />
              <span>دليل الحسابات (Chart of Accounts)</span>
            </button>

            <button
              onClick={() => setActiveTab('journal')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                activeTab === 'journal'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                  : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              <FileText className="w-4 h-4" />
              <span>دفتر اليومية العامة (Journal Entries)</span>
            </button>

            <button
              onClick={() => setActiveTab('tb')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                activeTab === 'tb'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                  : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              <Scale className="w-4 h-4" />
              <span>ميزان المراجعة (Trial Balance)</span>
            </button>

            <button
              onClick={() => setActiveTab('periods')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
                activeTab === 'periods'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                  : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              <Calendar className="w-4 h-4" />
              <span>الفترات المالية (Accounting Periods)</span>
            </button>
          </div>
        )}
      </div>

      {/* Error Message */}
      {error && (
        <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      {/* Main Tab Content */}
      {!selectedCompanyId && !loadingCompanies ? (
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-12 text-center flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <Building2 className="w-6 h-6" />
          </div>
          <h3 className="text-base font-bold text-white">يرجى اختيار أو إنشاء شركة أولاً</h3>
          <p className="text-xs text-slate-400 max-w-md">
            النظام المحاسبي يعتمد على العزل التام للشركات. اختر شركة من قائمة الشركات أعلاه أو أنشئ شركة جديدة لبدء إدارة دليل الحسابات.
          </p>
        </div>
      ) : activeTab === 'coa' ? (
        <AccountsPanel companyId={selectedCompanyId} canCreate={canWrite} canSeed={canWrite} />
      ) : activeTab === 'journal' ? (
        <JournalWorkspace
          companyId={selectedCompanyId}
          canWrite={canWrite}
          canPost={userRole === 'platform_admin' || userRole === 'company_admin'}
        />
      ) : activeTab === 'tb' ? (
        <TrialBalancePanel companyId={selectedCompanyId} />
      ) : (
        <PeriodsPanel companyId={selectedCompanyId} canManage={canWrite} />
      )}
    </div>
  );
}

