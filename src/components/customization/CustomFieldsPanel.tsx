import React, { useState, useEffect, useCallback } from 'react';
import {
  Sliders,
  Plus,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  ArrowUp,
  ArrowDown,
  Edit3,
  Power,
  X,
  Building2,
  Info,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';
import type { DynamicFieldDefinition, DynamicFieldType } from './DynamicFieldGroup.js';

interface Company {
  id: string;
  code: string;
  nameAr: string;
}

const FIELD_TYPE_LABELS: Record<DynamicFieldType, string> = {
  text: 'نص (text)',
  number: 'رقم (number)',
  date: 'تاريخ (date)',
  boolean: 'منطقي نعم/لا (boolean)',
  select: 'قائمة اختيار (select)',
};

function slugifyArabicOrLatin(label: string): string {
  const ascii = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (ascii && /^[a-z][a-z0-9_]*$/.test(ascii)) {
    return ascii.slice(0, 60);
  }
  if (ascii && /^[0-9]/.test(ascii)) {
    return `f_${ascii}`.slice(0, 60);
  }
  return '';
}

function parseOptionsText(raw: string): string[] {
  return raw
    .split(/[\n,،]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function CustomFieldsPanel() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const [entityType] = useState<'item'>('item');

  const [fields, setFields] = useState<DynamicFieldDefinition[]>([]);
  const [userCanWrite, setUserCanWrite] = useState(false);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // New field form state
  const [labelAr, setLabelAr] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [keyManuallyEdited, setKeyManuallyEdited] = useState(false);
  const [fieldType, setFieldType] = useState<DynamicFieldType>('text');
  const [optionsText, setOptionsText] = useState('');
  const [isRequired, setIsRequired] = useState(false);
  const [helpText, setHelpText] = useState('');
  const [sortOrder, setSortOrder] = useState('10');

  // Edit field modal/inline state
  const [editingField, setEditingField] = useState<DynamicFieldDefinition | null>(null);
  const [editLabelAr, setEditLabelAr] = useState('');
  const [editOptionsText, setEditOptionsText] = useState('');
  const [editIsRequired, setEditIsRequired] = useState(false);
  const [editHelpText, setEditHelpText] = useState('');
  const [editSortOrder, setEditSortOrder] = useState('0');

  useEffect(() => {
    async function fetchCompanies() {
      try {
        const res = await apiFetch('/api/companies');
        if (!res.ok) throw new Error('تعذر جلب قائمة الشركات');
        const data = await res.json();
        const list: Company[] = data.companies || [];
        setCompanies(list);
        if (list.length > 0) {
          setSelectedCompanyId(list[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'خطأ أثناء تحميل الشركات');
      }
    }
    fetchCompanies();
  }, []);

  const loadFields = useCallback(async () => {
    if (!selectedCompanyId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/companies/${selectedCompanyId}/custom-fields?entityType=${entityType}&includeInactive=true`
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'تعذر جلب تعريفات الحقول الإضافية');
      }
      setFields(data.fields || []);
      setUserCanWrite(Boolean(data.userCanWrite));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء جلب الحقول الإضافية');
    } finally {
      setLoading(false);
    }
  }, [selectedCompanyId, entityType]);

  useEffect(() => {
    loadFields();
  }, [loadFields]);

  const handleLabelChange = (val: string) => {
    setLabelAr(val);
    if (!keyManuallyEdited) {
      const slug = slugifyArabicOrLatin(val);
      if (slug) {
        setFieldKey(slug);
      } else if (!val.trim()) {
        setFieldKey('');
      }
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userCanWrite || !selectedCompanyId) return;

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const payload: Record<string, unknown> = {
        entityType: 'item',
        fieldKey: fieldKey.trim(),
        labelAr: labelAr.trim(),
        fieldType,
        isRequired,
        sortOrder: parseInt(sortOrder, 10) || 0,
        helpText: helpText.trim() || null,
      };
      if (fieldType === 'select') {
        payload.options = parseOptionsText(optionsText);
      }

      const res = await apiFetch(`/api/companies/${selectedCompanyId}/custom-fields`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'فشل إنشاء الحقل الإضافي');
      }

      setSuccess(`تم إنشاء الحقل الإضافي «${data.field.labelAr}» بنجاح`);
      setLabelAr('');
      setFieldKey('');
      setKeyManuallyEdited(false);
      setFieldType('text');
      setOptionsText('');
      setIsRequired(false);
      setHelpText('');
      setSortOrder(String((fields.length + 1) * 10));
      await loadFields();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء إنشاء الحقل');
    } finally {
      setSaving(false);
    }
  };

  const handleMoveOrder = async (index: number, direction: 'up' | 'down') => {
    if (!userCanWrite || !selectedCompanyId) return;
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= fields.length) return;

    const current = fields[index];
    const neighbor = fields[targetIdx];
    const newCurrentOrder =
      neighbor.sortOrder === current.sortOrder
        ? direction === 'up'
          ? current.sortOrder - 1
          : current.sortOrder + 1
        : neighbor.sortOrder;
    const newNeighborOrder = current.sortOrder;

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res1 = await apiFetch(`/api/companies/${selectedCompanyId}/custom-fields/${current.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sortOrder: newCurrentOrder }),
      });
      if (!res1.ok) {
        const d1 = await res1.json();
        throw new Error(d1.message || d1.error || 'فشل تحديث ترتيب الحقل');
      }
      if (neighbor.sortOrder !== current.sortOrder) {
        const res2 = await apiFetch(`/api/companies/${selectedCompanyId}/custom-fields/${neighbor.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sortOrder: newNeighborOrder }),
        });
        if (!res2.ok) {
          const d2 = await res2.json();
          throw new Error(d2.message || d2.error || 'فشل تحديث ترتيب الحقل المقابل');
        }
      }
      await loadFields();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تغيير الترتيب');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (field: DynamicFieldDefinition) => {
    if (!userCanWrite || !selectedCompanyId) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await apiFetch(`/api/companies/${selectedCompanyId}/custom-fields/${field.id}/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !field.isActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'فشل تغيير حالة الحقل');
      }
      setSuccess(
        data.field.isActive
          ? `تم تفعيل الحقل «${data.field.labelAr}»`
          : `تم تعطيل الحقل «${data.field.labelAr}» (القيم المحفوظة مسبقًا تظل محفوظة)`
      );
      await loadFields();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تغيير حالة التفعيل');
    } finally {
      setSaving(false);
    }
  };

  const openEditModal = (field: DynamicFieldDefinition) => {
    setEditingField(field);
    setEditLabelAr(field.labelAr);
    setEditOptionsText((field.options || []).join('\n'));
    setEditIsRequired(field.isRequired);
    setEditHelpText(field.helpText || '');
    setEditSortOrder(String(field.sortOrder));
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userCanWrite || !selectedCompanyId || !editingField) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const payload: Record<string, unknown> = {
        labelAr: editLabelAr.trim(),
        isRequired: editIsRequired,
        helpText: editHelpText.trim() || null,
        sortOrder: parseInt(editSortOrder, 10) || 0,
      };
      if (editingField.fieldType === 'select') {
        payload.options = parseOptionsText(editOptionsText);
      }

      const res = await apiFetch(`/api/companies/${selectedCompanyId}/custom-fields/${editingField.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'فشل تحديث الحقل الإضافي');
      }

      const warnCount = data.field?.outOfOptionsValuesCount || 0;
      setSuccess(
        warnCount > 0
          ? `تم تحديث الحقل «${data.field.labelAr}». تنبيه: توجد ${warnCount} قيمة محفوظة مسبقًا خارج الخيارات الجديدة (لم تُحذف حفاظًا على الأثر التدقيقي).`
          : `تم تحديث الحقل «${data.field.labelAr}» بنجاح`
      );
      setEditingField(null);
      await loadFields();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ أثناء تعديل الحقل');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      {/* Header Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
            <Sliders className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">الحقول الإضافية</h3>
            <p className="text-xs text-slate-400">
              تخصيص الحقول الإضافية على بطاقة الصنف (التسمية، النوع، الإلزام، الترتيب، والتفعيل)
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Company selector */}
          <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-300">
            <Building2 className="w-4 h-4 text-slate-400" />
            <select
              value={selectedCompanyId}
              onChange={(e) => setSelectedCompanyId(e.target.value)}
              className="bg-transparent text-white focus:outline-none font-medium cursor-pointer"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id} className="bg-slate-900 text-white">
                  {c.nameAr} ({c.code})
                </option>
              ))}
            </select>
          </div>

          {/* Entity selector: explicit disability for unimplemented entities */}
          <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-300">
            <span className="text-slate-400">الكيان:</span>
            <select
              value={entityType}
              onChange={() => {}}
              className="bg-transparent text-white focus:outline-none font-medium cursor-pointer"
            >
              <option value="item" className="bg-slate-900 text-white">
                الأصناف (item)
              </option>
              <option value="supplier" disabled className="bg-slate-900 text-slate-500">
                الموردون (supplier) — غير مدعوم بعد
              </option>
              <option value="customer" disabled className="bg-slate-900 text-slate-500">
                العملاء (customer) — غير مدعوم بعد
              </option>
              <option value="document" disabled className="bg-slate-900 text-slate-500">
                المستندات (document) — غير مدعوم بعد
              </option>
            </select>
          </div>

          <button
            onClick={loadFields}
            disabled={loading}
            className="p-2.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl text-slate-300 hover:text-white transition cursor-pointer"
            title="تحديث"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Scope explanation note */}
      <div className="p-3.5 bg-slate-900/70 border border-slate-800 rounded-xl text-xs text-slate-300 flex items-center gap-2.5">
        <Info className="w-4 h-4 text-indigo-400 shrink-0" />
        <span>
          تدعم هذه النسخة الحقول الإضافية على <strong>كيان الأصناف (item)</strong> فقط. باقي الكيانات (الموردون / العملاء / المستندات) معطّلة صراحةً كـ «غير مدعوم بعد» لحين ربط نماذجها الفعلية.
        </span>
      </div>

      {!userCanWrite && !loading && selectedCompanyId && (
        <div className="p-3.5 bg-amber-950/30 border border-amber-800/50 rounded-xl text-amber-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>وضع القراءة فقط: لا تملك صلاحية تعديل إعدادات الشركة لإضافة أو تعديل الحقول الإضافية.</span>
        </div>
      )}

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

      {/* New Field Form */}
      {userCanWrite && (
        <form
          onSubmit={handleCreate}
          className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col gap-4"
        >
          <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
            <Plus className="w-4 h-4 text-indigo-400" />
            <h4 className="text-sm font-bold text-white">حقل جديد</h4>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                التسمية العربية *
              </label>
              <input
                type="text"
                required
                placeholder="مثال: رقم التشغيلة أو بلد المنشأ"
                value={labelAr}
                onChange={(e) => handleLabelChange(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                المفتاح (field_key) *
              </label>
              <input
                type="text"
                required
                dir="ltr"
                placeholder="batch_number"
                value={fieldKey}
                onChange={(e) => {
                  setKeyManuallyEdited(true);
                  setFieldKey(e.target.value);
                }}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
              />
              <span className="text-[11px] text-slate-500 mt-0.5 block">
                أحرف إنجليزية صغيرة وأرقام و _ فقط (يبدأ بحرف صغير)
              </span>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                نوع الحقل *
              </label>
              <select
                value={fieldType}
                onChange={(e) => setFieldType(e.target.value as DynamicFieldType)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
              >
                <option value="text">نص (text)</option>
                <option value="number">رقم (number)</option>
                <option value="date">تاريخ (date)</option>
                <option value="boolean">منطقي نعم/لا (boolean)</option>
                <option value="select">قائمة اختيار (select)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                الترتيب
              </label>
              <input
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                نص مساعدة (اختياري)
              </label>
              <input
                type="text"
                placeholder="إرشاد يظهر للمستخدم أسفل الحقل"
                value={helpText}
                onChange={(e) => setHelpText(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isRequired}
                  onChange={(e) => setIsRequired(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <span className="text-xs font-semibold text-slate-200">حقل إلزامي عند حفظ الصنف</span>
              </label>
            </div>
          </div>

          {fieldType === 'select' && (
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                الخيارات (مفصولة بفاصلة أو سطر جديد) *
              </label>
              <textarea
                rows={3}
                required
                placeholder={'خيار 1\nخيار 2\nخيار 3'}
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
          )}

          <div className="flex justify-end pt-2 border-t border-slate-800">
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/20 transition cursor-pointer disabled:opacity-50"
            >
              {saving ? 'جاري الحفظ...' : 'إضافة الحقل'}
            </button>
          </div>
        </form>
      )}

      {/* Fields Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold">
                <th className="py-3.5 px-4">التسمية</th>
                <th className="py-3.5 px-4">المفتاح</th>
                <th className="py-3.5 px-4">النوع</th>
                <th className="py-3.5 px-4 text-center">إلزامي</th>
                <th className="py-3.5 px-4 text-center">مفعّل</th>
                <th className="py-3.5 px-4 text-center">الترتيب</th>
                {userCanWrite && <th className="py-3.5 px-4 text-center">إجراءات</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={userCanWrite ? 7 : 6} className="py-12 text-center text-slate-400">
                    جاري تحميل الحقول الإضافية...
                  </td>
                </tr>
              ) : fields.length === 0 ? (
                <tr>
                  <td colSpan={userCanWrite ? 7 : 6} className="py-12 text-center text-slate-400">
                    لا توجد حقول إضافية — أنشئ أول حقل
                  </td>
                </tr>
              ) : (
                fields.map((f, idx) => (
                  <tr key={f.id} className="hover:bg-slate-800/30 transition">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-white">{f.labelAr}</div>
                      {f.helpText && <div className="text-[11px] text-slate-500 mt-0.5">{f.helpText}</div>}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-indigo-300">{f.fieldKey}</td>
                    <td className="py-3.5 px-4">
                      <div>{FIELD_TYPE_LABELS[f.fieldType]}</div>
                      {f.fieldType === 'select' && f.options && (
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          ({f.options.join('، ')})
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      {f.isRequired ? (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-950/60 border border-rose-800/70 text-rose-300">
                          إلزامي *
                        </span>
                      ) : (
                        <span className="text-slate-500">اختياري</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      {f.isActive ? (
                        <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-950/60 border border-emerald-800/80 text-emerald-400">
                          مفعّل
                        </span>
                      ) : (
                        <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-800 border border-slate-700 text-slate-400">
                          معطّل
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      <div className="inline-flex items-center gap-1.5 font-mono">
                        <span>{f.sortOrder}</span>
                        {userCanWrite && (
                          <div className="flex items-center gap-0.5">
                            <button
                              type="button"
                              disabled={saving || idx === 0}
                              onClick={() => handleMoveOrder(idx, 'up')}
                              className="p-1 bg-slate-800 hover:bg-slate-700 rounded text-slate-300 disabled:opacity-30 cursor-pointer"
                              title="تحريك للأعلى"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              disabled={saving || idx === fields.length - 1}
                              onClick={() => handleMoveOrder(idx, 'down')}
                              className="p-1 bg-slate-800 hover:bg-slate-700 rounded text-slate-300 disabled:opacity-30 cursor-pointer"
                              title="تحريك للأسفل"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                    {userCanWrite && (
                      <td className="py-3.5 px-4 text-center">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => openEditModal(f)}
                            className="px-2.5 py-1 bg-slate-800 hover:bg-indigo-600/30 border border-slate-700 text-slate-200 rounded-lg text-[11px] font-semibold transition cursor-pointer inline-flex items-center gap-1"
                          >
                            <Edit3 className="w-3 h-3" />
                            <span>تعديل</span>
                          </button>
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => handleToggleActive(f)}
                            className={`px-2.5 py-1 border rounded-lg text-[11px] font-semibold transition cursor-pointer inline-flex items-center gap-1 ${
                              f.isActive
                                ? 'bg-amber-950/40 border-amber-800/60 text-amber-300 hover:bg-amber-900/50'
                                : 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300 hover:bg-emerald-900/50'
                            }`}
                          >
                            <Power className="w-3 h-3" />
                            <span>{f.isActive ? 'تعطيل' : 'تفعيل'}</span>
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Modal (key and type are intentionally immutable) */}
      {editingField && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h4 className="font-bold text-white text-sm">تعديل الحقل الإضافي</h4>
                <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                  {editingField.fieldKey} ({editingField.fieldType}) — المفتاح والنوع غير قابلين للتعديل
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingField(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">التسمية العربية *</label>
                <input
                  type="text"
                  required
                  value={editLabelAr}
                  onChange={(e) => setEditLabelAr(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الترتيب</label>
                <input
                  type="number"
                  value={editSortOrder}
                  onChange={(e) => setEditSortOrder(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">نص مساعدة</label>
                <input
                  type="text"
                  value={editHelpText}
                  onChange={(e) => setEditHelpText(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              {editingField.fieldType === 'select' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    الخيارات (مفصولة بفاصلة أو سطر جديد) *
                  </label>
                  <textarea
                    rows={3}
                    required
                    value={editOptionsText}
                    onChange={(e) => setEditOptionsText(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              )}

              <label className="flex items-center gap-2 cursor-pointer py-1">
                <input
                  type="checkbox"
                  checked={editIsRequired}
                  onChange={(e) => setEditIsRequired(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <span className="text-xs font-semibold text-slate-200">حقل إلزامي</span>
              </label>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800 mt-1">
                <button
                  type="button"
                  onClick={() => setEditingField(null)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold shadow-lg shadow-indigo-600/20 disabled:opacity-50 cursor-pointer"
                >
                  {saving ? 'جاري الحفظ...' : 'حفظ التعديلات'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
