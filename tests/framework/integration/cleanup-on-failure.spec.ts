import { CleanupRegistry } from '../../../src/data/cleanup.registry.js';
import { test, expect } from '../../fixtures/framework.fixture.js';

/**
 * Proves the cleanup contract: data registered for cleanup is removed even when
 * the test body fails. Uses an in-memory "resource store" so it needs no backend.
 */
const store = new Set<string>();

test.describe.serial('cleanup after failure', () => {
  test('a failing test still runs its registered cleanup', async ({ cleanup }) => {
    test.fail(true, 'this test fails on purpose');
    store.add('resource-1');
    cleanup.register('remove resource-1', async () => void store.delete('resource-1'));

    expect(store.has('resource-1')).toBe(true);
    throw new Error('simulated failure after creating test data');
  });

  test('the resource from the failed test was cleaned up', () => {
    expect(store.has('resource-1')).toBe(false);
  });

  test('cleanup failures are surfaced rather than swallowed', async () => {
    const registry = new CleanupRegistry();
    registry.register('flaky delete', () => Promise.reject(new Error('404?')));
    await expect(registry.runAll()).rejects.toThrow('flaky delete: 404?');
  });
});
