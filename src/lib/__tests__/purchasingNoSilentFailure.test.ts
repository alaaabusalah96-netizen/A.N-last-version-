import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('PurchasingWorkspace mutations check response status', () => {
  it('never awaits a bare apiFetch statement (failures must surface)', () => {
    const src = readFileSync('src/components/purchasing/PurchasingWorkspace.tsx', 'utf8');
    expect(/^\s*await apiFetch\(/m.test(src)).toBe(false);
  });
});
