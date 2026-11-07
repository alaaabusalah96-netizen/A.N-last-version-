import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isAppPreview, TRUSTED_PREVIEW_HOSTS } from '../env.js';

describe('Environment Detection (Preview vs Production)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should detect Preview when both flag and valid trusted host are present', () => {
    process.env.APP_PREVIEW_MODE = 'true';
    process.env.NODE_ENV = 'development';
    
    expect(isAppPreview(TRUSTED_PREVIEW_HOSTS[0])).toBe(true);
    expect(isAppPreview(TRUSTED_PREVIEW_HOSTS[1])).toBe(true);
  });

  it('should NOT detect Preview if flag is missing', () => {
    process.env.APP_PREVIEW_MODE = '';
    expect(isAppPreview(TRUSTED_PREVIEW_HOSTS[0])).toBe(false);
  });

  it('should NOT detect Preview if host is not in TRUSTED_PREVIEW_HOSTS', () => {
    process.env.APP_PREVIEW_MODE = 'true';
    expect(isAppPreview('myapp-preview.run.app')).toBe(false);
    expect(isAppPreview('my-production-domain.com')).toBe(false);
    expect(isAppPreview('evil-site.com')).toBe(false);
  });

  it('should NOT detect Preview if NODE_ENV is production', () => {
    process.env.APP_PREVIEW_MODE = 'true';
    process.env.NODE_ENV = 'production';
    expect(isAppPreview(TRUSTED_PREVIEW_HOSTS[0])).toBe(false);
  });

  it('should NOT detect Preview if flag is false', () => {
    process.env.APP_PREVIEW_MODE = 'false';
    expect(isAppPreview(TRUSTED_PREVIEW_HOSTS[0])).toBe(false);
  });

  it('should fail-safe to False if input is missing', () => {
    process.env.APP_PREVIEW_MODE = 'true';
    expect(isAppPreview(undefined)).toBe(false);
  });
});
