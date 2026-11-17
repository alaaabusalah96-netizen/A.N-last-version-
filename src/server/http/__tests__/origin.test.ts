import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';

import {
  validateOrigin,
  getAllowedOrigins,
} from '../originRegistry.js';

describe('Origin Validation Registry', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CORS_ORIGINS;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('allows the official production origin', () => {
    process.env.NODE_ENV = 'production';

    expect(
      validateOrigin(
        'https://erp-platform-foundation.ai.studio'
      )
    ).toBe(true);
  });

  it('rejects arbitrary AI Studio subdomains in production', () => {
    process.env.NODE_ENV = 'production';

    expect(
      validateOrigin('https://evil-other-app.ai.studio')
    ).toBe(false);
  });

  it('rejects preview origins in production by default', () => {
    process.env.NODE_ENV = 'production';

    expect(
      validateOrigin(
        'https://ais-dev-6vklnibghlun634krwmxyl-925777775579.europe-west2.run.app'
      )
    ).toBe(false);
  });

  it('allows explicitly configured production origins', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGINS = 'https://admin.example.com';

    expect(
      validateOrigin('https://admin.example.com')
    ).toBe(true);
  });

  it('rejects arbitrary AI Studio domains in development too', () => {
    process.env.NODE_ENV = 'development';

    expect(
      validateOrigin('https://evil-other-app.ai.studio')
    ).toBe(false);
  });

  it('allows explicitly trusted preview origins outside production', () => {
    process.env.NODE_ENV = 'development';

    expect(
      validateOrigin(
        'https://ais-dev-6vklnibghlun634krwmxyl-925777775579.europe-west2.run.app'
      )
    ).toBe(true);
  });

  it('allows localhost only outside production', () => {
    process.env.NODE_ENV = 'development';

    expect(
      validateOrigin('http://localhost:3000')
    ).toBe(true);

    process.env.NODE_ENV = 'production';

    expect(
      validateOrigin('http://localhost:3000')
    ).toBe(false);
  });

  it('allows exact additional origins', () => {
    expect(
      validateOrigin(
        'https://custom.example.com',
        ['https://custom.example.com']
      )
    ).toBe(true);
  });

  it('rejects malformed origins and origin spoofing', () => {
    process.env.NODE_ENV = 'production';

    const invalidOrigins = [
      '',
      'null',
      'https://evil.ai.studio.attacker.com',
      'https://erp-platform-foundation.ai.studio.attacker.com',
      'http://erp-platform-foundation.ai.studio',
      'https://erp-platform-foundation.ai.studio/path',
      'https://user:pass@erp-platform-foundation.ai.studio',
      'not-a-url',
    ];

    for (const origin of invalidOrigins) {
      expect(validateOrigin(origin)).toBe(false);
    }
  });

  it('does not include preview origins in production defaults', () => {
    process.env.NODE_ENV = 'production';

    expect(getAllowedOrigins()).toEqual([
      'https://erp-platform-foundation.ai.studio',
    ]);
  });
});
