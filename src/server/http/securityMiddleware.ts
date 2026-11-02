import helmet from 'helmet';
import { Request, Response, NextFunction, Application } from 'express';

// In-memory rate limiter tracking by IP
interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const loginAttempts = new Map<string, RateLimitRecord>();

/**
 * Basic in-memory rate limiter for login route to mitigate brute force attacks.
 * Limit: 20 requests per 15-minute window per IP.
 */
export function loginRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown-ip';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 20;

  const record = loginAttempts.get(ip);

  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + windowMs });
    return next();
  }

  if (record.count >= maxAttempts) {
    const retryAfterSec = Math.ceil((record.resetAt - now) / 1000);
    res.setHeader('Retry-After', retryAfterSec);
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Too many login attempts. Please try again later.',
      retryAfterSeconds: retryAfterSec,
    });
    return;
  }

  record.count++;
  next();
}

/**
 * Applies security headers (Helmet) and trust proxy configuration.
 */
export function applySecurityMiddleware(app: Application): void {
  // Respect TRUST_PROXY environment variable
  if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  // Apply Helmet with relaxed script policies for SPA dev/production
  app.use(
    helmet({
      contentSecurityPolicy: false, // Managed by Vite in frontend if required
      crossOriginEmbedderPolicy: false,
    })
  );
}
