import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type JsonWebKey,
} from 'node:crypto';

import type { SessionUser } from './session.js';

/**
 * "Sign in with Google" (OpenID Connect authorization-code flow with PKCE).
 *
 * - state + PKCE verifier live in a short-lived signed cookie (CSRF / code-injection protection);
 * - the code is exchanged server-side with the client secret;
 * - the ID token signature is verified against Google's JWKS (RS256), plus iss / aud / exp;
 * - only verified e-mail addresses are accepted, optionally restricted by domain or address list.
 */

export const GOOGLE_ENDPOINTS = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
};
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** e.g. ["gmail.com"]; empty = any verified Google account. */
  allowedDomains: string[];
  /** Explicit e-mail allowlist; empty = no address restriction. */
  allowedEmails: string[];
  endpoints?: Partial<typeof GOOGLE_ENDPOINTS>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export class AuthError extends Error {
  override readonly name = 'AuthError';
}

export interface LoginStart {
  url: string;
  state: string;
  verifier: string;
}

export function startLogin(config: GoogleAuthConfig): LoginStart {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(config.endpoints?.authorize ?? GOOGLE_ENDPOINTS.authorize);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: url.toString(), state, verifier };
}

let jwksCache: { keys: Array<JsonWebKey & { kid?: string }>; until: number } | undefined;

async function getJwks(config: GoogleAuthConfig, fetchImpl: NonNullable<GoogleAuthConfig['fetch']>) {
  if (jwksCache && jwksCache.until > Date.now()) return jwksCache.keys;
  const res = await fetchImpl(config.endpoints?.jwks ?? GOOGLE_ENDPOINTS.jwks);
  if (!res.ok) throw new AuthError(`Google keys unavailable (HTTP ${res.status})`);
  const json = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
  jwksCache = { keys: json.keys ?? [], until: Date.now() + 60 * 60_000 };
  return jwksCache.keys;
}

/** Test hook: forget cached signing keys. */
export function resetJwksCache(): void {
  jwksCache = undefined;
}

async function verifyIdToken(
  idToken: string,
  config: GoogleAuthConfig,
  fetchImpl: NonNullable<GoogleAuthConfig['fetch']>,
): Promise<Record<string, unknown>> {
  const [headerB64, payloadB64, signatureB64] = idToken.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) throw new AuthError('malformed ID token');
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== 'RS256') throw new AuthError('unexpected ID token algorithm');
  const jwk = (await getJwks(config, fetchImpl)).find((k) => k.kid === header.kid);
  if (!jwk) throw new AuthError('unknown ID token signing key');
  const valid = verifySignature(
    'RSA-SHA256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(signatureB64, 'base64url'),
  );
  if (!valid) throw new AuthError('invalid ID token signature');

  const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (!ISSUERS.has(String(claims.iss))) throw new AuthError('unexpected ID token issuer');
  const aud = claims.aud;
  if (aud !== config.clientId && !(Array.isArray(aud) && aud.includes(config.clientId)))
    throw new AuthError('ID token was issued for another application');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() - 60_000)
    throw new AuthError('ID token expired');
  return claims;
}

/** Applies the e-mail policy; returns a user-facing reason when access is denied. */
export function checkEmailPolicy(
  email: string,
  verified: boolean,
  config: Pick<GoogleAuthConfig, 'allowedDomains' | 'allowedEmails'>,
): string | undefined {
  if (!verified) return 'Your Google e-mail address is not verified.';
  const normalized = email.toLowerCase();
  const domain = normalized.split('@')[1] ?? '';
  if (config.allowedEmails.length > 0 && config.allowedEmails.includes(normalized)) return undefined;
  if (config.allowedDomains.length > 0 && !config.allowedDomains.includes(domain))
    return `Only ${config.allowedDomains.map((d) => '@' + d).join(', ')} accounts can sign in.`;
  if (config.allowedDomains.length === 0 && config.allowedEmails.length > 0)
    return 'Your account is not on the access list.';
  return undefined;
}

/** Exchanges the authorization code and returns the verified, policy-checked user. */
export async function completeLogin(
  code: string,
  verifier: string,
  config: GoogleAuthConfig,
): Promise<SessionUser> {
  const fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
  const res = await fetchImpl(config.endpoints?.token ?? GOOGLE_ENDPOINTS.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new AuthError(`Google sign-in failed (HTTP ${res.status})`);
  const { id_token: idToken } = (await res.json()) as { id_token?: string };
  if (!idToken) throw new AuthError('Google returned no ID token');

  const claims = await verifyIdToken(idToken, config, fetchImpl);
  const email = typeof claims.email === 'string' ? claims.email : '';
  const denied = checkEmailPolicy(email, claims.email_verified === true, config);
  if (denied) throw new AuthError(denied);
  return {
    sub: String(claims.sub),
    email: email.toLowerCase(),
    ...(typeof claims.name === 'string' ? { name: claims.name.slice(0, 100) } : {}),
  };
}
