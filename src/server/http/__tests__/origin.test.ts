import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateOrigin, getAllowedOrigins } from '../originRegistry.js';

describe('Origin Validation Registry', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should allow explicit AI Studio origins', () => {
    const devOrigin = 'https://ais-dev-6vklnibghlun634krwmxyl-925777775579.europe-west2.run.app';
    const preOrigin = 'https://ais-pre-6vklnibghlun634krwmxyl-925777775579.europe-west2.run.app';
    
    expect(validateOrigin(devOrigin)).toBe(true);
    expect(validateOrigin(preOrigin)).toBe(true);
  });

  it('should allow origins from CORS_ORIGINS environment variable', () => {
    process.env.CORS_ORIGINS = 'https://myapp.com,https://another.com';
    expect(validateOrigin('https://myapp.com')).toBe(true);
    expect(validateOrigin('https://another.com')).toBe(true);
  });

  it('should allow localhost in development', () => {
    process.env.NODE_ENV = 'development';
    expect(validateOrigin('http://localhost:3000')).toBe(true);
  });

  it('should NOT allow localhost in production', () => {
    process.env.NODE_ENV = 'production';
    expect(validateOrigin('http://localhost:3000')).toBe(false);
  });

  it('should allow origins passed as additionalOrigins', () => {
    expect(validateOrigin('https://custom.com', ['https://custom.com'])).toBe(true);
    expect(validateOrigin('https://custom.com', ['https://other.com'])).toBe(false);
  });

  it('should reject malformed or fake origins', () => {
    expect(validateOrigin('https://fake-ais-dev.run.app')).toBe(false);
    expect(validateOrigin('https://ais-dev-6vklnibghlun634krwmxyl.google.com.attacker.com')).toBe(false);
    expect(validateOrigin('')).toBe(false);
    expect(validateOrigin(undefined)).toBe(false);
  });
});
