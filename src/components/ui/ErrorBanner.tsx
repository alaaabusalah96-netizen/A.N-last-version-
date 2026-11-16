import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

export interface ErrorBannerProps {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorBanner({
  message,
  onRetry,
  retryLabel = 'إعادة المحاولة',
  className = '',
}: ErrorBannerProps) {
  return (
    <div
      dir="rtl"
      role="alert"
      className={`p-3.5 bg-red-950/40 border border-red-800/60 rounded-xl text-red-200 text-xs flex flex-wrap items-center justify-between gap-3 ${className}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <AlertCircle className="w-4 h-4 shrink-0 text-red-400" aria-hidden="true" />
        <span className="break-words">{message}</span>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-900/50 hover:bg-red-800/60 text-red-100 text-xs font-medium transition cursor-pointer whitespace-nowrap shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{retryLabel}</span>
        </button>
      )}
    </div>
  );
}
