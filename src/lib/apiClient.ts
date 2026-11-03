/**
 * Frontend API client with automatic CSRF token management and retry support
 */

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(';').shift() || null;
  return null;
}

export async function refreshCsrfToken(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/csrf', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      return data.csrfToken || getCookie('an_csrf');
    }
  } catch (err) {
    console.error('[apiClient] Failed to refresh CSRF token:', err);
  }
  return null;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', headers.get('Content-Type') || 'application/json');

  if (isMutating) {
    let csrfToken = getCookie('an_csrf');
    if (!csrfToken) {
      csrfToken = await refreshCsrfToken();
    }
    if (csrfToken) {
      headers.set('x-csrf-token', csrfToken);
    }
  }

  const reqInit: RequestInit = {
    ...init,
    method,
    headers,
    credentials: 'include',
  };

  let res = await fetch(path, reqInit);

  // If CSRF token invalid, refresh token and retry ONCE
  if (res.status === 403 && isMutating) {
    const clone = res.clone();
    try {
      const errorData = await clone.json();
      if (errorData.code === 'CSRF_INVALID') {
        console.warn('[apiClient] CSRF token invalid. Refreshing token and retrying request...');
        const newCsrfToken = await refreshCsrfToken();
        if (newCsrfToken) {
          headers.set('x-csrf-token', newCsrfToken);
          res = await fetch(path, { ...reqInit, headers });
        }
      }
    } catch {
      // Ignore JSON parse error on non-JSON response
    }
  }

  return res;
}
