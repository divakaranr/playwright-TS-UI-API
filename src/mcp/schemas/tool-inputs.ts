import * as z from 'zod';

import { ALL_TAGS } from '../../core/tags.js';
import { RUNNABLE_PROJECTS, SAFE_GREP } from '../../core/services/test-execution.service.js';

/**
 * Strict input schemas for every custom MCP tool. `.strict()` rejects unknown
 * properties; string inputs are length-bounded and pattern-restricted.
 */

/** prod is not even representable – production can never be targeted through MCP. */
export const mcpEnvironment = z
  .enum(['local', 'dev', 'qa', 'uat', 'staging'])
  .describe('Target environment (subject to MCP_ALLOWED_ENVIRONMENTS)');
const optionalEnvironment = mcpEnvironment.optional().describe('Defaults to the server environment');
const grep = z
  .string()
  .regex(SAFE_GREP, 'only letters, digits, @, whitespace and | ( ) . : \' " , > ? = * ^ - are allowed')
  .describe('Playwright --grep filter (title/tag regex)');
const browserProject = z.enum(['chromium', 'firefox', 'webkit']);
const runId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,80}$/)
  .describe('Run id returned by a run_* tool; omit for the latest local run');
const titleContains = z
  .string()
  .min(2)
  .max(300)
  .describe('Case-insensitive substring of the failed test title');
const role = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,30}$/)
  .describe('Role whose session to use (e.g. admin, viewer)');
/** Relative path ("/users?q=x") or absolute URL on the environment origin. */
const pageTarget = z
  .string()
  .min(1)
  .max(500)
  .regex(/^(\/|https?:\/\/)[^\s<>"'`]*$/, 'must be a path starting with "/" or an http(s) URL');

export const runUiTestsInput = z
  .object({ environment: mcpEnvironment, grep: grep.optional(), project: browserProject.default('chromium') })
  .strict();
export const runApiTestsInput = z.object({ environment: mcpEnvironment, grep: grep.optional() }).strict();
export const runE2eTestsInput = runUiTestsInput;
export const runSmokeTestsInput = z
  .object({
    environment: mcpEnvironment,
    includeUi: z.boolean().default(true),
    project: browserProject.default('chromium'),
  })
  .strict();
export const runTestsByTagInput = z
  .object({
    environment: mcpEnvironment,
    tags: z.array(z.enum(ALL_TAGS)).min(1).max(5),
    match: z.enum(['any', 'all']).default('any'),
    projects: z.array(z.enum(RUNNABLE_PROJECTS)).min(1).max(4).optional(),
  })
  .strict();

export const inspectApplicationInput = z
  .object({ url: pageTarget, environment: optionalEnvironment, role: role.optional() })
  .strict();
export const inspectPageElementsInput = inspectApplicationInput;

const workflowTarget = z.union([
  z.object({ role: z.string().regex(/^[a-z]{2,20}$/), name: z.string().max(200).optional() }).strict(),
  z.object({ label: z.string().min(1).max(200) }).strict(),
  z.object({ testId: z.string().regex(/^[\w-]{1,100}$/) }).strict(),
  z.object({ text: z.string().min(1).max(200) }).strict(),
]);
export const exploreUserWorkflowInput = z
  .object({
    startUrl: pageTarget,
    environment: optionalEnvironment,
    role: role.optional(),
    steps: z
      .array(
        z
          .object({
            action: z.enum(['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'expectVisible']),
            target: workflowTarget.optional(),
            value: z.string().max(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(25),
  })
  .strict();

export const inspectApiEndpointInput = z
  .object({
    path: z
      .string()
      .regex(/^\/[A-Za-z0-9/_.{}-]{0,200}$/, 'API path relative to API_BASE_URL, e.g. /users/1'),
    method: z.enum(['GET', 'HEAD', 'OPTIONS']).default('GET').describe('Read-only methods only'),
    query: z.record(z.string().regex(/^[\w.-]{1,50}$/), z.string().max(200)).optional(),
    environment: optionalEnvironment,
    role: role.optional(),
  })
  .strict();

const scenarioInput = z
  .object({
    title: z.string().min(3).max(200),
    type: z.enum(['positive', 'negative', 'boundary']).default('positive'),
    steps: z.array(z.string().min(1).max(500)).min(1).max(30),
    expectedResults: z.array(z.string().min(1).max(500)).min(1).max(20),
  })
  .strict();

export const generateUiTestInput = z
  .object({
    feature: z.string().min(3).max(200),
    requirementId: z
      .string()
      .regex(/^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/)
      .default('REQ-0'),
    scenarios: z.array(scenarioInput).min(1).max(20).optional(),
    requirement: z
      .string()
      .min(10)
      .max(5000)
      .optional()
      .describe('Free-text requirement; used with the LLM when scenarios are omitted'),
    saveDraft: z.boolean().default(false).describe('Write the draft to generated-tests/ (never into tests/)'),
  })
  .strict();

export const generateApiTestInput = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().regex(/^\/[A-Za-z0-9/_.{}-]{0,200}$/),
    useLlm: z.boolean().default(false),
    saveDraft: z.boolean().default(false),
  })
  .strict();

const criterion = z
  .object({ id: z.string().regex(/^[A-Z]{2,5}-\d{1,4}$/), text: z.string().min(3).max(1000) })
  .strict();
export const generateTestFromRequirementInput = z
  .object({
    title: z.string().min(3).max(200),
    userStory: z.string().min(10).max(5000),
    acceptanceCriteria: z.array(criterion).min(1).max(30),
    businessRules: z.array(criterion).max(30).default([]),
    includeApiSpecification: z
      .boolean()
      .default(false)
      .describe('Attach the approved OpenAPI spec as context'),
    saveDraft: z.boolean().default(false),
  })
  .strict();

export const getTestResultsInput = z
  .object({ runId: runId.optional(), listRecentRuns: z.boolean().default(false) })
  .strict();
export const inspectTestFailureInput = z
  .object({ runId: runId.optional(), titleContains: titleContains.optional() })
  .strict();
export const analyzeFailureLogsInput = z
  .object({ runId: runId.optional(), titleContains, useLlm: z.boolean().default(true) })
  .strict();
export const getTraceMetadataInput = z.object({ runId: runId.optional(), titleContains }).strict();

export const emptyInput = z.object({}).strict();
export const getAvailableTestSuitesInput = z.object({ refresh: z.boolean().default(false) }).strict();
