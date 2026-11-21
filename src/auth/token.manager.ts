import { AuthenticationError } from '../core/exceptions/index.js';
import type { Logger } from '../utils/logger.js';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
}

export interface TokenFetcher {
  /** Acquires a brand-new token set (e.g. password or client-credentials grant). */
  acquire(): Promise<TokenSet>;
  /** Exchanges a refresh token for a new token set. Optional. */
  refresh?(refreshToken: string): Promise<TokenSet>;
}

export interface TokenManagerOptions {
  /** Refresh this many ms before expiry to avoid using a token that expires in flight (default 30s). */
  expirySkewMs?: number;
  /** Injectable clock for deterministic unit tests. */
  now?: () => number;
  logger?: Logger;
}

/**
 * Caches tokens per key (e.g. "password:admin", "client:demo-client"), refreshes
 * them before expiry, falls back to full re-acquisition if refresh fails, and
 * de-duplicates concurrent requests for the same key. Token values are never logged.
 */
export class TokenManager {
  private readonly cache = new Map<string, TokenSet>();
  private readonly inFlight = new Map<string, Promise<TokenSet>>();
  private readonly skew: number;
  private readonly now: () => number;

  constructor(private readonly options: TokenManagerOptions = {}) {
    this.skew = options.expirySkewMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(key: string, fetcher: TokenFetcher): Promise<string> {
    return (await this.getTokenSet(key, fetcher)).accessToken;
  }

  async getTokenSet(key: string, fetcher: TokenFetcher): Promise<TokenSet> {
    const cached = this.cache.get(key);
    if (cached && !this.isExpiring(cached)) return cached;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = this.obtain(key, cached, fetcher).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  isExpiring(token: TokenSet): boolean {
    return token.expiresAt - this.skew <= this.now();
  }

  private async obtain(key: string, cached: TokenSet | undefined, fetcher: TokenFetcher): Promise<TokenSet> {
    if (cached?.refreshToken && fetcher.refresh) {
      try {
        const refreshed = await fetcher.refresh(cached.refreshToken);
        this.options.logger?.debug({ key }, 'access token refreshed');
        return this.store(key, refreshed);
      } catch (error) {
        this.options.logger?.warn({ key, err: error }, 'token refresh failed; re-acquiring');
      }
    }
    try {
      const acquired = await fetcher.acquire();
      this.options.logger?.debug({ key }, 'access token acquired');
      return this.store(key, acquired);
    } catch (error) {
      this.cache.delete(key);
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError(`Unable to acquire token for "${key}"`, { cause: error });
    }
  }

  private store(key: string, token: TokenSet): TokenSet {
    if (!token.accessToken)
      throw new AuthenticationError(`Token endpoint returned no access token for "${key}"`);
    this.cache.set(key, token);
    return token;
  }
}
