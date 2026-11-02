import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, Plugin } from 'vite';

// Development API plugin for Vite dev server
function devApiPlugin(): Plugin {
  return {
    name: 'an-erp-dev-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/api/health') {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              status: 'ok',
              service: 'an-erp-platform',
              phase: 'P02a',
              time: new Date().toISOString(),
            })
          );
          return;
        }
        if (req.url === '/api/ready') {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              ready: true,
              database: process.env.DATABASE_URL ? 'configured' : 'not_configured',
              engine: process.env.DATABASE_URL ? 'postgresql' : null,
              phase: 'P02a',
            })
          );
          return;
        }
        if (req.url === '/api/db/status') {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              configured: Boolean(process.env.DATABASE_URL),
              engine: process.env.DATABASE_URL ? 'postgresql' : null,
              phase: 'P02a',
            })
          );
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
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
