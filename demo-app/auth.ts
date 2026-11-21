import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { findByEmail, getUser, type Role } from './store.js';

export interface Principal {
  subject: string;
  role: Role;
  userId?: string;
  via: 'bearer' | 'basic' | 'session';
}

interface TokenEntry {
  principal: Principal;
  expiresAt: number;
}

const TOKEN_TTL_SECONDS = Number(process.env.DEMO_TOKEN_TTL_SECONDS ?? 900);
const OAUTH_CLIENTS: Record<string, { secret: string; role: Role }> = {
  [process.env.DEMO_CLIENT_ID ?? 'demo-client']: {
    secret: process.env.DEMO_CLIENT_SECRET ?? 'demo-client-secret',
    role: 'admin',
  },
};

const accessTokens = new Map<string, TokenEntry>();
const refreshTokens = new Map<string, Principal>();
const sessions = new Map<string, Principal>();

const newToken = () => randomBytes(24).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function verifyPassword(username: string, password: string): Principal | undefined {
  const user = findByEmail(username);
  if (!user?.password || user.status !== 'active' || !safeEqual(user.password, password)) return undefined;
  return { subject: user.email, role: user.role, userId: user.id, via: 'bearer' };
}

export function issueTokens(principal: Principal, ttlSeconds = TOKEN_TTL_SECONDS) {
  const accessToken = newToken();
  const refreshToken = newToken();
  accessTokens.set(accessToken, { principal, expiresAt: Date.now() + ttlSeconds * 1000 });
  refreshTokens.set(refreshToken, principal);
  return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: ttlSeconds };
}

/** Refresh tokens are single-use (rotation). */
export function rotateRefreshToken(refreshToken: string) {
  const principal = refreshTokens.get(refreshToken);
  if (!principal) return undefined;
  refreshTokens.delete(refreshToken);
  return issueTokens(principal);
}

export function clientCredentials(clientId: string, clientSecret: string) {
  const client = OAUTH_CLIENTS[clientId];
  if (!client || !safeEqual(client.secret, clientSecret)) return undefined;
  const principal: Principal = { subject: `client:${clientId}`, role: client.role, via: 'bearer' };
  const { accessToken, expiresIn } = issueTokens(principal);
  return { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn };
}

export function createSession(principal: Principal): string {
  const id = newToken();
  sessions.set(id, { ...principal, via: 'session' });
  return id;
}

export const destroySession = (id: string): boolean => sessions.delete(id);

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export type AuthResult =
  { ok: true; principal: Principal } | { ok: false; reason: 'missing' | 'invalid' | 'expired' };

/** Resolves the caller from a Bearer token, Basic credentials or the UI session cookie. */
export function authenticate(req: IncomingMessage): AuthResult {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const entry = accessTokens.get(header.slice(7).trim());
    if (!entry) return { ok: false, reason: 'invalid' };
    if (entry.expiresAt < Date.now()) return { ok: false, reason: 'expired' };
    return { ok: true, principal: entry.principal };
  }
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const principal =
      separator > 0 ? verifyPassword(decoded.slice(0, separator), decoded.slice(separator + 1)) : undefined;
    return principal
      ? { ok: true, principal: { ...principal, via: 'basic' } }
      : { ok: false, reason: 'invalid' };
  }
  const sessionId = readCookie(req, 'demo_session');
  if (sessionId) {
    const principal = sessions.get(sessionId);
    if (!principal) return { ok: false, reason: 'invalid' };
    // Session must still map to an active user.
    if (principal.userId && getUser(principal.userId)?.status !== 'active')
      return { ok: false, reason: 'invalid' };
    return { ok: true, principal };
  }
  return header ? { ok: false, reason: 'invalid' } : { ok: false, reason: 'missing' };
}

export const canWrite = (role: Role): boolean => role === 'admin' || role === 'editor';
export const canDelete = (role: Role): boolean => role === 'admin';
