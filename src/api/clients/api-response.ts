import type { APIResponse } from '@playwright/test';
import type * as z from 'zod';

import { formatZodIssues } from '../../config/config.schema.js';
import { SchemaValidationError } from '../../core/exceptions/index.js';

export interface ApiCallMeta {
  readonly method: string;
  readonly url: string;
  readonly durationMs: number;
  readonly correlationId: string;
}

/**
 * Thin wrapper around Playwright's APIResponse adding timing, correlation and
 * schema-validated parsing. `raw` exposes the underlying response for anything
 * not covered here.
 */
export class ApiResponse {
  constructor(
    readonly raw: APIResponse,
    readonly meta: ApiCallMeta,
  ) {}

  status(): number {
    return this.raw.status();
  }

  ok(): boolean {
    return this.raw.ok();
  }

  headers(): Record<string, string> {
    return this.raw.headers();
  }

  header(name: string): string | undefined {
    return this.raw.headers()[name.toLowerCase()];
  }

  get durationMs(): number {
    return this.meta.durationMs;
  }

  get correlationId(): string {
    return this.meta.correlationId;
  }

  text(): Promise<string> {
    return this.raw.text();
  }

  /** Parses JSON without validation. Prefer `parse(schema)` in tests. */
  async json(): Promise<unknown> {
    const text = await this.raw.text();
    if (text.trim() === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new SchemaValidationError(`${this.describe()} response body`, [
        `body is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      ]);
    }
  }

  /** Parses and validates the body against a Zod schema, returning typed data. */
  async parse<S extends z.ZodType>(schema: S): Promise<z.infer<S>> {
    const body = await this.json();
    const result = schema.safeParse(body);
    if (!result.success)
      throw new SchemaValidationError(`${this.describe()} response body`, formatZodIssues(result.error));
    return result.data;
  }

  describe(): string {
    return `${this.meta.method} ${this.meta.url} -> ${this.status()}`;
  }
}
