import { canAccessNav } from './lib/navAccess.js';
import React, { useState, useEffect, Suspense, lazy } from 'react';
import { RefreshCw, Menu } from 'lucide-react';
import { LoginForm } from './components/LoginForm.js';
import { AppSidebar } from './components/shell/AppSidebar.js';
import { LoadingState } from './components/ui/LoadingState.js';
import { WorkspaceErrorBoundary } from './components/WorkspaceErrorBoundary.js';
import { apiFetch } from './lib/apiClient.js';

const CompaniesPanel = lazy(() =>
  import('./components/CompaniesPanel.js').then((m) => ({ default: m.CompaniesPanel }))
);
const AccountingWorkspace = lazy(() =>
  import('./components/accounting/AccountingWorkspace.js').then((m) => ({
    default: m.AccountingWorkspace,
  }))
);
const InventoryWorkspace = lazy(() =>
  import('./components/inventory/InventoryWorkspace.js').then((m) => ({
    default: m.InventoryWorkspace,
  }))
);
const PurchasingWorkspace = lazy(() =>
  import('./components/purchasing/PurchasingWorkspace.js').then((m) => ({
    default: m.PurchasingWorkspace,
  }))
);
const SalesWorkspace = lazy(() =>
  import('./components/sales/SalesWorkspace.js').then((m) => ({ default: m.SalesWorkspace }))
);
const FleetWorkspace = lazy(() =>
  import('./components/fleet/FleetWorkspace.js').then((m) => ({
    default: m.FleetWorkspace,
  }))
);
const CashCustodyWorkspace = lazy(() =>
  import('./components/cash/CashCustodyWorkspace.js').then((m) => ({
    default: m.CashCustodyWorkspace,
  }))
);
const UsersAdminWorkspace = lazy(() =>
  import('./components/users/UsersAdminWorkspace.js').then((m) => ({
    default: m.UsersAdminWorkspace,
  }))
);
const CompanySettingsPanel = lazy(() =>
  import('./components/companies/CompanySettingsPanel.js').then((m) => ({
    default: m.CompanySettingsPanel,
  }))
);
const CompanyGroupsPanel = lazy(() =>
  import('./components/org/CompanyGroupsPanel.js').then((m) => ({ default: m.CompanyGroupsPanel }))
);
const OrgUnitsPanel = lazy(() =>
  import('./components/org/OrgUnitsPanel.js').then((m) => ({ default: m.OrgUnitsPanel }))
);
const ConfigPlatformPanel = lazy(() =>
  import('./components/config/ConfigPlatformPanel.js').then((m) => ({
    default: m.ConfigPlatformPanel,
  }))
);
const ConfigDefinitionsPanel = lazy(() =>
  import('./components/config/ConfigDefinitionsPanel.js').then((m) => ({
    default: m.ConfigDefinitionsPanel,
  }))
);
const RolesPanel = lazy(() =>
  import('./components/rbac/RolesPanel.js').then((m) => ({ default: m.RolesPanel }))
);
const CustomFieldsPanel = lazy(() =>
  import('./components/customization/CustomFieldsPanel.js').then((m) => ({
    default: m.CustomFieldsPanel,
  }))
);

interface AuthUser {
  id: string;
  username: string;
  role: string;
  companyId?: string | null;
  permissions?: string[];
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [activeNav, setActiveNav] = useState<'companies' | 'accounting' | 'inventory' | 'purchasing' | 'sales' | 'cash' | 'fleet' | 'users' | 'roles' | 'company_settings' | 'custom_fields' | 'org_units' | 'groups' | 'config_platform' | 'config_definitions'>('companies');
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
        // The sign-in role of a company user is 'user'. Show the company role the user holds.
        const baseRole = (data.user || {}).role;
        const isCompanyAdmin =
          baseRole !== 'platform_admin' &&
          Array.isArray(data.memberships) &&
          data.memberships.some((m: any) => m && m.isActive !== false && m.role === 'company_admin');
        const perms: string[] = Array.isArray(data.permissions) ? [...data.permissions] : [];
        // A user who belongs to a company group can open the groups screen even without company:read.
        try {
          const gRes = await apiFetch('/api/groups');
          if (gRes.ok) {
            const gData = await gRes.json();
            if (Array.isArray(gData.groups) && gData.groups.length > 0) perms.push('group:view');
          }
        } catch { /* groups are optional */ }
        setCurrentUser({
          ...(data.user || {}),
          role: isCompanyAdmin ? 'company_admin' : baseRole,
          permissions: perms,
        });
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

  // A user must never sit on a section the menu hides from them: move to the first allowed one.
  useEffect(() => {
    if (!currentUser) return;
    if (canAccessNav(activeNav, currentUser.role, currentUser.permissions)) return;
    const order: Array<typeof activeNav> = ['companies', 'accounting', 'inventory', 'purchasing', 'sales', 'cash', 'fleet', 'users', 'roles', 'org_units', 'groups', 'company_settings', 'custom_fields'];
    const first = order.find((k) => canAccessNav(k, currentUser.role, currentUser.permissions));
    if (first) setActiveNav(first);
  }, [currentUser, activeNav]);

  const noSectionAllowed =
    !!currentUser &&
    !(['companies', 'accounting', 'inventory', 'purchasing', 'sales', 'cash', 'fleet', 'users', 'roles', 'org_units', 'groups', 'company_settings', 'custom_fields'] as const).some((k) =>
      canAccessNav(k, currentUser.role, currentUser.permissions)
    );

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
        <LoginForm
          onLoginSuccess={(user) => {
            setCurrentUser(user);
            checkCurrentSession();
          }}
        />
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
        permissions={currentUser.permissions || []}
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
                : activeNav === 'sales'
                ? 'المبيعات'
                : activeNav === 'cash'
                ? 'الخزينة والعهد'
                : activeNav === 'fleet'
                ? 'الأسطول'
                : activeNav === 'users'
                ? 'المستخدمون'
                : activeNav === 'roles'
                ? 'الأدوار والصلاحيات'
                : activeNav === 'groups'
                ? 'مجموعة الشركات'
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
                : activeNav === 'sales'
                ? 'العملاء وأذون التسليم وفواتير المبيعات والتحصيل وأعمار الديون'
                : activeNav === 'cash'
                ? 'إدارة الصناديق النقدية وعهد الموظفين والأرصدة المفتوحة'
                : activeNav === 'fleet'
                ? 'المركبات والسائقون وحالتهم'
                : activeNav === 'users'
                ? 'إدارة الحسابات وصلاحيات الوصول'
                : activeNav === 'roles'
                ? 'إدارة أدوار الشركة ومصفوفة الصلاحيات'
                : activeNav === 'groups'
                ? 'ربط عدة شركات في مجموعة وصلاحيات مستوى المجموعة'
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

        <WorkspaceErrorBoundary resetKey={activeNav}>
          <Suspense
            fallback={
              <LoadingState
                label="جاري التحميل..."
                rows={0}
                className="flex-1 min-h-[240px] bg-slate-950"
              />
            }
          >
            {noSectionAllowed ? (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 text-sm text-amber-100" data-testid="no-permissions">
                حسابك لا يملك أي صلاحية على أقسام النظام حتى الآن. اطلب من مدير الشركة منحك دورًا مناسبًا ثم سجّل الدخول من جديد.
              </div>
            ) : activeNav === 'companies' ? (
              <CompaniesPanel userRole={currentUser.role} />
            ) : activeNav === 'accounting' ? (
              <AccountingWorkspace userRole={currentUser.role} permissions={currentUser.permissions || []} />
            ) : activeNav === 'inventory' ? (
              <InventoryWorkspace userRole={currentUser.role} permissions={currentUser.permissions || []} />
            ) : activeNav === 'purchasing' ? (
              <PurchasingWorkspace userRole={currentUser.role} />
            ) : activeNav === 'sales' ? (
              <SalesWorkspace userRole={currentUser.role} />
            ) : activeNav === 'cash' ? (
              <CashCustodyWorkspace userRole={currentUser.role} permissions={currentUser.permissions || []} />
            ) : activeNav === 'fleet' ? (
              <FleetWorkspace userRole={currentUser.role} permissions={currentUser.permissions || []} />
            ) : activeNav === 'users' ? (
              <UsersAdminWorkspace userRole={currentUser.role} />
            ) : activeNav === 'roles' ? (
              <RolesPanel userRole={currentUser.role} />
            ) : activeNav === 'groups' ? (
              <CompanyGroupsPanel userRole={currentUser.role} />
            ) : activeNav === 'org_units' ? (
              <OrgUnitsPanel userRole={currentUser.role} />
            ) : activeNav === 'config_platform' ? (
              <ConfigPlatformPanel userRole={currentUser.role} />
            ) : activeNav === 'config_definitions' ? (
              <ConfigDefinitionsPanel userRole={currentUser.role} />
            ) : activeNav === 'custom_fields' ? (
              <CustomFieldsPanel />
            ) : (
              <CompanySettingsPanel userRole={currentUser.role} permissions={currentUser.permissions || []} />
            )}
          </Suspense>
        </WorkspaceErrorBoundary>
      </main>
    </div>
  );
}
