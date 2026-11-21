import type { McpServer } from '@modelcontextprotocol/server';

import { TestGenerationService } from '../../../ai/services/test-generation.service.js';
import { FrameworkError } from '../../../core/exceptions/index.js';
import { generateTestFromRequirementInput } from '../../schemas/tool-inputs.js';
import type { McpServerContext } from '../context.js';
import { registerGuardedTool } from '../security/guarded-tool.js';
import { saveDraft } from './draft-writer.js';

export function registerGenerationTools(server: McpServer, ctx: McpServerContext): void {
  registerGuardedTool(server, ctx, {
    name: 'generate_test_from_requirement',
    title: 'Generate tests from a requirement',
    description:
      'Turn a user story with acceptance criteria and business rules into a traceable test plan (positive, negative, ' +
      'boundary; UI and API suggestions) validated against a strict schema, plus a spec draft. Requires a configured LLM. ' +
      'Output must be reviewed before entering the regression suite.',
    inputSchema: generateTestFromRequirementInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    timeoutMs: 300_000,
    handler: async ({ includeApiSpecification, saveDraft: save, ...requirement }) => {
      const provider = ctx.llm();
      if (!provider)
        throw new FrameworkError(
          'LLM_NOT_CONFIGURED',
          'Configure LLM_PROVIDER and LLM_MODEL (and LLM_API_KEY for cloud providers)',
        );
      const result = await new TestGenerationService(provider).generateFromRequirement({
        ...requirement,
        ...(includeApiSpecification ? { apiSpecification: JSON.stringify(ctx.openApiSpec()) } : {}),
      });
      return { ...result, ...(save ? { savedTo: saveDraft(requirement.title, result.specDraft) } : {}) };
    },
  });
}
