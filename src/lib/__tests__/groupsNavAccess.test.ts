import { describe, it, expect } from 'vitest';
import { canAccessNav } from '../navAccess';

describe('groups nav access', () => {
  it('shows the groups screen to a group member without company:read', () => {
    expect(canAccessNav('groups', 'user', ['group:view'])).toBe(true);
  });
  it('hides it from a user with no company:read and no group membership', () => {
    expect(canAccessNav('groups', 'user', ['inventory:read'])).toBe(false);
  });
  it('keeps company:read working', () => {
    expect(canAccessNav('groups', 'user', ['company:read'])).toBe(true);
  });
  it('always shows it to platform admin', () => {
    expect(canAccessNav('groups', 'platform_admin', [])).toBe(true);
  });
});
