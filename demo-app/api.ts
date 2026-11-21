import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  authenticate,
  canDelete,
  canWrite,
  clientCredentials,
  issueTokens,
  rotateRefreshToken,
  verifyPassword,
  type Principal,
} from './auth.js';
import { HttpError, readJson, sendError, sendJson } from './http.js';
import {
  countUsers,
  createUser,
  deleteUser,
  findByEmail,
  getUser,
  listUsers,
  ROLES,
  toPublic,
  updateUser,
  type Role,
} from './store.js';
import { validateUser } from './validation.js';

const OPENAPI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'openapi.json');
export const APP_VERSION = '1.4.0';

interface IdempotentResponse {
  fingerprint: string;
  status: number;
  body: unknown;
  headers: Record<string, string>;
}
const idempotencyStore = new Map<string, IdempotentResponse>();

function requireAuth(req: IncomingMessage): Principal {
  const result = authenticate(req);
  if (result.ok) return result.principal;
  const messages = {
    missing: 'Authentication required',
    invalid: 'Invalid credentials or token',
    expired: 'Access token expired',
  };
  throw new HttpError(
    401,
    result.reason === 'expired' ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED',
    messages[result.reason],
  );
}

function requireRole(principal: Principal, allowed: (role: Role) => boolean, action: string) {
  if (!allowed(principal.role)) {
    throw new HttpError(403, 'FORBIDDEN', `Role "${principal.role}" is not permitted to ${action}`);
  }
}

function parsePositiveInt(value: string | null, name: string, fallback: number, max: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      `Query parameter "${name}" must be an integer between 1 and ${max}`,
      [{ field: name, message: `Must be an integer between 1 and ${max}` }],
    );
  }
  return n;
}

/** Returns true when the request was handled. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const route = url.pathname.replace(/^\/api/, '') || '/';
  const userMatch = /^\/users\/([^/]+)$/.exec(route);

  try {
    if (route === '/health' && method === 'GET') {
      return sendJson(res, 200, {
        status: 'ok',
        version: APP_VERSION,
        uptimeSeconds: Math.round(process.uptime()),
      });
    }
    if (route === '/openapi.json' && method === 'GET') {
      return sendJson(res, 200, JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')));
    }

    // ---- Authentication -----------------------------------------------------------
    if (route === '/auth/login' && method === 'POST') {
      const body = (await readJson(req)) as { username?: unknown; password?: unknown } | undefined;
      if (typeof body?.username !== 'string' || typeof body.password !== 'string') {
        throw new HttpError(400, 'VALIDATION_ERROR', 'username and password are required');
      }
      const principal = verifyPassword(body.username, body.password);
      if (!principal) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
      return sendJson(res, 200, issueTokens(principal));
    }
    if (route === '/auth/refresh' && method === 'POST') {
      const body = (await readJson(req)) as { refreshToken?: unknown } | undefined;
      if (typeof body?.refreshToken !== 'string') {
        throw new HttpError(400, 'VALIDATION_ERROR', 'refreshToken is required');
      }
      const tokens = rotateRefreshToken(body.refreshToken);
      if (!tokens)
        throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or already used');
      return sendJson(res, 200, tokens);
    }
    if (route === '/oauth/token' && method === 'POST') {
      const body = (await readJson(req)) as Record<string, unknown> | undefined;
      if (body?.grant_type !== 'client_credentials') {
        return sendJson(res, 400, { error: 'unsupported_grant_type' });
      }
      const clientId = typeof body.client_id === 'string' ? body.client_id : '';
      const clientSecret = typeof body.client_secret === 'string' ? body.client_secret : '';
      const tokens = clientCredentials(clientId, clientSecret);
      if (!tokens) return sendJson(res, 401, { error: 'invalid_client' });
      return sendJson(res, 200, tokens);
    }

    // ---- Users ------------------------------------------------------------------------
    if (route === '/users' && method === 'GET') {
      requireAuth(req);
      const page = parsePositiveInt(url.searchParams.get('page'), 'page', 1, 10_000);
      const pageSize = parsePositiveInt(url.searchParams.get('pageSize'), 'pageSize', 20, 100);
      const role = url.searchParams.get('role') ?? undefined;
      if (role && !ROLES.includes(role as Role)) {
        throw new HttpError(400, 'VALIDATION_ERROR', `role must be one of: ${ROLES.join(', ')}`);
      }
      const all = listUsers({ search: url.searchParams.get('search') ?? undefined, role });
      const data = all.slice((page - 1) * pageSize, page * pageSize).map(toPublic);
      return sendJson(res, 200, { data, page, pageSize, total: all.length });
    }
    if (route === '/users' && method === 'POST') {
      const principal = requireAuth(req);
      requireRole(principal, canWrite, 'create users');
      const body = await readJson(req);
      const key = req.headers['idempotency-key'];
      const fingerprint = createHash('sha256')
        .update(JSON.stringify(body ?? null))
        .digest('hex');
      if (typeof key === 'string' && key.length > 0) {
        const scopedKey = `${principal.subject}:${key}`;
        const previous = idempotencyStore.get(scopedKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) {
            throw new HttpError(
              422,
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was already used with a different payload',
            );
          }
          return sendJson(res, previous.status, previous.body, {
            ...previous.headers,
            'Idempotent-Replayed': 'true',
          });
        }
      }
      const validation = validateUser(body, 'create');
      if (!validation.ok)
        throw new HttpError(400, 'VALIDATION_ERROR', 'Request validation failed', validation.errors);
      const input = validation.value;
      if (findByEmail(input.email!))
        throw new HttpError(409, 'EMAIL_CONFLICT', 'A user with this e-mail already exists');
      const created = toPublic(
        createUser({
          firstName: input.firstName!,
          lastName: input.lastName!,
          email: input.email!,
          role: input.role!,
          status: input.status ?? 'active',
        }),
      );
      const headers = { Location: `/api/users/${created.id}` };
      if (typeof key === 'string' && key.length > 0) {
        idempotencyStore.set(`${principal.subject}:${key}`, {
          fingerprint,
          status: 201,
          body: created,
          headers,
        });
      }
      return sendJson(res, 201, created, headers);
    }
    if (userMatch) {
      const id = decodeURIComponent(userMatch[1]!);
      const principal = requireAuth(req);
      const existing = getUser(id);
      if (method === 'GET') {
        if (!existing) throw new HttpError(404, 'NOT_FOUND', `User ${id} not found`);
        return sendJson(res, 200, toPublic(existing));
      }
      if (method === 'PUT' || method === 'PATCH') {
        requireRole(principal, canWrite, 'update users');
        if (!existing) throw new HttpError(404, 'NOT_FOUND', `User ${id} not found`);
        const validation = validateUser(await readJson(req), method === 'PUT' ? 'replace' : 'patch');
        if (!validation.ok)
          throw new HttpError(400, 'VALIDATION_ERROR', 'Request validation failed', validation.errors);
        const { email } = validation.value;
        if (email && email !== existing.email && findByEmail(email)) {
          throw new HttpError(409, 'EMAIL_CONFLICT', 'A user with this e-mail already exists');
        }
        const changes =
          method === 'PUT' ? { status: 'active' as const, ...validation.value } : validation.value;
        return sendJson(res, 200, toPublic(updateUser(id, changes)!));
      }
      if (method === 'DELETE') {
        requireRole(principal, canDelete, 'delete users');
        if (!existing) throw new HttpError(404, 'NOT_FOUND', `User ${id} not found`);
        if (existing.builtIn)
          throw new HttpError(409, 'PROTECTED_ACCOUNT', 'Built-in accounts cannot be deleted');
        deleteUser(id);
        return sendJson(res, 204, undefined);
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${method} not allowed on ${url.pathname}`);
    }
    if (route === '/stats' && method === 'GET') {
      requireAuth(req);
      return sendJson(res, 200, { totalUsers: countUsers() });
    }
    throw new HttpError(404, 'NOT_FOUND', `No route for ${method} ${url.pathname}`);
  } catch (error) {
    if (error instanceof HttpError) {
      const headers: Record<string, string> =
        error.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="demo-app"' } : {};
      return sendError(res, error, headers);
    }
    console.error('[demo-app] unhandled API error', error);
    return sendError(res, new HttpError(500, 'INTERNAL_ERROR', 'Internal server error'));
  }
}
