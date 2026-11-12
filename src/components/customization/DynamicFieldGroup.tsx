import React from 'react';

export type DynamicFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select';

export interface DynamicFieldDefinition {
  id: string;
  fieldKey: string;
  labelAr: string;
  fieldType: DynamicFieldType;
  options: string[] | null;
  isRequired: boolean;
  isActive: boolean;
  sortOrder: number;
  helpText: string | null;
}

export type DynamicFieldValuesMap = Record<string, string | number | boolean | null>;

interface DynamicFieldGroupProps {
  fields: DynamicFieldDefinition[];
  values: DynamicFieldValuesMap;
  errors?: Record<string, string>;
  onChange: (fieldId: string, value: string | number | boolean | null) => void;
  disabled?: boolean;
}

export function validateRequiredDynamicFields(
  fields: DynamicFieldDefinition[],
  values: DynamicFieldValuesMap
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (!field.isActive || !field.isRequired) continue;
    if (field.fieldType === 'boolean') continue;
    const raw = values[field.id];
    const isEmpty =
      raw === undefined ||
      raw === null ||
      (typeof raw === 'string' && raw.trim() === '');
    if (isEmpty) {
      errors[field.id] = `الحقل «${field.labelAr}» إلزامي`;
    }
  }
  return errors;
}

export function DynamicFieldGroup({
  fields,
  values,
  errors = {},
  onChange,
  disabled = false,
}: DynamicFieldGroupProps) {
  const ordered = [...fields]
    .filter((f) => f.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  if (ordered.length === 0) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" dir="rtl">
      {ordered.map((field) => {
        const rawVal = values[field.id];
        const fieldError = errors[field.id];
        const inputBorderClass = fieldError
          ? 'border-rose-500/80 focus:border-rose-400'
          : 'border-slate-800 focus:border-indigo-500';

        return (
          <div
            key={field.id}
            className="bg-slate-950/60 border border-slate-800 rounded-xl p-3.5 flex flex-col gap-1.5"
          >
            {field.fieldType !== 'boolean' && (
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1">
                <span>{field.labelAr}</span>
                {field.isRequired && <span className="text-rose-400 font-bold">*</span>}
              </label>
            )}

            {field.fieldType === 'text' && (
              <input
                type="text"
                disabled={disabled}
                value={typeof rawVal === 'string' ? rawVal : rawVal !== null && rawVal !== undefined ? String(rawVal) : ''}
                onChange={(e) => onChange(field.id, e.target.value)}
                placeholder={field.helpText || `أدخل ${field.labelAr}`}
                className={`w-full px-3 py-2 bg-slate-900 border ${inputBorderClass} rounded-lg text-xs text-white focus:outline-none disabled:opacity-60`}
              />
            )}

            {field.fieldType === 'number' && (
              <input
                type="number"
                step="any"
                disabled={disabled}
                value={rawVal === null || rawVal === undefined ? '' : String(rawVal)}
                onChange={(e) => onChange(field.id, e.target.value)}
                placeholder={field.helpText || '0'}
                className={`w-full px-3 py-2 bg-slate-900 border ${inputBorderClass} rounded-lg text-xs text-white font-mono focus:outline-none disabled:opacity-60`}
              />
            )}

            {field.fieldType === 'date' && (
              <input
                type="date"
                disabled={disabled}
                value={typeof rawVal === 'string' ? rawVal.slice(0, 10) : ''}
                onChange={(e) => onChange(field.id, e.target.value)}
                className={`w-full px-3 py-2 bg-slate-900 border ${inputBorderClass} rounded-lg text-xs text-white font-mono focus:outline-none disabled:opacity-60`}
              />
            )}

            {field.fieldType === 'boolean' && (
              <label className="flex items-center gap-2.5 cursor-pointer py-1.5">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={rawVal === true}
                  onChange={(e) => onChange(field.id, e.target.checked)}
                  className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500 cursor-pointer disabled:opacity-60"
                />
                <span className="text-xs font-semibold text-slate-200 flex items-center gap-1">
                  <span>{field.labelAr}</span>
                  {field.isRequired && <span className="text-rose-400 font-bold">*</span>}
                </span>
              </label>
            )}

            {field.fieldType === 'select' && (
              <select
                disabled={disabled}
                value={typeof rawVal === 'string' ? rawVal : ''}
                onChange={(e) => onChange(field.id, e.target.value)}
                className={`w-full px-3 py-2 bg-slate-900 border ${inputBorderClass} rounded-lg text-xs text-white focus:outline-none cursor-pointer disabled:opacity-60`}
              >
                <option value="">-- اختر --</option>
                {(field.options || []).map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            )}

            {field.helpText && (
              <span className="text-[11px] text-slate-500">{field.helpText}</span>
            )}

            {fieldError && (
              <span className="text-[11px] text-rose-400 font-medium">{fieldError}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
