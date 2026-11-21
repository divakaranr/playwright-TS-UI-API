import type { FailureAnalysis } from '../schemas/ai-output.schemas.js';
import type { FailureReport } from './failure-report.js';

interface Rule {
  id: string;
  classification: FailureAnalysis['classification'];
  confidence: FailureAnalysis['confidence'];
  test: (text: string, report: FailureReport) => boolean;
  rootCause: string;
  fix: string;
}

const RULES: Rule[] = [
  {
    id: 'network-unreachable',
    classification: 'environment_issue',
    confidence: 'high',
    test: (t) =>
      /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|net::ERR_(CONNECTION|NAME_NOT_RESOLVED|INTERNET)/i.test(
        t,
      ),
    rootCause: 'The application or a dependency was unreachable (connection refused / DNS failure).',
    fix: 'Verify the environment is up and the configured BASE_URL/API_BASE_URL are correct; check VPN/proxy and service health.',
  },
  {
    id: 'gateway-errors',
    classification: 'environment_issue',
    confidence: 'medium',
    test: (_t, r) => r.failedRequests.some((x) => x.status === 502 || x.status === 503 || x.status === 504),
    rootCause: 'Gateway/service-unavailable responses indicate an unhealthy environment or dependency.',
    fix: 'Check service health and deployments in the target environment before investigating test code.',
  },
  {
    id: 'server-error',
    classification: 'application_defect',
    confidence: 'medium',
    test: (t, r) =>
      r.failedRequests.some((x) => x.status === 500) || /\b500\b.*Internal|INTERNAL_ERROR/i.test(t),
    rootCause: 'The backend returned HTTP 500 during the test.',
    fix: 'Inspect server logs using the correlation id from the failure diagnostics and raise a defect if reproducible.',
  },
  {
    id: 'page-errors',
    classification: 'application_defect',
    confidence: 'medium',
    test: (_t, r) => r.pageErrors.length > 0,
    rootCause: 'Uncaught JavaScript errors occurred in the page.',
    fix: 'Review the page errors/console output; reproduce manually and raise a front-end defect.',
  },
  {
    id: 'data-conflict',
    classification: 'data_issue',
    confidence: 'medium',
    test: (t) => /\b409\b|already exists|EMAIL_CONFLICT|duplicate key|unique constraint/i.test(t),
    rootCause: 'Test data conflicted with existing records.',
    fix: 'Generate unique data via factories (UserFactory) and ensure cleanup is registered; avoid shared hard-coded records.',
  },
  {
    id: 'locator-not-found',
    classification: 'automation_defect',
    confidence: 'medium',
    test: (t) =>
      /strict mode violation|resolved to 0 elements|waiting for (getBy|locator\()|element\(s\) not found|Locator.*not (visible|attached)/i.test(
        t,
      ),
    rootCause:
      'A locator did not match (or matched multiple) elements – the UI changed or the locator is brittle/ambiguous.',
    fix: 'Inspect the trace/screenshot, update the page-object locator to a role/label/test-id based locator, and keep it unique.',
  },
  {
    id: 'auth-failure',
    classification: 'environment_issue',
    confidence: 'medium',
    test: (t) => /AUTHENTICATION_ERROR|Missing credentials|\b401\b|INVALID_CREDENTIALS/i.test(t),
    rootCause: 'Authentication failed – credentials are missing, expired or wrong for this environment.',
    fix: 'Verify APP_<ROLE>_USERNAME/PASSWORD secrets for the environment and that the account is active.',
  },
  {
    id: 'assertion-mismatch',
    classification: 'application_defect',
    confidence: 'low',
    test: (t) =>
      /expect\(.*\)\.(toBe|toEqual|toHaveText|toContainText|toHaveValue|toHaveStatus|toMatchObject)/i.test(t),
    rootCause: 'An assertion failed: actual application behaviour differed from the expectation.',
    fix: 'Compare expected vs actual in the error; confirm whether requirements changed (update test) or the product regressed (raise defect).',
  },
  {
    id: 'timeout',
    classification: 'unknown',
    confidence: 'low',
    test: (t) => /Timeout \d+ms exceeded|timed out/i.test(t),
    rootCause: 'An operation timed out without a more specific signal.',
    fix: 'Open the trace to see the last action; check for slow backend responses or missing UI state.',
  },
];

export interface HeuristicResult extends FailureAnalysis {
  ruleId: string;
}

/**
 * Deterministic first-pass classifier. Used (a) as the result when no LLM is
 * configured and (b) as a hint included in the LLM prompt.
 */
export function classifyFailure(report: FailureReport): HeuristicResult {
  const text = [
    report.error.message,
    report.error.stack ?? '',
    ...report.consoleErrors,
    ...report.apiCalls.map((c) => `${c.status ?? ''} ${c.error ?? ''}`),
  ].join('\n');
  const rule = RULES.find((r) => r.test(text, report));
  if (!rule) {
    return {
      ruleId: 'none',
      classification: 'unknown',
      confidence: 'low',
      probableRootCause: 'No known failure signature matched.',
      evidence: [report.error.message.split('\n')[0] ?? 'no error message'],
      suggestedFix: 'Review the trace, screenshot and diagnostics attachment for this test.',
      likelyFlaky: report.retry > 0,
    };
  }
  const evidence = [report.error.message.split('\n')[0] ?? ''];
  if (report.failedRequests.length > 0) {
    evidence.push(
      `failed requests: ${report.failedRequests
        .slice(0, 3)
        .map((r) => `${r.method} ${r.url} -> ${r.status ?? r.failure}`)
        .join('; ')}`,
    );
  }
  if (report.pageErrors.length > 0) evidence.push(`page errors: ${report.pageErrors.slice(0, 2).join('; ')}`);
  return {
    ruleId: rule.id,
    classification: rule.classification,
    confidence: rule.confidence,
    probableRootCause: rule.rootCause,
    evidence: evidence.filter(Boolean),
    suggestedFix: rule.fix,
    likelyFlaky: report.retry > 0,
  };
}
