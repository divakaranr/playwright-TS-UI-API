import path from 'node:path';

import { createLogger, type Logger } from '../../../utils/logger.js';
import { paths } from '../../../utils/paths.js';
import { redactSensitive, truncate } from '../../../utils/sanitizer.js';

export type AuditOutcome = 'success' | 'error' | 'denied' | 'timeout';

export interface AuditEvent {
  tool: string;
  outcome: AuditOutcome;
  durationMs: number;
  args: unknown;
  errorCode?: string;
  errorMessage?: string;
  transport?: string;
}

/**
 * Append-only JSONL audit trail of every MCP tool invocation (logs/mcp-audit.log).
 * Arguments are redacted; results are not stored (they may contain app data).
 */
export class AuditLogger {
  private readonly logger: Logger;

  constructor(file: string = process.env.MCP_AUDIT_LOG ?? path.join(paths.logs, 'mcp-audit.log')) {
    this.logger = createLogger({
      level: 'info',
      consoleLevel: 'silent',
      file,
      base: { stream: 'mcp-audit' },
    });
  }

  record(event: AuditEvent): void {
    this.logger.info(
      {
        ...event,
        args: redactSensitive(event.args, { maxStringLength: 2000 }),
        ...(event.errorMessage ? { errorMessage: truncate(event.errorMessage, 1000) } : {}),
      },
      `mcp tool ${event.tool} -> ${event.outcome}`,
    );
  }
}
