import * as z from 'zod';

import { redactSensitive, truncate } from '../../utils/sanitizer.js';

/**
 * Sanitised diagnostic package describing one failed test. Built from the
 * Playwright JSON report + failure-diagnostics attachment (see ResultsService),
 * or supplied directly by a caller.
 */
export const failureReportSchema = z
  .object({
    testTitle: z.string().min(1).max(500),
    file: z.string().max(500).optional(),
    line: z.number().int().positive().optional(),
    project: z.string().max(100).optional(),
    retry: z.number().int().min(0).default(0),
    error: z.object({ message: z.string().max(20_000), stack: z.string().max(20_000).optional() }).strict(),
    steps: z.array(z.string().max(500)).max(200).default([]),
    /** Paths to artifacts (screenshots are referenced, not embedded – see docs/ai-integration.md). */
    artifacts: z
      .array(z.object({ name: z.string(), path: z.string().optional(), contentType: z.string() }).strict())
      .default([]),
    traceSummary: z.array(z.string().max(500)).max(200).default([]),
    consoleErrors: z.array(z.string().max(4000)).max(100).default([]),
    pageErrors: z.array(z.string().max(4000)).max(100).default([]),
    failedRequests: z
      .array(
        z
          .object({
            method: z.string(),
            url: z.string(),
            status: z.number().optional(),
            failure: z.string().optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    apiCalls: z
      .array(
        z
          .object({
            method: z.string(),
            url: z.string(),
            status: z.number().optional(),
            durationMs: z.number().optional(),
            error: z.string().optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    /** Relevant test / page-object source excerpts. */
    sourceSnippets: z
      .array(z.object({ path: z.string(), content: z.string().max(20_000) }).strict())
      .max(10)
      .default([]),
  })
  .strict();
export type FailureReport = z.infer<typeof failureReportSchema>;
export type FailureReportInput = z.input<typeof failureReportSchema>;

/** Validates and deep-sanitises a report; long fields are truncated. */
export function sanitizeFailureReport(input: FailureReportInput): FailureReport {
  const report = failureReportSchema.parse(input);
  const sanitized = redactSensitive(report, { maxStringLength: 20_000 });
  return {
    ...sanitized,
    error: {
      message: truncate(sanitized.error.message, 6000),
      ...(sanitized.error.stack ? { stack: truncate(sanitized.error.stack, 6000) } : {}),
    },
  };
}
