import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { AppError, CorsOriginError } from './errors.js';

export interface ExtendedRequest extends Request {
  requestId?: string;
  user?: any;
  companyId?: string;
}

const REQUEST_ID_REGEX = /^[A-Za-z0-9._-]{8,64}$/;

export function requestIdMiddleware(req: ExtendedRequest, res: Response, next: NextFunction): void {
  const incomingId = req.headers['x-request-id'];
  const isValid = typeof incomingId === 'string' && REQUEST_ID_REGEX.test(incomingId.trim());
  const requestId = isValid ? (incomingId as string).trim() : crypto.randomUUID();

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
  const internalDetail = err?.internalDetail ? ` | Detail: ${err.internalDetail}` : '';
  console.error(`[ErrorHandler] RequestId: ${requestId} | Method: ${req.method} | Path: ${req.path}${internalDetail}`, err);

  if (res.headersSent) {
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  const code = err?.code;

  // CORS Origin Error (identify strictly via CorsOriginError or code CORS_FORBIDDEN)
  if (err instanceof CorsOriginError || code === 'CORS_FORBIDDEN') {
    res.status(403).json({
      error: 'Forbidden',
      code: 'CORS_FORBIDDEN',
    });
    return;
  }

  // DB Unavailable / Tenant Context Required
  if (message.startsWith('DB_UNAVAILABLE') || message.startsWith('TENANT_CONTEXT_REQUIRED')) {
    res.status(503).json({
      error: 'Service Unavailable',
      code: 'DB_UNAVAILABLE',
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
    const isServerError = err.statusCode >= 500;
    const clientMessage = isServerError ? 'Service Unavailable' : err.message;
    res.status(err.statusCode).json({
      error: clientMessage,
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
