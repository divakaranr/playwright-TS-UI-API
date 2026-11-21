/**
 * Controlled demo application used to validate the framework deterministically
 * (locally and in CI) without depending on an unstable third-party website.
 *
 *   npm run demo:start            -> http://localhost:4000
 *   DEMO_APP_PORT=4100 npm run demo:start
 *
 * Dependency-free (node:http). Not production code: state is in memory.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { handleApi } from './api.js';
import {
  authenticate,
  canDelete,
  canWrite,
  createSession,
  destroySession,
  readCookie,
  verifyPassword,
} from './auth.js';
import {
  applyStandardHeaders,
  HttpError,
  readBody,
  readForm,
  redirect,
  sendError,
  sendHtml,
  sendJson,
} from './http.js';
import {
  countUsers,
  createUser,
  findByEmail,
  getUser,
  listUsers,
  toPublic,
  type UserRecord,
} from './store.js';
import { PASSWORD_RULE, validateUser } from './validation.js';
import {
  COUNTRIES,
  dashboardView,
  helpWidgetView,
  loginView,
  notFoundView,
  registerView,
  registrationSuccessView,
  releaseNotesView,
  searchView,
  userDetailView,
  usersView,
} from './views.js';

const PORT = Number(process.env.DEMO_APP_PORT ?? 4000);
const SESSION_COOKIE = 'demo_session';

function safeNext(next: string | null | undefined): string {
  // Only allow local absolute paths (prevents open redirects).
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

function currentPrincipal(req: IncomingMessage) {
  const result = authenticate(req);
  return result.ok ? result.principal : undefined;
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function handleUi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const route = url.pathname;
  const principal = currentPrincipal(req);

  // ---- Public routes ------------------------------------------------------------------
  if (route === '/' && method === 'GET') return redirect(res, principal ? '/dashboard' : '/login');
  if (route === '/login' && method === 'GET') {
    return sendHtml(res, 200, loginView(undefined, '', safeNext(url.searchParams.get('next'))));
  }
  if (route === '/login' && method === 'POST') {
    const form = await readForm(req);
    const username = form.get('username')?.trim() ?? '';
    const password = form.get('password') ?? '';
    const next = safeNext(form.get('next'));
    if (!username || !password)
      return sendHtml(res, 400, loginView('Username and password are required', username, next));
    const authenticated = verifyPassword(username, password);
    if (!authenticated) return sendHtml(res, 401, loginView('Invalid username or password', username, next));
    const sessionId = createSession(authenticated);
    return redirect(res, next, {
      'Set-Cookie': `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/`,
    });
  }
  if (route === '/logout' && method === 'POST') {
    const sessionId = readCookie(req, SESSION_COOKIE);
    if (sessionId) destroySession(sessionId);
    return redirect(res, '/login', { 'Set-Cookie': `${SESSION_COOKIE}=; Max-Age=0; Path=/` });
  }
  if (route === '/register' && method === 'GET') return sendHtml(res, 200, registerView());
  if (route === '/register' && method === 'POST') {
    const form = Object.fromEntries(await readForm(req));
    const errors: string[] = [];
    const validation = validateUser(
      { firstName: form.firstName, lastName: form.lastName, email: form.email, role: 'viewer' },
      'create',
    );
    if (!validation.ok) {
      const labels: Record<string, string> = {
        firstName: 'First name',
        lastName: 'Last name',
        email: 'Email',
      };
      errors.push(...validation.errors.map((x) => `${labels[x.field] ?? x.field}: ${x.message}`));
    }
    if (!PASSWORD_RULE.test(form.password ?? '')) {
      errors.push('Password: Must be 8-64 characters and include an uppercase letter, a digit and a symbol');
    }
    if ((form.password ?? '') !== (form.confirmPassword ?? ''))
      errors.push('Confirm password: Passwords do not match');
    if (!COUNTRIES.includes((form.country ?? '') as (typeof COUNTRIES)[number]))
      errors.push('Country: Select a country');
    if (form.terms !== 'yes') errors.push('Terms: You must accept the terms and conditions');
    if (validation.ok && findByEmail(validation.value.email!))
      errors.push('Email: An account with this e-mail already exists');
    if (errors.length > 0 || !validation.ok) return sendHtml(res, 400, registerView(errors, form));
    const user = createUser({
      firstName: validation.value.firstName!,
      lastName: validation.value.lastName!,
      email: validation.value.email!,
      role: 'viewer',
      status: 'active',
      password: form.password!,
    } satisfies Omit<UserRecord, 'id' | 'createdAt' | 'updatedAt'>);
    return sendHtml(res, 201, registrationSuccessView(user.email));
  }
  if (route === '/widgets/help' && method === 'GET') return sendHtml(res, 200, helpWidgetView());
  if (route === '/release-notes' && method === 'GET') return sendHtml(res, 200, releaseNotesView(principal));

  // ---- Authenticated routes -------------------------------------------------------
  if (!principal) return redirect(res, `/login?next=${encodeURIComponent(route + url.search)}`);

  if (route === '/dashboard' && method === 'GET')
    return sendHtml(res, 200, dashboardView(principal, countUsers()));
  if (route === '/users' && method === 'GET') {
    const filter = url.searchParams.get('q') ?? '';
    const users = listUsers({ search: filter }).map(toPublic);
    return sendHtml(
      res,
      200,
      usersView(principal, users, filter, {
        canEdit: canWrite(principal.role),
        canDelete: canDelete(principal.role),
      }),
    );
  }
  if (route === '/users/export.csv' && method === 'GET') {
    const lines = ['id,firstName,lastName,email,role,status'].concat(
      listUsers().map((u) =>
        [u.id, u.firstName, u.lastName, u.email, u.role, u.status].map(csvEscape).join(','),
      ),
    );
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
    res.end(`${lines.join('\n')}\n`);
    return;
  }
  if (route === '/users/import' && method === 'POST') {
    if (!canWrite(principal.role)) throw new HttpError(403, 'FORBIDDEN', 'Not permitted to import users');
    const [header, ...rows] = (await readBody(req)).trim().split(/\r?\n/);
    if (header?.trim() !== 'firstName,lastName,email,role') {
      throw new HttpError(400, 'INVALID_CSV', 'Expected header: firstName,lastName,email,role');
    }
    let imported = 0;
    for (const row of rows.filter((r) => r.trim())) {
      const [firstName, lastName, email, role] = row.split(',').map((c) => c.trim());
      const validation = validateUser({ firstName, lastName, email, role }, 'create');
      if (!validation.ok || findByEmail(validation.value.email!)) continue;
      createUser({ ...(validation.value as Required<typeof validation.value>), status: 'active' });
      imported += 1;
    }
    return sendJson(res, 200, { imported });
  }
  const detail = /^\/users\/([^/]+)$/.exec(route);
  if (detail && method === 'GET') {
    const user = getUser(decodeURIComponent(detail[1]!));
    return user
      ? sendHtml(res, 200, userDetailView(principal, toPublic(user)))
      : sendHtml(res, 404, notFoundView(principal));
  }
  if (route === '/search' && method === 'GET') {
    const term = url.searchParams.get('term');
    const results = term === null ? undefined : term.trim() ? listUsers({ search: term }).map(toPublic) : [];
    return sendHtml(res, 200, searchView(principal, term ?? '', results));
  }
  return sendHtml(res, 404, notFoundView(principal));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  applyStandardHeaders(req, res);
  if (process.env.DEMO_APP_VERBOSE === 'true') console.log(`[demo-app] ${req.method} ${url.pathname}`);
  const handler = url.pathname === '/api' || url.pathname.startsWith('/api/') ? handleApi : handleUi;
  handler(req, res, url).catch((error: unknown) => {
    if (error instanceof HttpError) return sendError(res, error);
    console.error('[demo-app] unhandled error', error);
    return sendError(res, new HttpError(500, 'INTERNAL_ERROR', 'Internal server error'));
  });
});

server.listen(PORT, () => console.log(`[demo-app] listening on http://localhost:${PORT}`));

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
