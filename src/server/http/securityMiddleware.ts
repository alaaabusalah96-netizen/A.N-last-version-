import helmet from 'helmet';
import { Request, Response, NextFunction, Application } from 'express';

interface RateLimitRecord {
  failedAttempts: number;
  resetAt: number;
}

const loginFailedAttempts = new Map<string, RateLimitRecord>();

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILED_ATTEMPTS = 10;

/**
 * Cleanup expired entries periodically to prevent memory growth
 */
function cleanupExpiredRecords(): void {
  const now = Date.now();
  for (const [ip, record] of loginFailedAttempts.entries()) {
    if (now > record.resetAt) {
      loginFailedAttempts.delete(ip);
    }
  }
}

// Run cleanup every 10 minutes (unref to avoid hanging process exit in tests)
const cleanupTimer = setInterval(cleanupExpiredRecords, 10 * 60 * 1000);
if (cleanupTimer.unref) {
  cleanupTimer.unref();
}

export function checkLoginRateLimit(req: Request, res: Response, next: NextFunction): void {
  cleanupExpiredRecords();
  const ip = req.ip || req.socket.remoteAddress || 'unknown-ip';
  const now = Date.now();

  const record = loginFailedAttempts.get(ip);
  if (record && now <= record.resetAt && record.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    const retryAfterSec = Math.ceil((record.resetAt - now) / 1000);
    res.setHeader('Retry-After', retryAfterSec);
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Too many failed login attempts. Please try again later.',
      retryAfterSeconds: retryAfterSec,
    });
    return;
  }

  next();
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const record = loginFailedAttempts.get(ip);

  if (!record || now > record.resetAt) {
    loginFailedAttempts.set(ip, { failedAttempts: 1, resetAt: now + WINDOW_MS });
  } else {
    record.failedAttempts++;
  }
}

export function recordLoginSuccess(ip: string): void {
  loginFailedAttempts.delete(ip);
}

// Backward compatibility alias for router middleware
export const loginRateLimiter = checkLoginRateLimit;

/**
 * Applies security headers (Helmet) with minimal safe Content Security Policy.
 */
export function applySecurityMiddleware(app: Application): void {
  const isProd = process.env.NODE_ENV === 'production';

  // Respect TRUST_PROXY environment variable
  if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  // Production-grade minimal Content Security Policy
  app.use(
    helmet({
      contentSecurityPolicy: isProd
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:'],
              connectSrc: ["'self'"],
              objectSrc: ["'none'"],
              baseUri: ["'self'"],
              formAction: ["'self'"],
            },
          }
        : false, // In development, let Vite manage script injection without CSP blockers
      crossOriginEmbedderPolicy: false,
    })
  );
}
