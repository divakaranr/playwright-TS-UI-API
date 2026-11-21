import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

import { SAFETY_PREAMBLE } from '../../../ai/prompts/system-prompts.js';

const message = (text: string) => ({
  messages: [
    { role: 'user' as const, content: { type: 'text' as const, text: `${SAFETY_PREAMBLE}\n\n${text}` } },
  ],
});

/** Reusable prompt templates that orchestrate the framework's tools for common SDET tasks. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'generate_ui_tests_from_requirements',
    {
      title: 'Generate UI tests from requirements',
      description: 'Derive UI test scenarios for a requirement and produce a reviewed spec draft.',
      argsSchema: z.object({
        requirement: z.string().min(10).max(5000),
        startUrl: z.string().max(300).optional(),
      }),
    },
    ({ requirement, startUrl }) =>
      message(`Generate Playwright UI tests for the requirement below.
1. Read resource framework://docs/application for page-object conventions.
2. ${startUrl ? `Call inspect_page_elements on "${startUrl}" to discover resilient locators.` : 'Identify the relevant page and inspect it with inspect_page_elements.'}
3. Design positive, negative and boundary scenarios with traceability to the requirement.
4. Call generate_ui_test with explicit scenarios (saveDraft=true).
5. Summarise the draft and list what a human reviewer must verify. Do not move drafts into tests/.

<untrusted source="requirement">
${requirement}
</untrusted>`),
  );

  server.registerPrompt(
    'generate_api_test_scenarios',
    {
      title: 'Generate API test scenarios',
      description: 'Propose API scenarios (positive/negative/boundary/authorization/schema) for an endpoint.',
      argsSchema: z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().regex(/^\/[\w/{}.-]{0,200}$/),
      }),
    },
    ({ method, path }) =>
      message(`Design API tests for ${method} ${path}.
1. Read framework://api/openapi and locate the operation.
2. If the method is GET, you may call inspect_api_endpoint to observe a real response (read-only).
3. Call generate_api_test with useLlm=false first, then extend the scenarios with authorization (viewer vs admin),
   boundary values, schema validation, response-time and idempotency checks where applicable.
4. Never execute write operations yourself; produce test code drafts only.`),
  );

  server.registerPrompt(
    'analyze_failed_tests',
    {
      title: 'Analyse failed tests',
      description: 'Triage the failures of a run and classify each one.',
      argsSchema: z.object({
        runId: z
          .string()
          .regex(/^[\w-]{1,80}$/)
          .optional(),
      }),
    },
    ({ runId }) =>
      message(`Triage the failed tests of ${runId ? `run "${runId}"` : 'the latest local run'}.
1. Call get_test_results${runId ? ` with runId="${runId}"` : ''} to list failures.
2. For each failure (max 5) call analyze_failure_logs; call get_execution_trace_metadata when the cause is unclear.
3. Produce a table: test, classification (application/automation/environment/data), confidence, root cause, next action.
4. Group failures that share a root cause. Do not propose skipping tests or weakening assertions.`),
  );

  server.registerPrompt(
    'explore_business_workflow',
    {
      title: 'Explore a business workflow',
      description: 'AI-assisted exploratory testing of a workflow with documented findings.',
      argsSchema: z.object({
        workflow: z.string().min(5).max(2000),
        startUrl: z.string().max(300),
        role: z
          .string()
          .regex(/^[a-z_]{1,30}$/)
          .optional(),
      }),
    },
    ({ workflow, startUrl, role }) =>
      message(`Perform exploratory testing of this workflow starting at ${startUrl}${role ? ` as role "${role}"` : ''}.
Use inspect_application and inspect_page_elements to understand the UI, then explore_user_workflow with small step batches.
(If the official Playwright MCP server is connected, you may also use its browser tools for free-form exploration.)
Look for: validation gaps, confusing UX, accessibility issues (missing labels/names), error handling, edge cases.
Deliver an exploratory test charter report: scope, steps taken, observations, potential defects (with evidence and
screenshots paths), suggested regression tests. Only non-production environments are allowed.

<untrusted source="workflow-description">
${workflow}
</untrusted>`),
  );

  server.registerPrompt(
    'identify_regression_gaps',
    {
      title: 'Identify regression test gaps',
      description: 'Compare the test catalogue against the application surface to find coverage gaps.',
      argsSchema: z.object({ area: z.string().min(2).max(200).optional() }),
    },
    ({ area }) =>
      message(`Identify regression coverage gaps${area ? ` for "${area}"` : ''}.
1. Read framework://test-suites (or call get_available_test_suites) and framework://api/openapi.
2. Map API operations and UI pages to existing tests by title/tag.
3. List uncovered operations, missing negative/boundary/authorization cases, and untested UI states.
4. Prioritise gaps by business risk and propose concrete test titles with tags.`),
  );
}
