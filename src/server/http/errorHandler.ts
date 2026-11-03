import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { AppError } from './errors.js';

export interface ExtendedRequest extends Request {
  requestId?: string;
  user?: any;
  companyId?: string;
}

export function requestIdMiddleware(req: ExtendedRequest, res: Response, next: NextFunction): void {
  const incomingId = req.headers['x-request-id'];
  const requestId = typeof incomingId === 'string' && incomingId.trim() ? incomingId.trim() : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

export function errorHandler(
  err: any,
  req: ExtendedRequest,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.requestId || 'unknown-request';
  console.error(`[ErrorHandler] RequestId: ${requestId} | Method: ${req.method} | Path: ${req.path}`, err);

  if (res.headersSent) {
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  const code = err?.code;

  // DB Unavailable / Tenant Context Required
  if (message.startsWith('DB_UNAVAILABLE') || message.startsWith('TENANT_CONTEXT_REQUIRED')) {
    res.status(503).json({
      error: 'Service Unavailable',
      code: 'DB_UNAVAILABLE',
    });
    return;
  }

  // CORS Forbidden
  if (message.includes('CORS')) {
    res.status(403).json({
      error: 'Forbidden',
      code: 'CORS_FORBIDDEN',
    });
    return;
  }

  // Body parser syntax error
  if (err instanceof SyntaxError && 'body' in err && (err as any).status === 400) {
    res.status(400).json({
      error: 'Bad Request',
      code: 'INVALID_JSON',
    });
    return;
  }

  // Postgres unique constraint violation
  if (code === '23505') {
    res.status(409).json({
      error: 'Conflict',
      code: 'CONFLICT',
    });
    return;
  }

  // Postgres invalid UUID representation
  if (code === '22P02') {
    res.status(400).json({
      error: 'Bad Request',
      code: 'INVALID_UUID',
    });
    return;
  }

  // AppError instance
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
    });
    return;
  }

  // Generic internal server error (never leak internal details)
  res.status(500).json({
    error: 'Internal Server Error',
    code: 'INTERNAL',
    requestId,
  });
}
