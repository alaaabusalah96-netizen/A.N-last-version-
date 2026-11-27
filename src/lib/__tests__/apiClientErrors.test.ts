import { describe, it, expect } from 'vitest';
import { normalizeApiResponse, arabicHttpErrorMessage } from '../apiClient';
import { canAccessNav } from '../navAccess';

describe('apiClient error normalisation', () => {
  it('turns an HTML 403 into a JSON Arabic message with the same status', async () => {
    const res = normalizeApiResponse('/api/companies', new Response('<html>Forbidden</html>', { status: 403, headers: { 'Content-Type': 'text/html' } }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe(arabicHttpErrorMessage(403));
    expect(data.error).toMatch(/صلاحية/);
  });
  it('turns an API path answered with an HTML page into an error', async () => {
    const res = normalizeApiResponse('/api/config/platform', new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    expect(res.ok).toBe(false);
    const data = await res.json();
    expect(data.code).toBe('HTTP_502');
  });
  it('leaves JSON answers and successful answers untouched', async () => {
    const ok = new Response('{"a":1}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    expect(normalizeApiResponse('/api/x', ok)).toBe(ok);
    const bad = new Response('{"error":"x"}', { status: 400, headers: { 'Content-Type': 'application/json' } });
    expect(normalizeApiResponse('/api/x', bad)).toBe(bad);
  });
});

describe('sidebar access', () => {
  it('shows nothing sensitive to a user with no permissions', () => {
    for (const k of ['accounting', 'inventory', 'purchasing', 'sales', 'cash', 'fleet', 'users', 'roles', 'org_units', 'company_settings', 'custom_fields', 'config_platform', 'config_definitions', 'companies'] as const) {
      expect(canAccessNav(k, 'user', [])).toBe(false);
    }
  });
  it('shows only the sections matching a permission', () => {
    expect(canAccessNav('sales', 'user', ['sales:read'])).toBe(true);
    expect(canAccessNav('purchasing', 'user', ['sales:read'])).toBe(false);
  });
  it('keeps platform settings for admins only', () => {
    expect(canAccessNav('config_definitions', 'company_admin', [])).toBe(false);
    expect(canAccessNav('config_definitions', 'platform_admin', [])).toBe(true);
    expect(canAccessNav('config_platform', 'company_admin', [])).toBe(true);
  });
});
