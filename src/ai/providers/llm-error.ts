import { FrameworkError } from '../../core/exceptions/index.js';

export type LlmErrorKind =
  | 'configuration'
  | 'authentication'
  | 'rate_limit'
  | 'timeout'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'invalid_response';

/**
 * Normalised error for every provider. Callers branch on `kind`/`retryable`
 * instead of provider-specific status codes or payloads. Messages never
 * contain API keys or prompt content.
 */
export class LlmError extends FrameworkError {
  readonly provider: string;
  readonly kind: LlmErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    provider: string,
    kind: LlmErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(`LLM_${kind.toUpperCase()}`, `[${provider}] ${message}`, {
      cause: options.cause,
      details: { provider, kind, status: options.status },
    });
    this.provider = provider;
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    this.retryable = kind === 'rate_limit' || kind === 'server' || kind === 'network' || kind === 'timeout';
  }
}

export function classifyStatus(status: number): LlmErrorKind {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/** Parses Retry-After (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
