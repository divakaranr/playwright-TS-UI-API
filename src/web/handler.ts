import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { z } from 'zod';

import type { FetchLike } from '../ai/providers/http-transport.js';
import { LlmError } from '../ai/providers/llm-error.js';
import { listToolCallingModels } from '../ai/providers/model-catalog.js';
import type { ToolCallingProvider } from '../ai/providers/tool-chat.js';
import { formatZodIssues } from '../config/config.schema.js';
import { sanitizePrompt, validateTargetUrl } from '../console/input-guard.js';
import { apiKeySchema, modelIdSchema, PROVIDER_LABELS } from '../console/llm-settings.js';
import { launchBrowser, type BrowserLauncher } from './browser-tools.js';
import { AuthError, completeLogin, startLogin, type GoogleAuthConfig } from './google-auth.js';
import { cookieName, CookieSigner, parseCookies, serializeCookie, type SessionUser } from './session.js';
import { executeWebRun, WEB_PROVIDERS, type WebEvent } from './web-run.js';

/**
 * Hosted Test Console API (one serverless function for /api/*).
 *
 *   GET  /api/health                 liveness + configuration state (no secrets)
 *   GET  /api/auth/login             → Google sign-in
 *   GET  /api/auth/callback          ← Google, sets the session cookie
 *   POST /api/auth/logout
 *   GET  /api/me                     current user (401 when signed out)
 *   POST /api/models                 {provider, apiKey?} → tool-calling models (bring your own key)
 *   POST /api/run                    {targetUrl, prompt, mode, maxSteps, provider, model, apiKey} → NDJSON stream
 *
 * Users bring their own LLM key: it is used for that one request and never stored or logged.
 */

export interface WebHandlerDeps {
  env?: NodeJS.ProcessEnv;
  launch?: BrowserLauncher;
  /** fetch for LLM + model catalogue calls (tests). */
  fetch?: FetchLike;
  baseUrls?: Partial<Record<ToolCallingProvider, string>>;
  google?: Pick<GoogleAuthConfig, 'endpoints' | 'fetch'>;
  lookup?: (hostname: string) => Promise<string[]>;
  /** Tests only – the hosted app never allows private targets. */
  allowPrivateNetwork?: boolean;
  runBudget?: { softMs: number; hardMs: number };
  limits?: { runsPerHour: number };
  /** Structured log sink (default: one JSON line on stdout, collected by Vercel). */
  log?: (entry: Record<string, unknown>) => void;
}

const SESSION_TTL = 12 * 60 * 60;
const LOGIN_TTL = 10 * 60;
const BODY_LIMIT = 32_000;

const runSchema = z
  .object({
    targetUrl: z.string().max(2048),
    prompt: z.string().max(4000),
    mode: z.enum(['explore', 'generate']).default('generate'),
    maxSteps: z.number().int().min(3).max(25).default(20),
    provider: z.enum(WEB_PROVIDERS),
    model: modelIdSchema,
    apiKey: apiKeySchema,
  })
  .strict();
const modelsSchema = z.object({ provider: z.enum(WEB_PROVIDERS), apiKey: apiKeySchema.optional() }).strict();

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly errors: string[],
  ) {
    super(errors.join('; '));
  }
}

const csv = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

interface ResolvedConfig {
  signer: CookieSigner;
  google: GoogleAuthConfig;
}

function resolveConfig(env: NodeJS.ProcessEnv, deps: WebHandlerDeps, origin: string): ResolvedConfig {
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'AUTH_SECRET'].filter((k) => !env[k]);
  if (missing.length > 0) throw new HttpError(503, [`Server not configured: set ${missing.join(', ')}`]);
  const appUrl =
    env.APP_URL ??
    (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : origin);
  return {
    signer: new CookieSigner(env.AUTH_SECRET!),
    google: {
      clientId: env.GOOGLE_CLIENT_ID!,
      clientSecret: env.GOOGLE_CLIENT_SECRET!,
      redirectUri: `${appUrl.replace(/\/$/, '')}/api/auth/callback`,
      allowedDomains: csv(env.ALLOWED_EMAIL_DOMAINS),
      allowedEmails: csv(env.ALLOWED_EMAILS),
      ...(deps.google?.endpoints ? { endpoints: deps.google.endpoints } : {}),
      ...(deps.google?.fetch ? { fetch: deps.google.fetch } : {}),
    },
  };
}

function describeLlmError(provider: ToolCallingProvider, error: unknown): HttpError {
  const label = PROVIDER_LABELS[provider];
  if (!(error instanceof LlmError)) return new HttpError(502, [`${label}: ${(error as Error).message}`]);
  if (error.kind === 'configuration') return new HttpError(400, [`API key: required for ${label}`]);
  if (error.kind === 'authentication') return new HttpError(400, [`API key: rejected by ${label}`]);
  if (error.kind === 'rate_limit') return new HttpError(429, [`${label}: rate limited – try again shortly`]);
  return new HttpError(502, [`${label}: ${error.message.replace(/^\[[^\]]+\]\s*/, '')}`]);
}

export function createWebHandler(deps: WebHandlerDeps = {}) {
  const env = deps.env ?? process.env;
  const launch = deps.launch ?? launchBrowser;
  const log =
    deps.log ?? ((entry: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(entry)}\n`));
  const runsPerHour = deps.limits?.runsPerHour ?? Number(env.RUNS_PER_HOUR ?? 10);
  // Best-effort per-instance limits (serverless instances are reused while warm).
  const history = new Map<string, number[]>();
  const active = new Set<string>();

  const send = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string | string[]> = {},
  ) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const redirect = (res: ServerResponse, location: string, cookies: string[] = []) => {
    res.writeHead(302, {
      Location: location,
      'Cache-Control': 'no-store',
      ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
    });
    res.end();
  };

  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? ''))
      throw new HttpError(415, ['Content-Type must be application/json']);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > BODY_LIMIT) throw new HttpError(413, ['request too large']);
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    } catch {
      throw new HttpError(400, ['invalid JSON']);
    }
  };

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host =
      req.headers['x-forwarded-host']?.toString().split(',')[0]?.trim() || req.headers.host || 'localhost';
    const proto = req.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim() || 'http';
    const origin = `${proto}://${host}`;
    const secure = proto === 'https';
    const url = new URL(req.url ?? '/', origin);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'GET' && path === '/api/health') {
        const configured = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'AUTH_SECRET'].every((k) => env[k]);
        return send(res, 200, { ok: true, configured, providers: WEB_PROVIDERS });
      }
      // State-changing requests must come from this site (CSRF defence in addition to SameSite cookies).
      if (req.method !== 'GET' && req.headers.origin !== origin)
        throw new HttpError(403, ['forbidden origin']);

      const config = resolveConfig(env, deps, origin);
      const cookies = parseCookies(req.headers.cookie);
      const user = config.signer.verify<SessionUser & Record<string, unknown>>(
        cookies[cookieName('pwc_session', secure)],
      );

      if (req.method === 'GET' && path === '/api/auth/login') {
        const login = startLogin(config.google);
        return redirect(res, login.url, [
          serializeCookie(
            'pwc_login',
            config.signer.sign({ state: login.state, verifier: login.verifier }, LOGIN_TTL),
            {
              maxAge: LOGIN_TTL,
              secure,
            },
          ),
        ]);
      }
      if (req.method === 'GET' && path === '/api/auth/callback') {
        const pending = config.signer.verify<{ state: string; verifier: string }>(
          cookies[cookieName('pwc_login', secure)],
        );
        const clearLogin = serializeCookie('pwc_login', '', { maxAge: 0, secure });
        const fail = (message: string) =>
          redirect(res, `/?auth_error=${encodeURIComponent(message)}`, [clearLogin]);
        if (url.searchParams.get('error')) return fail('Sign-in was cancelled.');
        const code = url.searchParams.get('code');
        if (!pending || !code || url.searchParams.get('state') !== pending.state)
          return fail('Sign-in expired or was tampered with. Please try again.');
        try {
          const signedIn = await completeLogin(code, pending.verifier, config.google);
          log({ event: 'sign_in', user: hashUser(signedIn.email) });
          return redirect(res, '/', [
            clearLogin,
            serializeCookie('pwc_session', config.signer.sign({ ...signedIn }, SESSION_TTL), {
              maxAge: SESSION_TTL,
              secure,
            }),
          ]);
        } catch (error) {
          return fail(error instanceof AuthError ? error.message : 'Sign-in failed. Please try again.');
        }
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        return send(
          res,
          200,
          { ok: true },
          { 'Set-Cookie': serializeCookie('pwc_session', '', { maxAge: 0, secure }) },
        );
      }

      if (!user) throw new HttpError(401, ['Please sign in with Google.']);

      if (req.method === 'GET' && path === '/api/me') {
        return send(res, 200, { email: user.email, name: user.name ?? null, runsPerHour });
      }
      if (req.method === 'POST' && path === '/api/models') {
        const input = modelsSchema.safeParse(await readJson(req));
        if (!input.success) throw new HttpError(400, formatZodIssues(input.error));
        try {
          const models = await listToolCallingModels(input.data.provider, {
            apiKey: input.data.apiKey,
            ...(deps.baseUrls?.[input.data.provider] ? { baseUrl: deps.baseUrls[input.data.provider] } : {}),
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
          });
          return send(res, 200, { provider: input.data.provider, models });
        } catch (error) {
          throw describeLlmError(input.data.provider, error);
        }
      }
      if (req.method === 'POST' && path === '/api/run') {
        const parsed = runSchema.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, formatZodIssues(parsed.error));
        const target = await validateTargetUrl(
          parsed.data.targetUrl,
          {
            allowPrivateNetwork: deps.allowPrivateNetwork ?? false,
            allowedHosts: csv(env.ALLOWED_TARGET_HOSTS),
          },
          ...(deps.lookup ? [deps.lookup] : []),
        );
        const prompt = target.ok ? sanitizePrompt(parsed.data.prompt, target.value) : undefined;
        const errors = [
          ...(target.ok ? [] : target.errors.map((e) => `Website URL: ${e}`)),
          ...(prompt && !prompt.ok ? prompt.errors.map((e) => `Prompt: ${e}`) : []),
        ];
        if (errors.length > 0 || !target.ok || !prompt?.ok) throw new HttpError(400, errors);

        if (active.has(user.sub)) throw new HttpError(409, ['You already have a run in progress.']);
        const now = Date.now();
        const recent = (history.get(user.sub) ?? []).filter((t) => t > now - 3_600_000);
        if (recent.length >= runsPerHour)
          throw new HttpError(429, [`Limit reached: ${runsPerHour} runs per hour. Please try again later.`]);
        history.set(user.sub, [...recent, now]);
        active.add(user.sub);

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        const abort = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) abort.abort();
        });
        const write = (event: WebEvent | { type: 'ping' }) => {
          if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
        };
        const heartbeat = setInterval(() => write({ type: 'ping' }), 15_000);
        try {
          const status = await executeWebRun(
            { ...parsed.data, targetUrl: target.value, prompt: prompt.value.prompt },
            {
              launch,
              emit: write,
              signal: abort.signal,
              ...(deps.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
              ...(deps.baseUrls ? { baseUrls: deps.baseUrls } : {}),
              ...(deps.fetch ? { fetch: deps.fetch } : {}),
              ...(deps.runBudget
                ? { softBudgetMs: deps.runBudget.softMs, hardBudgetMs: deps.runBudget.hardMs }
                : {}),
            },
          );
          log({
            event: 'run',
            user: hashUser(user.email),
            host: new URL(target.value).host,
            provider: parsed.data.provider,
            status,
            ms: Date.now() - now,
          });
        } finally {
          clearInterval(heartbeat);
          active.delete(user.sub);
          res.end();
        }
        return;
      }
      throw new HttpError(404, ['not found']);
    } catch (error) {
      if (error instanceof HttpError) {
        if (res.headersSent) return void res.end();
        return send(res, error.status, { error: error.message, errors: error.errors });
      }
      log({ event: 'error', message: (error as Error).message });
      if (!res.headersSent) send(res, 500, { error: 'internal error', errors: ['internal error'] });
      else res.end();
    }
  };
}

const hashUser = (email: string) => createHash('sha256').update(email).digest('hex').slice(0, 12);

/** Vercel entry point. */
export default createWebHandler();
