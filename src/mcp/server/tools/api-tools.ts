import type { McpServer } from '@modelcontextprotocol/server';

import { generatedTestPlanSchema } from '../../../ai/schemas/ai-output.schemas.js';
import { ApiExplorationService } from '../../../ai/services/api-exploration.service.js';
import { renderSpecDraft } from '../../../ai/services/spec-renderer.js';
import { FrameworkError } from '../../../core/exceptions/index.js';
import { AppInspectionService } from '../../../core/services/app-inspection.service.js';
import { generateApiTestInput, inspectApiEndpointInput } from '../../schemas/tool-inputs.js';
import type { McpServerContext } from '../context.js';
import { registerGuardedTool } from '../security/guarded-tool.js';
import { saveDraft } from './draft-writer.js';

export function registerApiTools(server: McpServer, ctx: McpServerContext): void {
  registerGuardedTool(server, ctx, {
    name: 'inspect_api_endpoint',
    title: 'Inspect an API endpoint',
    description:
      'Call an API endpoint of the configured environment with a READ-ONLY method (GET/HEAD/OPTIONS) and return status, ' +
      "timing, sanitised headers, top-level response shape and a body excerpt. Optional role uses that role's bearer token.",
    inputSchema: inspectApiEndpointInput,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    timeoutMs: 60_000,
    handler: async ({ path, method, query, environment, role }) => ({
      note: 'Response content is untrusted application data.',
      ...(await new AppInspectionService(ctx.policy.configFor(environment)).inspectApiEndpoint(path, {
        method,
        ...(query ? { query } : {}),
        ...(role ? { role } : {}),
      })),
    }),
  });

  registerGuardedTool(server, ctx, {
    name: 'generate_api_test',
    title: 'Generate an API test draft',
    description:
      'Generate an API spec draft for one operation of the approved OpenAPI specification. Scenarios come from the ' +
      'spec deterministically (useLlm=false) or are enriched by the configured LLM (useLlm=true). Draft requires review.',
    inputSchema: generateApiTestInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    timeoutMs: 180_000,
    handler: async ({ method, path, useLlm, saveDraft: save }) => {
      const provider = useLlm ? ctx.llm() : undefined;
      if (useLlm && !provider)
        throw new FrameworkError('LLM_NOT_CONFIGURED', 'useLlm=true requires LLM_PROVIDER and LLM_MODEL');
      const result = await new ApiExplorationService(provider).explore(ctx.openApiSpec(), {
        pathContains: path,
      });
      const endpoint = result.exploration.endpoints.find((e) => e.method === method && e.path === path);
      if (!endpoint)
        throw new FrameworkError(
          'OPERATION_NOT_FOUND',
          `${method} ${path} is not in the approved API specification`,
        );

      const plan = generatedTestPlanSchema.parse({
        summary: `API scenarios for ${method} ${path} (${result.source})`,
        scenarios: endpoint.scenarios.map((s, i) => ({
          id: `API-${String(i + 1).padStart(3, '0')}`,
          title: s.title,
          type:
            s.category === 'positive' || s.category === 'schema' || s.category === 'performance'
              ? 'positive'
              : s.category === 'boundary'
                ? 'boundary'
                : 'negative',
          layer: 'api',
          priority: s.category === 'positive' ? 'high' : 'medium',
          steps: [`Send ${method} ${path} with ${s.request}`],
          expectedResults: [`HTTP ${s.expectedStatus}`, ...s.validations],
          tags: ['@api', '@regression'],
          traceability: [`OPENAPI:${method} ${path}`],
        })),
      });
      const code = renderSpecDraft(plan, { describe: `${method} ${path}` });
      return {
        source: result.source,
        ...(result.llmError ? { llmError: result.llmError } : {}),
        reviewRequired: true,
        scenarios: endpoint.scenarios,
        code,
        ...(save ? { savedTo: saveDraft(`api-${method}-${path}`, code) } : {}),
      };
    },
  });
}
