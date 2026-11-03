import { Router, Request, Response } from 'express';
import { defaultAuthService } from '../auth/authService.js';
import { AuthenticatedRequest, getSessionCookieName, requireAuth } from '../auth/authMiddleware.js';
import { wrap } from '../http/asyncHandler.js';
import { defaultRateLimitStore } from '../security/rateLimitStore.js';
import { defaultAuditService } from '../audit/auditService.js';
import { generateCsrfToken, setCsrfCookie } from '../security/csrfProtection.js';
import { InvalidCredentialsError, ValidationError } from '../http/errors.js';

export const authRoutes = Router();

// GET /api/auth/csrf — Fetch or refresh CSRF token
authRoutes.get(
  '/csrf',
  wrap(async (req: Request, res: Response) => {
    const cookieName = getSessionCookieName();
    const sessionToken = req.cookies?.[cookieName] || '';
    const csrfToken = generateCsrfToken(sessionToken);
    setCsrfCookie(res, csrfToken);
    return res.status(200).json({ status: 'ok', csrfToken });
  })
);

// POST /api/auth/login — Login with DB-backed rate limiting & audit logging
authRoutes.post(
  '/login',
  wrap(async (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const { username, password } = req.body || {};

    if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
      throw new ValidationError('Username and password are required');
    }

    const normalizedUsername = username.trim().toLowerCase();
    const ipKey = `ip:${ip}`;
    const userKey = `user:${normalizedUsername}`;

    // 1. Rate Limit Check
    const rateCheck = await defaultRateLimitStore.isBlocked({ ipKey, userKey });
    if (rateCheck.blocked) {
      await defaultAuditService.record(
        {
          action: 'auth.login.blocked',
          ipAddress: ip,
          metadata: { username: normalizedUsername, reason: rateCheck.reason },
        },
        { mode: 'best_effort' }
      );

      res.setHeader('Retry-After', rateCheck.retryAfterSec || 900);
      return res.status(429).json({
        error: 'Too Many Requests',
        message: rateCheck.reason || 'Too many failed login attempts',
        retryAfterSeconds: rateCheck.retryAfterSec,
      });
    }

    // 2. Attempt Login
    let loginResult;
    try {
      loginResult = await defaultAuthService.login(normalizedUsername, password);
    } catch (loginErr) {
      // Record failed login attempt
      await defaultRateLimitStore.recordFailure(ipKey);
      await defaultRateLimitStore.recordFailure(userKey);

      await defaultAuditService.record(
        {
          action: 'auth.login.failure',
          ipAddress: ip,
          metadata: { username: normalizedUsername },
        },
        { mode: 'best_effort' }
      );

      throw loginErr;
    }

    const { session, user } = loginResult;

    // 3. Clear User Rate Limit Failures
    await defaultRateLimitStore.clearUser(userKey);

    // 4. Audit Log Successful Login (Required Mode)
    try {
      await defaultAuditService.record(
        {
          actorUserId: user.id,
          action: 'auth.login.success',
          ipAddress: ip,
          metadata: { username: user.username, role: user.role },
        },
        { mode: 'required' }
      );
    } catch (auditErr) {
      // Revoke created session if audit logging fails
      await defaultAuthService.logout(session.id);
      throw auditErr;
    }

    // 5. Session Cookie
    const cookieName = getSessionCookieName();
    res.cookie(cookieName, session.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
    });

    // 6. Rotate CSRF Token bound to new session
    const csrfToken = generateCsrfToken(session.id);
    setCsrfCookie(res, csrfToken);

    return res.status(200).json({
      status: 'ok',
      user,
      csrfToken,
      expiresAt: session.expiresAt,
    });
  })
);

// POST /api/auth/logout
authRoutes.post(
  '/logout',
  wrap(async (req: Request, res: Response) => {
    const cookieName = getSessionCookieName();
    const token = req.cookies?.[cookieName];

    if (token) {
      const user = await defaultAuthService.getSessionUser(token);
      await defaultAuthService.logout(token);

      await defaultAuditService.record(
        {
          actorUserId: user?.id || null,
          action: 'auth.logout',
          ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
        },
        { mode: 'best_effort' }
      );
    }

    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });

    // Rotate CSRF token for unauthenticated state
    const csrfToken = generateCsrfToken('');
    setCsrfCookie(res, csrfToken);

    return res.status(200).json({
      status: 'ok',
      message: 'Logged out successfully',
      csrfToken,
    });
  })
);

// POST /api/auth/logout-all
authRoutes.post(
  '/logout-all',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user!;
    const count = await defaultAuthService.revokeAllSessionsForUser(user.id);

    await defaultAuditService.record(
      {
        actorUserId: user.id,
        action: 'auth.logout_all',
        ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
        metadata: { revokedSessionsCount: count },
      },
      { mode: 'best_effort' }
    );

    const cookieName = getSessionCookieName();
    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });

    const csrfToken = generateCsrfToken('');
    setCsrfCookie(res, csrfToken);

    return res.status(200).json({
      status: 'ok',
      message: 'All sessions revoked successfully',
      revokedCount: count,
      csrfToken,
    });
  })
);

// GET /api/auth/me
authRoutes.get(
  '/me',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    return res.status(200).json({
      status: 'ok',
      user: req.user,
    });
  })
);
