import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { getDefaultExecutor } from './src/server/db/index.js';
import { authRoutes } from './src/server/routes/authRoutes.js';
import { defaultAuthService } from './src/server/auth/authService.js';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());

// Initialize platform admin from environment variables (silent if not configured)
defaultAuthService.bootstrapPlatformAdminFromEnv().catch((err) => {
  console.error('[auth] Bootstrap error:', err);
});

// Auth Routes Router (Modular, no business logic in server.ts)
app.use('/api/auth', authRoutes);

// Health check endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'an-erp-platform',
    phase: 'P03',
    time: new Date().toISOString(),
  });
});

// Database & readiness reflection endpoint
app.get('/api/ready', async (_req: Request, res: Response) => {
  try {
    const executor = await getDefaultExecutor();
    if (!executor) {
      return res.status(200).json({
        ready: true,
        database: 'not_configured',
        engine: null,
        phase: 'P03',
      });
    }

    const healthCheck = await executor.health();
    return res.status(200).json({
      ready: true,
      database: healthCheck.ok ? 'ok' : 'error',
      engine: 'postgresql',
      phase: 'P03',
      detail: healthCheck.detail,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(200).json({
      ready: true,
      database: 'error',
      engine: 'postgresql',
      phase: 'P03',
      detail: message,
    });
  }
});

// Static assets serving if dist directory exists
const distPath = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (_req: Request, res: Response) => {
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(200).json({ status: 'ok', service: 'an-erp-platform' });
    }
  });
} else {
  app.get('/', (_req: Request, res: Response) => {
    res.send('A.N ERP Platform API is running. In development, the UI is served via Vite.');
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[an-erp-platform] Server running on http://0.0.0.0:${PORT}`);
});

export default app;
