import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(cors());
app.use(express.json());

// Mandatory GET /api/health endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'an-erp-platform',
    phase: 'P01',
    time: new Date().toISOString(),
  });
});

// Mandatory GET /api/ready endpoint
app.get('/api/ready', (_req: Request, res: Response) => {
  res.status(200).json({
    ready: true,
    database: 'not_configured_p01',
  });
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
