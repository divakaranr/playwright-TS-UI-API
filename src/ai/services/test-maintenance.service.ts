import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { findFiles } from '../../utils/file.util.js';
import { paths } from '../../utils/paths.js';
import { wrapUntrusted } from '../../utils/sanitizer.js';
import type { LLMProvider } from '../providers/llm-provider.interface.js';
import { LOCATOR_ADVICE_SYSTEM } from '../prompts/system-prompts.js';
import { locatorAdviceSchema, type LocatorAdvice } from '../schemas/ai-output.schemas.js';
import { generateStructured } from './structured-output.js';

export interface LocatorFinding {
  file: string;
  line: number;
  code: string;
  rule: string;
  severity: 'high' | 'medium' | 'low';
  advice: string;
}

const RULES: Array<{ rule: string; pattern: RegExp; severity: LocatorFinding['severity']; advice: string }> =
  [
    {
      rule: 'xpath',
      pattern: /locator\(\s*['"`](\/\/|xpath=)/,
      severity: 'high',
      advice: 'Replace XPath with getByRole/getByLabel/getByTestId.',
    },
    {
      rule: 'positional-css',
      pattern: /:nth-(child|of-type)\(|\.nth\(\d+\)|\.first\(\)|\.last\(\)/,
      severity: 'medium',
      advice: 'Positional selectors break when order changes; filter by accessible name or test id.',
    },
    {
      rule: 'generated-class',
      pattern: /locator\(\s*['"`][^'"`]*\.(css|sc|jsx|MuiBox|chakra)-[a-z0-9]+/i,
      severity: 'high',
      advice: 'Generated class names change between builds; use semantic locators.',
    },
    {
      rule: 'hard-wait',
      pattern: /waitForTimeout\(/,
      severity: 'high',
      advice: 'Replace fixed sleeps with web-first assertions or condition-based waits.',
    },
    {
      rule: 'raw-css-id',
      pattern: /locator\(\s*['"`]#[A-Za-z]/,
      severity: 'low',
      advice:
        'IDs are acceptable but not user-facing; prefer getByRole/getByLabel when an accessible name exists.',
    },
    {
      rule: 'force-click',
      pattern: /force:\s*true/,
      severity: 'medium',
      advice: 'force:true bypasses actionability checks and can hide real UI defects.',
    },
  ];

/**
 * AI-assisted test maintenance. A deterministic static audit flags brittle
 * locators and hard waits; optionally an LLM proposes concrete replacements.
 * Output is advisory only – the framework never self-heals or edits tests.
 */
export class TestMaintenanceService {
  constructor(
    private readonly provider?: LLMProvider,
    private readonly roots: string[] = [path.join(paths.src, 'ui'), paths.tests],
  ) {}

  async audit(): Promise<LocatorFinding[]> {
    const files = (await Promise.all(this.roots.map((r) => findFiles(r, (f) => f.endsWith('.ts'))))).flat();
    const findings: LocatorFinding[] = [];
    for (const file of files) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((code, index) => {
        if (code.trim().startsWith('//') || code.trim().startsWith('*')) return;
        for (const rule of RULES) {
          if (rule.pattern.test(code)) {
            findings.push({
              file: path.relative(paths.root, file),
              line: index + 1,
              code: code.trim(),
              rule: rule.rule,
              severity: rule.severity,
              advice: rule.advice,
            });
          }
        }
      });
    }
    return findings;
  }

  /** Asks the LLM for replacement locators, given findings and (optionally) a live accessibility snapshot. */
  async suggest(findings: LocatorFinding[], ariaSnapshot?: string): Promise<LocatorAdvice> {
    if (!this.provider)
      throw new Error('LLM provider not configured – use audit() for deterministic findings');
    if (findings.length === 0) return { recommendations: [] };
    const result = await generateStructured(
      this.provider,
      {
        systemPrompt: LOCATOR_ADVICE_SYSTEM,
        userPrompt: [
          wrapUntrusted('findings', JSON.stringify(findings.slice(0, 50), null, 1)),
          ariaSnapshot
            ? wrapUntrusted('accessibility-snapshot', ariaSnapshot, 15_000)
            : 'No accessibility snapshot provided.',
        ].join('\n\n'),
        maxTokens: 3000,
      },
      locatorAdviceSchema,
    );
    return result.data;
  }
}
