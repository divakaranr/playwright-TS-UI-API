import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import type { BrowserContext } from '@playwright/test';

import { ensureDir } from '../utils/file.util.js';
import { paths } from '../utils/paths.js';

/**
 * Manages Playwright browser storage-state files per environment and role.
 * Files live in `.auth/` (git-ignored) because they contain session cookies.
 *
 * Storage state is produced once per run by the `setup` project
 * (tests/fixtures/auth.setup.ts) and consumed through the `role` fixture option,
 * so each test gets a fresh, isolated browser context pre-loaded with the
 * role's session instead of logging in through the UI every time.
 */
export class StorageStateManager {
  constructor(
    private readonly environment: string,
    private readonly baseDir: string = paths.auth,
  ) {}

  pathFor(role: string): string {
    if (!/^[a-z][a-z0-9_]*$/.test(role)) throw new Error(`Invalid role name: ${role}`);
    return path.join(this.baseDir, this.environment, `${role}.json`);
  }

  exists(role: string): boolean {
    return existsSync(this.pathFor(role));
  }

  /** True when the state file exists and is younger than `maxAgeMs` (0 = never fresh). */
  isFresh(role: string, maxAgeMs: number): boolean {
    if (maxAgeMs <= 0 || !this.exists(role)) return false;
    return Date.now() - statSync(this.pathFor(role)).mtimeMs < maxAgeMs;
  }

  async save(context: BrowserContext, role: string): Promise<string> {
    const file = this.pathFor(role);
    ensureDir(path.dirname(file));
    await context.storageState({ path: file });
    return file;
  }
}
