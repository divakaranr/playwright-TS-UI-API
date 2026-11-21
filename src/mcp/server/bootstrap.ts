import { getConfig } from '../../config/index.js';
import { createLogger, setLogger, type Logger } from '../../utils/logger.js';
import { createServerContext, type McpServerContext } from './context.js';

/**
 * Shared bootstrap for MCP entry points. Logging is forced to stderr/file:
 * on the stdio transport, stdout is reserved for JSON-RPC protocol messages.
 */
export function bootstrap(transport: 'stdio' | 'http'): { ctx: McpServerContext; logger: Logger } {
  process.env.LOG_DESTINATION = 'stderr';
  const config = getConfig();
  const logger = createLogger({
    level: config.logging.level,
    consoleLevel:
      process.env.MCP_LOG_CONSOLE_LEVEL === undefined
        ? 'warn'
        : (process.env.MCP_LOG_CONSOLE_LEVEL as 'warn'),
    destination: 'stderr',
    pretty: false,
    base: { component: `mcp-${transport}`, env: config.environment.name },
  });
  setLogger(logger);
  return { ctx: createServerContext(config, logger, transport), logger };
}
