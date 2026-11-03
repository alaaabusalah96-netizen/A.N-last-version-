import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

const CSRF_COOKIE_NAME = 'an_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * CSRF Protection Middleware (Double-Submit Cookie Pattern)
 * Issues a cryptographically secure CSRF token cookie if not present,
 * and validates that mutating requests (POST, PUT, PATCH, DELETE) provide
 * a matching token in the x-csrf-token header.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  let token = req.cookies?.[CSRF_COOKIE_NAME];

  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false, // Must be readable by frontend JS to attach header
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
  }

  // Safe methods bypass validation
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Exempt login from requiring CSRF header if needed, or validate header
  if (req.path === '/login' || req.path === '/api/auth/login') {
    return next();
  }

  const headerToken = req.headers[CSRF_HEADER_NAME] || req.headers[CSRF_HEADER_NAME.toLowerCase()];

  if (!headerToken || typeof headerToken !== 'string' || headerToken !== token) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'CSRF token missing or invalid',
    });
    return;
  }

  next();
}
