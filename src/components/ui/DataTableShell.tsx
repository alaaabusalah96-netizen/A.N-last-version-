import React from 'react';
import { EmptyState, EmptyStateProps } from './EmptyState.js';
import { LoadingState } from './LoadingState.js';

export interface DataTableShellProps {
  title?: string;
  subtitle?: string;
  toolbar?: React.ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  isEmpty?: boolean;
  emptyState?: EmptyStateProps;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

/**
 * Shared RTL data table frame enforcing single-elevation contrast, horizontal scroll safety,
 * tabular numerals, and uniform loading/empty states.
 */
export function DataTableShell({
  title,
  subtitle,
  toolbar,
  loading = false,
  loadingLabel = 'جاري تحميل البيانات...',
  isEmpty = false,
  emptyState,
  children,
  footer,
  className = '',
}: DataTableShellProps) {
  return (
    <div
      dir="rtl"
      className={`bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl ${className}`}
    >
      {(title || toolbar) && (
        <div className="px-4 py-3.5 border-b border-slate-800 bg-slate-950/40 flex flex-wrap items-center justify-between gap-3">
          {title && (
            <div className="min-w-0">
              <h4 className="text-sm font-bold text-white truncate">{title}</h4>
              {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
            </div>
          )}
          {toolbar && <div className="flex flex-wrap items-center gap-2 shrink-0">{toolbar}</div>}
        </div>
      )}

      {loading ? (
        <LoadingState label={loadingLabel} />
      ) : isEmpty && emptyState ? (
        <div className="p-4">
          <EmptyState {...emptyState} />
        </div>
      ) : (
        <div className="overflow-x-auto tabular-nums">{children}</div>
      )}

      {footer && (
        <div className="px-4 py-3 border-t border-slate-800 bg-slate-950/50 text-xs text-slate-400">
          {footer}
        </div>
      )}
    </div>
  );
}
