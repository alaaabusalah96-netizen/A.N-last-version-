import React from 'react';
import { Building2, BookOpen, LogOut, Layers, UserCheck, Users, Settings, Network, Boxes, ShoppingBag } from 'lucide-react';
import { displayRoleLabel } from './roleLabels.js';

interface AppSidebarProps {
  activeNav: 'companies' | 'accounting' | 'inventory' | 'purchasing' | 'users' | 'company_settings' | 'org_units';
  onNavigate: (nav: 'companies' | 'accounting' | 'inventory' | 'purchasing' | 'users' | 'company_settings' | 'org_units') => void;
  userName: string;
  userRole: string;
  onLogout: () => void;
  loggingOut?: boolean;
}

export function AppSidebar({
  activeNav,
  onNavigate,
  userName,
  userRole,
  onLogout,
  loggingOut,
}: AppSidebarProps) {
  return (
    <aside className="w-64 bg-slate-900/95 border-l border-slate-800 flex flex-col h-screen sticky top-0 shrink-0 select-none overflow-y-auto overflow-x-hidden" dir="rtl">
      {/* Brand Header */}
      <div className="p-5 border-b border-slate-800/80 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
          <Layers className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-sm font-bold tracking-tight text-white">A.N ERP</h1>
          <p className="text-[11px] text-slate-400">منصة إدارة الأعمال</p>
        </div>
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
  );
}
