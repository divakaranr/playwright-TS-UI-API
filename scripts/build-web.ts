/**
 * Builds the hosted Test Console in Vercel's Build Output API format (.vercel/output):
 *   static/                 web/public (UI)
 *   functions/api.func/     one Node.js function for /api/* (esbuild bundle + runtime packages)
 *   config.json             routes and security headers
 *
 *   npm run web:build       (Vercel runs the same command on every Git deploy – see vercel.json)
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.vercel', 'output');
const funcDir = path.join(out, 'functions', 'api.func');
/** Loaded at runtime from node_modules (native binaries / dynamic requires) instead of being bundled. */
const RUNTIME_PACKAGES = ['playwright-core', '@sparticuz/chromium'];

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** Copies a package and its production dependency closure from the root node_modules. */
function copyPackage(name: string, seen = new Set<string>()): void {
  if (seen.has(name)) return;
  seen.add(name);
  const source = path.join(root, 'node_modules', name);
  if (!existsSync(source)) return; // optional dependency not installed on this platform
  cpSync(source, path.join(funcDir, 'node_modules', name), { recursive: true, dereference: true });
  const pkg = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) copyPackage(dep, seen);
}

function dirSize(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const full = path.join(dir, entry.name);
    return total + (entry.isDirectory() ? dirSize(full) : statSync(full).size);
  }, 0);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(funcDir, { recursive: true });

// 1. Static UI
cpSync(path.join(root, 'web', 'public'), path.join(out, 'static'), { recursive: true });

// 2. API function
await build({
  entryPoints: [path.join(root, 'src', 'web', 'handler.ts')],
  outfile: path.join(funcDir, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: RUNTIME_PACKAGES,
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'warning',
});
for (const pkg of RUNTIME_PACKAGES) copyPackage(pkg);
writeFileSync(path.join(funcDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
writeFileSync(
  path.join(funcDir, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration: 300,
      memory: 2048,
    },
    null,
    2,
  ),
);

// 3. Routing + headers
writeFileSync(
  path.join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '/(.*)', headers: SECURITY_HEADERS, continue: true },
        { src: '/api/(.*)', headers: { 'Cache-Control': 'no-store' }, continue: true },
        { handle: 'filesystem' },
        { src: '/api/(.*)', dest: '/api' },
        { src: '/(.*)', status: 404, dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
process.stdout.write(`Built .vercel/output · function size ${mb(dirSize(funcDir))} (limit 250 MB)\n`);
