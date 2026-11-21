// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'reports/**',
      'test-results/**',
      'playwright-report/**',
      'blob-report/**',
      'generated-tests/**',
      'logs/**',
      '.auth/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Floating promises are the #1 cause of flaky Playwright tests.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      // Hard waits are banned framework-wide; use web-first assertions or wait utilities.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='waitForTimeout']",
          message: 'Fixed sleeps are not allowed. Use web-first assertions or condition-based waits.',
        },
      ],
    },
  },
  {
    // CLI scripts and the demo app legitimately write to the console.
    files: ['scripts/**/*.ts', 'demo-app/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Playwright fixtures use an empty-object destructuring pattern by design.
    files: ['src/core/fixtures/**/*.ts', 'tests/**/*.ts'],
    rules: { 'no-empty-pattern': 'off' },
  },
  {
    // Async test doubles (fake fetchers, handlers) legitimately have no `await`.
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
