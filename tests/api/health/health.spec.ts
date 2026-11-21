import { healthSchema } from '../../../src/api/schemas/index.js';
import { test, expect, Tags } from '../../fixtures/framework.fixture.js';

/**
 * Read-only health checks. Tagged @prod-safe: the only tests permitted against
 * production (npm run test:prod-health).
 */
test.describe('Health', { tag: [Tags.api, Tags.prodSafe, Tags.smoke] }, () => {
  test('service reports healthy with a semantic version', async ({ apiClient, config }) => {
    const response = await apiClient.get('/health');

    await expect(response).toHaveStatus(200);
    await expect(response).toMatchSchema(healthSchema);
    await expect(response).toRespondWithin(config.environment.api.responseTimeThresholdMs);
  });
});
