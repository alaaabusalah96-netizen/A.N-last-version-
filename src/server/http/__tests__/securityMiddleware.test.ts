import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applySecurityMiddleware } from '../securityMiddleware.js';

const PREVIEW_HOST_DEV =
  'https://ais-dev-6vklnibghlun634krwmxyl-925777775579.europe-west2.run.app';
const PREVIEW_HOST_PRE =
  'https://ais-pre-6vklnibghlun634krwmxyl-925777775579.europe-west2.run.app';

function parseCspDirectives(header: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const name = tokens[0].toLowerCase();
    directives[name] = tokens.slice(1);
  }
  return directives;
}

async function requestWithSecurityMiddleware(
  nodeEnv: string,
  extraEnv: Record<string, string> = {}
): Promise<{ status: number; cspHeader: string | null }> {
  process.env.NODE_ENV = nodeEnv;
  for (const [key, value] of Object.entries(extraEnv)) {
    process.env[key] = value;
  }

  const app = express();
  applySecurityMiddleware(app);
  app.get('/__csp_probe', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const server = await new Promise<http.Server>((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });

  try {
    const address = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${address.port}/__csp_probe`);
    return {
      status: res.status,
      cspHeader: res.headers.get('content-security-policy'),
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('applySecurityMiddleware Production CSP Hardening', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CORS_ORIGINS;
    delete process.env.TRUST_PROXY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('T01: In production, response contains Content-Security-Policy', async () => {
    const { status, cspHeader } = await requestWithSecurityMiddleware('production');
    expect(status).toBe(200);
    expect(cspHeader).toBeTruthy();
  });

  it("T02: Production connect-src contains 'self'", async () => {
    const { cspHeader } = await requestWithSecurityMiddleware('production');
    const directives = parseCspDirectives(cspHeader || '');
    expect(directives['connect-src']).toContain("'self'");
  });

  it('T03: Production connect-src does not contain https://*.ai.studio', async () => {
    const { cspHeader } = await requestWithSecurityMiddleware('production');
    const directives = parseCspDirectives(cspHeader || '');
    expect(directives['connect-src']).not.toContain('https://*.ai.studio');
  });

  it('T04: Production connect-src does not contain either Preview Cloud Run host', async () => {
    const { cspHeader } = await requestWithSecurityMiddleware('production');
    const directives = parseCspDirectives(cspHeader || '');
    expect(directives['connect-src']).not.toContain(PREVIEW_HOST_DEV);
    expect(directives['connect-src']).not.toContain(PREVIEW_HOST_PRE);
  });

  it("T05: Production frame-ancestors contains 'self'", async () => {
    const { cspHeader } = await requestWithSecurityMiddleware('production');
    const directives = parseCspDirectives(cspHeader || '');
    expect(directives['frame-ancestors']).toContain("'self'");
  });

  it('T06: Production frame-ancestors does not contain https://*.ai.studio', async () => {
    const { cspHeader } = await requestWithSecurityMiddleware('production');
    const directives = parseCspDirectives(cspHeader || '');
    expect(directives['frame-ancestors']).not.toContain('https://*.ai.studio');
  });

  it('T07: Production frame-ancestors does not contain either Preview Cloud Run host', async () => {
    const { cspHeader } = await requestWithSecurityMiddleware('production');
    const directives = parseCspDirectives(cspHeader || '');
    expect(directives['frame-ancestors']).not.toContain(PREVIEW_HOST_DEV);
    expect(directives['frame-ancestors']).not.toContain(PREVIEW_HOST_PRE);
  });

  it('T08: Production frame-ancestors retains the exact https://aistudio.google.com', async () => {
    const { cspHeader } = await requestWithSecurityMiddleware('production');
    const directives = parseCspDirectives(cspHeader || '');
    expect(directives['frame-ancestors']).toEqual(["'self'", 'https://aistudio.google.com']);
  });

  it('T09: Production connect-src retains the exact https://aistudio.google.com', async () => {
    const { cspHeader } = await requestWithSecurityMiddleware('production');
    const directives = parseCspDirectives(cspHeader || '');
    expect(directives['connect-src']).toEqual(["'self'", 'https://aistudio.google.com']);
  });

  it("T10: Production default-src remains 'self'", async () => {
    const { cspHeader } = await requestWithSecurityMiddleware('production');
    const directives = parseCspDirectives(cspHeader || '');
    expect(directives['default-src']).toEqual(["'self'"]);
  });

  it("T11: Production object-src remains 'none'", async () => {
    const { cspHeader } = await requestWithSecurityMiddleware('production');
    const directives = parseCspDirectives(cspHeader || '');
    expect(directives['object-src']).toEqual(["'none'"]);
  });

  it("T12: Production form-action remains 'self'", async () => {
    const { cspHeader } = await requestWithSecurityMiddleware('production');
    const directives = parseCspDirectives(cspHeader || '');
    expect(directives['form-action']).toEqual(["'self'"]);
  });

  it('T13: Non-production behavior remains unchanged (CSP disabled when NODE_ENV is not production)', async () => {
    const devRes = await requestWithSecurityMiddleware('development');
    expect(devRes.status).toBe(200);
    expect(devRes.cspHeader).toBeNull();

    const testRes = await requestWithSecurityMiddleware('test');
    expect(testRes.status).toBe(200);
    expect(testRes.cspHeader).toBeNull();
  });

  it('does not inject CORS_ORIGINS into production CSP directives', async () => {
    const { cspHeader } = await requestWithSecurityMiddleware('production', {
      CORS_ORIGINS: 'https://custom-partner.example.com',
    });
    expect(cspHeader).toBeTruthy();
    expect(cspHeader).not.toContain('https://custom-partner.example.com');
  });
});

describe('Static security verification for securityMiddleware.ts', () => {
  it('verifies no wildcard *.ai.studio or Preview Cloud Run hosts remain and all directives & Helmet options are preserved', () => {
    const filePath = path.resolve(process.cwd(), 'src/server/http/securityMiddleware.ts');
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).not.toContain('*.ai.studio');
    expect(source).not.toContain('ais-dev-');
    expect(source).not.toContain('ais-pre-');
    expect(source).not.toContain('.run.app');
    expect(source).not.toContain('CORS_ORIGINS');

    for (const requiredDirective of [
      'defaultSrc:',
      'scriptSrc:',
      'styleSrc:',
      'imgSrc:',
      'connectSrc:',
      'objectSrc:',
      'baseUri:',
      'formAction:',
      'frameAncestors:',
    ]) {
      expect(source).toContain(requiredDirective);
    }

    expect(source).toContain('crossOriginEmbedderPolicy: false');
    expect(source).toContain('frameguard: false');
    expect(source).toContain("app.set('trust proxy', 1)");
  });
});
