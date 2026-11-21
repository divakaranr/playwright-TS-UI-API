import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/server';

import { paths } from '../../../utils/paths.js';
import type { McpServerContext } from '../context.js';
import { describeEnvironments } from '../tools/framework-tools.js';

const doc = (file: string) => () => readFile(path.join(paths.docs, file), 'utf8');

/** Static, read-only context an LLM can pull in on demand. */
export function registerResources(server: McpServer, ctx: McpServerContext): void {
  const resources: Array<{
    name: string;
    uri: string;
    title: string;
    description: string;
    mimeType: string;
    read: () => Promise<string>;
  }> = [
    {
      name: 'framework-architecture',
      uri: 'framework://docs/architecture',
      title: 'Framework architecture',
      description: 'Layers, components, design decisions and extension points of the automation framework.',
      mimeType: 'text/markdown',
      read: doc('architecture.md'),
    },
    {
      name: 'environments',
      uri: 'framework://environments',
      title: 'Available environments',
      description: 'Configured environments, URLs, read-only status and MCP permissions (no secrets).',
      mimeType: 'application/json',
      read: () => Promise.resolve(JSON.stringify(describeEnvironments(ctx), null, 2)),
    },
    {
      name: 'test-suite-catalogue',
      uri: 'framework://test-suites',
      title: 'Test suite catalogue',
      description: 'Tests per project, tag and file (discovered with playwright --list).',
      mimeType: 'application/json',
      read: async () => JSON.stringify(await ctx.catalog.getCatalog(), null, 2),
    },
    {
      name: 'application-test-documentation',
      uri: 'framework://docs/application',
      title: 'Application test documentation',
      description: 'Page objects, components, conventions and the demo application under test.',
      mimeType: 'text/markdown',
      read: doc('ui-automation.md'),
    },
    {
      name: 'api-endpoint-catalogue',
      uri: 'framework://api/openapi',
      title: 'API endpoint catalogue',
      description: 'The approved OpenAPI specification of the application API.',
      mimeType: 'application/json',
      read: () => Promise.resolve(JSON.stringify(ctx.openApiSpec(), null, 2)),
    },
    {
      name: 'test-execution-guidelines',
      uri: 'framework://docs/execution-guidelines',
      title: 'Test execution guidelines',
      description: 'Execution strategy per pipeline stage, tagging, retries policy and environment rules.',
      mimeType: 'text/markdown',
      read: doc('test-execution-guidelines.md'),
    },
  ];

  for (const resource of resources) {
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: resource.mimeType },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: resource.mimeType, text: await resource.read() }],
      }),
    );
  }
}
