import React, { useState, useEffect } from 'react';
import { ShieldCheck, LogOut, Layers, CheckCircle2, User, Key, RefreshCw, Building2, BookOpen } from 'lucide-react';
import { LoginForm } from './components/LoginForm.js';
import { CompaniesPanel } from './components/CompaniesPanel.js';
import { AccountingWorkspace } from './components/accounting/AccountingWorkspace.js';
import { apiFetch } from './lib/apiClient.js';

interface AuthUser {
  id: string;
  username: string;
  role: string;
  companyId?: string | null;
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [activeNav, setActiveNav] = useState<'companies' | 'accounting'>('companies');

  // Check existing session via GET /api/auth/me
  const checkCurrentSession = async () => {
    try {
      const res = await apiFetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        setCurrentUser(data.user);
      } else {
        setCurrentUser(null);
      }
    } catch {
      setCurrentUser(null);
    } finally {
      setCheckingAuth(false);
    }
  };

  useEffect(() => {
    checkCurrentSession();
  }, []);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await apiFetch('/api/auth/logout', {
        method: 'POST',
      });
      setCurrentUser(null);
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans" dir="rtl">
      {/* Top Header */}
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
            AN Foundation Repair
          </span>
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
            <ShieldCheck className="w-3.5 h-3.5" />
            لا Firebase
          </span>
        </div>
      </header>

      {/* Main Body */}
      <main className="flex-1 max-w-4xl w-full mx-auto p-6 md:p-10 flex flex-col justify-center items-center">
        {checkingAuth ? (
          <div className="flex flex-col items-center gap-3 text-slate-400 text-sm">
            <RefreshCw className="w-6 h-6 animate-spin text-indigo-500" />
            <span>جاري التحقق من الجلسة...</span>
          </div>
        ) : currentUser ? (
          <div className="w-full flex flex-col gap-6">
            {/* Authenticated Dashboard Header */}
            <div className="w-full bg-slate-900/80 border border-slate-800 rounded-2xl p-6 md:p-8 shadow-2xl">
              <div className="flex items-center justify-between pb-6 border-b border-slate-800">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                    <User className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        مسجّل الدخول
                      </span>
                      <span className="text-xs text-slate-500 font-mono">ID: {currentUser.id.slice(0, 8)}...</span>
                    </div>
                    <h2 className="text-xl font-bold text-white mt-1">{currentUser.username}</h2>
                  </div>
                </div>

                <button
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800 hover:bg-red-950/40 hover:text-red-400 border border-slate-700 text-slate-300 text-sm font-medium transition cursor-pointer"
                >
                  <LogOut className="w-4 h-4" />
                  <span>تسجيل الخروج</span>
                </button>
              </div>

              {/* Primary App Module Navigation Bar */}
              <div className="pt-6 flex items-center gap-3">
                <button
                  onClick={() => setActiveNav('companies')}
                  className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                    activeNav === 'companies'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25 border border-indigo-500/40'
                      : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                  }`}
                >
                  <Building2 className="w-4 h-4" />
                  <span>إدارة الشركات</span>
                </button>

                <button
                  onClick={() => setActiveNav('accounting')}
                  className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                    activeNav === 'accounting'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25 border border-indigo-500/40'
                      : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                  }`}
                >
                  <BookOpen className="w-4 h-4" />
                  <span>المحاسبة</span>
                </button>
              </div>
            </div>

            {/* Selected Module View */}
            {activeNav === 'companies' ? (
              <CompaniesPanel userRole={currentUser.role} />
            ) : (
              <AccountingWorkspace />
            )}
          </div>
        ) : (
          /* Login Form View */
          <LoginForm onLoginSuccess={(user) => setCurrentUser(user)} />
        )}
      </main>


      {/* Footer */}
      <footer className="border-t border-slate-800/80 py-4 px-6 text-center text-xs text-slate-500">
        A.N ERP Platform &bull; الإصدار الأول V1
      </footer>
    </div>
  );
}
