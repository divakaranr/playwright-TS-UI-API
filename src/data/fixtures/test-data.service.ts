import { existsSync } from 'node:fs';
import path from 'node:path';

import type * as z from 'zod';

import { TestDataError } from '../../core/exceptions/index.js';
import { readJsonFile } from '../../utils/file.util.js';
import { paths } from '../../utils/paths.js';
import { UserBuilder } from '../builders/user.builder.js';
import { UserFactory } from '../factories/user.factory.js';

/**
 * Central access point for test data:
 * - `load(name, schema)` reads test-data/<env>/<name>.json, falling back to
 *   test-data/common/<name>.json, and validates it with a Zod schema.
 * - `users` / `userBuilder()` generate unique dynamic data.
 *
 * Static JSON holds *rules and scenarios* (invalid payloads, boundaries); records
 * a test mutates are always generated, never shared.
 */
export class TestDataService {
  private readonly cache = new Map<string, unknown>();

  constructor(
    private readonly environment: string,
    private readonly baseDir: string = paths.testData,
  ) {}

  readonly users = UserFactory;

  userBuilder(): UserBuilder {
    return new UserBuilder();
  }

  load<S extends z.ZodType>(name: string, schema: S): z.infer<S> {
    if (!/^[a-z0-9-]+$/.test(name)) throw new TestDataError(`Invalid test data name: ${name}`);
    const cacheKey = `${this.environment}/${name}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey) as z.infer<S>;

    const candidates = [
      path.join(this.baseDir, this.environment, `${name}.json`),
      path.join(this.baseDir, 'common', `${name}.json`),
    ];
    const file = candidates.find((candidate) => existsSync(candidate));
    if (!file) throw new TestDataError(`Test data "${name}" not found in: ${candidates.join(', ')}`);
    const data = readJsonFile(file, schema);
    this.cache.set(cacheKey, data);
    return data;
  }
}
