import { wrapUntrusted } from '../../utils/sanitizer.js';
import type { LLMProvider } from '../providers/llm-provider.interface.js';
import { API_EXPLORATION_SYSTEM } from '../prompts/system-prompts.js';
import { apiExplorationSchema, type ApiExploration } from '../schemas/ai-output.schemas.js';
import { generateStructured } from './structured-output.js';

type HttpMethod = ApiExploration['endpoints'][number]['method'];
const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export interface EndpointSummary {
  method: HttpMethod;
  path: string;
  summary: string;
  parameters: string[];
  responses: number[];
  secured: boolean;
  hasRequestBody: boolean;
}

/** Deterministically summarises an OpenAPI 3.x document (no network, no LLM). */
export function summarizeOpenApi(spec: unknown): EndpointSummary[] {
  const doc = spec as { paths?: Record<string, Record<string, unknown>>; security?: unknown[] };
  if (!doc || typeof doc !== 'object' || !doc.paths)
    throw new Error('not an OpenAPI document (missing "paths")');
  const endpoints: EndpointSummary[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    const shared = (item.parameters as Array<{ name: string; in: string }> | undefined) ?? [];
    for (const method of METHODS) {
      const op = item[method.toLowerCase()] as
        | {
            summary?: string;
            parameters?: Array<{ name: string; in: string }>;
            responses?: Record<string, unknown>;
            security?: unknown[];
            requestBody?: unknown;
          }
        | undefined;
      if (!op) continue;
      endpoints.push({
        method,
        path,
        summary: op.summary ?? '',
        parameters: [...shared, ...(op.parameters ?? [])].map((p) => `${p.in}:${p.name}`),
        responses: Object.keys(op.responses ?? {})
          .map(Number)
          .filter(Number.isFinite),
        // Explicit operation security wins; otherwise inherit global security or infer from a documented 401.
        secured: Array.isArray(op.security)
          ? op.security.length > 0
          : Boolean(doc.security?.length) || Object.hasOwn(op.responses ?? {}, '401'),
        hasRequestBody: op.requestBody !== undefined,
      });
    }
  }
  return endpoints;
}

/**
 * Baseline coverage suggestions derived purely from the spec – every documented
 * response code becomes a scenario, plus auth and boundary checks. Works without
 * an LLM and is validated against the same schema as LLM output.
 */
export function baselineExploration(endpoints: EndpointSummary[]): ApiExploration {
  return apiExplorationSchema.parse({
    summary: `Baseline coverage for ${endpoints.length} operation(s) derived from the specification.`,
    endpoints: endpoints.map((e) => ({
      method: e.method,
      path: e.path,
      scenarios: [
        ...e.responses.map((status) => ({
          title: `${e.method} ${e.path} returns ${status}`,
          category:
            status < 300 ? 'positive' : status === 401 || status === 403 ? 'authorization' : 'negative',
          request:
            status < 300
              ? 'valid request with authorised credentials'
              : `request that triggers documented ${status}`,
          expectedStatus: status,
          validations:
            status < 300
              ? ['response matches documented schema', 'business fields are correct']
              : ['error body matches error schema'],
        })),
        ...(e.secured && !e.responses.includes(401)
          ? [
              {
                title: `${e.method} ${e.path} without credentials`,
                category: 'authorization',
                request: 'no Authorization header',
                expectedStatus: 401,
                validations: ['WWW-Authenticate header present'],
              },
            ]
          : []),
        ...(e.parameters.some((p) => p.startsWith('query:'))
          ? [
              {
                title: `${e.method} ${e.path} query parameter boundaries`,
                category: 'boundary',
                request: 'min/max/out-of-range query values',
                expectedStatus: 400,
                validations: ['validation error lists the parameter'],
              },
            ]
          : []),
        {
          title: `${e.method} ${e.path} response time`,
          category: 'performance',
          request: 'representative valid request',
          expectedStatus: e.responses.find((s) => s < 300) ?? 200,
          validations: ['responds within configured threshold'],
        },
      ],
    })),
    coverageGaps: endpoints
      .filter((e) => e.responses.length === 0)
      .map((e) => `${e.method} ${e.path} documents no responses`),
  });
}

export interface ApiExplorationResult {
  source: 'llm' | 'baseline';
  exploration: ApiExploration;
  endpoints: EndpointSummary[];
  llmError?: string;
}

/**
 * AI API exploration over an approved specification. Read-only: it never calls
 * the API itself. Returns baseline suggestions when no provider is configured.
 */
export class ApiExplorationService {
  constructor(private readonly provider?: LLMProvider) {}

  async explore(spec: unknown, focus?: { pathContains?: string }): Promise<ApiExplorationResult> {
    const endpoints = summarizeOpenApi(spec).filter(
      (e) => !focus?.pathContains || e.path.includes(focus.pathContains),
    );
    if (endpoints.length === 0) throw new Error('no operations matched the requested focus');
    const baseline = baselineExploration(endpoints);
    if (!this.provider) return { source: 'baseline', exploration: baseline, endpoints };

    try {
      const result = await generateStructured(
        this.provider,
        {
          systemPrompt: API_EXPLORATION_SYSTEM,
          userPrompt: [
            wrapUntrusted('api-operations', JSON.stringify(endpoints, null, 1)),
            wrapUntrusted('openapi-spec', JSON.stringify(spec), 30_000),
          ].join('\n\n'),
          maxTokens: 4000,
        },
        apiExplorationSchema,
      );
      return { source: 'llm', exploration: result.data, endpoints };
    } catch (error) {
      return {
        source: 'baseline',
        exploration: baseline,
        endpoints,
        llmError: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
