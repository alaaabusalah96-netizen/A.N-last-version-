import { Router, Request, Response } from 'express';
import { defaultAuthService } from '../auth/authService.js';
import { AuthenticatedRequest, getSessionCookieName, requireAuth } from '../auth/authMiddleware.js';
import { checkLoginRateLimit, recordLoginFailure, recordLoginSuccess } from '../http/securityMiddleware.js';

export const authRoutes = Router();

// POST /api/auth/login — protected with checkLoginRateLimit
authRoutes.post('/login', checkLoginRateLimit, async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown-ip';

  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      recordLoginFailure(ip);
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Username and password are required',
      });
    }

    const { session, user } = await defaultAuthService.login(username, password);
    recordLoginSuccess(ip);

    const cookieName = getSessionCookieName();
    res.cookie(cookieName, session.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
    });

    return res.status(200).json({
      status: 'ok',
      user,
      expiresAt: session.expiresAt,
    });
  } catch (err: unknown) {
    recordLoginFailure(ip);
    const message = err instanceof Error ? err.message : 'Login failed';
    return res.status(401).json({
      error: 'Unauthorized',
      message,
    });
  }
});

// POST /api/auth/logout
authRoutes.post('/logout', async (req: Request, res: Response) => {
  const cookieName = getSessionCookieName();
  const token = req.cookies?.[cookieName];

  if (token) {
    try {
      await defaultAuthService.logout(token);
    } catch (err) {
      console.error('[auth] Logout error:', err);
    }
  }

  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });

  return res.status(200).json({
    status: 'ok',
    message: 'Logged out successfully',
  });
});

// GET /api/auth/me
authRoutes.get('/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  return res.status(200).json({
    status: 'ok',
    user: req.user,
  });
});
