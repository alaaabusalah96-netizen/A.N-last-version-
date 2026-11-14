import { Building2, BookOpen, LogOut, Layers, UserCheck, Users, Settings, Network, Boxes, ShoppingBag, Wallet, SlidersHorizontal, Shield, Sliders, X } from 'lucide-react';
import { displayRoleLabel } from './roleLabels.js';

type NavKey =
  | 'companies'
  | 'accounting'
  | 'inventory'
  | 'purchasing'
  | 'cash'
  | 'users'
  | 'roles'
  | 'company_settings'
  | 'custom_fields'
  | 'org_units'
  | 'config_platform'
  | 'config_definitions';

interface AppSidebarProps {
  activeNav: NavKey;
  onNavigate: (nav: NavKey) => void;
  userName: string;
  userRole: string;
  permissions?: string[];
  onLogout: () => void;
  loggingOut?: boolean;
  isOpen?: boolean;
  onClose?: () => void;
}

export function AppSidebar({
  activeNav,
  onNavigate,
  userName,
  userRole,
  permissions = [],
  onLogout,
  loggingOut,
  isOpen = true,
  onClose,
}: AppSidebarProps) {
  return (
    <>
      {isOpen && (
        <div
          data-sidebar-backdrop="true"
          onClick={onClose}
          aria-hidden="true"
          className="fixed inset-0 bg-black/60 backdrop-blur-xs z-30 lg:hidden"
        />
      )}
      <aside
        data-sidebar-open={isOpen ? 'true' : 'false'}
        className={`w-64 bg-slate-900/95 border-l border-slate-800 flex-col h-screen shrink-0 select-none overflow-y-auto overflow-x-hidden ${
          isOpen
            ? 'flex fixed inset-y-0 right-0 z-40 shadow-2xl lg:shadow-none lg:sticky lg:top-0 lg:z-20'
            : 'hidden'
        }`}
        dir="rtl"
      >
        {/* Brand Header */}
        <div className="p-5 border-b border-slate-800/80 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
              <Layers className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-bold tracking-tight text-white">A.N ERP</h1>
              <p className="text-[11px] text-slate-400">منصة إدارة الأعمال</p>
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="إغلاق القائمة"
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/80 transition cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

      {/* User Info Card */}
      <div className="p-4 m-3 bg-slate-950/60 border border-slate-800/80 rounded-xl">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
            <UserCheck className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-white truncate">{userName || 'المستخدم الحالي'}</p>
            <p className="text-[11px] text-emerald-400 font-medium truncate">{displayRoleLabel(userRole)}</p>
          </div>
        </div>
      </div>

      {/* Navigation Section */}
      <div className="flex-1 px-3 py-2 space-y-1">
        <p className="px-3 pb-2 text-[11px] font-semibold text-slate-500 tracking-wider">القائمة الرئيسية</p>

        <button
          onClick={() => onNavigate('companies')}
          className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeNav === 'companies'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 border border-indigo-500/30'
              : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
          }`}
        >
          <Building2 className="w-4 h-4 shrink-0" />
          <span>الشركات</span>
        </button>

        <button
          onClick={() => onNavigate('accounting')}
          className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeNav === 'accounting'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 border border-indigo-500/30'
              : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
          }`}
        >
          <BookOpen className="w-4 h-4 shrink-0" />
          <span>المحاسبة</span>
        </button>

        <button
          onClick={() => onNavigate('inventory')}
          className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeNav === 'inventory'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 border border-indigo-500/30'
              : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
          }`}
        >
          <Boxes className="w-4 h-4 shrink-0" />
          <span>المخزون</span>
        </button>

        <button
          onClick={() => onNavigate('purchasing')}
          className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeNav === 'purchasing'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 border border-indigo-500/30'
              : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
          }`}
        >
          <ShoppingBag className="w-4 h-4 shrink-0" />
          <span>المشتريات</span>
        </button>

        {(userRole === 'platform_admin' ||
          userRole === 'company_admin' ||
          permissions.length === 0 ||
          permissions.includes('cash:read')) && (
          <button
            onClick={() => onNavigate('cash')}
            className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
              activeNav === 'cash'
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 border border-indigo-500/30'
                : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
            }`}
          >
            <Wallet className="w-4 h-4 shrink-0" />
            <span>الخزينة والعهد</span>
          </button>
        )}

        <button
          onClick={() => onNavigate('users')}
          className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeNav === 'users'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 border border-indigo-500/30'
              : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
          }`}
        >
          <Users className="w-4 h-4 shrink-0" />
          <span>المستخدمون</span>
        </button>

        {(userRole === 'platform_admin' || userRole === 'company_admin') && (
          <button
            onClick={() => onNavigate('roles')}
            className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
              activeNav === 'roles'
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 border border-indigo-500/30'
                : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
            }`}
          >
            <Shield className="w-4 h-4 shrink-0" />
            <span>الأدوار والصلاحيات</span>
          </button>
        )}

        <button
          onClick={() => onNavigate('org_units')}
          className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeNav === 'org_units'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 border border-indigo-500/30'
              : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
          }`}
        >
          <Network className="w-4 h-4 shrink-0" />
          <span>الوحدات التنظيمية</span>
        </button>

        <button
          onClick={() => onNavigate('company_settings')}
          className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeNav === 'company_settings'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 border border-indigo-500/30'
              : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
          }`}
        >
          <Settings className="w-4 h-4 shrink-0" />
          <span>إعدادات الشركة</span>
        </button>

        <button
          onClick={() => onNavigate('custom_fields')}
          className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeNav === 'custom_fields'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 border border-indigo-500/30'
              : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
          }`}
        >
          <Sliders className="w-4 h-4 shrink-0" />
          <span>الحقول الإضافية</span>
        </button>

        <button
          onClick={() => onNavigate('config_platform')}
          className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeNav === 'config_platform'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 border border-indigo-500/30'
              : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
          }`}
        >
          <SlidersHorizontal className="w-4 h-4 shrink-0" />
          <span>منصة الإعدادات</span>
        </button>

        {userRole === 'platform_admin' && (
          <button
            onClick={() => onNavigate('config_definitions')}
            className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
              activeNav === 'config_definitions'
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 border border-indigo-500/30'
                : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
            }`}
          >
            <SlidersHorizontal className="w-4 h-4 shrink-0" />
            <span>تعريفات الإعدادات</span>
          </button>
        )}
      </div>

      {/* Sidebar Footer / Logout */}
      <div className="p-4 border-t border-slate-800/80 bg-slate-950/40">
        <button
          onClick={onLogout}
          disabled={loggingOut}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800/80 hover:bg-red-950/40 hover:text-red-400 border border-slate-700/80 text-slate-300 text-xs font-medium transition cursor-pointer disabled:opacity-50"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          <span>تسجيل الخروج</span>
        </button>
      </div>
      </aside>
    </>
  );
}
