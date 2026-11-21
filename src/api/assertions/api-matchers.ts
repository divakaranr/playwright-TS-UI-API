import type * as z from 'zod';

import { formatZodIssues } from '../../config/config.schema.js';
import { truncate } from '../../utils/sanitizer.js';
import { ApiResponse } from '../clients/api-response.js';

interface MatcherState {
  isNot: boolean;
}
interface MatcherResult {
  pass: boolean;
  message: () => string;
  name: string;
  expected?: unknown;
  actual?: unknown;
}

function assertApiResponse(received: unknown, matcher: string): asserts received is ApiResponse {
  if (!(received instanceof ApiResponse)) {
    throw new Error(`${matcher}() expects an ApiResponse returned by a framework API client`);
  }
}

async function bodySnippet(response: ApiResponse): Promise<string> {
  try {
    return truncate(await response.text(), 1000);
  } catch {
    return '<unreadable body>';
  }
}

/**
 * Custom web-first-style matchers for API responses. Failure messages include
 * the request line, correlation id and a body excerpt so failures are diagnosable
 * from the report alone.
 */
export const apiMatchers = {
  async toHaveStatus(
    this: MatcherState,
    received: unknown,
    expected: number | readonly number[],
  ): Promise<MatcherResult> {
    assertApiResponse(received, 'toHaveStatus');
    const allowed = Array.isArray(expected) ? expected : [expected as number];
    const actual = received.status();
    const pass = allowed.includes(actual);
    const body = pass === this.isNot ? await bodySnippet(received) : '';
    return {
      name: 'toHaveStatus',
      pass,
      expected: allowed,
      actual,
      message: () =>
        `${received.describe()}\nExpected status ${this.isNot ? 'not ' : ''}${allowed.join(' or ')}, received ${actual}` +
        `\nCorrelation id: ${received.correlationId}\nBody: ${body}`,
    };
  },

  async toMatchSchema(this: MatcherState, received: unknown, schema: z.ZodType): Promise<MatcherResult> {
    assertApiResponse(received, 'toMatchSchema');
    let issues: string[] = [];
    try {
      const result = schema.safeParse(await received.json());
      if (!result.success) issues = formatZodIssues(result.error);
    } catch (error) {
      issues = [error instanceof Error ? error.message : String(error)];
    }
    const pass = issues.length === 0;
    const body = pass === this.isNot ? await bodySnippet(received) : '';
    return {
      name: 'toMatchSchema',
      pass,
      message: () =>
        pass
          ? `${received.describe()}\nExpected body not to match schema, but it did\nBody: ${body}`
          : `${received.describe()}\nSchema validation failed:\n - ${issues.join('\n - ')}\nBody: ${body}`,
    };
  },

  // Returns a Promise (like the other matchers) so every API assertion is consistently awaited.
  toRespondWithin(this: MatcherState, received: unknown, thresholdMs: number): Promise<MatcherResult> {
    assertApiResponse(received, 'toRespondWithin');
    const pass = received.durationMs <= thresholdMs;
    return Promise.resolve({
      name: 'toRespondWithin',
      pass,
      expected: thresholdMs,
      actual: received.durationMs,
      message: () =>
        `${received.describe()}\nExpected response time ${this.isNot ? '>' : '<='} ${thresholdMs}ms, actual ${received.durationMs}ms`,
    });
  },

  toHaveHeader(
    this: MatcherState,
    received: unknown,
    name: string,
    expected?: string | RegExp,
  ): Promise<MatcherResult> {
    assertApiResponse(received, 'toHaveHeader');
    const value = received.header(name);
    const pass =
      value !== undefined &&
      (expected === undefined || (typeof expected === 'string' ? value === expected : expected.test(value)));
    return Promise.resolve({
      name: 'toHaveHeader',
      pass,
      expected,
      actual: value,
      message: () =>
        `${received.describe()}\nExpected header "${name}"${expected !== undefined ? ` matching ${String(expected)}` : ''}` +
        ` ${this.isNot ? 'to be absent/different' : 'to be present'}; actual: ${value ?? '<missing>'}`,
    });
  },
};
