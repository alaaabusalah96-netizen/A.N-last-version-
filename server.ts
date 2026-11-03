import 'dotenv/config';
import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { createCorsMiddleware } from './src/server/http/corsConfig.js';
import { applySecurityMiddleware } from './src/server/http/securityMiddleware.js';
import { handleLiveness, handleReadiness } from './src/server/http/readiness.js';
import { csrfProtection } from './src/server/security/csrfProtection.js';
import { authRoutes } from './src/server/routes/authRoutes.js';
import { companyRoutes } from './src/server/routes/companyRoutes.js';
import { defaultAuthService } from './src/server/auth/authService.js';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Apply Helmet security headers and trust proxy
applySecurityMiddleware(app);

// Hardened CORS configuration
app.use(createCorsMiddleware());

app.use(cookieParser());
app.use(express.json());

// Apply CSRF protection to all /api routes
app.use('/api', csrfProtection);

// Initialize platform admin from environment variables
defaultAuthService.bootstrapPlatformAdminFromEnv().catch((err) => {
  console.error('[auth] Bootstrap error:', err);
});

// Modular Routers
app.use('/api/auth', authRoutes);
app.use('/api/companies', companyRoutes);

// Health (Liveness) & Readiness Endpoints
app.get('/api/health', handleLiveness);
app.get('/api/ready', handleReadiness);

// Static assets serving in production
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
