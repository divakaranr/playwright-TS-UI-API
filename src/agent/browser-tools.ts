import { isScriptPayload } from '../console/input-guard.js';
import type { McpClient } from '../mcp/client/mcp-client.js';
import type { AgentTool, ToolOutcome } from './types.js';

/**
 * Official Playwright MCP tools the agent may use. Deliberately excluded:
 * browser_run_code_unsafe / browser_evaluate (arbitrary code), browser_file_upload
 * (local file access), resize/emulation/drag helpers (not needed for testing).
 */
export const ALLOWED_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_wait_for',
  'browser_handle_dialog',
  'browser_take_screenshot',
  'browser_console_messages',
  'browser_network_requests',
  'browser_tabs',
] as const;

/** Tools after which the console captures a screenshot for the live view. */
export const STATE_CHANGING_TOOLS = new Set<string>([
  'browser_navigate',
  'browser_navigate_back',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_handle_dialog',
]);

/** Restricts navigation to the origins of the target application. */
export class OriginGuard {
  private readonly origins: Set<string>;

  constructor(
    private readonly targetUrl: string,
    extraOrigins: string[] = [],
  ) {
    this.origins = new Set([new URL(targetUrl).origin, ...extraOrigins.map((o) => new URL(o).origin)]);
  }

  /** Returns an error message when the URL leaves the allowed origins. */
  check(url: string): string | undefined {
    let parsed: URL;
    try {
      parsed = new URL(url, this.targetUrl);
    } catch {
      return `"${url}" is not a valid URL`;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return `protocol ${parsed.protocol} is not allowed`;
    return this.origins.has(parsed.origin)
      ? undefined
      : `navigation to ${parsed.origin} is blocked; allowed: ${[...this.origins].join(', ')}`;
  }
}

/**
 * Validates every string inside the tool arguments (including nested form fields):
 * URL-like values must stay on the target origin and typed text must not contain
 * script/markup payloads – the agent tests the site, it never attacks it.
 */
export function checkArguments(args: unknown, guard: OriginGuard): string | undefined {
  const strings: Array<[string, string]> = [];
  const walk = (value: unknown, key: string) => {
    if (typeof value === 'string') strings.push([key, value]);
    else if (Array.isArray(value)) value.forEach((v) => walk(v, key));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(args, '');
  for (const [key, value] of strings) {
    if (key === 'url' || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      const blocked = guard.check(value);
      if (blocked) return blocked;
    }
    if (isScriptPayload(value))
      return `argument "${key}" contains script/markup content, which is not allowed`;
  }
  return undefined;
}

/** Wraps the allow-listed Playwright MCP tools as agent tools with argument guards applied. */
export async function createBrowserTools(client: McpClient, guard: OriginGuard): Promise<AgentTool[]> {
  const available = await client.listTools();
  return available
    .filter((tool) => (ALLOWED_BROWSER_TOOLS as readonly string[]).includes(tool.name))
    .map((tool) => {
      const { $schema: _schema, ...parameters } = tool.inputSchema as Record<string, unknown>;
      return {
        spec: { name: tool.name, description: tool.description ?? tool.name, parameters },
        execute: async (args): Promise<ToolOutcome> => {
          const violation = checkArguments(args, guard);
          if (violation) return { text: `ERROR: ${violation}`, isError: true };
          try {
            const result = await client.callTool(tool.name, args, { timeoutMs: 120_000 });
            const text = result.content
              .map((block) => (block.type === 'text' ? block.text : `[${block.type} content]`))
              .join('\n');
            const images = result.content.flatMap((block) =>
              block.type === 'image' ? [{ mimeType: block.mimeType, data: block.data }] : [],
            );
            return { text: text || '(no output)', isError: result.isError === true, images };
          } catch (error) {
            return { text: `ERROR: ${(error as Error).message}`, isError: true };
          }
        },
      } satisfies AgentTool;
    });
}
