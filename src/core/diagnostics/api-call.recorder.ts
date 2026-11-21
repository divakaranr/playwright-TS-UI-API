import { redactSensitive, sanitizeHeaders, truncate } from '../../utils/sanitizer.js';

export interface ApiCallRecord {
  timestamp: string;
  method: string;
  url: string;
  status?: number;
  durationMs: number;
  correlationId: string;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  error?: string;
}

const MAX_BODY_CHARS = 4000;
const MAX_RECORDS = 200;

/**
 * Collects sanitised request/response metadata for every API call made during a
 * test. Attached to the report when a test fails (failure diagnostics) and used
 * as evidence by AI failure analysis.
 */
export class ApiCallRecorder {
  private readonly records: ApiCallRecord[] = [];

  record(entry: ApiCallRecord): void {
    const sanitized: ApiCallRecord = {
      ...entry,
      requestHeaders: sanitizeHeaders(entry.requestHeaders),
      requestBody: entry.requestBody === undefined ? undefined : redactSensitive(entry.requestBody),
      ...(entry.responseHeaders ? { responseHeaders: sanitizeHeaders(entry.responseHeaders) } : {}),
      ...(entry.responseBody !== undefined
        ? { responseBody: truncate(redactSensitive(entry.responseBody), MAX_BODY_CHARS) }
        : {}),
    };
    this.records.push(sanitized);
    if (this.records.length > MAX_RECORDS) this.records.shift();
  }

  all(): readonly ApiCallRecord[] {
    return this.records;
  }

  failures(): ApiCallRecord[] {
    return this.records.filter((r) => r.error !== undefined || (r.status !== undefined && r.status >= 500));
  }

  get size(): number {
    return this.records.length;
  }
}
