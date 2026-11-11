export type BatteryStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIPPED';

export function mapExitCodeToStatus(code: number | null | undefined): BatteryStatus {
  if (code === 0) return 'PASS';
  if (code === 2) return 'BLOCKED';
  if (code === 3) return 'SKIPPED';
  return 'FAIL';
}

export function evaluateCiPolicy(
  status: BatteryStatus,
  options: { requireDb?: boolean } = {}
): { allowed: boolean; reason?: string } {
  if (status === 'FAIL') {
    return { allowed: false, reason: 'Script failed with exit code 1' };
  }
  if (options.requireDb) {
    if (status === 'BLOCKED') {
      return { allowed: false, reason: 'REQUIRE_DB=1 rejects BLOCKED scripts' };
    }
    if (status === 'SKIPPED') {
      return { allowed: false, reason: 'REQUIRE_DB=1 rejects SKIPPED scripts' };
    }
  }
  return { allowed: true };
}
