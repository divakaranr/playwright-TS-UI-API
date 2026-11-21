import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stateless signed cookies (HMAC-SHA256) for the hosted Test Console.
 * Payloads are not secret (only user id / e-mail), but they cannot be forged
 * without AUTH_SECRET and they expire. No database is needed.
 */

export interface SessionUser {
  sub: string;
  email: string;
  name?: string;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

export class CookieSigner {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters');
    this.key = Buffer.from(secret, 'utf8');
  }

  sign(payload: Record<string, unknown>, ttlSeconds: number, now = Date.now()): string {
    const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds }));
    return `${body}.${this.mac(body)}`;
  }

  /** Returns the payload when the signature is valid and the value has not expired. */
  verify<T extends Record<string, unknown>>(value: string | undefined, now = Date.now()): T | undefined {
    if (!value || value.length > 4096) return undefined;
    const [body, signature, extra] = value.split('.');
    if (!body || !signature || extra !== undefined) return undefined;
    const expected = Buffer.from(this.mac(body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
      if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return undefined;
      return payload;
    } catch {
      return undefined;
    }
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // ignore malformed cookie values
    }
  }
  return cookies;
}

/** Builds a Set-Cookie header. `secure` cookies get the __Host- prefix (HTTPS, path=/, no domain). */
export function serializeCookie(
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean; sameSite?: 'Lax' | 'Strict' },
): string {
  return [
    `${options.secure ? '__Host-' : ''}${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${options.sameSite ?? 'Lax'}`,
    `Max-Age=${options.maxAge}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}

export const cookieName = (name: string, secure: boolean) => `${secure ? '__Host-' : ''}${name}`;
