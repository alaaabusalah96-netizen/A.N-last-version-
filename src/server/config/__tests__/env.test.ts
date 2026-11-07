import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isAppPreview } from '../env.js';

describe('Environment Detection (Preview vs Production)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should detect Preview when both flag and valid host are present', () => {
    process.env.APP_PREVIEW_MODE = 'true';
    expect(isAppPreview('myapp-preview.run.app')).toBe(true);
    expect(isAppPreview('another-preview.run.app')).toBe(true);
  });

  it('should NOT detect Preview if flag is missing', () => {
    process.env.APP_PREVIEW_MODE = '';
    expect(isAppPreview('myapp-preview.run.app')).toBe(false);
  });

  it('should NOT detect Preview if host is not a .run.app subdomain', () => {
    process.env.APP_PREVIEW_MODE = 'true';
    expect(isAppPreview('my-production-domain.com')).toBe(false);
    expect(isAppPreview('localhost:3000')).toBe(false);
  });

  it('should NOT detect Preview if flag is false', () => {
    process.env.APP_PREVIEW_MODE = 'false';
    expect(isAppPreview('myapp-preview.run.app')).toBe(false);
  });

  it('should fail-safe to Lax/False if input is missing', () => {
    process.env.APP_PREVIEW_MODE = 'true';
    expect(isAppPreview(undefined)).toBe(false);
  });
});
