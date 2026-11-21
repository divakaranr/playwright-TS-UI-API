import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as z from 'zod';

import { FrameworkError } from '../../core/exceptions/index.js';
import type { Logger } from '../../utils/logger.js';
import { paths } from '../../utils/paths.js';
import { withTimeout } from '../../utils/wait.util.js';
import type { McpServerConfig } from './mcp-config.js';

export class McpClientError extends FrameworkError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
  }
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'closed';

/**
 * Typed wrapper around the official MCP client SDK.
 *
 * - STDIO and Streamable HTTP transports
 * - connection timeout, per-request timeout, disconnect detection
 * - dynamic tool discovery; tool names AND arguments are validated against the
 *   server-advertised JSON Schema before invocation (no assumptions about tools)
 * - resources and prompts, graceful shutdown
 */
export class McpClient {
  private client: Client | undefined;
  private transport: Transport | undefined;
  private tools: Map<string, { tool: Tool; validator: z.ZodType | undefined }> | undefined;
  private stateValue: ConnectionState = 'disconnected';
  private readonly disconnectListeners = new Set<(reason: string) => void>();

  constructor(
    readonly config: McpServerConfig,
    private readonly logger?: Logger,
  ) {}

  get state(): ConnectionState {
    return this.stateValue;
  }

  get isConnected(): boolean {
    return this.stateValue === 'connected';
  }

  get serverInfo() {
    return this.client?.getServerVersion();
  }

  /** PID of a STDIO server process (diagnostics / tests). */
  get processId(): number | undefined {
    return this.transport instanceof StdioClientTransport ? (this.transport.pid ?? undefined) : undefined;
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;
    this.stateValue = 'connecting';
    const client = new Client({ name: 'playwright-enterprise-framework-client', version: '1.0.0' });
    const transport = this.createTransport();
    this.transport = transport;
    transport.onclose = () => this.handleDisconnect('transport closed');
    try {
      await withTimeout(
        client.connect(transport, { timeout: this.config.connectTimeoutMs }),
        this.config.connectTimeoutMs,
        `connect to MCP server "${this.config.name}"`,
      );
    } catch (error) {
      this.stateValue = 'disconnected';
      await client.close().catch(() => undefined);
      throw new McpClientError(
        'MCP_CONNECT_FAILED',
        `Failed to connect to MCP server "${this.config.name}": ${(error as Error).message}`,
        { cause: error },
      );
    }
    // The SDK replaces transport callbacks during connect; observe closure through the client.
    client.onclose = () => this.handleDisconnect('connection closed');
    this.client = client;
    this.tools = undefined;
    this.stateValue = 'connected';
    this.logger?.info({ server: this.config.name, info: client.getServerVersion() }, 'MCP client connected');
  }

  async listTools(options: { refresh?: boolean } = {}): Promise<Tool[]> {
    const client = this.requireClient();
    if (!this.tools || options.refresh) {
      const all: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: this.config.connectTimeoutMs,
        });
        all.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      this.tools = new Map(all.map((tool) => [tool.name, { tool, validator: toValidator(tool) }]));
    }
    return [...this.tools.values()].map((t) => t.tool);
  }

  async hasTool(name: string): Promise<boolean> {
    await this.listTools();
    return this.tools!.has(name);
  }

  /**
   * Validates the tool name and arguments, then invokes the tool.
   * `skipValidation` exists only to verify server-side validation in tests.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number; skipValidation?: boolean } = {},
  ): Promise<CallToolResult> {
    const client = this.requireClient();
    await this.listTools();
    const entry = this.tools!.get(name);
    if (!entry && !options.skipValidation) {
      throw new McpClientError(
        'MCP_UNKNOWN_TOOL',
        `Server "${this.config.name}" does not expose tool "${name}". Available: ${[...this.tools!.keys()].join(', ')}`,
      );
    }
    if (entry?.validator && !options.skipValidation) {
      const parsed = entry.validator.safeParse(args);
      if (!parsed.success) {
        throw new McpClientError(
          'MCP_INVALID_ARGUMENTS',
          `Invalid arguments for "${name}": ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
        );
      }
    }
    const timeout = options.timeoutMs ?? this.config.requestTimeoutMs;
    return client.callTool({ name, arguments: args }, { timeout, resetTimeoutOnProgress: true });
  }

  /** Calls a tool and parses its first text content as JSON. Throws on tool errors. */
  async callToolJson<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const result = await this.callTool(name, args, options);
    const text =
      result.content.find((c): c is { type: 'text'; text: string } => c.type === 'text')?.text ?? '';
    if (result.isError) throw new McpClientError('MCP_TOOL_ERROR', `Tool "${name}" failed: ${text}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  async listResources() {
    return (await this.requireClient().listResources()).resources;
  }

  async readResource(uri: string): Promise<string> {
    const result = await this.requireClient().readResource({ uri });
    return result.contents.map((c) => ('text' in c ? c.text : `[binary ${c.mimeType ?? ''}]`)).join('\n');
  }

  async listPrompts() {
    return (await this.requireClient().listPrompts()).prompts;
  }

  async getPrompt(name: string, args: Record<string, string> = {}) {
    return this.requireClient().getPrompt({ name, arguments: args });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.tools = undefined;
    this.stateValue = 'closed';
    if (client)
      await client
        .close()
        .catch((error: unknown) => this.logger?.warn({ err: error }, 'error while closing MCP client'));
  }

  private requireClient(): Client {
    if (!this.client || !this.isConnected) {
      throw new McpClientError(
        'MCP_NOT_CONNECTED',
        `MCP server "${this.config.name}" is not connected (state: ${this.stateValue})`,
      );
    }
    return this.client;
  }

  private handleDisconnect(reason: string): void {
    if (this.stateValue === 'closed' || this.stateValue === 'disconnected') return;
    this.stateValue = 'disconnected';
    this.client = undefined;
    this.tools = undefined;
    this.logger?.warn({ server: this.config.name, reason }, 'MCP server disconnected');
    for (const listener of this.disconnectListeners) listener(reason);
  }

  private createTransport(): Transport {
    if (this.config.transport === 'stdio') {
      return new StdioClientTransport({
        command: this.config.command!,
        args: this.config.args,
        cwd: this.config.cwd ?? paths.root,
        // Only a minimal safe environment is inherited, plus explicitly configured variables.
        env: { ...getDefaultEnvironment(), ...this.config.env },
        stderr: 'pipe',
      });
    }
    return new StreamableHTTPClientTransport(new URL(this.config.url!), {
      requestInit: { headers: this.config.headers },
    });
  }
}

function toValidator(tool: Tool): z.ZodType | undefined {
  try {
    return z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return undefined; // unsupported schema features: rely on server-side validation
  }
}
