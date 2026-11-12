import React, { useState, useEffect } from 'react';
import {
  Package,
  Boxes,
  History,
  Building2,
  ArrowLeft,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  ArrowRightLeft,
  AlertCircle,
  CheckCircle2,
  FileText,
  Save,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import {
  DynamicFieldGroup,
  DynamicFieldDefinition,
  DynamicFieldValuesMap,
  validateRequiredDynamicFields,
} from '../customization/DynamicFieldGroup.js';

interface Item {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  uom: string;
  isActive: boolean;
  createdAt: string;
}

interface Warehouse {
  id: string;
  code: string;
  nameAr: string;
}

interface StockBalance {
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  qty: number;
  updatedAt: string;
}

interface StockMovement {
  id: string;
  warehouseId: string;
  warehouseCode?: string;
  warehouseNameAr?: string;
  movementType: 'receive' | 'issue' | 'transfer_out' | 'transfer_in' | 'transfer';
  qty: number;
  memo?: string;
  transferId?: string;
  createdAt: string;
}

interface ItemCardPanelProps {
  companyId: string;
  itemId: string;
  warehouses: Warehouse[];
  onClose: () => void;
  onQuickAction?: (actionType: 'receive' | 'issue' | 'transfer', itemId: string) => void;
}

export function ItemCardPanel({
  companyId,
  itemId,
  warehouses,
  onClose,
  onQuickAction,
}: ItemCardPanelProps) {
  const [item, setItem] = useState<Item | null>(null);
  const [balances, setBalances] = useState<StockBalance[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);

  const [activeSubTab, setActiveSubTab] = useState<'info' | 'balances' | 'movements'>('info');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters for movements
  const [filterWarehouseId, setFilterWarehouseId] = useState('');
  const [filterType, setFilterType] = useState('');

  // Dynamic Custom Fields
  const [customFields, setCustomFields] = useState<DynamicFieldDefinition[]>([]);
  const [customValues, setCustomValues] = useState<DynamicFieldValuesMap>({});
  const [customFieldErrors, setCustomFieldErrors] = useState<Record<string, string>>({});
  const [customCanWrite, setCustomCanWrite] = useState(false);
  const [savingCustom, setSavingCustom] = useState(false);
  const [customSuccess, setCustomSuccess] = useState<string | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);

  const loadItemData = async () => {
    if (!companyId || !itemId) return;
    setLoading(true);
    setError(null);
    try {
      let movQuery = `/api/inventory/items/${itemId}/movements?companyId=${companyId}`;
      if (filterWarehouseId) movQuery += `&warehouseId=${filterWarehouseId}`;
      if (filterType) movQuery += `&type=${filterType}`;

      const [itemRes, balRes, movRes, cvRes, cfRes] = await Promise.all([
        apiFetch(`/api/inventory/items/${itemId}?companyId=${companyId}`),
        apiFetch(`/api/inventory/items/${itemId}/stock?companyId=${companyId}`),
        apiFetch(movQuery),
        apiFetch(`/api/companies/${companyId}/custom-values/${itemId}`),
        apiFetch(`/api/companies/${companyId}/custom-fields?entityType=item`),
      ]);

      if (itemRes.ok) setItem((await itemRes.json()).item);
      else throw new Error('فشل تحميل بيانات الصنف');

      if (balRes.ok) setBalances((await balRes.json()).balances || []);
      if (movRes.ok) setMovements((await movRes.json()).movements || []);

      let activeDefs: DynamicFieldDefinition[] = [];
      if (cfRes.ok) {
        const cfData = await cfRes.json();
        activeDefs = cfData.fields || [];
      }

      if (cvRes.ok) {
        const cvData = await cvRes.json();
        setCustomCanWrite(Boolean(cvData.userCanWrite));
        if (activeDefs.length === 0 && Array.isArray(cvData.fields)) {
          activeDefs = cvData.fields;
        }
        const map: DynamicFieldValuesMap = {};
        for (const v of cvData.values || []) {
          map[v.fieldId] = v.value ?? null;
        }
        setCustomValues(map);
      }
      setCustomFields(activeDefs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تحميل بيانات بطاقة الصنف');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadItemData();
  }, [companyId, itemId, filterWarehouseId, filterType]);

  const handleCustomValueChange = (fieldId: string, val: string | number | boolean | null) => {
    setCustomValues((prev) => ({ ...prev, [fieldId]: val }));
    setCustomFieldErrors((prev) => {
      if (!prev[fieldId]) return prev;
      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
  };

  const handleSaveCustomValues = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customCanWrite || customFields.length === 0) return;

    setCustomError(null);
    setCustomSuccess(null);
    const clientErrs = validateRequiredDynamicFields(customFields, customValues);
    setCustomFieldErrors(clientErrs);
    if (Object.keys(clientErrs).length > 0) {
      setCustomError('يرجى استكمال الحقول الإلزامية المميزة بعلامة *');
      return;
    }

    setSavingCustom(true);
    try {
      const payloadValues = customFields
        .filter((f) => f.isActive)
        .map((f) => {
          const v = customValues[f.id];
          return {
            fieldId: f.id,
            value: f.fieldType === 'boolean' ? Boolean(v) : v ?? null,
          };
        });

      const res = await apiFetch(`/api/companies/${companyId}/custom-values/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: payloadValues }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'فشل حفظ البيانات الإضافية');
      }
      setCustomSuccess('تم حفظ البيانات الإضافية للصنف بنجاح');
      await loadItemData();
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : 'خطأ أثناء حفظ البيانات الإضافية');
    } finally {
      setSavingCustom(false);
    }
  };

  const totalStock = balances.reduce((acc, b) => acc + (b.qty || 0), 0);

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-3.5">
          <button
            onClick={onClose}
            className="p-2.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer"
            title="العودة لقائمة الأصناف"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
            <Package className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-white">بطاقة صنف (Item Card)</h3>
              {item && (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-indigo-950 border border-indigo-800 text-indigo-300">
                  {item.code}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              {item ? `${item.nameAr} | إجمالي الرصيد: ${totalStock} ${item.uom}` : 'جاري تحميل تفاصيل الصنف...'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={loadItemData}
            disabled={loading}
            className="p-2.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer"
            title="تحديث البيانات"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {onQuickAction && item && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => onQuickAction('receive', item.id)}
                className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-emerald-600/20 transition cursor-pointer flex items-center gap-1.5"
              >
                <TrendingUp className="w-3.5 h-3.5" />
                <span>استلام</span>
              </button>
              <button
                onClick={() => onQuickAction('issue', item.id)}
                className="px-3 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-rose-600/20 transition cursor-pointer flex items-center gap-1.5"
              >
                <TrendingDown className="w-3.5 h-3.5" />
                <span>صرف</span>
              </button>
              <button
                onClick={() => onQuickAction('transfer', item.id)}
                className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer flex items-center gap-1.5"
              >
                <ArrowRightLeft className="w-3.5 h-3.5" />
                <span>تحويل</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      {/* Sub Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setActiveSubTab('info')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeSubTab === 'info'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <FileText className="w-4 h-4" />
          <span>بيانات الصنف</span>
        </button>

        <button
          onClick={() => setActiveSubTab('balances')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeSubTab === 'balances'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <Boxes className="w-4 h-4" />
          <span>الأرصدة بالمستودعات ({balances.length})</span>
        </button>

        <button
          onClick={() => setActiveSubTab('movements')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
            activeSubTab === 'movements'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-white'
          }`}
        >
          <History className="w-4 h-4" />
          <span>سجل الحركات ({movements.length})</span>
        </button>
      </div>

      {/* Sub Tab Panels */}
      {activeSubTab === 'info' && item && (
        <form onSubmit={handleSaveCustomValues} className="flex flex-col gap-6">
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 block mb-1">كود الصنف</span>
              <span className="text-sm font-bold font-mono text-indigo-300">{item.code}</span>
            </div>

            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 block mb-1">اسم الصنف (بالعربية)</span>
              <span className="text-sm font-bold text-white">{item.nameAr}</span>
            </div>

            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 block mb-1">اسم الصنف (بالإنجليزية)</span>
              <span className="text-sm font-bold text-slate-300">{item.nameEn || '—'}</span>
            </div>

            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 block mb-1">وحدة القياس (UOM)</span>
              <span className="text-sm font-bold font-mono text-emerald-400">{item.uom}</span>
            </div>

            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 block mb-1">إجمالي الكمية المتوفرة</span>
              <span className="text-sm font-bold font-mono text-white">{totalStock} {item.uom}</span>
            </div>

            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 block mb-1">تاريخ الإنشاء</span>
              <span className="text-sm font-mono text-slate-300">
                {new Date(item.createdAt).toLocaleDateString('ar-EG')}
              </span>
            </div>
          </div>

          {customFields.length > 0 && (
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h4 className="text-sm font-bold text-white">بيانات إضافية</h4>
                <span className="text-[11px] text-slate-400">حقول معرفة مسبقًا على مستوى الشركة</span>
              </div>

              {customError && (
                <div className="p-3 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                  <span>{customError}</span>
                </div>
              )}
              {customSuccess && (
                <div className="p-3 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                  <span>{customSuccess}</span>
                </div>
              )}

              <DynamicFieldGroup
                fields={customFields}
                values={customValues}
                errors={customFieldErrors}
                onChange={handleCustomValueChange}
                disabled={!customCanWrite || savingCustom}
              />

              {customCanWrite && (
                <div className="flex justify-end pt-3 border-t border-slate-800">
                  <button
                    type="submit"
                    disabled={savingCustom}
                    className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer disabled:opacity-50"
                  >
                    <Save className="w-4 h-4" />
                    <span>{savingCustom ? 'جاري الحفظ...' : 'حفظ البيانات الإضافية'}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </form>
      )}

      {activeSubTab === 'balances' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">كود المستودع</th>
                <th className="py-3.5 px-4">اسم المستودع</th>
                <th className="py-3.5 px-4 text-center">الكمية الحالية</th>
                <th className="py-3.5 px-4 text-center">آخر تحديث</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {balances.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-12 text-center text-slate-500">
                    لا توجد أرصدة لهذا الصنف في المستودعات حتى الآن.
                  </td>
                </tr>
              ) : (
                balances.map((b) => (
                  <tr key={b.warehouseId} className="hover:bg-slate-800/30 transition">
                    <td className="py-3.5 px-4 font-mono font-bold text-indigo-300">{b.warehouseCode}</td>
                    <td className="py-3.5 px-4 font-medium text-slate-200">{b.warehouseNameAr}</td>
                    <td className="py-3.5 px-4 text-center font-mono font-bold text-emerald-400 text-sm">
                      {b.qty}
                    </td>
                    <td className="py-3.5 px-4 text-center text-slate-400 font-mono text-[11px]">
                      {new Date(b.updatedAt).toLocaleString('ar-EG')}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeSubTab === 'movements' && (
        <div className="flex flex-col gap-4">
          {/* Movement Filters */}
          <div className="flex flex-wrap items-center gap-3 bg-slate-900/90 border border-slate-800 rounded-xl p-3">
            <div className="flex items-center gap-2">
              <Building2 className="w-4 h-4 text-slate-400" />
              <select
                value={filterWarehouseId}
                onChange={(e) => setFilterWarehouseId(e.target.value)}
                className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none cursor-pointer"
              >
                <option value="">جميع المستودعات</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.nameAr} ({w.code})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none cursor-pointer"
              >
                <option value="">جميع أنواع الحركات</option>
                <option value="receive">إستلام (+)</option>
                <option value="issue">صرف (-)</option>
                <option value="transfer_out">تحويل صادر (-)</option>
                <option value="transfer_in">تحويل وارد (+)</option>
              </select>
            </div>
          </div>

          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="py-3.5 px-4">التاريخ والوقت</th>
                  <th className="py-3.5 px-4">نوع الحركة</th>
                  <th className="py-3.5 px-4">المستودع</th>
                  <th className="py-3.5 px-4 text-center">الكمية</th>
                  <th className="py-3.5 px-4">ملاحظات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-200">
                {movements.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-slate-500">
                      لا توجد حركات مخزنية مسجلة لهذا الصنف بالمعايير المحددة.
                    </td>
                  </tr>
                ) : (
                  movements.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 px-4 text-slate-400 font-mono text-[11px]">
                        {new Date(m.createdAt).toLocaleString('ar-EG')}
                      </td>
                      <td className="py-3.5 px-4">
                        {m.movementType === 'receive' ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-950/60 border border-emerald-800/80 text-emerald-400">
                            <TrendingUp className="w-3 h-3" />
                            <span>إستلام (+)</span>
                          </span>
                        ) : m.movementType === 'issue' ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-rose-950/60 border border-rose-800/80 text-rose-400">
                            <TrendingDown className="w-3 h-3" />
                            <span>صرف (-)</span>
                          </span>
                        ) : m.movementType === 'transfer_out' ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-950/60 border border-amber-800/80 text-amber-400">
                            <ArrowRightLeft className="w-3 h-3" />
                            <span>تحويل صادر (-)</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-indigo-950/60 border border-indigo-800/80 text-indigo-400">
                            <ArrowRightLeft className="w-3 h-3" />
                            <span>تحويل وارد (+)</span>
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-slate-300">{m.warehouseNameAr}</td>
                      <td className="py-3.5 px-4 text-center font-mono font-bold text-white">{m.qty}</td>
                      <td className="py-3.5 px-4 text-slate-400">{m.memo || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
