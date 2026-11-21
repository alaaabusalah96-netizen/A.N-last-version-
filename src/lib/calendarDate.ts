/**
 * Returns today's calendar date in 'YYYY-MM-DD' using the browser's local calendar
 * (getFullYear / getMonth / getDate), avoiding UTC drift from .toISOString().
 */
export function getLocalTodayDateString(now: Date = new Date()): string {
  const safe = Number.isNaN(now.getTime()) ? new Date() : now;
  const year = safe.getFullYear();
  const month = String(safe.getMonth() + 1).padStart(2, '0');
  const day = String(safe.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
