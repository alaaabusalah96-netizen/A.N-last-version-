import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { getDefaultExecutor } from './src/server/db/index.js';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(cors());
app.use(express.json());

// Mandatory GET /api/health endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'an-erp-platform',
    phase: 'P02a',
    time: new Date().toISOString(),
  });
});

// Mandatory GET /api/ready endpoint with database status reflection
app.get('/api/ready', async (_req: Request, res: Response) => {
  try {
    const executor = await getDefaultExecutor();
    if (!executor) {
      return res.status(200).json({
        ready: true,
        database: 'not_configured',
        engine: null,
        phase: 'P02a',
      });
    }

    const healthCheck = await executor.health();
    if (healthCheck.ok) {
      return res.status(200).json({
        ready: true,
        database: 'ok',
        engine: 'postgresql',
        phase: 'P02a',
      });
    } else {
      return res.status(200).json({
        ready: true,
        database: 'error',
        engine: 'postgresql',
        phase: 'P02a',
        detail: healthCheck.detail,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(200).json({
      ready: true,
      database: 'error',
      engine: 'postgresql',
      phase: 'P02a',
      detail: message,
    });
  }
});

// Optional GET /api/db/status endpoint (safe metadata without secrets)
app.get('/api/db/status', async (_req: Request, res: Response) => {
  try {
    const executor = await getDefaultExecutor();
    if (!executor) {
      return res.status(200).json({
        configured: false,
        engine: null,
        phase: 'P02a',
        message: 'No DATABASE_URL configured. Running in non-persistent / scaffold mode.',
      });
    }

    const healthCheck = await executor.health();
    return res.status(200).json({
      configured: true,
      engine: 'postgresql',
      healthy: healthCheck.ok,
      phase: 'P02a',
      detail: healthCheck.detail,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(200).json({
      configured: true,
      engine: 'postgresql',
      healthy: false,
      phase: 'P02a',
      error: message,
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
