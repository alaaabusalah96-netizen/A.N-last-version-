import { describe, it, expect } from 'vitest';
import fs from 'fs';

describe('roles screen warns when a custom role lacks company:read', () => {
  const src = fs.readFileSync('src/components/rbac/PermissionMatrix.tsx', 'utf8');
  it('shows the warning only for a non-empty selection without company:read', () => {
    expect(src).toContain("selectedPerms.size > 0 && !selectedPerms.has('company:read')");
    expect(src).toContain('data-testid="company-read-warning"');
    expect(src).toContain('company:read');
  });
});
