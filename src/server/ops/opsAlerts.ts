import fs from 'fs';
import path from 'path';

/**
 * Redacts credentials from free text before it is logged, alerted or returned.
 * Covers DB URLs, key=value secrets, bearer tokens and user:pass@host fragments.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgresql://[REDACTED]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@'"]+:[^\s/@'"]+@[^\s'"]+/gi, '[REDACTED_URL]')
    .replace(/(authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/(password|secret|token|apiKey|csrfSecret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

export type OpsAlertSeverity = 'warning' | 'critical';

export interface OpsAlert {
  severity: OpsAlertSeverity;
  event: string;
  requestId?: string;
  detail?: string;
}

/**
 * Local-only alert sink. Appends one JSON line per alert to the file named by
 * OPS_ALERT_LOG_FILE. It never opens a network connection and is off when the
 * variable is unset. Any external channel (email, chat, pager) needs owner approval.
 * This function never throws: monitoring must not break request handling.
 */
export function emitOpsAlert(alert: OpsAlert): void {
  const file = process.env.OPS_ALERT_LOG_FILE;
  if (!file || file.trim() === '') return;
  try {
    const record = {
      ts: new Date().toISOString(),
      service: 'an-erp-platform',
      severity: alert.severity,
      event: alert.event,
      requestId: alert.requestId,
      detail: alert.detail ? redactSecrets(alert.detail).slice(0, 500) : undefined,
    };
    fs.appendFileSync(path.resolve(file), JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch {
    console.error('[ops-alert] sink write failed');
  }
}
