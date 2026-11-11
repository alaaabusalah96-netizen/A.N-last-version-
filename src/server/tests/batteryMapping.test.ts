import { describe, it, expect } from 'vitest';

export function mapExitCodeToStatus(exitCode: number | null): 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIPPED' {
  if (exitCode === 0) return 'PASS';
  if (exitCode === 2) return 'BLOCKED';
  if (exitCode === 3) return 'SKIPPED';
  return 'FAIL';
}

export function validateBatterySummary(summary: { total: number; passed: number; failed: number; blocked: number; skipped: number }): boolean {
  return summary.total === (summary.passed + summary.failed + summary.blocked + summary.skipped);
}

export function evaluateCiPolicy(
  requireDb: boolean,
  results: { status: 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIPPED' }[]
): { passed: boolean; reason?: string } {
  const failedCount = results.filter((r) => r.status === 'FAIL').length;
  const blockedCount = results.filter((r) => r.status === 'BLOCKED').length;
  const skippedCount = results.filter((r) => r.status === 'SKIPPED').length;

  if (failedCount > 0) {
    return { passed: false, reason: 'One or more test scripts failed' };
  }

  if (requireDb && (blockedCount > 0 || skippedCount > 0)) {
    return { passed: false, reason: 'REQUIRE_DB=1 or CI=true is set, but test scripts reported BLOCKED or SKIPPED' };
  }

  return { passed: true };
}

describe('Foundation Battery Status & CI Policy Mapping', () => {
  it('maps exit code 0 to PASS', () => {
    expect(mapExitCodeToStatus(0)).toBe('PASS');
  });

  it('maps exit code 1 to FAIL', () => {
    expect(mapExitCodeToStatus(1)).toBe('FAIL');
  });

  it('maps exit code 2 to BLOCKED', () => {
    expect(mapExitCodeToStatus(2)).toBe('BLOCKED');
  });

  it('maps exit code 3 to SKIPPED', () => {
    expect(mapExitCodeToStatus(3)).toBe('SKIPPED');
  });

  it('maps unknown exit codes or null to FAIL', () => {
    expect(mapExitCodeToStatus(137)).toBe('FAIL');
    expect(mapExitCodeToStatus(null)).toBe('FAIL');
  });

  it('validates summary counts matching total sum', () => {
    expect(validateBatterySummary({ total: 10, passed: 7, failed: 1, blocked: 1, skipped: 1 })).toBe(true);
    expect(validateBatterySummary({ total: 10, passed: 7, failed: 1, blocked: 1, skipped: 0 })).toBe(false);
  });

  it('evaluates CI policy: fails when REQUIRE_DB=true and blocked/skipped exist', () => {
    const res = evaluateCiPolicy(true, [{ status: 'PASS' }, { status: 'BLOCKED' }]);
    expect(res.passed).toBe(false);
    expect(res.reason).toContain('REQUIRE_DB=1 or CI=true is set');
  });

  it('evaluates CI policy: passes when all tests PASS', () => {
    const res = evaluateCiPolicy(true, [{ status: 'PASS' }, { status: 'PASS' }]);
    expect(res.passed).toBe(true);
  });

  it('evaluates local policy: allows SKIPPED when REQUIRE_DB=false', () => {
    const res = evaluateCiPolicy(false, [{ status: 'PASS' }, { status: 'SKIPPED' }]);
    expect(res.passed).toBe(true);
  });
});
