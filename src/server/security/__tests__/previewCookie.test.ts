import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setCsrfCookie } from '../csrfProtection.js';
import { TRUSTED_PREVIEW_HOSTS } from '../../config/env.js';
import { Response, Request } from 'express';

describe('CSRF Cookie Policy (Preview vs Production)', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;

  beforeEach(() => {
    vi.resetModules();
    mockRes = {
      cookie: vi.fn(),
    };
    mockReq = {
      get: vi.fn(),
    };
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    delete process.env.APP_PREVIEW_MODE;
    delete process.env.NODE_ENV;
  });

  it('should use SameSite=None in valid Preview context', () => {
    process.env.APP_PREVIEW_MODE = 'true';
    (mockReq.get as any).mockReturnValue(TRUSTED_PREVIEW_HOSTS[0]);

    setCsrfCookie(mockReq as Request, mockRes as Response, 'test-token');

    expect(mockRes.cookie).toHaveBeenCalledWith('an_csrf', 'test-token', expect.objectContaining({
      sameSite: 'none',
      secure: true
    }));
  });

  it('should default to SameSite=Lax in Production context (even if flag set)', () => {
    process.env.APP_PREVIEW_MODE = 'true';
    process.env.NODE_ENV = 'production';
    (mockReq.get as any).mockReturnValue(TRUSTED_PREVIEW_HOSTS[0]);

    setCsrfCookie(mockReq as Request, mockRes as Response, 'test-token');

    expect(mockRes.cookie).toHaveBeenCalledWith('an_csrf', 'test-token', expect.objectContaining({
      sameSite: 'lax'
    }));
  });

  it('should default to SameSite=Lax if host is not trusted', () => {
    process.env.APP_PREVIEW_MODE = 'true';
    (mockReq.get as any).mockReturnValue('random.run.app');

    setCsrfCookie(mockReq as Request, mockRes as Response, 'test-token');

    expect(mockRes.cookie).toHaveBeenCalledWith('an_csrf', 'test-token', expect.objectContaining({
      sameSite: 'lax'
    }));
  });

  it('should default to SameSite=Lax if APP_PREVIEW_MODE is missing', () => {
    process.env.APP_PREVIEW_MODE = '';
    (mockReq.get as any).mockReturnValue(TRUSTED_PREVIEW_HOSTS[0]);

    setCsrfCookie(mockReq as Request, mockRes as Response, 'test-token');

    expect(mockRes.cookie).toHaveBeenCalledWith('an_csrf', 'test-token', expect.objectContaining({
      sameSite: 'lax'
    }));
  });
});
