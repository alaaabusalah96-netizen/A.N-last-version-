import express, { Express, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { createCorsMiddleware } from './http/corsConfig.js';
import { applySecurityMiddleware } from './http/securityMiddleware.js';
import { handleLiveness, handleReadiness } from './http/readiness.js';
import { csrfProtection } from './security/csrfProtection.js';
import { requestIdMiddleware, errorHandler } from './http/errorHandler.js';
import { authRoutes } from './routes/authRoutes.js';
import { companyRoutes } from './routes/companyRoutes.js';

export function createApp(): Express {
  const app = express();

  // Apply Helmet security headers and trust proxy
  applySecurityMiddleware(app);

  // Hardened CORS configuration
  app.use(createCorsMiddleware());

  app.use(cookieParser());
  app.use(express.json({ limit: '100kb' }));

  // Attach Request-Id to all requests
  app.use(requestIdMiddleware);

  // CSRF protection for /api routes
  app.use('/api', csrfProtection);

  // Health (Liveness) & Readiness Endpoints
  app.get('/api/health', handleLiveness);
  app.get('/api/ready', handleReadiness);

  // Modular Routers
  app.use('/api/auth', authRoutes);
  app.use('/api/companies', companyRoutes);

  // 404 Handler for undefined /api routes
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found', code: 'NOT_FOUND' });
  });

  // Static assets serving & SPA fallback in production
  const distPath = path.resolve(process.cwd(), 'dist');
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response, next) => {
      if (req.path.startsWith('/api')) {
        return next();
      }
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

  // Centralized Error Handler (must be mounted last)
  app.use(errorHandler);

  return app;
}
