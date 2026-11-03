import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { getSessionCookieName } from '../auth/authMiddleware.js';

const CSRF_COOKIE_NAME = 'an_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';

const isProd = process.env.NODE_ENV === 'production';

function getCsrfSecret(): string {
  const secret = process.env.CSRF_SECRET;
  if (!secret || secret.length < 32) {
    if (isProd) {
      throw new Error('FATAL: CSRF_SECRET environment variable is missing or less than 32 characters in production');
    }
    console.warn('[csrf] WARNING: CSRF_SECRET not set or too short in development. Using ephemeral random secret.');
    return 'development_ephemeral_csrf_secret_32chars_minimum_key';
  }
  return secret;
}

const CSRF_SECRET = getCsrfSecret();

export function generateCsrfToken(sessionToken: string = ''): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const hmac = crypto
    .createHmac('sha256', CSRF_SECRET)
    .update(`${nonce}|${sessionToken}`)
    .digest('hex');
  return `v1.${nonce}.${hmac}`;
}

export function verifyCsrfToken(token: string, sessionToken: string = ''): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;

  const [_, nonce, expectedHmac] = parts;
  const computedHmac = crypto
    .createHmac('sha256', CSRF_SECRET)
    .update(`${nonce}|${sessionToken}`)
    .digest('hex');

  if (expectedHmac.length !== computedHmac.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expectedHmac), Buffer.from(computedHmac));
}

export function setCsrfCookie(res: Response, token: string): void {
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // JS must read cookie to include in header
    secure: isProd,
    sameSite: 'lax',
    path: '/',
  });
}

/**
 * Double-submit + HMAC CSRF Protection Middleware
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  // Safe HTTP methods bypass CSRF check
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Stateless Bearer token requests (without session cookie) bypass CSRF check
  const sessionCookieName = getSessionCookieName();
  const sessionToken = req.cookies?.[sessionCookieName] || '';
  const hasAuthHeader = req.headers.authorization && req.headers.authorization.startsWith('Bearer ');

  if (hasAuthHeader && !sessionToken) {
    return next();
  }

  // 1. Origin & Referer Verification for mutating requests
  const origin = (req.headers.origin as string) || '';
  const referer = (req.headers.referer as string) || '';

  if (isProd && !origin && !referer) {
    res.status(403).json({
      error: 'Forbidden',
      code: 'CSRF_ORIGIN',
      message: 'Mutating requests must include Origin or Referer header',
    });
    return;
  }

  const requestHost = req.headers.host || '';
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : [];

  const targetOrigin = origin || (referer ? new URL(referer).origin : '');
  if (targetOrigin) {
    let isValidOrigin = false;
    try {
      const url = new URL(targetOrigin);
      if (url.host === requestHost || allowedOrigins.includes(targetOrigin)) {
        isValidOrigin = true;
      }
    } catch {
      isValidOrigin = false;
    }

    if (!isValidOrigin && allowedOrigins.length > 0 && !allowedOrigins.includes(targetOrigin)) {
      res.status(403).json({
        error: 'Forbidden',
        code: 'CSRF_ORIGIN',
        message: 'Origin or Referer not allowed',
      });
      return;
    }
  }

  // 2. Token Verification
  const headerToken = (req.headers[CSRF_HEADER_NAME] || req.headers[CSRF_HEADER_NAME.toLowerCase()]) as string;
  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];

  if (!headerToken || !cookieToken) {
    res.status(403).json({
      error: 'Forbidden',
      code: 'CSRF_INVALID',
      message: 'CSRF token missing in header or cookie',
    });
    return;
  }

  // Double submit check
  if (headerToken.length !== cookieToken.length || !crypto.timingSafeEqual(Buffer.from(headerToken), Buffer.from(cookieToken))) {
    res.status(403).json({
      error: 'Forbidden',
      code: 'CSRF_INVALID',
      message: 'CSRF token mismatch between header and cookie',
    });
    return;
  }

  // HMAC verification bound to current session
  if (!verifyCsrfToken(headerToken, sessionToken)) {
    res.status(403).json({
      error: 'Forbidden',
      code: 'CSRF_INVALID',
      message: 'CSRF token signature invalid for current session state',
    });
    return;
  }

  next();
}
