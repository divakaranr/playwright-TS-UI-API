/**
 * Local development server for the hosted Test Console (same handler as on Vercel).
 *
 *   npm run web:dev    → http://localhost:3100
 *
 * Needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and AUTH_SECRET in .env, and
 * http://localhost:3100/api/auth/callback as an authorised redirect URI of the Google OAuth client.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { loadDotenvFiles } from '../src/config/framework.config.js';
import { createWebHandler } from '../src/web/handler.js';

loadDotenvFiles();
const port = Number(process.env.WEB_PORT ?? 3100);
const publicDir = path.resolve(import.meta.dirname, '..', 'web', 'public');
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const handler = createWebHandler({
  env: { ...process.env, APP_URL: process.env.APP_URL ?? `http://localhost:${port}` },
});

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (url.pathname.startsWith('/api/')) return void handler(req, res);
  const file = path.join(publicDir, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(publicDir) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(readFileSync(file));
}).listen(port, () => process.stdout.write(`\n  Hosted Test Console (dev): http://localhost:${port}\n\n`));
