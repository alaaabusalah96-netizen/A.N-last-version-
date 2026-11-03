/**
 * Custom application errors for centralized error handling
 */

export class AppError extends Error {
  public internalDetail?: string;

  constructor(
    public statusCode: number,
    public message: string,
    public code: string,
    internalDetail?: string
  ) {
    super(message);
    this.name = 'AppError';
    this.internalDetail = internalDetail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidCredentialsError extends AppError {
  constructor(message = 'Invalid username or password') {
    super(401, message, 'INVALID_CREDENTIALS');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(409, message, 'CONFLICT');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, message, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(400, message, 'VALIDATION_ERROR');
  }
}

export class CorsOriginError extends AppError {
  constructor(message = 'CORS origin not allowed') {
    super(403, message, 'CORS_FORBIDDEN');
  }
}

export class AuditUnavailableError extends AppError {
  constructor(internalDetail?: string) {
    super(503, 'Audit service unavailable', 'AUDIT_UNAVAILABLE', internalDetail);
  }
}
