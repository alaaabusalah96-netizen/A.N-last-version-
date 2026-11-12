import { Router, Request, Response } from 'express';
import { defaultAuthService } from '../auth/authService.js';
import { AuthenticatedRequest, getSessionCookieName, requireAuth } from '../auth/authMiddleware.js';
import { wrap } from '../http/asyncHandler.js';
import { defaultRateLimitStore } from '../security/rateLimitStore.js';
import { defaultAuditService } from '../audit/auditService.js';
import { generateCsrfToken, setCsrfCookie } from '../security/csrfProtection.js';
import { InvalidCredentialsError, ValidationError } from '../http/errors.js';
import { ExtendedRequest } from '../http/errorHandler.js';
import { isAppPreview, isProduction } from '../config/env.js';
import { defaultMembershipStore } from '../org/membershipStore.js';
import { ROLE_PERMISSIONS, RoleName } from '../rbac/roles.js';
import { PermissionCode } from '../rbac/permissions.js';

export const authRoutes = Router();

// GET /api/auth/csrf — Fetch or refresh CSRF token
authRoutes.get(
  '/csrf',
  wrap(async (req: Request, res: Response) => {
    const cookieName = getSessionCookieName();
    const sessionToken = req.cookies?.[cookieName] || '';
    const csrfToken = generateCsrfToken(sessionToken);
    setCsrfCookie(req, res, csrfToken);
    return res.status(200).json({ status: 'ok', csrfToken });
  })
);

// POST /api/auth/login — Login with DB-backed rate limiting & audit logging
authRoutes.post(
  '/login',
  wrap(async (req: ExtendedRequest, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const requestId = req.requestId || 'unknown';
    const rawUserAgent = req.headers['user-agent'] || '';
    const userAgent = typeof rawUserAgent === 'string' ? rawUserAgent.substring(0, 200) : '';

    const { username, password } = req.body || {};

    if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
      throw new ValidationError('Username and password are required');
    }

    const normalizedUsername = username.trim().toLowerCase();
    const ipKey = `ip:${ip}`;
    const userKey = `user:${normalizedUsername}`;

    // 1. Rate Limit Check (Throws DB_UNAVAILABLE if DB is down)
    const rateCheck = await defaultRateLimitStore.isBlocked({ ipKey, userKey });
    if (rateCheck.blocked) {
      await defaultAuditService.record(
        {
          action: 'auth.login.blocked',
          ipAddress: ip,
          metadata: { username: normalizedUsername, reason: rateCheck.reason, requestId, userAgent },
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
      if (loginErr instanceof InvalidCredentialsError) {
        // Record failed attempt ONLY on invalid credentials
        await defaultRateLimitStore.recordFailure(ipKey);
        await defaultRateLimitStore.recordFailure(userKey);

        await defaultAuditService.record(
          {
            action: 'auth.login.failure',
            ipAddress: ip,
            metadata: { username: normalizedUsername, requestId, userAgent },
          },
          { mode: 'best_effort' }
        );
      }
      throw loginErr;
    }

    const { session, user } = loginResult;

    // 3. Clear User Rate Limit Failures (Do NOT clear IP failures)
    await defaultRateLimitStore.clearUser(userKey);

    // 4. Audit Log Successful Login (Required Mode)
    try {
      await defaultAuditService.record(
        {
          actorUserId: user.id,
          action: 'auth.login.success',
          ipAddress: ip,
          metadata: { username: user.username, role: user.role, requestId, userAgent },
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
    res.cookie(cookieName, session.id, getSessionCookieOptions(req, session.expiresAt));

    // 6. Rotate CSRF Token bound to new session
    const csrfToken = generateCsrfToken(session.id);
    setCsrfCookie(req, res, csrfToken);

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
  wrap(async (req: ExtendedRequest, res: Response) => {
    const cookieName = getSessionCookieName();
    const token = req.cookies?.[cookieName];
    const requestId = req.requestId || 'unknown';
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].substring(0, 200) : '';

    if (token) {
      const user = await defaultAuthService.getSessionUser(token);
      await defaultAuthService.logout(token);

      await defaultAuditService.record(
        {
          actorUserId: user?.id || null,
          action: 'auth.logout',
          ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
          metadata: { requestId, userAgent },
        },
        { mode: 'best_effort' }
      );
    }

    res.clearCookie(cookieName, getSessionCookieOptions(req));

    // Rotate CSRF token for unauthenticated state
    const csrfToken = generateCsrfToken('');
    setCsrfCookie(req, res, csrfToken);

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
    res.clearCookie(cookieName, getSessionCookieOptions(req));

    const csrfToken = generateCsrfToken('');
    setCsrfCookie(req, res, csrfToken);

    return res.status(200).json({
      status: 'ok',
      message: 'All sessions revoked successfully',
      revokedCount: count,
      csrfToken,
    });
  })
);

/**
 * Shared Session Cookie Options
 * Ensures login and logout use identical attributes (SameSite, Secure, Path).
 */
function getSessionCookieOptions(req: Request, expires?: Date) {
  const isProd = isProduction();
  const isPreview = isAppPreview(req.get('host'));

  return {
    httpOnly: true,
    secure: isProd || isPreview,
    sameSite: (isPreview ? 'none' : 'lax') as 'none' | 'lax' | 'strict',
    path: '/',
    ...(expires ? { expires } : {}),
  };
}

async function resolveEffectiveAccess(user: AuthenticatedRequest['user']): Promise<{
  permissions: PermissionCode[];
  memberships: { companyId: string; role: RoleName; isActive: boolean }[];
  degraded: boolean;
}> {
  try {
    if (user!.role === 'platform_admin') {
      return {
        permissions: [...ROLE_PERMISSIONS.platform_admin],
        memberships: [],
        degraded: false,
      };
    }
    const raw = await defaultMembershipStore.listByUser(user!.id);
    const active = raw.filter((m) => m.isActive !== false);
    const permissions = new Set<PermissionCode>();
    for (const membership of active) {
      const perms = ROLE_PERMISSIONS[membership.role as RoleName] || [];
      for (const p of perms) permissions.add(p);
    }
    return {
      permissions: [...permissions],
      memberships: active.map((m) => ({
        companyId: m.companyId,
        role: m.role as RoleName,
        isActive: true,
      })),
      degraded: false,
    };
  } catch {
    return { permissions: [], memberships: [], degraded: true };
  }
}

// GET /api/auth/me
authRoutes.get(
  '/me',
  requireAuth,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const access = await resolveEffectiveAccess(req.user);
    return res.status(200).json({
      status: 'ok',
      user: req.user,
      permissions: access.permissions,
      memberships: access.memberships,
      degraded: access.degraded,
    });
  })
);
