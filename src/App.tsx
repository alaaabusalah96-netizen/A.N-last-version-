import React, { useState, useEffect } from 'react';
import { Server, ShieldCheck, CheckCircle2, RefreshCw, Terminal, Layers } from 'lucide-react';

interface HealthResponse {
  status: string;
  service: string;
  phase: string;
  time: string;
}

export default function App() {
  const [healthData, setHealthData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/health');
      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status}`);
      }
      const data: HealthResponse = await response.json();
      setHealthData(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'فشل الاتصال بنقطة الفحص');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
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
            P01 Scaffold
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
                PACKAGE: P01-PLATFORM-SCAFFOLD-1
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">النظام قيد التأسيس — لا Firebase</h2>
              <p className="text-slate-400 text-sm leading-relaxed max-w-xl">
                تم تثبيت سقالة المنصة الأساسية بنجاح: خادم Express مستقل، واجهة React + TypeScript مع Vite، وعزل تام للبيئة عن أي خدمات خارجية مغلقة.
              </p>
            </div>
            <button
              onClick={fetchHealth}
              disabled={loading}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-60 text-white font-medium text-sm transition shadow-lg shadow-indigo-600/20 cursor-pointer self-start md:self-center"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              فحص حالة الخادم (/api/health)
            </button>
          </div>

          {/* Health Details Block */}
          <div className="pt-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                <Terminal className="w-4 h-4 text-slate-500" />
                استجابة الخادم المباشرة
              </span>
              <span className="text-xs text-slate-500 font-mono">GET /api/health</span>
            </div>

            {loading && !healthData && (
              <div className="bg-slate-950 rounded-xl p-5 border border-slate-800 text-center text-slate-400 text-sm">
                جاري استدعاء نقطة الفحص...
              </div>
            )}

            {error && (
              <div className="bg-red-950/30 border border-red-800/50 rounded-xl p-4 text-red-300 text-sm">
                خطأ: {error}
              </div>
            )}

            {healthData && (
              <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-5 font-mono text-xs text-slate-300 space-y-2">
                <div className="flex items-center justify-between border-b border-slate-800/50 pb-2">
                  <span className="text-slate-500">Service:</span>
                  <span className="text-indigo-300 font-semibold">{healthData.service}</span>
                </div>
                <div className="flex items-center justify-between border-b border-slate-800/50 pb-2">
                  <span className="text-slate-500">Phase:</span>
                  <span className="text-emerald-400 font-semibold">{healthData.phase}</span>
                </div>
                <div className="flex items-center justify-between border-b border-slate-800/50 pb-2">
                  <span className="text-slate-500">Status:</span>
                  <span className="text-emerald-400 font-semibold flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {healthData.status}
                  </span>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-slate-500">Server Time:</span>
                  <span className="text-slate-400">{healthData.time}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Status Indicators */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-400">الخادم والهيكل</p>
              <p className="text-sm font-semibold text-white">Modular Express + Vite</p>
            </div>
          </div>

          <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-400">قاعدة البيانات</p>
              <p className="text-sm font-semibold text-white">مؤجلة لحزمة P02a</p>
            </div>
          </div>

          <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-400">نظام الهوية</p>
              <p className="text-sm font-semibold text-white">مستقل ذاتيًا (P03)</p>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 py-4 px-6 text-center text-xs text-slate-500">
        A.N ERP Platform &bull; الإصدار الأول V1 &bull; الحزمة الحالية P01
      </footer>
    </div>
  );
}
