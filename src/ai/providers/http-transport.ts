import type { Logger } from '../../utils/logger.js';
import { retry } from '../../utils/retry.util.js';
import { maskSensitiveText, truncate } from '../../utils/sanitizer.js';
import { classifyStatus, LlmError, parseRetryAfter } from './llm-error.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpTransportOptions {
  provider: string;
  timeoutMs: number;
  maxRetries: number;
  fetch?: FetchLike;
  logger?: Logger;
  /** Upper bound for honouring Retry-After (default 30s). */
  maxRetryAfterMs?: number;
}

/**
 * Shared JSON-over-HTTP transport for LLM providers: timeout (AbortSignal),
 * retries with exponential backoff for transient failures (429/5xx/network/timeout),
 * Retry-After support for rate limits, and normalised LlmError mapping.
 * Uses the platform `fetch` (injectable for tests) – no provider SDK required.
 */
export class LlmHttpTransport {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async postJson(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const { provider } = this.options;
    const maxRetryAfter = this.options.maxRetryAfterMs ?? 30_000;

    return retry(
      async (attempt) => {
        const signal = AbortSignal.timeout(timeoutMs ?? this.options.timeoutMs);
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
            body: JSON.stringify(body),
            signal,
          });
        } catch (error) {
          const isTimeout =
            error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
          throw new LlmError(
            provider,
            isTimeout ? 'timeout' : 'network',
            isTimeout
              ? `request timed out after ${timeoutMs ?? this.options.timeoutMs}ms`
              : `network error: ${(error as Error).message}`,
            { cause: error },
          );
        }

        const text = await response.text();
        if (!response.ok) {
          const kind = classifyStatus(response.status);
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
          throw new LlmError(
            provider,
            kind,
            `HTTP ${response.status}: ${truncate(maskSensitiveText(text), 500)}`,
            {
              status: response.status,
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            },
          );
        }
        this.options.logger?.debug({ provider, attempt, status: response.status }, 'LLM call succeeded');
        try {
          return JSON.parse(text) as unknown;
        } catch (error) {
          throw new LlmError(provider, 'invalid_response', 'response body is not valid JSON', {
            cause: error,
          });
        }
      },
      {
        attempts: this.options.maxRetries + 1,
        initialDelayMs: 500,
        maxDelayMs: 10_000,
        shouldRetry: (error) => error instanceof LlmError && error.retryable,
        delayFor: (error, _attempt, computed) =>
          error instanceof LlmError && error.retryAfterMs !== undefined
            ? Math.min(error.retryAfterMs, maxRetryAfter)
            : computed,
        onRetry: (error, attempt, delayMs) =>
          this.options.logger?.warn(
            { provider, attempt, delayMs, kind: error instanceof LlmError ? error.kind : 'unknown' },
            'retrying LLM call',
          ),
      },
    );
  }
}

/** Safely reads a nested property path from an unknown JSON value. */
export function pick(value: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

export const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;
export const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
