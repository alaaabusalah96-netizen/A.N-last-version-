import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createApp } from '../app.js';

describe('P0 HTTP Route Mounting (C1 Verification)', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      // Listen on ephemeral port (port 0) on loopback
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address() as { port: number; address: string };
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('GET /api/accounting/accounts without auth returns 401 Unauthorized, NOT 404', async () => {
    const res = await fetch(`${baseUrl}/api/accounting/accounts`);
    expect(res.status).not.toBe(404);
    // Should be 401 since requireAuth protects this route
    expect([401, 403]).toContain(res.status);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('GET /api/users without auth returns 401 Unauthorized, NOT 404', async () => {
    const res = await fetch(`${baseUrl}/api/users`);
    expect(res.status).not.toBe(404);
    // Should be 401 since requireAuth protects this route
    expect([401, 403]).toContain(res.status);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('GET /api/nonexistent-route returns 404 Not Found', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent-route`);
    expect(res.status).toBe(404);
  });
});
