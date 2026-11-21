import { expect, test } from '@playwright/test';

import { OperationTimeoutError, UiActionError } from '../../../src/core/exceptions/index.js';
import { isPathInside } from '../../../src/utils/paths.js';
import { uniqueId } from '../../../src/utils/random.util.js';
import { retry } from '../../../src/utils/retry.util.js';
import { slugify } from '../../../src/utils/file.util.js';
import { waitUntil, withTimeout } from '../../../src/utils/wait.util.js';

test.describe('retry', () => {
  test('retries transient failures then succeeds', async () => {
    let attempts = 0;
    const result = await retry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('transient');
        return 'ok';
      },
      { attempts: 3, initialDelayMs: 1, jitter: false },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  test('stops immediately for non-retryable errors', async () => {
    let attempts = 0;
    await expect(
      retry(
        async () => {
          attempts += 1;
          throw new Error('fatal');
        },
        { attempts: 5, initialDelayMs: 1, shouldRetry: () => false },
      ),
    ).rejects.toThrow('fatal');
    expect(attempts).toBe(1);
  });

  test('honours delay overrides (e.g. Retry-After)', async () => {
    const delays: number[] = [];
    await retry(
      async (attempt) => {
        if (attempt === 1) throw new Error('429');
      },
      { attempts: 2, delayFor: () => 5, onRetry: (_e, _a, d) => delays.push(d) },
    );
    expect(delays).toEqual([5]);
  });
});

test.describe('wait utilities', () => {
  test('waitUntil resolves when the condition becomes true', async () => {
    let value = 0;
    const result = await waitUntil(
      async () => ++value,
      (v) => v >= 3,
      { intervalsMs: [1] },
    );
    expect(result).toBe(3);
  });

  test('waitUntil times out with a descriptive error', async () => {
    await expect(
      waitUntil(async () => false, Boolean, { timeoutMs: 50, intervalsMs: [10], description: 'flag set' }),
    ).rejects.toThrow('flag set timed out after 50ms');
  });

  test('withTimeout rejects slow work', async () => {
    await expect(withTimeout(new Promise(() => undefined), 20, 'slow op')).rejects.toBeInstanceOf(
      OperationTimeoutError,
    );
  });
});

test.describe('misc utilities', () => {
  test('uniqueId is unique and carries a prefix', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uniqueId('x')));
    expect(ids.size).toBe(1000);
    expect([...ids][0]).toMatch(/^x-w\w+-[a-z0-9]+-[0-9a-f]{6}$/);
  });

  test('isPathInside prevents traversal', () => {
    expect(isPathInside('/base', '/base/a/b')).toBe(true);
    expect(isPathInside('/base', '/base/../etc/passwd')).toBe(false);
  });

  test('slugify produces filesystem-safe names', () => {
    expect(slugify('Login > valid user: can log in!')).toBe('login-valid-user-can-log-in');
  });

  test('UiActionError carries action, target, url and cause', () => {
    const cause = new Error('Timeout 15000ms exceeded.\nCall log: ...');
    const error = new UiActionError('click', { url: 'http://x/login', target: "getByRole('button')" }, cause);
    expect(error.message).toBe(
      "UI action failed: click [target: getByRole('button')] [url: http://x/login] -> Timeout 15000ms exceeded.",
    );
    expect(error.cause).toBe(cause);
    expect(error.code).toBe('UI_ACTION_ERROR');
  });
});
