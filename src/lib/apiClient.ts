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
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        return data.csrfToken || getCookie('an_csrf');
      }
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
      const contentType = clone.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const errorData = await clone.json();
        if (errorData.code === 'CSRF_INVALID') {
          console.warn('[apiClient] CSRF token invalid. Refreshing token and retrying request...');
          const newCsrfToken = await refreshCsrfToken();
          if (newCsrfToken) {
            headers.set('x-csrf-token', newCsrfToken);
            res = await fetch(path, { ...reqInit, headers });
          }
        }
      }
    } catch {
      // Ignore JSON parse error on non-JSON response
    }
  }

  return normalizeApiResponse(path, res);
}

/** Arabic message for a failed request whose body is not JSON (proxy page, HTML, empty). */
export function arabicHttpErrorMessage(status: number): string {
  if (status === 401) return 'انتهت الجلسة. سجّل الدخول من جديد.';
  if (status === 403) return 'ليست لديك صلاحية لتنفيذ هذه العملية. اطلب الصلاحية من مدير الشركة.';
  if (status === 404) return 'الخدمة المطلوبة غير موجودة. حدّث الصفحة وحاول مرة أخرى.';
  if (status === 429) return 'طلبات كثيرة في وقت قصير. انتظر قليلاً ثم حاول مرة أخرى.';
  if (status >= 500) return 'تعذّر على الخادم تنفيذ الطلب. حاول بعد قليل، وإن تكرر أبلغ المسؤول.';
  return 'تعذّر تنفيذ الطلب. تحقق من البيانات وحاول مرة أخرى.';
}

/**
 * Never let a screen read raw HTML as JSON ("Unexpected token <") or show "HTTP 403".
 * A failed API answer that is not JSON, or an API path answered with an HTML page, becomes a JSON
 * answer with the same status and an Arabic message. JSON answers are returned untouched.
 */
export function normalizeApiResponse(path: string, res: Response): Response {
  if (!path.startsWith('/api/')) return res;
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const isJson = contentType.includes('application/json');
  const isHtmlOk = res.ok && contentType.includes('text/html');
  if ((res.ok && !isHtmlOk) || isJson) return res;
  if (res.status === 204 || res.status === 304) return res;
  const status = isHtmlOk ? 502 : res.status;
  const message = isHtmlOk
    ? 'وصل رد غير متوقع من الخادم. حدّث الصفحة وسجّل الدخول من جديد إن لزم.'
    : arabicHttpErrorMessage(res.status);
  return new Response(JSON.stringify({ error: message, message, code: `HTTP_${status}` }), {
    status,
    statusText: res.statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}
