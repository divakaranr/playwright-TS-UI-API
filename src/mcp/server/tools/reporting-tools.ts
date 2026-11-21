import type { McpServer } from '@modelcontextprotocol/server';

import { FailureAnalysisService } from '../../../ai/services/failure-analysis.service.js';
import {
  analyzeFailureLogsInput,
  getTestResultsInput,
  getTraceMetadataInput,
  inspectTestFailureInput,
} from '../../schemas/tool-inputs.js';
import type { McpServerContext } from '../context.js';
import { registerGuardedTool } from '../security/guarded-tool.js';

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

export function registerReportingTools(server: McpServer, ctx: McpServerContext): void {
  registerGuardedTool(server, ctx, {
    name: 'get_test_results',
    title: 'Get test results',
    description:
      'Return the summary (totals, per-project results, failures, flaky tests) of a run, or list recent MCP runs.',
    inputSchema: getTestResultsInput,
    annotations: READ_ONLY,
    timeoutMs: 30_000,
    handler: async ({ runId, listRecentRuns }) =>
      listRecentRuns
        ? { runs: await ctx.results.listRuns(20) }
        : { runId: runId ?? 'latest-local', summary: ctx.results.getSummary(runId) },
  });

  registerGuardedTool(server, ctx, {
    name: 'inspect_test_failure',
    title: 'Inspect test failure',
    description:
      'Return details of failed tests in a run: error, stack, steps, artifacts (trace/screenshot/video paths) and the ' +
      'sanitised failure diagnostics (console errors, failed requests, API calls).',
    inputSchema: inspectTestFailureInput,
    annotations: READ_ONLY,
    timeoutMs: 30_000,
    handler: async ({ runId, titleContains }) => {
      const failures = await ctx.results.findFailedTests(runId, titleContains);
      if (failures.length === 0)
        return { failures: [], message: 'No failed tests found for the given filter.' };
      const [first, ...rest] = failures;
      return {
        totalFailures: failures.length,
        failure: {
          ...first,
          attachments: first!.attachments.map(({ body: _body, ...a }) => a),
          diagnostics: await ctx.results.readDiagnostics(first!),
        },
        otherFailures: rest
          .slice(0, 20)
          .map((f) => ({ title: f.title, project: f.project, error: f.errorMessage.split('\n')[0] })),
      };
    },
  });

  registerGuardedTool(server, ctx, {
    name: 'analyze_failure_logs',
    title: 'Analyse a failure',
    description:
      'Build a sanitised diagnostic package for a failed test (error, steps, trace actions, console/network evidence, ' +
      'test source) and return a structured diagnosis: root cause, classification (application/automation/environment/' +
      'data issue), evidence, suggested fix, confidence. Uses the configured LLM when available, otherwise heuristics. ' +
      'Never modifies tests or results.',
    inputSchema: analyzeFailureLogsInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
    timeoutMs: 180_000,
    handler: async ({ runId, titleContains, useLlm }) => {
      const failure = await ctx.results.getFailure(runId, titleContains);
      const report = await ctx.results.buildFailureReport(failure);
      const service = new FailureAnalysisService(useLlm ? ctx.llm() : undefined);
      return { test: failure.title, project: failure.project, ...(await service.analyze(report)) };
    },
  });

  registerGuardedTool(server, ctx, {
    name: 'get_execution_trace_metadata',
    title: 'Get trace metadata',
    description:
      'Summarise the Playwright trace of a failed test: browser, action timeline with durations, failing actions, ' +
      'resource/screenshot counts and the command to open it in the trace viewer.',
    inputSchema: getTraceMetadataInput,
    annotations: READ_ONLY,
    timeoutMs: 60_000,
    handler: async ({ runId, titleContains }) => {
      const failure = await ctx.results.getFailure(runId, titleContains);
      return {
        test: failure.title,
        project: failure.project,
        trace: await ctx.results.traceMetadata(failure),
      };
    },
  });
}
