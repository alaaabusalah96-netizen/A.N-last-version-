import React, { useState, useEffect } from 'react';
import { Server, ShieldCheck, CheckCircle2, RefreshCw, Terminal, Layers, Database } from 'lucide-react';

interface HealthResponse {
  status: string;
  service: string;
  phase: string;
  time: string;
}

interface ReadyResponse {
  ready: boolean;
  database: string;
  engine: string | null;
  phase: string;
  detail?: string;
}

export default function App() {
  const [healthData, setHealthData] = useState<HealthResponse | null>(null);
  const [readyData, setReadyData] = useState<ReadyResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const [resHealth, resReady] = await Promise.all([
        fetch('/api/health'),
        fetch('/api/ready'),
      ]);

      if (resHealth.ok) {
        const hData: HealthResponse = await resHealth.json();
        setHealthData(hData);
      }
      if (resReady.ok) {
        const rData: ReadyResponse = await resReady.json();
        setReadyData(rData);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'فشل الاتصال بنقاط فحص الخادم');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans" dir="rtl">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <Layers className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">A.N ERP Platform</h1>
            <p className="text-xs text-slate-400">منصة تخطيط موارد المؤسسات المعيارية</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            P02a DB Foundation
          </span>
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
            <ShieldCheck className="w-3.5 h-3.5" />
            لا Firebase
          </span>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl w-full mx-auto p-6 md:p-10 flex flex-col gap-6 justify-center">
        {/* Banner Card */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-8 shadow-xl">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 pb-6 border-b border-slate-800/80">
            <div>
              <div className="inline-block px-2.5 py-1 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-xs font-mono mb-3">
                PACKAGE: P02a-DB-FOUNDATION-1
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">تأسيس طبقة البيانات المستقلة — لا Firebase</h2>
              <p className="text-slate-400 text-sm leading-relaxed max-w-xl">
                تم تأسيس عقود قواعد البيانات المحايدة (DbExecutor, DatabaseEngine)، ومحول PostgreSQL المرجعي، وسجل الاتصالات ConnectionRegistry ومحدد المستأجر TenantResolver بنجاح.
              </p>
            </div>
            <button
              onClick={fetchStatus}
              disabled={loading}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-60 text-white font-medium text-sm transition shadow-lg shadow-indigo-600/20 cursor-pointer self-start md:self-center"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              تحديث الفحص (/api/ready)
            </button>
          </div>

          {/* Details Grid */}
          <div className="pt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Health Info */}
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-5 font-mono text-xs text-slate-300 space-y-2.5">
              <div className="flex items-center justify-between border-b border-slate-800/50 pb-2">
                <span className="text-slate-500 flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                  Service Health:
                </span>
                <span className="text-indigo-300 font-semibold">{healthData?.service || 'an-erp-platform'}</span>
              </div>
              <div className="flex items-center justify-between border-b border-slate-800/50 pb-2">
                <span className="text-slate-500">Current Phase:</span>
                <span className="text-emerald-400 font-semibold">{healthData?.phase || 'P02a'}</span>
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-slate-500">Status:</span>
                <span className="text-emerald-400 font-semibold flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {healthData?.status || 'ok'}
                </span>
              </div>
            </div>

            {/* Ready / DB Info */}
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-5 font-mono text-xs text-slate-300 space-y-2.5">
              <div className="flex items-center justify-between border-b border-slate-800/50 pb-2">
                <span className="text-slate-500 flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-blue-400" />
                  Database Layer:
                </span>
                <span className="text-blue-300 font-semibold">
                  {readyData?.database === 'ok' ? 'Connected (PostgreSQL)' : 'Interfaces Ready (Optional URL)'}
                </span>
              </div>
              <div className="flex items-center justify-between border-b border-slate-800/50 pb-2">
                <span className="text-slate-500">Reference Engine:</span>
                <span className="text-slate-300 font-semibold">PostgreSQL (Adapter Loaded)</span>
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-slate-500">System Ready:</span>
                <span className="text-emerald-400 font-semibold flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {readyData?.ready ? 'Ready' : 'Initializing'}
                </span>
              </div>
            </div>
          </div>

          {error && (
            <div className="mt-4 bg-red-950/30 border border-red-800/50 rounded-xl p-4 text-red-300 text-sm">
              خطأ: {error}
            </div>
          )}
        </div>

        {/* Architectural Pillars */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-400">محول البيانات</p>
              <p className="text-sm font-semibold text-white">PostgresqlAdapter</p>
            </div>
          </div>

          <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-400">سجل وتوجيه القواعد</p>
              <p className="text-sm font-semibold text-white">Registry + Resolver</p>
            </div>
          </div>

          <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-400">عزل الشركات</p>
              <p className="text-sm font-semibold text-white">Multi-Tenant Isolation</p>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 py-4 px-6 text-center text-xs text-slate-500">
        A.N ERP Platform &bull; الإصدار الأول V1 &bull; الحزمة المعتمدة P02a
      </footer>
    </div>
  );
}
