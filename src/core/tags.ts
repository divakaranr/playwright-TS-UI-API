/**
 * Canonical test tags (use with `test('…', { tag: [Tags.smoke, Tags.ui] }, …)`).
 * Run subsets with `--grep @smoke`, `--grep-invert @slow`, etc.
 */
export const Tags = {
  smoke: '@smoke',
  regression: '@regression',
  sanity: '@sanity',
  ui: '@ui',
  api: '@api',
  e2e: '@e2e',
  critical: '@critical',
  negative: '@negative',
  integration: '@integration',
  mobile: '@mobile',
  /** Read-only test permitted against production. */
  prodSafe: '@prod-safe',
  /** Mutates/deletes data – never allowed in read-only environments. */
  destructive: '@destructive',
} as const;

export type Tag = (typeof Tags)[keyof typeof Tags];
export const ALL_TAGS = Object.values(Tags) as [Tag, ...Tag[]];
