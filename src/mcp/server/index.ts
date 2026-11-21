/**
 * Custom automation-framework MCP server (STDIO transport).
 *
 *   npm run build && node dist/mcp/server/index.js      (MCP hosts)
 *   npm run mcp:server:dev                              (tsx, no build)
 *
 * Configuration comes from .env / environment variables (TEST_ENV, MCP_*).
 * Never write to stdout from this process – it carries the protocol.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { bootstrap } from './bootstrap.js';
import { createFrameworkServer } from './create-server.js';

const { ctx, logger } = bootstrap('stdio');

const handle = serveStdio(() => createFrameworkServer(ctx), {
  onerror: (error) => logger.error({ err: error }, 'MCP stdio transport error'),
});

logger.info(
  { environment: ctx.config.environment.name, allowed: ctx.config.mcp.allowedEnvironments },
  'MCP stdio server started',
);

const shutdown = (signal: string) => {
  logger.info({ signal }, 'MCP server shutting down');
  handle
    .close()
    .catch((error: unknown) => logger.error({ err: error }, 'error during shutdown'))
    .finally(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
