import { expect, test } from '@playwright/test';

import { TokenManager, type TokenFetcher, type TokenSet } from '../../../src/auth/token.manager.js';
import { AuthenticationError } from '../../../src/core/exceptions/index.js';

function fakeFetcher(options: { refreshFails?: boolean; acquireFails?: boolean } = {}) {
  const calls = { acquire: 0, refresh: 0 };
  let counter = 0;
  const issue = (now: number): TokenSet => {
    counter += 1;
    return { accessToken: `access-${counter}`, refreshToken: `refresh-${counter}`, expiresAt: now + 60_000 };
  };
  let clock = 1_000_000;
  const fetcher: TokenFetcher = {
    acquire: async () => {
      calls.acquire += 1;
      if (options.acquireFails) throw new Error('identity provider down');
      return issue(clock);
    },
    refresh: async () => {
      calls.refresh += 1;
      if (options.refreshFails) throw new Error('refresh rejected');
      return issue(clock);
    },
  };
  return { fetcher, calls, advance: (ms: number) => (clock += ms), now: () => clock };
}

test.describe('TokenManager', () => {
  test('caches a valid token', async () => {
    const f = fakeFetcher();
    const manager = new TokenManager({ now: f.now });

    expect(await manager.getAccessToken('admin', f.fetcher)).toBe('access-1');
    expect(await manager.getAccessToken('admin', f.fetcher)).toBe('access-1');
    expect(f.calls).toEqual({ acquire: 1, refresh: 0 });
  });

  test('refreshes before expiry using the refresh token', async () => {
    const f = fakeFetcher();
    const manager = new TokenManager({ now: f.now, expirySkewMs: 10_000 });
    await manager.getAccessToken('admin', f.fetcher);

    f.advance(51_000); // within the 10s skew window of the 60s lifetime

    expect(await manager.getAccessToken('admin', f.fetcher)).toBe('access-2');
    expect(f.calls).toEqual({ acquire: 1, refresh: 1 });
  });

  test('falls back to full acquisition when refresh fails', async () => {
    const f = fakeFetcher({ refreshFails: true });
    const manager = new TokenManager({ now: f.now });
    await manager.getAccessToken('admin', f.fetcher);
    f.advance(120_000);

    expect(await manager.getAccessToken('admin', f.fetcher)).toBe('access-2');
    expect(f.calls).toEqual({ acquire: 2, refresh: 1 });
  });

  test('de-duplicates concurrent requests for the same key', async () => {
    const f = fakeFetcher();
    const manager = new TokenManager({ now: f.now });

    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => manager.getAccessToken('admin', f.fetcher)),
    );

    expect(new Set(tokens)).toEqual(new Set(['access-1']));
    expect(f.calls.acquire).toBe(1);
  });

  test('keeps keys isolated and supports invalidation', async () => {
    const f = fakeFetcher();
    const manager = new TokenManager({ now: f.now });
    const admin = await manager.getAccessToken('admin', f.fetcher);
    const viewer = await manager.getAccessToken('viewer', f.fetcher);
    expect(admin).not.toBe(viewer);

    manager.invalidate('admin');

    expect(await manager.getAccessToken('admin', f.fetcher)).toBe('access-3');
  });

  test('wraps acquisition failures in AuthenticationError without leaking details', async () => {
    const f = fakeFetcher({ acquireFails: true });
    const manager = new TokenManager({ now: f.now });

    await expect(manager.getAccessToken('admin', f.fetcher)).rejects.toThrow(AuthenticationError);
    await expect(manager.getAccessToken('admin', f.fetcher)).rejects.toThrow(
      'Unable to acquire token for "admin"',
    );
  });
});
