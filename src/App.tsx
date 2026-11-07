import React, { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { LoginForm } from './components/LoginForm.js';
import { CompaniesPanel } from './components/CompaniesPanel.js';
import { AccountingWorkspace } from './components/accounting/AccountingWorkspace.js';
import { UsersAdminWorkspace } from './components/users/UsersAdminWorkspace.js';
import { AppSidebar } from './components/shell/AppSidebar.js';
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
  const [activeNav, setActiveNav] = useState<'companies' | 'accounting' | 'users'>('companies');

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

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center font-sans" dir="rtl">
        <div className="flex flex-col items-center gap-3 text-slate-400 text-sm">
          <RefreshCw className="w-6 h-6 animate-spin text-indigo-500" />
          <span>جاري التحقق من الجلسة...</span>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-6 font-sans" dir="rtl">
        <LoginForm onLoginSuccess={(user) => setCurrentUser(user)} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-row font-sans" dir="rtl">
      {/* Scrollable Right Sidebar */}
      <AppSidebar
        activeNav={activeNav}
        onNavigate={setActiveNav}
        userName={currentUser.username}
        userRole={currentUser.role}
        onLogout={handleLogout}
        loggingOut={loggingOut}
      />

      {/* Main Content Area */}
      <main className="flex-1 min-w-0 overflow-y-auto p-6 md:p-10 flex flex-col gap-6">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div>
            <h2 className="text-xl font-bold text-white">
              {activeNav === 'companies' ? 'الشركات' : activeNav === 'accounting' ? 'المحاسبة' : 'المستخدمون'}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {activeNav === 'companies' ? 'إدارة الشركات والمستأجرين' : activeNav === 'accounting' ? 'الدليل المحاسبي والقيود' : 'إدارة الحسابات وصلاحيات الوصول'}
            </p>
          </div>
          <div className="text-xs text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl">
            جلسة نشطة: <span className="text-emerald-400 font-semibold">{currentUser.username}</span>
          </div>
        </div>

        {activeNav === 'companies' ? (
          <CompaniesPanel userRole={currentUser.role} />
        ) : activeNav === 'accounting' ? (
          <AccountingWorkspace userRole={currentUser.role} />
        ) : (
          <UsersAdminWorkspace />
        )}
      </main>
    </div>
  );
}
