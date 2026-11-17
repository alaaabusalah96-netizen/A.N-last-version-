import http from 'node:http';
import type { Request, Response } from 'express';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../../app.js';
import { createCsrfProtection } from '../csrfProtection.js';

describe('CSRF Safe-Method Origin Validation & Mutation Protection', () => {
  const originalEnv = { ...process.env };
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    process.env = { ...originalEnv };
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    delete process.env.CORS_ORIGINS;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    if (originalEnv.CORS_ORIGINS !== undefined) {
      process.env.CORS_ORIGINS = originalEnv.CORS_ORIGINS;
    } else {
      delete process.env.CORS_ORIGINS;
    }
  });

  it('rejects GET /api/auth/csrf at HTTP/CORS layer with 403 when untrusted *.ai.studio Origin is sent', async () => {
    const res = await fetch(`${baseUrl}/api/auth/csrf`, {
      method: 'GET',
      headers: {
        Origin: 'https://evil-other-app.ai.studio',
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('CORS_FORBIDDEN');
  });

  it('rejects GET /api/auth/csrf in production at HTTP/CORS layer when Preview Origin is sent', async () => {
    process.env.NODE_ENV = 'production';
    const res = await fetch(`${baseUrl}/api/auth/csrf`, {
      method: 'GET',
      headers: {
        Origin: 'https://ais-dev-6vklnibghlun634krwmxyl-925777775579.europe-west2.run.app',
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('CORS_FORBIDDEN');
  });

  it('allows GET /api/auth/csrf with trusted production Origin in production', async () => {
    process.env.NODE_ENV = 'production';
    const res = await fetch(`${baseUrl}/api/auth/csrf`, {
      method: 'GET',
      headers: {
        Origin: 'https://erp-platform-foundation.ai.studio',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.csrfToken).toBe('string');
    expect(body.csrfToken.length).toBeGreaterThan(10);
  });

  it('allows GET /api/auth/csrf without an Origin header', async () => {
    const res = await fetch(`${baseUrl}/api/auth/csrf`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.csrfToken).toBe('string');
  });

  it('defense-in-depth: createCsrfProtection rejects safe-method GET/HEAD/OPTIONS with untrusted Origin using 403 CSRF_ORIGIN', () => {
    process.env.NODE_ENV = 'production';
    const mw = createCsrfProtection({
      secret: 'test-csrf-secret-at-least-32-characters-long',
      isProd: true,
      strict: true,
    });

    for (const method of ['GET', 'HEAD', 'OPTIONS'] as const) {
      const jsonSpy = vi.fn();
      const statusSpy = vi.fn(() => ({ json: jsonSpy }));
      const nextSpy = vi.fn();
      const req = {
        method,
        headers: { origin: 'https://evil-other-app.ai.studio' },
      } as unknown as Request;
      const res = { status: statusSpy } as unknown as Response;

      mw(req, res, nextSpy);

      expect(nextSpy).not.toHaveBeenCalled();
      expect(statusSpy).toHaveBeenCalledWith(403);
      expect(jsonSpy).toHaveBeenCalledWith({
        error: 'Forbidden',
        code: 'CSRF_ORIGIN',
        message: 'Origin header not allowed',
      });
    }
  });

  it('createCsrfProtection allows safe-method GET with trusted Origin or no Origin and still enforces CSRF token on POST mutations', () => {
    process.env.NODE_ENV = 'production';
    const mw = createCsrfProtection({
      secret: 'test-csrf-secret-at-least-32-characters-long',
      isProd: true,
      strict: true,
    });

    const nextTrusted = vi.fn();
    mw(
      {
        method: 'GET',
        headers: { origin: 'https://erp-platform-foundation.ai.studio' },
      } as unknown as Request,
      { status: vi.fn() } as unknown as Response,
      nextTrusted
    );
    expect(nextTrusted).toHaveBeenCalledOnce();

    const nextNoOrigin = vi.fn();
    mw(
      { method: 'GET', headers: {} } as unknown as Request,
      { status: vi.fn() } as unknown as Response,
      nextNoOrigin
    );
    expect(nextNoOrigin).toHaveBeenCalledOnce();

    const jsonPostSpy = vi.fn();
    const statusPostSpy = vi.fn(() => ({ json: jsonPostSpy }));
    const nextPostSpy = vi.fn();
    mw(
      {
        method: 'POST',
        headers: { origin: 'https://erp-platform-foundation.ai.studio' },
        cookies: {},
      } as unknown as Request,
      { status: statusPostSpy } as unknown as Response,
      nextPostSpy
    );
    expect(nextPostSpy).not.toHaveBeenCalled();
    expect(statusPostSpy).toHaveBeenCalledWith(403);
    expect(jsonPostSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Forbidden' })
    );
  });
});
