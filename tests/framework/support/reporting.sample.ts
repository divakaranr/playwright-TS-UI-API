/**
 * Sample suite executed by tests/framework/integration/reporting.spec.ts in a
 * nested Playwright run. Not matched by the main projects (no .spec.ts suffix).
 */
import { test, expect } from '../../fixtures/framework.fixture.js';

test('sample passing test', { tag: ['@sample'] }, () => {
  expect(1 + 1).toBe(2);
});

test('sample failing test with secrets in diagnostics', { tag: ['@sample'] }, ({ apiRecorder }) => {
  apiRecorder.record({
    timestamp: new Date().toISOString(),
    method: 'POST',
    url: 'https://api.example.com/auth/login',
    status: 500,
    durationMs: 12,
    correlationId: 'sample-correlation',
    requestHeaders: { Authorization: 'Bearer sample-secret-token' },
    requestBody: { username: 'someone@example.com', password: 'sample-secret-password' },
    responseBody: '{"error":"boom"}',
  });
  expect('actual', 'deliberate failure for reporting verification').toBe('expected');
});

test.skip('sample skipped test', () => undefined);
