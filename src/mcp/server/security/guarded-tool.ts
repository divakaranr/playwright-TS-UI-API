import type { McpServer, CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod';

import {
  EnvironmentPolicyError,
  FrameworkError,
  OperationTimeoutError,
} from '../../../core/exceptions/index.js';
import { redactSensitive } from '../../../utils/sanitizer.js';
import type { McpServerContext } from '../context.js';

export interface GuardedToolDefinition<S extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations?: ToolAnnotations;
  /** Overrides MCP_TOOL_TIMEOUT_MS for quick tools. */
  timeoutMs?: number;
  handler: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown>;
}

const MAX_RESULT_CHARS = 60_000;

function toText(value: unknown): string {
  const text = JSON.stringify(redactSensitive(value), null, 2);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated]` : text;
}

/**
 * Registers a tool with uniform governance:
 *  1. allowlist – disabled tools are never registered
 *  2. strict Zod input validation (performed by the SDK before the handler runs)
 *  3. execution timeout with cancellation (AbortSignal)
 *  4. output redaction + size limit
 *  5. error normalisation (framework errors -> isError results; internals hidden)
 *  6. audit logging of every invocation
 */
export function registerGuardedTool<S extends z.ZodObject>(
  server: McpServer,
  ctx: McpServerContext,
  definition: GuardedToolDefinition<S>,
): boolean {
  if (!ctx.policy.isToolEnabled(definition.name)) return false;
  const timeoutMs = Math.min(
    definition.timeoutMs ?? ctx.config.mcp.toolTimeoutMs,
    ctx.config.mcp.toolTimeoutMs,
  );

  const callback = async (args: z.infer<S>): Promise<CallToolResult> => {
    const started = Date.now();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        definition.handler(args, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new OperationTimeoutError(`tool ${definition.name}`, timeoutMs));
          }, timeoutMs);
        }),
      ]);
      ctx.audit.record({
        tool: definition.name,
        outcome: 'success',
        durationMs: Date.now() - started,
        args,
        transport: ctx.transport,
      });
      return { content: [{ type: 'text', text: toText(result) }] };
    } catch (error) {
      const outcome =
        error instanceof OperationTimeoutError
          ? 'timeout'
          : error instanceof EnvironmentPolicyError
            ? 'denied'
            : 'error';
      const known = error instanceof FrameworkError;
      const message = known
        ? error.message
        : 'Internal error while executing the tool (details in server logs).';
      ctx.audit.record({
        tool: definition.name,
        outcome,
        durationMs: Date.now() - started,
        args,
        errorCode: known ? error.code : 'INTERNAL_ERROR',
        errorMessage: error instanceof Error ? error.message : String(error),
        transport: ctx.transport,
      });
      if (!known) ctx.logger.error({ tool: definition.name, err: error }, 'MCP tool failed');
      return {
        isError: true,
        content: [
          { type: 'text', text: toText({ error: { code: known ? error.code : 'INTERNAL_ERROR', message } }) },
        ],
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      ...(definition.annotations ? { annotations: definition.annotations } : {}),
    },
    callback as never,
  );
  return true;
}
