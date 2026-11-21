import * as z from 'zod';

import { wrapUntrusted } from '../../utils/sanitizer.js';
import type { LLMProvider } from '../providers/llm-provider.interface.js';
import { TEST_GENERATION_SYSTEM } from '../prompts/system-prompts.js';
import { generatedTestPlanSchema, type GeneratedTestPlan } from '../schemas/ai-output.schemas.js';
import { renderSpecDraft } from './spec-renderer.js';
import { generateStructured } from './structured-output.js';

export const requirementInputSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    userStory: z.string().trim().min(10).max(5000),
    acceptanceCriteria: z
      .array(
        z
          .object({ id: z.string().regex(/^[A-Z]{2,5}-\d{1,4}$/), text: z.string().trim().min(3).max(1000) })
          .strict(),
      )
      .min(1)
      .max(30),
    businessRules: z
      .array(
        z
          .object({ id: z.string().regex(/^[A-Z]{2,5}-\d{1,4}$/), text: z.string().trim().min(3).max(1000) })
          .strict(),
      )
      .max(30)
      .default([]),
    apiSpecification: z.string().max(40_000).optional(),
  })
  .strict();
export type RequirementInput = z.input<typeof requirementInputSchema>;

export interface GeneratedTests {
  plan: GeneratedTestPlan;
  specDraft: string;
  reviewRequired: true;
  model: string;
  usage: { inputTokens: number; outputTokens: number; latencyMs: number };
}

/**
 * Requirement → structured, traceable test plan (validated with Zod) → spec draft.
 * Output is always a *draft* for human review; this service never writes into
 * the regression suite.
 */
export class TestGenerationService {
  constructor(private readonly provider: LLMProvider) {}

  async generateFromRequirement(input: RequirementInput): Promise<GeneratedTests> {
    const requirement = requirementInputSchema.parse(input);
    const knownIds = new Set(
      [...requirement.acceptanceCriteria, ...requirement.businessRules].map((x) => x.id),
    );

    const userPrompt = [
      `Requirement title: ${requirement.title}`,
      wrapUntrusted('user-story', requirement.userStory),
      wrapUntrusted(
        'acceptance-criteria',
        requirement.acceptanceCriteria.map((c) => `${c.id}: ${c.text}`).join('\n'),
      ),
      requirement.businessRules.length > 0
        ? wrapUntrusted(
            'business-rules',
            requirement.businessRules.map((r) => `${r.id}: ${r.text}`).join('\n'),
          )
        : 'Business rules: none provided',
      requirement.apiSpecification
        ? wrapUntrusted('api-specification', requirement.apiSpecification)
        : 'API specification: not provided',
      `Valid traceability ids: ${[...knownIds].join(', ')}`,
    ].join('\n\n');

    // Traceability must reference real requirement ids – checked in addition to the shape.
    const tracedSchema = generatedTestPlanSchema.superRefine((plan, ctx) => {
      plan.scenarios.forEach((scenario, index) => {
        const unknown = scenario.traceability.filter((id) => !knownIds.has(id));
        if (unknown.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['scenarios', index, 'traceability'],
            message: `unknown ids: ${unknown.join(', ')}`,
          });
        }
      });
      const covered = new Set(plan.scenarios.flatMap((s) => s.traceability));
      const uncovered = requirement.acceptanceCriteria.filter((c) => !covered.has(c.id)).map((c) => c.id);
      if (uncovered.length > 0)
        ctx.addIssue({
          code: 'custom',
          path: ['scenarios'],
          message: `acceptance criteria not covered: ${uncovered.join(', ')}`,
        });
    });

    const result = await generateStructured(
      this.provider,
      { systemPrompt: TEST_GENERATION_SYSTEM, userPrompt, maxTokens: 4000 },
      tracedSchema,
    );
    return {
      plan: result.data,
      specDraft: renderSpecDraft(result.data, { describe: requirement.title }),
      reviewRequired: true,
      model: this.provider.model,
      usage: {
        inputTokens: result.responses.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
        outputTokens: result.responses.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
        latencyMs: result.responses.reduce((sum, r) => sum + r.latencyMs, 0),
      },
    };
  }
}
