import * as z from 'zod';

/** Every AI output is validated against one of these schemas before it is returned. */

const nonEmpty = z.string().trim().min(1);

export const testScenarioSchema = z
  .object({
    id: z.string().regex(/^[A-Z]{2,6}-\d{1,4}$/, 'ids look like "TC-001"'),
    title: nonEmpty.max(200),
    type: z.enum(['positive', 'negative', 'boundary']),
    layer: z.enum(['ui', 'api', 'e2e']),
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    preconditions: z.array(nonEmpty).default([]),
    steps: z.array(nonEmpty).min(1),
    expectedResults: z.array(nonEmpty).min(1),
    tags: z.array(z.string().regex(/^@[a-z-]+$/)).default([]),
    /** Acceptance-criterion / business-rule ids this scenario covers, e.g. ["AC-1"]. */
    traceability: z.array(nonEmpty).min(1),
  })
  .strict();
export type TestScenario = z.infer<typeof testScenarioSchema>;

export const generatedTestPlanSchema = z
  .object({
    summary: nonEmpty.max(1000),
    scenarios: z.array(testScenarioSchema).min(1).max(50),
    uiTestSuggestions: z.array(nonEmpty).default([]),
    apiTestSuggestions: z.array(nonEmpty).default([]),
    assumptions: z.array(nonEmpty).default([]),
    openQuestions: z.array(nonEmpty).default([]),
  })
  .strict();
export type GeneratedTestPlan = z.infer<typeof generatedTestPlanSchema>;

export const FAILURE_CLASSIFICATIONS = [
  'application_defect',
  'automation_defect',
  'environment_issue',
  'data_issue',
  'unknown',
] as const;

export const failureAnalysisSchema = z
  .object({
    probableRootCause: nonEmpty.max(1500),
    classification: z.enum(FAILURE_CLASSIFICATIONS),
    evidence: z.array(nonEmpty).min(1).max(20),
    suggestedFix: nonEmpty.max(2000),
    confidence: z.enum(['low', 'medium', 'high']),
    likelyFlaky: z.boolean().default(false),
  })
  .strict();
export type FailureAnalysis = z.infer<typeof failureAnalysisSchema>;

export const apiExplorationSchema = z
  .object({
    summary: nonEmpty,
    endpoints: z
      .array(
        z
          .object({
            method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
            path: z.string().startsWith('/'),
            scenarios: z
              .array(
                z
                  .object({
                    title: nonEmpty,
                    category: z.enum([
                      'positive',
                      'negative',
                      'boundary',
                      'authorization',
                      'schema',
                      'performance',
                    ]),
                    request: nonEmpty,
                    expectedStatus: z.number().int().min(100).max(599),
                    validations: z.array(nonEmpty).default([]),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
    coverageGaps: z.array(nonEmpty).default([]),
  })
  .strict();
export type ApiExploration = z.infer<typeof apiExplorationSchema>;

export const locatorAdviceSchema = z
  .object({
    recommendations: z.array(
      z
        .object({
          file: nonEmpty,
          line: z.number().int().positive().optional(),
          current: nonEmpty,
          suggested: nonEmpty,
          reason: nonEmpty,
        })
        .strict(),
    ),
  })
  .strict();
export type LocatorAdvice = z.infer<typeof locatorAdviceSchema>;
