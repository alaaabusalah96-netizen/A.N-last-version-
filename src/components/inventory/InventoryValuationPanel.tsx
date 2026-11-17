import React, { useState, useEffect } from 'react';
import { Layers, ShieldCheck, RefreshCw, AlertCircle, Plus, CheckCircle2, X } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface ValuationBalance {
  warehouseCode: string;
  warehouseNameAr: string;
  itemCode: string;
  itemNameAr: string;
  itemUom: string;
  quantity: number;
  totalCost: number;
  unitCost: number;
  updatedAt: string;
}

interface CostingProfile {
  id: string;
  name: string;
  costingMethod: 'FIFO' | 'PERPETUAL_MOVING_AVERAGE';
  isDefault: boolean;
  isActive: boolean;
}

interface InventoryValuationPanelProps {
  companyId: string;
  userRole: string;
}

export function InventoryValuationPanel({ companyId, userRole }: InventoryValuationPanelProps) {
  const [balances, setBalances] = useState<ValuationBalance[]>([]);
  const [profiles, setProfiles] = useState<CostingProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [costingMethod, setCostingMethod] = useState<'FIFO' | 'PERPETUAL_MOVING_AVERAGE'>('FIFO');
  const [isDefault, setIsDefault] = useState(false);

  const canWrite = userRole === 'platform_admin' || userRole === 'company_admin';

  const loadValuationData = async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const [valRes, profRes] = await Promise.all([
        apiFetch(`/api/inventory/warehouse-valuations?companyId=${companyId}`),
        apiFetch(`/api/inventory/costing-profiles?companyId=${companyId}`),
      ]);

      if (valRes.ok) {
        setBalances((await valRes.json()).balances || []);
      }
      if (profRes.ok) {
        setProfiles((await profRes.json()).profiles || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تحميل بيانات تقييم المخزون');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadValuationData();
  }, [companyId]);

  const handleCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch('/api/inventory/costing-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, name: profileName, costingMethod, isDefault }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'فشل في إنشاء ملف التكلفة');

      setSuccess(`تم إنشاء ملف التكلفة (${data.profile.name}) بنجاح`);
      setShowProfileModal(false);
      setProfileName('');
      setCostingMethod('FIFO');
      setIsDefault(false);
      await loadValuationData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء إنشاء ملف التكلفة');
    }
  };

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-purple-600/20 border border-purple-500/30 flex items-center justify-center text-purple-400 shrink-0">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">محرك تقييم المخزون (Inventory Valuation Engine)</h3>
            <p className="text-xs text-slate-400">إدارة سياسات التكلفة (FIFO & Perpetual Moving Average) وتقييم المستودعات</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={loadValuationData}
            disabled={loading}
            className="p-2.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer"
            title="تحديث البيانات"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {canWrite && (
            <button
              onClick={() => setShowProfileModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>إضافة ملف تكلفة جديد</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="p-4 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          <span>{success}</span>
        </div>
      )}

      {/* Costing Profiles Section */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col gap-4">
        <h4 className="text-sm font-bold text-white flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-indigo-400" />
          <span>ملفات سياسات التكلفة المتاحة للشركة</span>
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {profiles.length === 0 ? (
            <p className="text-xs text-slate-500 col-span-full py-4 text-center">
              لا توجد ملفات تكلفة معرّفة. سيتم تطبيق طريقة FIFO افتراضياً على الأصناف.
            </p>
          ) : (
            profiles.map((p) => (
              <div key={p.id} className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white text-xs">{p.name}</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-indigo-950 text-indigo-300 border border-indigo-800">
                    {p.costingMethod}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-slate-400">
                  <span>الافتراضي: {p.isDefault ? 'نعم' : 'لا'}</span>
                  <span>•</span>
                  <span>الحالة: نشط</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Warehouse Monetary Valuation Balances */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col">
        <div className="p-4 bg-slate-950/60 border-b border-slate-800 flex items-center justify-between">
          <h4 className="text-sm font-bold text-white">أرصدة وتقييم المخزون المالي حسب المستودع</h4>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="bg-slate-950/40 border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">المستودع</th>
                <th className="py-3.5 px-4">كود الصنف</th>
                <th className="py-3.5 px-4">اسم الصنف</th>
                <th className="py-3.5 px-4 text-center">الكمية</th>
                <th className="py-3.5 px-4 text-center">متوسط التكلفة</th>
                <th className="py-3.5 px-4 text-center">إجمالي التكلفة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {balances.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    لا توجد تقييمات مالية مسجلة للأصناف حتى الآن.
                  </td>
                </tr>
              ) : (
                balances.map((b, idx) => (
                  <tr key={`${b.warehouseCode}-${b.itemCode}-${idx}`} className="hover:bg-slate-800/30 transition">
                    <td className="py-3.5 px-4 font-medium text-slate-200">
                      {b.warehouseNameAr} ({b.warehouseCode})
                    </td>
                    <td className="py-3.5 px-4 font-mono font-bold text-indigo-300">{b.itemCode}</td>
                    <td className="py-3.5 px-4 text-slate-200">{b.itemNameAr}</td>
                    <td className="py-3.5 px-4 text-center font-mono font-bold text-emerald-400">{b.quantity}</td>
                    <td className="py-3.5 px-4 text-center font-mono text-slate-300">{b.unitCost}</td>
                    <td className="py-3.5 px-4 text-center font-mono font-bold text-white">{b.totalCost}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Profile Creation Modal */}
      {showProfileModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-bold text-white text-sm">إضافة ملف سياسة تكلفة جديد</h4>
              <button onClick={() => setShowProfileModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateProfile} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">اسم الملف *</label>
                <input
                  type="text"
                  required
                  placeholder="مثال: سياسة الوارد أولاً صادر أولاً القياسية"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">طريقة التكلفة *</label>
                <select
                  value={costingMethod}
                  onChange={(e) => setCostingMethod(e.target.value as any)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value="FIFO">FIFO (الوارد أولاً صادر أولاً)</option>
                  <option value="PERPETUAL_MOVING_AVERAGE">Perpetual Moving Average (المتوسط المتحرك المستمر)</option>
                </select>
              </div>
              <div className="flex items-center gap-2 pt-2">
                <input
                  type="checkbox"
                  id="isDefault"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                  className="rounded bg-slate-950 border-slate-800 text-indigo-600 focus:ring-0 cursor-pointer"
                />
                <label htmlFor="isDefault" className="text-xs text-slate-300 cursor-pointer">
                  جعله الملف الافتراضي للشركة
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-2">
                <button
                  type="button"
                  onClick={() => setShowProfileModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-indigo-600/20"
                >
                  حفظ الملف
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
