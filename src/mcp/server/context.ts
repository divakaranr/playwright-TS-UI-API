import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createLlmProvider, isLlmConfigured, type LLMProvider } from '../../ai/providers/index.js';
import type { FrameworkConfig } from '../../config/index.js';
import { ResultsService } from '../../core/services/results.service.js';
import { TestCatalogService } from '../../core/services/test-catalog.service.js';
import { TestExecutionService } from '../../core/services/test-execution.service.js';
import type { Logger } from '../../utils/logger.js';
import { isPathInside, paths } from '../../utils/paths.js';
import { AuditLogger } from './security/audit-logger.js';
import { ToolPolicy } from './security/tool-policy.js';

/** Shared dependencies for all MCP tools, resources and prompts (created once per process). */
export interface McpServerContext {
  config: FrameworkConfig;
  logger: Logger;
  policy: ToolPolicy;
  audit: AuditLogger;
  execution: TestExecutionService;
  results: ResultsService;
  catalog: TestCatalogService;
  /** The configured LLM provider, or undefined when AI is not configured. */
  llm: () => LLMProvider | undefined;
  /** Reads the approved OpenAPI specification (OPENAPI_SPEC_PATH, default: demo app spec). */
  openApiSpec: () => unknown;
  transport: 'stdio' | 'http';
}

export function createServerContext(
  config: FrameworkConfig,
  logger: Logger,
  transport: 'stdio' | 'http',
): McpServerContext {
  let provider: LLMProvider | undefined;
  return {
    config,
    logger,
    transport,
    policy: new ToolPolicy(config),
    audit: new AuditLogger(),
    execution: new TestExecutionService({ config, logger }),
    results: new ResultsService(),
    catalog: new TestCatalogService(),
    llm: () => {
      if (!isLlmConfigured(config.llm)) return undefined;
      provider ??= createLlmProvider(config.llm, { logger });
      return provider;
    },
    openApiSpec: () => {
      const file = path.resolve(paths.root, process.env.OPENAPI_SPEC_PATH ?? 'demo-app/openapi.json');
      if (!isPathInside(paths.root, file)) throw new Error('OPENAPI_SPEC_PATH must be inside the project');
      return JSON.parse(readFileSync(file, 'utf8')) as unknown;
    },
  };
}
