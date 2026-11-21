import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 1_000_000;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.trim() === '') return undefined;
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'MALFORMED_JSON', 'Request body is not valid JSON');
  }
}

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req));
}

const CORRELATION = /^[A-Za-z0-9-]{8,64}$/;

/** Applies standard security/diagnostic headers and returns the correlation id. */
export function applyStandardHeaders(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-correlation-id'];
  const correlationId = typeof incoming === 'string' && CORRELATION.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Correlation-Id', correlationId);
  res.setHeader('X-Request-Id', randomUUID());
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return correlationId;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

export function sendError(res: ServerResponse, error: HttpError, headers: Record<string, string> = {}) {
  sendJson(
    res,
    error.status,
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    },
    headers,
  );
}

export function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string> = {},
) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(html);
}

export function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}) {
  res.statusCode = 303;
  res.setHeader('Location', location);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end();
}

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
