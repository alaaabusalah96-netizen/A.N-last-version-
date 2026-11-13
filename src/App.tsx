import React, { useState, useEffect } from 'react';
import { RefreshCw, Menu } from 'lucide-react';
import { LoginForm } from './components/LoginForm.js';
import { CompaniesPanel } from './components/CompaniesPanel.js';
import { AccountingWorkspace } from './components/accounting/AccountingWorkspace.js';
import { InventoryWorkspace } from './components/inventory/InventoryWorkspace.js';
import { PurchasingWorkspace } from './components/purchasing/PurchasingWorkspace.js';
import { UsersAdminWorkspace } from './components/users/UsersAdminWorkspace.js';
import { CompanySettingsPanel } from './components/companies/CompanySettingsPanel.js';
import { OrgUnitsPanel } from './components/org/OrgUnitsPanel.js';
import { ConfigPlatformPanel } from './components/config/ConfigPlatformPanel.js';
import { ConfigDefinitionsPanel } from './components/config/ConfigDefinitionsPanel.js';
import { RolesPanel } from './components/rbac/RolesPanel.js';
import { CustomFieldsPanel } from './components/customization/CustomFieldsPanel.js';
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
  const [activeNav, setActiveNav] = useState<'companies' | 'accounting' | 'inventory' | 'purchasing' | 'users' | 'roles' | 'company_settings' | 'custom_fields' | 'org_units' | 'config_platform' | 'config_definitions'>('companies');
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.matchMedia('(min-width: 1024px)').matches;
  });

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

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (e: MediaQueryListEvent) => {
      setSidebarOpen(e.matches);
    };
    setSidebarOpen(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const handleNavigate = (nav: typeof activeNav) => {
    setActiveNav(nav);
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches) {
      setSidebarOpen(false);
    }
  };

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
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-row font-sans overflow-x-hidden" dir="rtl">
      {/* Scrollable Right Sidebar */}
      <AppSidebar
        activeNav={activeNav}
        onNavigate={handleNavigate}
        userName={currentUser.username}
        userRole={currentUser.role}
        onLogout={handleLogout}
        loggingOut={loggingOut}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main Content Area */}
      <main className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6 md:p-10 flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3 min-w-0">
            {!sidebarOpen && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label="فتح القائمة"
                className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800 transition cursor-pointer shrink-0"
              >
                <Menu className="w-5 h-5" />
              </button>
            )}
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-white truncate">
              {activeNav === 'companies'
                ? 'الشركات'
                : activeNav === 'accounting'
                ? 'المحاسبة'
                : activeNav === 'inventory'
                ? 'المخزون'
                : activeNav === 'purchasing'
                ? 'المشتريات'
                : activeNav === 'users'
                ? 'المستخدمون'
                : activeNav === 'roles'
                ? 'الأدوار والصلاحيات'
                : activeNav === 'org_units'
                ? 'الوحدات التنظيمية'
                : activeNav === 'config_platform'
                ? 'منصة الإعدادات'
                : activeNav === 'config_definitions'
                ? 'تعريفات الإعدادات'
                : activeNav === 'custom_fields'
                ? 'الحقول الإضافية'
                : 'إعدادات الشركة'}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {activeNav === 'companies'
                ? 'إدارة الشركات والمستأجرين'
                : activeNav === 'accounting'
                ? 'الدليل المحاسبي والقيود'
                : activeNav === 'inventory'
                ? 'المستودعات والأصناف والأرصدة والحركات'
                : activeNav === 'purchasing'
                ? 'الموردون وسندات استلام البضائع GRN'
                : activeNav === 'users'
                ? 'إدارة الحسابات وصلاحيات الوصول'
                : activeNav === 'roles'
                ? 'إدارة أدوار الشركة ومصفوفة الصلاحيات'
                : activeNav === 'org_units'
                ? 'الفروع والإدارات ومراكز التكلفة'
                : activeNav === 'config_platform'
                ? 'تعريفات الإعداد المركزي والمسودات والنشر والإصدارات'
                : activeNav === 'config_definitions'
                ? 'إدارة كتالوج نقط التكييف والمخططات والقيود على مستوى المنصة'
                : activeNav === 'custom_fields'
                ? 'تعريف الحقول الإضافية وترتيبها وإلزاميتها للأصناف'
                : 'الإعدادات التشغيلية والمالية للشركة'}
              </p>
            </div>
          </div>
          <div className="text-xs text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl shrink-0">
            جلسة نشطة: <span className="text-emerald-400 font-semibold">{currentUser.username}</span>
          </div>
        </div>

        {activeNav === 'companies' ? (
          <CompaniesPanel userRole={currentUser.role} />
        ) : activeNav === 'accounting' ? (
          <AccountingWorkspace userRole={currentUser.role} />
        ) : activeNav === 'inventory' ? (
          <InventoryWorkspace userRole={currentUser.role} />
        ) : activeNav === 'purchasing' ? (
          <PurchasingWorkspace userRole={currentUser.role} />
        ) : activeNav === 'users' ? (
          <UsersAdminWorkspace />
        ) : activeNav === 'roles' ? (
          <RolesPanel userRole={currentUser.role} />
        ) : activeNav === 'org_units' ? (
          <OrgUnitsPanel userRole={currentUser.role} />
        ) : activeNav === 'config_platform' ? (
          <ConfigPlatformPanel userRole={currentUser.role} />
        ) : activeNav === 'config_definitions' ? (
          <ConfigDefinitionsPanel userRole={currentUser.role} />
        ) : activeNav === 'custom_fields' ? (
          <CustomFieldsPanel />
        ) : (
          <CompanySettingsPanel userRole={currentUser.role} />
        )}
      </main>
    </div>
  );
}
