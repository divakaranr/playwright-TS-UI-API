import type * as z from 'zod';

import { formatZodIssues } from '../../config/config.schema.js';
import { LlmError } from '../providers/llm-error.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../providers/llm-provider.interface.js';

export interface StructuredResult<T> {
  data: T;
  responses: LLMResponse[];
  repaired: boolean;
}

/**
 * Extracts the first top-level JSON object from model output. Tolerates
 * markdown fences and leading/trailing prose, which many models add despite
 * instructions.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in model output');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const char = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(candidate.slice(start, i + 1)) as unknown;
  }
  throw new Error('unterminated JSON object in model output');
}

/**
 * Calls the provider and validates the answer against a Zod schema. On invalid
 * output it performs bounded repair attempts, feeding the validation errors back
 * to the model. Never returns unvalidated data.
 */
export async function generateStructured<S extends z.ZodType>(
  provider: LLMProvider,
  request: LLMRequest,
  schema: S,
  options: { repairAttempts?: number } = {},
): Promise<StructuredResult<z.infer<S>>> {
  const maxRepairs = options.repairAttempts ?? 1;
  const responses: LLMResponse[] = [];
  let currentRequest: LLMRequest = { temperature: 0.2, ...request, responseFormat: 'json' };

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const response = await provider.generate(currentRequest);
    responses.push(response);

    let problems: string[];
    try {
      const parsed = schema.safeParse(extractJson(response.content));
      if (parsed.success) return { data: parsed.data, responses, repaired: attempt > 0 };
      problems = formatZodIssues(parsed.error);
    } catch (error) {
      problems = [error instanceof Error ? error.message : String(error)];
    }

    currentRequest = {
      ...currentRequest,
      userPrompt: `${request.userPrompt}\n\nYour previous answer was rejected by schema validation:\n- ${problems
        .slice(0, 15)
        .join('\n- ')}\nReturn a corrected JSON object that satisfies the required shape exactly.`,
    };
  }
  throw new LlmError(
    provider.name,
    'invalid_response',
    `model output failed schema validation after ${maxRepairs + 1} attempt(s)`,
  );
}
