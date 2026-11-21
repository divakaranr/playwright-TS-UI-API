import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Parallel-safe unique identifiers. Combines the Playwright worker index (when
 * available), a base-36 timestamp and cryptographic randomness so that values
 * never collide across workers, shards or CI agents running concurrently.
 */
export function uniqueId(prefix = 'pw'): string {
  const worker = process.env.TEST_WORKER_INDEX ?? process.env.TEST_PARALLEL_INDEX ?? 'm';
  return `${prefix}-w${worker}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export function correlationId(): string {
  return randomUUID();
}

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomString(length: number, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
