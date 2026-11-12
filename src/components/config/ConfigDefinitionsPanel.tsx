import React, { useState, useEffect } from 'react';
import { SlidersHorizontal, Plus, Edit3, RefreshCw, AlertCircle, CheckCircle2, ShieldAlert, FileCode } from 'lucide-react';
import { apiFetch } from '../../lib/apiClient.js';

interface ConfigDefinition {
  id: string;
  key: string;
  domain: string;
  labelAr: string | null;
  isSystem: boolean;
  schema: Record<string, unknown>;
  defaultValue: Record<string, unknown>;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ConfigDefinitionsPanelProps {
  userRole?: string;
}

export function ConfigDefinitionsPanel({ userRole }: ConfigDefinitionsPanelProps) {
  const [definitions, setDefinitions] = useState<ConfigDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingDef, setEditingDef] = useState<ConfigDefinition | null>(null);

  // Form states for create
  const [newKey, setNewKey] = useState('');
  const [newDomain, setNewDomain] = useState('general');
  const [newLabelAr, setNewLabelAr] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newSchemaJson, setNewSchemaJson] = useState('{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": false\n}');
  const [newDefaultValJson, setNewDefaultValJson] = useState('{}');
  const [saving, setSaving] = useState(false);

  // Form states for edit metadata
  const [editLabelAr, setEditLabelAr] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editDomain, setEditDomain] = useState('');

  const isPlatformAdmin = userRole === 'platform_admin';

  async function loadDefinitions() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/config/definitions');
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.message || body.error || 'تعذر تحميل تعريفات الإعدادات');
      }
      const data = await res.json();
      setDefinitions(data.definitions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في جلب التعريفات');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDefinitions();
  }, []);

  const handleCreateDefinition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isPlatformAdmin) return;
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      let schemaObj: any;
      let defaultObj: any;
      try {
        schemaObj = JSON.parse(newSchemaJson);
      } catch {
        throw new Error('مخطط (schema) غير مطابق لصيغة JSON الصحيحة');
      }
      try {
        defaultObj = JSON.parse(newDefaultValJson);
      } catch {
        throw new Error('القيمة الافتراضية غير مطابقة لصيغة JSON الصحيحة');
      }

      const res = await apiFetch('/api/config/definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: newKey,
          domain: newDomain,
          labelAr: newLabelAr || null,
          description: newDescription || null,
          schema: schemaObj,
          defaultValue: defaultObj,
          isSystem: false,
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.message || body.error || 'فشل إنشاء التعريف');
      }

      setSuccess('تم إنشاء تعريف الإعداد بنجاح');
      setShowCreateModal(false);
      setNewKey('');
      setNewLabelAr('');
      setNewDescription('');
      await loadDefinitions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في إنشاء التعريف');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateMeta = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isPlatformAdmin || !editingDef) return;
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await apiFetch(`/api/config/definitions/${encodeURIComponent(editingDef.key)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          labelAr: editLabelAr || null,
          description: editDescription || null,
          domain: editDomain || 'general',
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.message || body.error || 'فشل تحديث التعريف');
      }

      setSuccess('تم تحديث بيانات التعريف بنجاح');
      setEditingDef(null);
      await loadDefinitions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطأ في تحديث التعريف');
    } finally {
      setSaving(false);
    }
  };

  if (!isPlatformAdmin) {
    return (
      <div className="w-full bg-slate-900 border border-slate-800 rounded-2xl p-12 text-center flex flex-col items-center gap-3 text-slate-300" dir="rtl">
        <ShieldAlert className="w-10 h-10 text-amber-400" />
        <h3 className="text-base font-bold text-white">غير مصرح لك بالوصول</h3>
        <p className="text-xs text-slate-400">إدارة تعريفات الإعدادات المركزية متاحة لمدير النظام (platform_admin) فقط.</p>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col gap-6" dir="rtl">
      {/* Header */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl backdrop-blur-md flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <SlidersHorizontal className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">تعريفات الإعدادات المركزية (Config Definition Catalog)</h3>
            <p className="text-xs text-slate-400">إدارة كتالوج نقط التكييف والمخططات والقيود على مستوى المنصة</p>
          </div>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-indigo-600/20 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>تعريف إعداد جديد</span>
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={loadDefinitions}
            className="px-3 py-1 bg-red-900/50 hover:bg-red-800/60 text-red-200 rounded-lg font-semibold transition cursor-pointer shrink-0"
          >
            إعادة محاولة
          </button>
        </div>
      )}

      {success && (
        <div className="p-4 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
          <span>{success}</span>
        </div>
      )}

      {/* Definitions Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
        {loading ? (
          <div className="p-12 text-center flex flex-col items-center gap-3 text-slate-400 text-xs">
            <RefreshCw className="w-6 h-6 animate-spin text-indigo-400" />
            <span>جاري تحميل كتالوج التعريفات...</span>
          </div>
        ) : definitions.length === 0 ? (
          <div className="p-12 text-center flex flex-col items-center gap-3 text-slate-400 text-xs">
            <FileCode className="w-8 h-8 text-slate-600" />
            <span>لا توجد تعريفات إعدادات مسجلة — ابدأ بإضافة تعريف جديد</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 font-semibold bg-slate-950/50">
                  <th className="py-3 px-4">مفتاح الإعداد (Key)</th>
                  <th className="py-3 px-4">الاسم العربي / الوصف</th>
                  <th className="py-3 px-4">المجال (Domain)</th>
                  <th className="py-3 px-4">النظام</th>
                  <th className="py-3 px-4 text-left">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {definitions.map((def) => (
                  <tr key={def.id} className="hover:bg-slate-800/30">
                    <td className="py-3 px-4 font-mono font-bold text-indigo-300">{def.key}</td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-white">{def.labelAr || '—'}</div>
                      <div className="text-[11px] text-slate-400">{def.description || 'لا يوجد وصف'}</div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2.5 py-1 rounded-full bg-slate-800 text-slate-300 font-mono text-[11px] border border-slate-700">
                        {def.domain}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {def.isSystem ? (
                        <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 border border-purple-500/30 text-[10px]">
                          نظام
                        </span>
                      ) : (
                        <span className="text-slate-500 text-[11px]">مخصص</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-left">
                      <button
                        onClick={() => {
                          setEditingDef(def);
                          setEditLabelAr(def.labelAr || '');
                          setEditDescription(def.description || '');
                          setEditDomain(def.domain || 'general');
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold transition cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>تعديل الوصف/المجال</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 shadow-2xl flex flex-col gap-4">
            <h4 className="text-sm font-bold text-white border-b border-slate-800 pb-3">إنشاء تعريف إعداد جديد</h4>
            <form onSubmit={handleCreateDefinition} className="flex flex-col gap-4 text-xs">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="font-semibold text-slate-300">مفتاح الإعداد (Key):</label>
                  <input
                    type="text"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="e.g. inventory.valuation_method"
                    required
                    className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2 font-mono"
                  />
                  <span className="text-[10px] text-slate-500">صيغة إجبارية: domain.setting_name</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="font-semibold text-slate-300">المجال (Domain):</label>
                  <select
                    value={newDomain}
                    onChange={(e) => setNewDomain(e.target.value)}
                    className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2"
                  >
                    <option value="system">النظام (system)</option>
                    <option value="accounting">المحاسبة (accounting)</option>
                    <option value="inventory">المستودعات (inventory)</option>
                    <option value="purchasing">المشتريات (purchasing)</option>
                    <option value="general">عام (general)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="font-semibold text-slate-300">الاسم العربي (Label AR):</label>
                  <input
                    type="text"
                    value={newLabelAr}
                    onChange={(e) => setNewLabelAr(e.target.value)}
                    placeholder="مثال: طريقة تقييم المخزون"
                    className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="font-semibold text-slate-300">الوصف:</label>
                  <input
                    type="text"
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    placeholder="شرح موجز للإعداد..."
                    className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">مخطط JSON Schema (JSON):</label>
                <textarea
                  value={newSchemaJson}
                  onChange={(e) => setNewSchemaJson(e.target.value)}
                  rows={6}
                  className="bg-slate-950 border border-slate-800 text-emerald-400 font-mono rounded-xl p-3 resize-none"
                  required
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">القيمة الافتراضية Default Value (JSON):</label>
                <textarea
                  value={newDefaultValJson}
                  onChange={(e) => setNewDefaultValJson(e.target.value)}
                  rows={4}
                  className="bg-slate-950 border border-slate-800 text-emerald-400 font-mono rounded-xl p-3 resize-none"
                  required
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-semibold transition cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-bold transition cursor-pointer"
                >
                  {saving ? 'جاري الحفظ...' : 'حفظ وإنشاء'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Meta Modal */}
      {editingDef && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg p-6 shadow-2xl flex flex-col gap-4" dir="rtl">
            <h4 className="text-sm font-bold text-white border-b border-slate-800 pb-3">
              تعديل بيانات التعريف: <span className="font-mono text-indigo-300">{editingDef.key}</span>
            </h4>
            <form onSubmit={handleUpdateMeta} className="flex flex-col gap-4 text-xs">
              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">مفتاح الإعداد (غير قابل للتعديل):</label>
                <input
                  type="text"
                  value={editingDef.key}
                  disabled
                  className="bg-slate-950/50 border border-slate-800/50 text-slate-500 rounded-xl px-3 py-2 font-mono cursor-not-allowed"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">المجال (Domain):</label>
                <select
                  value={editDomain}
                  onChange={(e) => setEditDomain(e.target.value)}
                  className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2"
                >
                  <option value="system">النظام (system)</option>
                  <option value="accounting">المحاسبة (accounting)</option>
                  <option value="inventory">المستودعات (inventory)</option>
                  <option value="purchasing">المشتريات (purchasing)</option>
                  <option value="general">عام (general)</option>
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">الاسم العربي (Label AR):</label>
                <input
                  type="text"
                  value={editLabelAr}
                  onChange={(e) => setEditLabelAr(e.target.value)}
                  className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">الوصف:</label>
                <input
                  type="text"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="bg-slate-950 border border-slate-800 text-slate-200 rounded-xl px-3 py-2"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-slate-300">مخطط JSON Schema (غير قابل للتعديل):</label>
                <textarea
                  value={JSON.stringify(editingDef.schema || {}, null, 2)}
                  disabled
                  rows={4}
                  className="bg-slate-950/50 border border-slate-800/50 text-slate-500 font-mono rounded-xl p-3 resize-none cursor-not-allowed"
                />
              </div>

              <div className="p-3 bg-amber-950/20 border border-amber-800/40 rounded-xl text-amber-300 text-[11px]">
                ملاحظة: المفتاح ومخطط JSON Schema والقيمة الافتراضية غير قابلة للتعديل بعد الإنشاء للحفاظ على سلامة الإصدارات المنشورة ونتائج resolve.
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditingDef(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-semibold transition cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-bold transition cursor-pointer"
                >
                  {saving ? 'جاري التحديث...' : 'حفظ التعديلات'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
