import type { Credentials } from '../../config/index.js';

/**
 * Strategy for attaching credentials to outgoing API requests. Clients depend on
 * this interface only, so tests can switch between anonymous, Basic, Bearer and
 * OAuth2 client-credentials auth without changing client code.
 */
export interface AuthProvider {
  /** Human-readable scheme name for logs (never the credential itself). */
  readonly scheme: string;
  headers(): Promise<Record<string, string>>;
}

export class NoAuthProvider implements AuthProvider {
  readonly scheme = 'none';
  headers(): Promise<Record<string, string>> {
    return Promise.resolve({});
  }
}

export class BasicAuthProvider implements AuthProvider {
  readonly scheme = 'basic';
  constructor(private readonly credentials: Credentials) {}

  headers(): Promise<Record<string, string>> {
    const encoded = Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString(
      'base64',
    );
    return Promise.resolve({ Authorization: `Basic ${encoded}` });
  }
}

/** Bearer token resolved lazily on every request (lets TokenManager refresh transparently). */
export class BearerTokenProvider implements AuthProvider {
  readonly scheme: string;
  constructor(
    private readonly tokenSource: () => Promise<string>,
    label = 'bearer',
  ) {
    this.scheme = label;
  }

  async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.tokenSource()}` };
  }
}

/** A fixed (possibly deliberately invalid) token – used by negative authentication tests. */
export class StaticTokenProvider implements AuthProvider {
  readonly scheme = 'static-bearer';
  constructor(private readonly token: string) {}

  headers(): Promise<Record<string, string>> {
    return Promise.resolve({ Authorization: `Bearer ${this.token}` });
  }
}
