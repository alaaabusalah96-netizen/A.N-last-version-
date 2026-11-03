/**
 * Testkit helper for foundation verification scripts
 */

export interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  detail?: string;
}

const results: TestResult[] = [];
let isBlocked = false;
let blockReason = '';

const isDbRequired = process.env.REQUIRE_DB === '1' || process.env.REQUIRE_DB === 'true' || process.env.CI === 'true';

export async function check(
  name: string,
  condition: boolean | (() => boolean | Promise<boolean>),
  detail?: string
): Promise<boolean> {
  let passed = false;
  try {
    if (typeof condition === 'function') {
      passed = await condition();
    } else {
      passed = Boolean(condition);
    }
  } catch (err) {
    passed = false;
    detail = detail || (err instanceof Error ? err.message : String(err));
  }

  if (passed) {
    results.push({ name, status: 'PASS', detail });
    console.log(`[PASS] ${name}${detail ? ` - ${detail}` : ''}`);
    return true;
  } else {
    results.push({ name, status: 'FAIL', detail });
    console.error(`[FAIL] ${name}${detail ? ` - ${detail}` : ''}`);
    return false;
  }
}

export function blocked(reason: string): void {
  isBlocked = true;
  blockReason = reason;
  const status = isDbRequired ? 'FAIL' : 'BLOCKED';
  const label = isDbRequired ? '[FAIL - BLOCKED]' : '[BLOCKED]';
  results.push({ name: reason, status: isDbRequired ? 'FAIL' : 'BLOCKED', detail: reason });
  console.log(`${label} ${reason}${isDbRequired ? ' (Failing because REQUIRE_DB=1 or CI=true)' : ''}`);
}

export function summary(): { passed: number; failed: number; blocked: number; exitCode: number } {
  let passedCount = 0;
  let failedCount = 0;
  let blockedCount = 0;

  for (const r of results) {
    if (r.status === 'PASS') passedCount++;
    else if (r.status === 'FAIL') failedCount++;
    else if (r.status === 'BLOCKED') blockedCount++;
  }

  if (isBlocked && results.length === 0) {
    if (isDbRequired) failedCount++;
    else blockedCount++;
  }

  console.log(`\nSummary -> Passed: ${passedCount} | Failed: ${failedCount} | Blocked: ${blockedCount}`);

  let exitCode = 0;
  if (failedCount > 0) {
    exitCode = 1;
  } else if (blockedCount > 0) {
    exitCode = isDbRequired ? 1 : 2;
  }

  return { passed: passedCount, failed: failedCount, blocked: blockedCount, exitCode };
}

/**
 * Cookie Jar fetch client for E2E HTTP integration tests
 */
export class CookieJarFetch {
  private cookies: Map<string, string> = new Map();

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers || {});

    // Attach existing cookies
    if (this.cookies.size > 0) {
      const cookieStr = Array.from(this.cookies.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      headers.set('Cookie', cookieStr);
    }

    const res = await fetch(url, { ...init, headers });

    // Store new cookies from set-cookie headers
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookies.length === 0 && res.headers.get('set-cookie')) {
      const raw = res.headers.get('set-cookie')!;
      setCookies.push(...raw.split(/,(?=\s*[^;=]+=[^;]+)/));
    }

    for (const sc of setCookies) {
      const parts = sc.split(';')[0].trim();
      const eqIdx = parts.indexOf('=');
      if (eqIdx > 0) {
        const name = parts.substring(0, eqIdx).trim();
        const val = parts.substring(eqIdx + 1).trim();
        if (val) {
          this.cookies.set(name, val);
        } else {
          this.cookies.delete(name);
        }
      }
    }

    return res;
  }

  getCookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  clear(): void {
    this.cookies.clear();
  }
}

/**
 * Helper to log in a user and rotate/store the new session & CSRF token
 */
export async function loginAs(
  jar: CookieJarFetch,
  baseUrl: string,
  username: string,
  password: string
): Promise<{ csrfToken: string; user: any }> {
  const csrfRes = await jar.fetch(`${baseUrl}/api/auth/csrf`);
  const csrfData = await csrfRes.json();
  const preLoginToken = csrfData.csrfToken;

  const loginRes = await jar.fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': preLoginToken,
    },
    body: JSON.stringify({ username, password }),
  });

  if (!loginRes.ok) {
    const errData = await loginRes.json().catch(() => ({}));
    throw new Error(`loginAs failed for '${username}': HTTP ${loginRes.status} ${JSON.stringify(errData)}`);
  }

  const loginData = await loginRes.json();
  const postLoginToken = loginData.csrfToken;

  return { csrfToken: postLoginToken, user: loginData.user };
}
