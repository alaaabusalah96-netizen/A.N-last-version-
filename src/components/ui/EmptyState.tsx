import React from 'react';
import { Inbox } from 'lucide-react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  actionLabel,
  onAction,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      dir="rtl"
      className={`flex flex-col items-center justify-center text-center py-10 px-6 border border-dashed border-slate-800 rounded-xl bg-slate-950/30 ${className}`}
    >
      <div className="w-10 h-10 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 mb-3">
        {icon || <Inbox className="w-5 h-5" aria-hidden="true" />}
      </div>
      <p className="text-sm font-semibold text-slate-200">{title}</p>
      {description && <p className="text-xs text-slate-400 mt-1 max-w-md">{description}</p>}
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-4 inline-flex items-center justify-center px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition cursor-pointer whitespace-nowrap shrink-0"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
