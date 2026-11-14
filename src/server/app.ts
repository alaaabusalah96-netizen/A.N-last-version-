import express, { Express, Request, Response, NextFunction } from 'express';
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
import { accountingRoutes } from './routes/accountingRoutes.js';
import { userAdminRoutes } from './routes/userAdminRoutes.js';
import { inventoryRoutes } from './routes/inventoryRoutes.js';
import { purchasingRoutes } from './routes/purchasingRoutes.js';
import { cashRoutes } from './routes/cashRoutes.js';
import { configPlatformRoutes } from './routes/configRoutes.js';
import { rbacRoutes } from './routes/roleRoutes.js';
import { tenantDemoRoutes } from './routes/tenantDemoRoutes.js';

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

  // Diagnostic Login Flow Tracer
  app.use((req: any, _res: Response, next: NextFunction) => {
    if (req.path.includes('/auth/login') || req.path.includes('/auth/csrf')) {
      const requestId = req.requestId || 'unknown';
      const origin = req.headers['origin'] || 'none';
      const hasCookie = Boolean(req.cookies?.['an_csrf']);
      const hasHeader = Boolean(req.headers['x-csrf-token']);
      console.log(`[AuthTrace] ID: ${requestId} | Method: ${req.method} | Path: ${req.path} | Origin: ${origin} | HasCsrfCookie: ${hasCookie} | HasCsrfHeader: ${hasHeader}`);
    }
    next();
  });

  // CSRF protection for /api routes
  app.use('/api', csrfProtection);

  // Health (Liveness) & Readiness Endpoints
  app.get('/api/health', handleLiveness);
  app.get('/api/ready', handleReadiness);

  // Modular Routers
  app.use('/api/auth', authRoutes);
  app.use('/api/companies', companyRoutes);
  app.use('/api/accounting', accountingRoutes);
  app.use('/api/users', userAdminRoutes);
  app.use('/api/inventory', inventoryRoutes);
  app.use('/api/purchasing', purchasingRoutes);
  app.use('/api/cash', cashRoutes);

  // Configuration Platform — global definitions catalog (Wave A / A2)
  app.use('/api/config', configPlatformRoutes);

  // RBAC permissions catalog (AN-RBAC-ROLES-5)
  app.use('/api/rbac', rbacRoutes);

  // Tenant Demo Routes (Development & Test environments only)
  if (process.env.NODE_ENV !== 'production' && process.env.ENABLE_TENANT_DEMO === '1') {
    app.use('/api/companies/:companyId/demo-items', tenantDemoRoutes);
  }

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
