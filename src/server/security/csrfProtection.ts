import crypto from 'crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { getSessionCookieName } from '../auth/authMiddleware.js';
import { isProduction, isStrictEnv, isAppPreview } from '../config/env.js';
import { validateOrigin } from '../http/originRegistry.js';

const CSRF_COOKIE_NAME = 'an_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';

export interface CsrfOptions {
  secret?: string;
  strict?: boolean;
  isProd?: boolean;
  allowedOrigins?: string[];
  sessionCookieName?: string;
}

// Module-level fallback secret generated ONCE per process execution when CSRF_SECRET is unconfigured
const processEphemeralSecret = crypto.randomBytes(32).toString('hex');

function resolveSecret(customSecret?: string, strict?: boolean): string {
  const secret = customSecret || process.env.CSRF_SECRET;
  const isStrict = strict !== undefined ? strict : isStrictEnv();

  if (!secret || secret.length < 32) {
    if (isStrict) {
      throw new Error('FATAL: CSRF_SECRET environment variable is missing or less than 32 characters in strict environment');
    }
    return processEphemeralSecret;
  }
  return secret;
}

export function generateCsrfToken(sessionToken: string = '', secret?: string): string {
  const activeSecret = resolveSecret(secret, false);
  const nonce = crypto.randomBytes(16).toString('hex');
  const hmac = crypto
    .createHmac('sha256', activeSecret)
    .update(`${nonce}|${sessionToken}`)
    .digest('hex');
  return `v1.${nonce}.${hmac}`;
}

export function verifyCsrfToken(token: string, sessionToken: string = '', secret?: string): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;

  const activeSecret = resolveSecret(secret, false);
  const [_, nonce, expectedHmac] = parts;
  const computedHmac = crypto
    .createHmac('sha256', activeSecret)
    .update(`${nonce}|${sessionToken}`)
    .digest('hex');

  if (expectedHmac.length !== computedHmac.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expectedHmac), Buffer.from(computedHmac));
}

export function setCsrfCookie(req: Request, res: Response, token: string): void {
  const isProd = isProduction();
  const host = req.get('host');
  const isPreview = isAppPreview(host);

  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // JS must read cookie to attach header
    secure: isProd || isPreview, // Must be secure for SameSite=None
    sameSite: isPreview ? 'none' : 'lax',
    path: '/',
  });
}

/**
 * Factory for CSRF Protection Middleware
 */
export function createCsrfProtection(options: CsrfOptions = {}): RequestHandler {
  const isProd = options.isProd !== undefined ? options.isProd : isProduction();
  const strict = options.strict !== undefined ? options.strict : isStrictEnv();
  const secret = resolveSecret(options.secret, strict);

  return (req: Request, res: Response, next: NextFunction): void => {
    // Safe HTTP methods bypass CSRF check
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    // Stateless Bearer token requests (without session cookie) bypass CSRF check
    const cookieName = options.sessionCookieName || getSessionCookieName();
    const sessionToken = req.cookies?.[cookieName] || '';
    const hasAuthHeader = req.headers.authorization && req.headers.authorization.startsWith('Bearer ');

    if (hasAuthHeader && !sessionToken) {
      return next();
    }

    // 1. Origin & Referer Verification for mutating requests
    const origin = (req.headers.origin as string) || '';
    const referer = (req.headers.referer as string) || '';

    if (origin) {
      if (!validateOrigin(origin, options.allowedOrigins)) {
        res.status(403).json({
          error: 'Forbidden',
          code: 'CSRF_ORIGIN',
          message: 'Origin header not allowed',
        });
        return;
      }
    } else if (referer) {
      let refererOrigin = '';
      try {
        refererOrigin = new URL(referer).origin;
      } catch {
        res.status(403).json({
          error: 'Forbidden',
          code: 'CSRF_ORIGIN',
          message: 'Malformed Referer header',
        });
        return;
      }

      if (!validateOrigin(refererOrigin, options.allowedOrigins)) {
        res.status(403).json({
          error: 'Forbidden',
          code: 'CSRF_ORIGIN',
          message: 'Referer origin not allowed',
        });
        return;
      }
    } else if (strict) {
      res.status(403).json({
        error: 'Forbidden',
        code: 'CSRF_ORIGIN',
        message: 'Mutating requests must include Origin or Referer header',
      });
      return;
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
    if (
      headerToken.length !== cookieToken.length ||
      !crypto.timingSafeEqual(Buffer.from(headerToken), Buffer.from(cookieToken))
    ) {
      res.status(403).json({
        error: 'Forbidden',
        code: 'CSRF_INVALID',
        message: 'CSRF token mismatch between header and cookie',
      });
      return;
    }

    // HMAC verification bound to current session
    if (!verifyCsrfToken(headerToken, sessionToken, secret)) {
      res.status(403).json({
        error: 'Forbidden',
        code: 'CSRF_INVALID',
        message: 'CSRF token signature invalid for current session state',
      });
      return;
    }

    next();
  };
}

export const csrfProtection = createCsrfProtection();
