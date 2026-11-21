import { setTimeout as delay } from 'node:timers/promises';

import { OperationTimeoutError } from '../core/exceptions/index.js';

export interface PollOptions {
  /** Overall budget in ms (default 10_000). */
  timeoutMs?: number;
  /** Poll intervals in ms; the last value repeats (default [100, 250, 500, 1000]). */
  intervalsMs?: readonly number[];
  /** Describes the awaited condition for error messages. */
  description?: string;
}

/**
 * Polls `probe` until `predicate` accepts its result – a condition-based wait for
 * non-UI state (e.g. eventual consistency of a backend after a UI action).
 * For UI state always prefer Playwright web-first assertions (`expect(locator)…`)
 * or `expect.poll`; this utility exists for framework code outside a test.
 */
export async function waitUntil<T>(
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: PollOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervals = options.intervalsMs ?? [100, 250, 500, 1000];
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (let i = 0; ; i++) {
    try {
      const value = await probe();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = new OperationTimeoutError(options.description ?? 'waitUntil condition', timeoutMs);
      if (lastError !== undefined) (error as { cause?: unknown }).cause = lastError;
      throw error;
    }
    const interval = intervals[Math.min(i, intervals.length - 1)] ?? 1000;
    await delay(Math.min(interval, remaining));
  }
}

/** Races a promise against a timeout. The underlying work is not cancelled; pass an AbortSignal for that. */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(operation, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
