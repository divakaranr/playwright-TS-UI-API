import { wrapUntrusted } from '../../utils/sanitizer.js';
import type { LLMProvider } from '../providers/llm-provider.interface.js';
import { FAILURE_ANALYSIS_SYSTEM } from '../prompts/system-prompts.js';
import { failureAnalysisSchema, type FailureAnalysis } from '../schemas/ai-output.schemas.js';
import { classifyFailure, type HeuristicResult } from './failure-heuristics.js';
import { sanitizeFailureReport, type FailureReport, type FailureReportInput } from './failure-report.js';
import { generateStructured } from './structured-output.js';

export interface FailureAnalysisResult {
  source: 'llm' | 'heuristic';
  analysis: FailureAnalysis;
  heuristic: HeuristicResult;
  model?: string;
  /** Present when the LLM was requested but failed; the heuristic result is returned instead. */
  llmError?: string;
  disclaimer: string;
}

const DISCLAIMER =
  'Advisory output. The framework never modifies test code or test outcomes automatically; validate the diagnosis before acting.';

/**
 * AI failure analysis. Always sanitises the diagnostic package first, computes a
 * deterministic heuristic classification, then (if a provider is available) asks
 * the LLM for a deeper diagnosis validated against `failureAnalysisSchema`.
 * LLM failures degrade gracefully to the heuristic result.
 */
export class FailureAnalysisService {
  constructor(private readonly provider?: LLMProvider) {}

  async analyze(input: FailureReportInput): Promise<FailureAnalysisResult> {
    const report = sanitizeFailureReport(input);
    const heuristic = classifyFailure(report);
    if (!this.provider) {
      return { source: 'heuristic', analysis: stripRule(heuristic), heuristic, disclaimer: DISCLAIMER };
    }
    try {
      const result = await generateStructured(
        this.provider,
        {
          systemPrompt: FAILURE_ANALYSIS_SYSTEM,
          userPrompt: buildPrompt(report, heuristic),
          maxTokens: 1500,
        },
        failureAnalysisSchema,
      );
      return {
        source: 'llm',
        analysis: result.data,
        heuristic,
        model: this.provider.model,
        disclaimer: DISCLAIMER,
      };
    } catch (error) {
      return {
        source: 'heuristic',
        analysis: stripRule(heuristic),
        heuristic,
        llmError: error instanceof Error ? error.message : String(error),
        disclaimer: DISCLAIMER,
      };
    }
  }
}

function stripRule({ ruleId: _ruleId, ...analysis }: HeuristicResult): FailureAnalysis {
  return analysis;
}

function buildPrompt(report: FailureReport, heuristic: HeuristicResult): string {
  const sections = [
    `Test: ${report.testTitle}${report.project ? ` [project: ${report.project}]` : ''}${report.file ? ` (${report.file}${report.line ? `:${report.line}` : ''})` : ''}`,
    `Retry attempt: ${report.retry}`,
    wrapUntrusted('error', `${report.error.message}\n\n${report.error.stack ?? ''}`),
    report.steps.length ? wrapUntrusted('test-steps', report.steps.join('\n')) : '',
    report.traceSummary.length ? wrapUntrusted('trace-actions', report.traceSummary.join('\n')) : '',
    report.consoleErrors.length ? wrapUntrusted('console-errors', report.consoleErrors.join('\n')) : '',
    report.pageErrors.length ? wrapUntrusted('page-errors', report.pageErrors.join('\n')) : '',
    report.failedRequests.length
      ? wrapUntrusted('failed-network-requests', JSON.stringify(report.failedRequests, null, 1))
      : '',
    report.apiCalls.length ? wrapUntrusted('api-calls', JSON.stringify(report.apiCalls, null, 1)) : '',
    report.artifacts.length
      ? `Artifacts available (not embedded): ${report.artifacts.map((a) => `${a.name} (${a.contentType})`).join(', ')}`
      : '',
    ...report.sourceSnippets.map((s) => wrapUntrusted(`source:${s.path}`, s.content, 8000)),
    `Deterministic pre-classification (hint, may be wrong): ${heuristic.classification} via rule "${heuristic.ruleId}" – ${heuristic.probableRootCause}`,
  ];
  return sections.filter(Boolean).join('\n\n');
}
