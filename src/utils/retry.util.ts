import { setTimeout as delay } from 'node:timers/promises';

export interface RetryOptions {
  /** Total attempts including the first one (default 3). */
  attempts?: number;
  /** Initial backoff in ms (default 200). */
  initialDelayMs?: number;
  /** Maximum backoff in ms (default 5000). */
  maxDelayMs?: number;
  /** Exponential factor (default 2). */
  factor?: number;
  /** Adds +/-25% random jitter to avoid thundering herds (default true). */
  jitter?: boolean;
  /** Decides whether an error is transient and worth retrying (default: always). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Overrides the computed delay, e.g. to honour a Retry-After header. */
  delayFor?: (error: unknown, attempt: number, computedDelayMs: number) => number;
  /** Called before each retry (logging hook). */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Aborts waiting/retrying. */
  signal?: AbortSignal;
}

/**
 * Retries an async operation with exponential backoff.
 *
 * Intended for transient infrastructure failures (network blips, 429/5xx from
 * an LLM provider, eventual consistency in test-data setup). It must NOT be used
 * to paper over flaky assertions inside tests.
 */
export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const initial = options.initialDelayMs ?? 200;
  const max = options.maxDelayMs ?? 5000;
  const factor = options.factor ?? 2;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const retryable = attempt < attempts && (options.shouldRetry?.(error, attempt) ?? true);
      if (!retryable) throw error;
      let wait = Math.min(max, initial * factor ** (attempt - 1));
      if (options.jitter !== false) wait = Math.round(wait * (0.75 + Math.random() * 0.5));
      if (options.delayFor) wait = Math.max(0, options.delayFor(error, attempt, wait));
      options.onRetry?.(error, attempt, wait);
      await delay(wait, undefined, options.signal ? { signal: options.signal } : undefined);
    }
  }
  throw lastError;
}
