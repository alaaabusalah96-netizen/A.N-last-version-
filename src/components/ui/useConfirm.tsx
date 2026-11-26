import React, { useCallback, useRef, useState } from 'react';

/**
 * In-app replacement for the native browser confirm dialog.
 * Sandboxed iframes (AI Studio preview/published app) silently block native dialogs, so
 * the native dialog returns false without showing anything and the action button looks frozen.
 */
export function useConfirm(): [(message: string) => Promise<boolean>, React.ReactNode] {
  const [message, setMessage] = useState<string | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirmFn = useCallback((msg: string) => {
    return new Promise<boolean>((resolve) => {
      resolver.current?.(false);
      resolver.current = resolve;
      setMessage(msg);
    });
  }, []);

  const close = (v: boolean) => {
    const r = resolver.current;
    resolver.current = null;
    setMessage(null);
    r?.(v);
  };

  const dialog = message === null ? null : (
    <div
      role="dialog"
      aria-modal="true"
      dir="rtl"
      data-testid="confirm-dialog"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }}
    >
      <div style={{ background: '#fff', borderRadius: 8, padding: 20, minWidth: 300, maxWidth: 420, boxShadow: '0 8px 30px rgba(0,0,0,0.3)' }}>
        <p style={{ margin: '0 0 16px', fontSize: 15 }}>{message}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-start' }}>
          <button type="button" data-testid="confirm-yes" onClick={() => close(true)} style={{ padding: '6px 16px', background: '#2563eb', color: '#fff', border: 0, borderRadius: 6, cursor: 'pointer' }}>
            تأكيد
          </button>
          <button type="button" data-testid="confirm-no" onClick={() => close(false)} style={{ padding: '6px 16px', background: '#e5e7eb', border: 0, borderRadius: 6, cursor: 'pointer' }}>
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );

  return [confirmFn, dialog];
}
