/**
 * Test Console entry point.   npm run console   ->   http://localhost:4100
 *
 * Provider, model and API key are chosen in the UI ("Model settings") and saved
 * encrypted (AES-256-GCM) in .secrets/llm-settings.enc.json; the master key lives
 * outside the project in ~/.playwright-test-console/master.key. LLM_* in .env is
 * only a fallback until settings are saved. Optional:
 *   CONSOLE_PORT=4100
 *   CONSOLE_ALLOWED_HOSTS=demo-qa-app.azurewebsites.net,staging.example.com
 *   CONSOLE_RUN_TIMEOUT_MS=1200000
 *   CONSOLE_ALLOW_PRIVATE_NETWORK=true   (allow localhost/intranet targets; off by default)
 *   CONSOLE_SECRETS_FILE=<path>          (encrypted settings file)
 *   CONSOLE_MASTER_KEY_FILE=<path>       (master key file, created on first save)
 *   CONSOLE_MASTER_KEY=<passphrase>      (instead of a key file, e.g. containers; min. 16 chars)
 */
import { homedir } from 'node:os';
import path from 'node:path';

import { getConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { paths } from '../utils/paths.js';
import { EncryptedFileStore } from './secret-store.js';
import { startConsoleServer } from './server.js';

const config = getConfig();
const logger = createLogger({
  level: config.logging.level,
  consoleLevel: 'info',
  base: { component: 'test-console' },
});
const allowedHosts = (process.env.CONSOLE_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

const passphrase = process.env.CONSOLE_MASTER_KEY?.trim();
const secretStore = new EncryptedFileStore({
  file: process.env.CONSOLE_SECRETS_FILE ?? path.join(paths.root, '.secrets', 'llm-settings.enc.json'),
  ...(passphrase
    ? { passphrase }
    : {
        keyFile:
          process.env.CONSOLE_MASTER_KEY_FILE ??
          path.join(homedir(), '.playwright-test-console', 'master.key'),
      }),
});

const { url, close } = await startConsoleServer({
  port: Number(process.env.CONSOLE_PORT ?? 4100),
  llm: config.llm,
  secretStore,
  logger,
  allowedHosts,
  allowPrivateNetwork: process.env.CONSOLE_ALLOW_PRIVATE_NETWORK === 'true',
  ...(process.env.CONSOLE_RUN_TIMEOUT_MS ? { runTimeoutMs: Number(process.env.CONSOLE_RUN_TIMEOUT_MS) } : {}),
});

logger.info(
  { url, secrets: secretStore.file, masterKey: secretStore.keySource },
  `Test Console running at ${url}`,
);
process.stdout.write(`\n  Test Console: ${url}\n\n`);

const shutdown = () => void close().finally(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
