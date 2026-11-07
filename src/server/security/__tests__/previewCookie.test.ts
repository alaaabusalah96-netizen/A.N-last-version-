import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setCsrfCookie } from '../csrfProtection.js';
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
  });

  afterEach(() => {
    delete process.env.APP_PREVIEW_MODE;
  });

  it('should use SameSite=None in valid Preview context', () => {
    process.env.APP_PREVIEW_MODE = 'true';
    (mockReq.get as any).mockReturnValue('myapp-preview.run.app');

    setCsrfCookie(mockReq as Request, mockRes as Response, 'test-token');

    expect(mockRes.cookie).toHaveBeenCalledWith('an_csrf', 'test-token', expect.objectContaining({
      sameSite: 'none',
      secure: true
    }));
  });

  it('should default to SameSite=Lax in Production context (even if flag set)', () => {
    process.env.APP_PREVIEW_MODE = 'true';
    (mockReq.get as any).mockReturnValue('production-domain.com');

    setCsrfCookie(mockReq as Request, mockRes as Response, 'test-token');

    expect(mockRes.cookie).toHaveBeenCalledWith('an_csrf', 'test-token', expect.objectContaining({
      sameSite: 'lax'
    }));
  });

  it('should default to SameSite=Lax if APP_PREVIEW_MODE is missing', () => {
    process.env.APP_PREVIEW_MODE = '';
    (mockReq.get as any).mockReturnValue('myapp-preview.run.app');

    setCsrfCookie(mockReq as Request, mockRes as Response, 'test-token');

    expect(mockRes.cookie).toHaveBeenCalledWith('an_csrf', 'test-token', expect.objectContaining({
      sameSite: 'lax'
    }));
  });
});
