import { Request, Response, NextFunction } from 'express';
import { defaultAuthService } from './authService.js';
import { User } from './userStore.js';

export interface AuthenticatedRequest extends Request {
  user?: Omit<User, 'passwordHash'>;
  sessionId?: string;
}

export function getSessionCookieName(): string {
  return process.env.SESSION_COOKIE_NAME || 'an_session';
}

/**
 * Middleware requiring a valid active session.
 * Reads token from httpOnly cookie (or Bearer Authorization header).
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const cookieName = getSessionCookieName();
  let token = req.cookies?.[cookieName];

  if (!token && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }
  }

  if (!token) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication session required',
    });
    return;
  }

  const user = await defaultAuthService.getSessionUser(token);
  if (!user) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Session has expired or is invalid',
    });
    return;
  }

  req.user = user;
  req.sessionId = token;
  next();
}
