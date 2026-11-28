import React, { useState } from 'react';
import { X } from 'lucide-react';

export interface EditField {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'checkbox';
  required?: boolean;
}

interface Props {
  title: string;
  fields: EditField[];
  initial: Record<string, any>;
  onSave: (values: Record<string, any>) => Promise<void>;
  onClose: () => void;
}

export function EditRecordModal({ title, fields, initial, onSave, onClose }: Props) {
  const [values, setValues] = useState<Record<string, any>>(() => {
    const v: Record<string, any> = {};
    for (const f of fields) v[f.key] = initial[f.key] ?? (f.type === 'checkbox' ? false : '');
    return v;
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    for (const f of fields) {
      if (f.required && !String(values[f.key] ?? '').trim()) {
        setErr(`${f.label} مطلوب`);
        return;
      }
    }
    setBusy(true);
    setErr(null);
    try {
      await onSave(values);
    } catch (ex: any) {
      setErr(ex?.message || 'فشل الحفظ');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" role="dialog" aria-label={title}>
      <form onSubmit={submit} className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white">{title}</h3>
          <button type="button" onClick={onClose} aria-label="إغلاق"><X className="w-4 h-4 text-slate-400" /></button>
        </div>
        {fields.map((f) =>
          f.type === 'checkbox' ? (
            <label key={f.key} className="flex items-center gap-2 text-xs text-slate-200">
              <input
                type="checkbox"
                name={`edit-${f.key}`}
                checked={!!values[f.key]}
                onChange={(e) => setValues((p) => ({ ...p, [f.key]: e.target.checked }))}
              />
              {f.label}
            </label>
          ) : (
            <label key={f.key} className="block text-xs text-slate-400 space-y-1">
              <span>{f.label}</span>
              <input
                name={`edit-${f.key}`}
                type={f.type === 'number' ? 'number' : 'text'}
                step={f.type === 'number' ? 'any' : undefined}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((p) => ({ ...p, [f.key]: e.target.value }))}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white"
              />
            </label>
          )
        )}
        {err && <div className="text-xs text-rose-300 bg-rose-950/60 border border-rose-800/80 rounded-xl p-2">{err}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-slate-300 text-xs cursor-pointer">إلغاء</button>
          <button type="submit" disabled={busy} className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white rounded-xl text-xs font-bold cursor-pointer">حفظ التعديل</button>
        </div>
      </form>
    </div>
  );
}
