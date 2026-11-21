/**
 * Custom MCP server over Streamable HTTP – for shared/team access ONLY.
 *
 *   MCP_HTTP_TOKEN=<32+ random chars> npm run mcp:http
 *
 * Security controls:
 *  - mandatory bearer token (constant-time comparison), fail-fast if missing/weak
 *  - binds to 127.0.0.1 by default (MCP_HTTP_HOST to change; put TLS + SSO in front for remote use)
 *  - Origin allowlist (DNS-rebinding protection), request size limit, single /mcp endpoint
 * Each HTTP request is served by a fresh server instance (stateless) sharing one context.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { createMcpHandler } from '@modelcontextprotocol/server';

import { bootstrap } from './bootstrap.js';
import { createFrameworkServer } from './create-server.js';

const MAX_BODY = 1_000_000;
const { ctx, logger } = bootstrap('http');
const token = ctx.config.mcp.httpToken;
if (!token || token.length < 32) {
  logger.fatal('MCP_HTTP_TOKEN must be set to a random value of at least 32 characters');
  process.exit(1);
}
const expected = Buffer.from(`Bearer ${token}`);
const host = process.env.MCP_HTTP_HOST ?? '127.0.0.1';
const port = ctx.config.mcp.httpPort;
const allowedOrigins = new Set(
  (process.env.MCP_HTTP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
);

const handler = createMcpHandler(() => createFrameworkServer(ctx), {
  onerror: (error) => logger.error({ err: error }, 'MCP HTTP handler error'),
});

function authorized(req: IncomingMessage): boolean {
  const header = Buffer.from(req.headers.authorization ?? '');
  return header.length === expected.length && timingSafeEqual(header, expected);
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('payload too large');
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  return new Request(`http://${host}:${port}${req.url ?? '/'}`, {
    method: req.method ?? 'GET',
    headers,
    ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
  });
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as unknown as NodeReadableStream)
      .on('error', reject)
      .pipe(res)
      .on('finish', resolve);
  });
}

const server = createServer((req, res) => {
  void (async () => {
    const reject = (status: number, message: string) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
      });
      res.end(JSON.stringify({ error: message }));
    };
    try {
      if (!req.url?.startsWith('/mcp')) return reject(404, 'not found');
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) return reject(403, 'origin not allowed');
      if (!authorized(req)) {
        ctx.audit.record({
          tool: '(http-auth)',
          outcome: 'denied',
          durationMs: 0,
          args: { path: req.url },
          transport: 'http',
        });
        return reject(401, 'unauthorized');
      }
      await writeResponse(await handler.fetch(await toRequest(req)), res);
    } catch (error) {
      logger.error({ err: error }, 'MCP HTTP request failed');
      if (!res.headersSent) reject(500, 'internal error');
      else res.end();
    }
  })();
});

server.listen(port, host, () =>
  logger.warn({ host, port }, 'MCP Streamable HTTP server listening (token required)'),
);

const shutdown = () => {
  server.close();
  void handler.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
