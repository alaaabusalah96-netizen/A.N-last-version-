import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, Plugin } from 'vite';

// In-memory dev sessions and companies for Vite dev server middleware
const devSessions = new Map<string, { username: string; role: string }>();
const devCompanies: Array<{
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
}> = [
  {
    id: 'comp-main-001',
    code: 'HQ01',
    nameAr: 'شركة المنصة المركزية',
    nameEn: 'Central Platform Co',
    isActive: true,
    createdAt: new Date().toISOString(),
    createdBy: 'admin',
  },
];

function devApiPlugin(): Plugin {
  return {
    name: 'an-erp-dev-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Health check
        if (req.url === '/api/health') {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              status: 'ok',
              service: 'an-erp-platform',
              phase: 'P04',
              time: new Date().toISOString(),
            })
          );
          return;
        }

        // Ready check
        if (req.url === '/api/ready') {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              ready: true,
              database: process.env.DATABASE_URL ? 'configured' : 'not_configured',
              engine: process.env.DATABASE_URL ? 'postgresql' : null,
              phase: 'P04',
            })
          );
          return;
        }

        // Auth Login in Vite dev server
        if (req.url === '/api/auth/login' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const { username, password } = JSON.parse(body || '{}');
              if (!username || !password) {
                res.setHeader('Content-Type', 'application/json');
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Bad Request', message: 'Username and password required' }));
                return;
              }

              const expectedUser = process.env.PLATFORM_ADMIN_USERNAME || 'admin';
              const expectedPass = process.env.PLATFORM_ADMIN_PASSWORD || 'AdminPass123!';

              if (username !== expectedUser || password !== expectedPass) {
                res.setHeader('Content-Type', 'application/json');
                res.statusCode = 401;
                res.end(JSON.stringify({ error: 'Unauthorized', message: 'Invalid username or password' }));
                return;
              }

              const token = 'dev_token_' + Date.now();
              devSessions.set(token, { username, role: 'platform_admin' });

              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Set-Cookie', `an_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
              res.statusCode = 200;
              res.end(
                JSON.stringify({
                  status: 'ok',
                  user: { id: 'dev-admin-id', username, role: 'platform_admin' },
                })
              );
            } catch {
              res.setHeader('Content-Type', 'application/json');
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
          });
          return;
        }

        // Auth Logout in Vite dev server
        if (req.url === '/api/auth/logout' && req.method === 'POST') {
          const cookieHeader = req.headers.cookie || '';
          const match = cookieHeader.match(/an_session=([^;]+)/);
          if (match) {
            devSessions.delete(match[1]);
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Set-Cookie', `an_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly`);
          res.statusCode = 200;
          res.end(JSON.stringify({ status: 'ok', message: 'Logged out successfully' }));
          return;
        }

        // Auth Me in Vite dev server
        if (req.url === '/api/auth/me' && req.method === 'GET') {
          const cookieHeader = req.headers.cookie || '';
          const match = cookieHeader.match(/an_session=([^;]+)/);
          const session = match ? devSessions.get(match[1]) : null;

          if (!session) {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'Unauthorized', message: 'No active session' }));
            return;
          }

          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              status: 'ok',
              user: { id: 'dev-admin-id', username: session.username, role: session.role },
            })
          );
          return;
        }

        // Companies GET in Vite dev server
        if (req.url === '/api/companies' && req.method === 'GET') {
          const cookieHeader = req.headers.cookie || '';
          const match = cookieHeader.match(/an_session=([^;]+)/);
          if (!match || !devSessions.has(match[1])) {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }

          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(JSON.stringify({ status: 'ok', companies: devCompanies }));
          return;
        }

        // Companies POST in Vite dev server
        if (req.url === '/api/companies' && req.method === 'POST') {
          const cookieHeader = req.headers.cookie || '';
          const match = cookieHeader.match(/an_session=([^;]+)/);
          const session = match ? devSessions.get(match[1]) : null;

          if (!session) {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }

          if (session.role !== 'platform_admin') {
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 403;
            res.end(JSON.stringify({ error: 'Forbidden', message: 'Missing required permission' }));
            return;
          }

          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const { code, nameAr, nameEn } = JSON.parse(body || '{}');
              if (!code || !nameAr) {
                res.setHeader('Content-Type', 'application/json');
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Bad Request', message: 'code and nameAr are required' }));
                return;
              }

              const newComp = {
                id: 'comp-' + Date.now(),
                code: String(code).toUpperCase(),
                nameAr: String(nameAr),
                nameEn: nameEn ? String(nameEn) : undefined,
                isActive: true,
                createdAt: new Date().toISOString(),
                createdBy: session.username,
              };

              devCompanies.push(newComp);
              res.setHeader('Content-Type', 'application/json');
              res.statusCode = 201;
              res.end(JSON.stringify({ status: 'ok', company: newComp }));
            } catch {
              res.setHeader('Content-Type', 'application/json');
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
          });
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), devApiPlugin()],
    resolve: {
      alias: {
        '@': path.resolve('.'),
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
