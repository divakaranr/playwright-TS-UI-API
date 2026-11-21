/** Small, dependency-free date helpers used by data factories and reporting. */

export const nowIso = (): string => new Date().toISOString();

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/** YYYY-MM-DD in UTC (stable across agent time zones). */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Filesystem-safe timestamp, e.g. 2026-01-31T10-15-30-123Z. */
export function fileTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
