import type { CallToolResult } from '@modelcontextprotocol/client';

import type { Logger } from '../../utils/logger.js';
import { McpClient, McpClientError } from './mcp-client.js';
import type { McpServerConfig } from './mcp-config.js';

export interface ConnectionReport {
  server: string;
  status: 'connected' | 'failed' | 'disabled';
  error?: string;
  tools?: number;
}

/**
 * Manages several MCP servers (e.g. the official Playwright MCP + the framework
 * server). Servers connect independently – one failing server does not block
 * the others – and disconnected servers are reconnected lazily on next use.
 */
export class ConnectionManager {
  private readonly clients = new Map<string, McpClient>();

  constructor(
    configs: McpServerConfig[],
    private readonly options: { logger?: Logger; autoReconnect?: boolean } = {},
  ) {
    for (const config of configs) {
      if (this.clients.has(config.name))
        throw new McpClientError('MCP_DUPLICATE_SERVER', `Duplicate MCP server name: ${config.name}`);
      this.clients.set(config.name, new McpClient(config, options.logger));
    }
  }

  async connectAll(): Promise<ConnectionReport[]> {
    return Promise.all(
      [...this.clients.values()].map(async (client): Promise<ConnectionReport> => {
        if (!client.config.enabled) return { server: client.config.name, status: 'disabled' };
        try {
          await client.connect();
          return {
            server: client.config.name,
            status: 'connected',
            tools: (await client.listTools()).length,
          };
        } catch (error) {
          return { server: client.config.name, status: 'failed', error: (error as Error).message };
        }
      }),
    );
  }

  /** Returns a connected client, reconnecting if it dropped (when autoReconnect is on). */
  async get(name: string): Promise<McpClient> {
    const client = this.clients.get(name);
    if (!client)
      throw new McpClientError(
        'MCP_UNKNOWN_SERVER',
        `Unknown MCP server "${name}". Configured: ${[...this.clients.keys()].join(', ')}`,
      );
    if (!client.config.enabled)
      throw new McpClientError('MCP_SERVER_DISABLED', `MCP server "${name}" is disabled`);
    if (!client.isConnected) {
      if (client.state !== 'disconnected' && client.state !== 'closed')
        throw new McpClientError('MCP_NOT_CONNECTED', `MCP server "${name}" is ${client.state}`);
      if (this.options.autoReconnect === false && client.state === 'disconnected') {
        throw new McpClientError('MCP_NOT_CONNECTED', `MCP server "${name}" is disconnected`);
      }
      await client.connect();
    }
    return client;
  }

  /** Finds which connected servers expose a tool (servers expose different tool sets). */
  async findTool(toolName: string): Promise<string[]> {
    const owners: string[] = [];
    for (const client of this.clients.values()) {
      if (client.isConnected && (await client.hasTool(toolName))) owners.push(client.config.name);
    }
    return owners;
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown> = {},
    options?: { timeoutMs?: number },
  ): Promise<CallToolResult> {
    return (await this.get(server)).callTool(tool, args, options);
  }

  status(): Array<{ server: string; state: string; transport: string }> {
    return [...this.clients.values()].map((c) => ({
      server: c.config.name,
      state: c.state,
      transport: c.config.transport,
    }));
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
  }
}
