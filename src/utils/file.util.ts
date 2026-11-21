import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type * as z from 'zod';

import { SchemaValidationError, TestDataError } from '../core/exceptions/index.js';
import { formatZodIssues } from '../config/config.schema.js';

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Reads and schema-validates a JSON file. */
export function readJsonFile<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  if (!existsSync(file)) throw new TestDataError(`JSON file not found: ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new TestDataError(`Invalid JSON in ${file}`, { cause: error });
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new SchemaValidationError(path.basename(file), formatZodIssues(result.error));
  return result.data;
}

/** Writes JSON atomically (temp file + rename) so concurrent readers never see partial content. */
export function writeJsonFileAtomic(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/** Recursively lists files below `dir` whose name matches `predicate`. */
export async function findFiles(
  dir: string,
  predicate: (file: string) => boolean,
  maxDepth = 8,
): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (predicate(full)) results.push(full);
    }
  };
  await walk(dir, 0);
  return results;
}

export async function fileSize(file: string): Promise<number> {
  return (await stat(file)).size;
}

/** Converts a free-text title into a filesystem-safe slug. */
export function slugify(text: string, maxLength = 80): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength) || 'untitled'
  );
}
