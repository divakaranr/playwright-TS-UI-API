import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import type { FetchLike } from '../ai/providers/http-transport.js';
import {
  createToolChatClient,
  type ToolCallingProvider,
  type ToolChatClient,
} from '../ai/providers/tool-chat.js';
import type { AgentEvent, AgentRunStatus } from '../agent/types.js';
import type { FrameworkConfig } from '../config/index.js';
import { formatZodIssues } from '../config/config.schema.js';
import { fileTimestamp } from '../utils/date.util.js';
import type { Logger } from '../utils/logger.js';
import { isPathInside, paths } from '../utils/paths.js';
import { executeConsoleRun, runRequestSchema, type RunRequest } from './console-run.js';
import { sanitizePrompt, validateTargetUrl } from './input-guard.js';
import { LlmSettings, modelsInputSchema, settingsInputSchema, SettingsError } from './llm-settings.js';
import type { EncryptedFileStore } from './secret-store.js';

export interface ConsoleServerOptions {
  port: number;
  /** LLM_* from .env – used until provider/model/key are saved in the UI. */
  llm: FrameworkConfig['llm'];
  /** Encrypted store for the settings entered in the UI (in memory only when omitted). */
  secretStore?: EncryptedFileStore;
  /** Provider endpoint overrides and fetch for model listing (tests). */
  providerBaseUrls?: Partial<Record<ToolCallingProvider, string>>;
  providerFetch?: FetchLike;
  logger?: Logger;
  /** Optional allowlist of target hostnames (CONSOLE_ALLOWED_HOSTS; "*.example.com" allowed). Empty = any public host. */
  allowedHosts?: string[];
  /** Allow localhost/private-network targets (CONSOLE_ALLOW_PRIVATE_NETWORK). Default false (SSRF protection). */
  allowPrivateNetwork?: boolean;
  /** DNS resolver override (tests). */
  lookup?: (hostname: string) => Promise<string[]>;
  /** Hard limit for one run (default 20 minutes). */
  runTimeoutMs?: number;
  /** Injection point for tests. */
  createChat?: () => ToolChatClient;
}

interface RunRecord {
  id: string;
  request: RunRequest;
  status: 'running' | AgentRunStatus;
  startedAt: string;
  events: AgentEvent[];
  listeners: Set<ServerResponse>;
  abort: AbortController;
}

const SERVED_ROOTS = [path.join(paths.reports, 'console-runs'), path.join(paths.generatedTests, 'console')];
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.webm': 'video/webm',
  '.yml': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Local "Test Console": a web UI that takes a prompt and lets an LLM test a
 * website through the official Playwright MCP. Binds to 127.0.0.1 only and
 * rejects foreign Host/Origin headers (DNS-rebinding / CSRF protection).
 */
export async function startConsoleServer(
  options: ConsoleServerOptions,
): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const runs = new Map<string, RunRecord>();
  let active: RunRecord | undefined;
  const uiFile = path.join(paths.src, 'console', 'ui.html');

  const urlFor = (absolute: string) =>
    `/files/${path.relative(paths.root, absolute).split(path.sep).map(encodeURIComponent).join('/')}`;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const publish = (run: RunRecord, event: AgentEvent) => {
    run.events.push(event);
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const listener of run.listeners) listener.write(payload);
    if (event.type === 'done') {
      run.status = event.status;
      for (const listener of run.listeners) listener.end();
      run.listeners.clear();
    }
  };

  const settings = new LlmSettings({
    env: options.llm,
    ...(options.secretStore ? { store: options.secretStore } : {}),
    ...(options.providerBaseUrls ? { baseUrls: options.providerBaseUrls } : {}),
    ...(options.providerFetch ? { fetch: options.providerFetch } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const llmStatus = () => {
    const { ready, message, provider, model, source } = settings.status();
    return { ready, message, provider, model, source };
  };
  const isJson = (req: IncomingMessage) =>
    /^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '');

  const startRun = (request: RunRequest): RunRecord => {
    const run: RunRecord = {
      id: `${fileTimestamp()}-${randomBytes(3).toString('hex')}`,
      request,
      status: 'running',
      startedAt: new Date().toISOString(),
      events: [],
      listeners: new Set(),
      abort: new AbortController(),
    };
    runs.set(run.id, run);
    for (const old of [...runs.keys()].slice(0, Math.max(0, runs.size - 20))) runs.delete(old);
    active = run;
    const timer = setTimeout(() => run.abort.abort(), options.runTimeoutMs ?? 20 * 60_000);
    const llm = settings.llmConfig();
    const chat =
      options.createChat?.() ??
      createToolChatClient(
        llm ?? { ...options.llm, provider: 'none' },
        options.logger ? { logger: options.logger } : {},
      );
    options.logger?.info(
      { runId: run.id, target: request.targetUrl, mode: request.mode },
      'console run started',
    );

    executeConsoleRun({
      runId: run.id,
      request,
      chat,
      emit: (e) => publish(run, e),
      signal: run.abort.signal,
      urlFor,
      ...(options.logger ? { logger: options.logger } : {}),
    })
      .catch((error: unknown) => {
        publish(run, { type: 'error', message: (error as Error).message });
        publish(run, { type: 'done', status: 'failed', durationMs: 0, steps: 0 });
      })
      .finally(() => {
        clearTimeout(timer);
        if (active === run) active = undefined;
      });
    return run;
  };

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 100_000) throw new Error('request too large');
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  };

  const serveFile = (res: ServerResponse, relative: string) => {
    const absolute = path.resolve(paths.root, decodeURIComponent(relative));
    if (
      !SERVED_ROOTS.some((root) => isPathInside(root, absolute)) ||
      !existsSync(absolute) ||
      !statSync(absolute).isFile()
    ) {
      return json(res, 404, { error: 'not found' });
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream',
    });
    res.end(readFileSync(absolute));
  };

  let port = options.port;
  const server = createServer((req, res) => {
    void (async () => {
      // Only accept requests addressed to this local server (blocks DNS rebinding) …
      const host = req.headers.host ?? '';
      if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(host))
        return json(res, 403, { error: 'forbidden host' });
      // … and state-changing requests from this page only (blocks CSRF from other sites).
      const origin = req.headers.origin;
      if (req.method !== 'GET' && origin && origin !== `http://${host}`)
        return json(res, 403, { error: 'forbidden origin' });

      const url = new URL(req.url ?? '/', `http://${host}`);
      const runMatch = /^\/api\/runs\/([\w-]+)(\/events|\/cancel)?$/.exec(url.pathname);

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
        });
        return res.end(readFileSync(uiFile, 'utf8'));
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return json(res, 200, {
          llm: llmStatus(),
          activeRun: active?.id ?? null,
          allowedHosts: options.allowedHosts ?? [],
        });
      }
      if (url.pathname === '/api/settings' || url.pathname === '/api/settings/models') {
        if (req.method === 'GET' && url.pathname === '/api/settings')
          return json(res, 200, settings.status());
        // Writes must be JSON (forces a CORS preflight for any cross-site attempt).
        if (!isJson(req)) return json(res, 415, { error: 'Content-Type must be application/json' });
        try {
          if (req.method === 'DELETE' && url.pathname === '/api/settings')
            return json(res, 200, settings.clear());
          const body = await readBody(req).catch((error: unknown) => {
            throw new SettingsError([(error as Error).message]);
          });
          if (req.method === 'POST' && url.pathname === '/api/settings/models') {
            const input = modelsInputSchema.safeParse(body);
            if (!input.success) throw new SettingsError(formatZodIssues(input.error));
            const models = await settings.listModels(input.data.provider, input.data.apiKey);
            return json(res, 200, { provider: input.data.provider, models });
          }
          if (req.method === 'PUT' && url.pathname === '/api/settings') {
            const input = settingsInputSchema.safeParse(body);
            if (!input.success) throw new SettingsError(formatZodIssues(input.error));
            return json(res, 200, await settings.save(input.data));
          }
          return json(res, 405, { error: 'method not allowed' });
        } catch (error) {
          if (!(error instanceof SettingsError)) throw error;
          return json(res, error.status, { error: error.message, errors: error.errors });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') {
        return json(
          res,
          200,
          [...runs.values()].reverse().map((r) => ({
            id: r.id,
            status: r.status,
            startedAt: r.startedAt,
            targetUrl: r.request.targetUrl,
            mode: r.request.mode,
          })),
        );
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const llm = llmStatus();
        if (!llm.ready && !options.createChat) return json(res, 400, { error: llm.message });
        if (active) return json(res, 409, { error: `A run is already in progress (${active.id})` });
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
        const parsed = runRequestSchema.safeParse(body);
        if (!parsed.success) {
          const errors = formatZodIssues(parsed.error);
          return json(res, 400, { error: errors.join('; '), errors });
        }

        // Authoritative validation & sanitisation (the UI only mirrors these checks).
        const url = await validateTargetUrl(
          parsed.data.targetUrl,
          {
            allowPrivateNetwork: options.allowPrivateNetwork ?? false,
            allowedHosts: options.allowedHosts ?? [],
          },
          ...(options.lookup ? [options.lookup] : []),
        );
        const prompt = url.ok ? sanitizePrompt(parsed.data.prompt, url.value) : undefined;
        const errors = [
          ...(url.ok ? [] : url.errors.map((e) => `Website URL: ${e}`)),
          ...(prompt && !prompt.ok ? prompt.errors.map((e) => `Prompt: ${e}`) : []),
        ];
        if (errors.length > 0 || !url.ok || !prompt?.ok) {
          // Audit without echoing the raw input (it may be hostile).
          options.logger?.warn(
            {
              rejected: errors,
              promptSha256: createHash('sha256')
                .update(String(parsed.data.prompt))
                .digest('hex')
                .slice(0, 16),
            },
            'console input rejected',
          );
          return json(res, 400, { error: errors.join(' · '), errors });
        }
        const run = startRun({ ...parsed.data, targetUrl: url.value, prompt: prompt.value.prompt });
        return json(res, 202, { id: run.id });
      }
      if (runMatch) {
        const run = runs.get(runMatch[1]!);
        if (!run) return json(res, 404, { error: 'unknown run' });
        if (req.method === 'GET' && !runMatch[2]) {
          return json(res, 200, {
            id: run.id,
            status: run.status,
            request: run.request,
            startedAt: run.startedAt,
            events: run.events,
          });
        }
        if (req.method === 'POST' && runMatch[2] === '/cancel') {
          run.abort.abort();
          return json(res, 202, { cancelled: true });
        }
        if (req.method === 'GET' && runMatch[2] === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
          for (const event of run.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
          if (run.status !== 'running') return res.end();
          run.listeners.add(res);
          req.on('close', () => run.listeners.delete(res));
          return undefined;
        }
      }
      if (req.method === 'GET' && url.pathname.startsWith('/files/'))
        return serveFile(res, url.pathname.slice('/files/'.length));
      return json(res, 404, { error: 'not found' });
    })().catch((error: unknown) => {
      options.logger?.error({ err: error }, 'console request failed');
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://localhost:${port}`,
    server,
    close: async () => {
      for (const run of runs.values()) run.abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
