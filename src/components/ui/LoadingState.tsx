import React from 'react';
import { RefreshCw } from 'lucide-react';

export interface LoadingStateProps {
  label?: string;
  rows?: number;
  className?: string;
}

export function LoadingState({
  label = 'جاري تحميل البيانات...',
  rows = 3,
  className = '',
}: LoadingStateProps) {
  return (
    <div
      dir="rtl"
      aria-live="polite"
      className={`py-8 px-4 flex flex-col items-center justify-center gap-3 text-slate-400 ${className}`}
    >
      <div className="flex items-center gap-2 text-xs font-medium">
        <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" aria-hidden="true" />
        <span>{label}</span>
      </div>
      {rows > 0 && (
        <div className="w-full max-w-2xl space-y-2 mt-1">
          {Array.from({ length: rows }).map((_, idx) => (
            <div
              key={idx}
              className="h-8 rounded-lg bg-slate-800/50 animate-pulse"
            />
          ))}
        </div>
      )}
    </div>
  );
}
