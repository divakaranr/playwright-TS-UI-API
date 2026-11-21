import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export type MockHandler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

/**
 * Minimal deterministic HTTP server for framework integration tests (API client,
 * LLM provider adapters). Records every request for assertions.
 */
export class MockServer {
  readonly requests: RecordedRequest[] = [];
  private server: Server | undefined;
  private handler: MockHandler = (_req, res) => {
    res.statusCode = 404;
    res.end();
  };

  on(handler: MockHandler): this {
    this.handler = handler;
    return this;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const recorded = {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        };
        this.requests.push(recorded);
        Promise.resolve(this.handler(recorded, res)).catch((error: unknown) => {
          res.statusCode = 500;
          res.end(String(error));
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
