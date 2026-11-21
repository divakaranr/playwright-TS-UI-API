import { apiErrorSchema, userSchema } from '../../../src/api/schemas/index.js';
import { getConfig } from '../../../src/config/index.js';
import { TestDataService } from '../../../src/data/fixtures/test-data.service.js';
import { userValidationDataSchema } from '../../../src/data/schemas/test-data.schema.js';
import { test, expect, Tags } from '../../fixtures/framework.fixture.js';

const validation = new TestDataService(getConfig().environment.name).load(
  'user-validation',
  userValidationDataSchema,
);

test.describe('Users API – validation', { tag: [Tags.api, Tags.negative, Tags.regression] }, () => {
  test('missing mandatory fields are reported individually', async ({ userApi }) => {
    const response = await userApi.createUser({ firstName: 'Only' });

    await expect(response).toHaveStatus(400);
    const body = await response.parse(apiErrorSchema);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details?.map((d) => d.field).sort()).toEqual(['email', 'lastName', 'role']);
  });

  // Data-driven from test-data/<env|common>/user-validation.json
  for (const scenario of validation.invalidPayloads) {
    test(`invalid payload is rejected: ${scenario.name}`, async ({ userApi }) => {
      const response = await userApi.createUser(scenario.payload);

      await expect(response).toHaveStatus(scenario.expectedStatus);
      const body = await response.parse(apiErrorSchema);
      expect(body.error.details?.map((d) => d.field)).toEqual(
        expect.arrayContaining(scenario.expectedFields),
      );
    });
  }

  test('malformed JSON is rejected', async ({ userApi }) => {
    // A Buffer is sent verbatim; a string would be JSON-encoded by Playwright.
    const response = await userApi.post('/users', Buffer.from('{"firstName": "broken"'), {
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(response).toHaveStatus(400);
    expect((await response.parse(apiErrorSchema)).error.code).toBe('MALFORMED_JSON');
  });

  test('duplicate e-mail is a conflict', async ({ userApi, userService, testData }) => {
    const existing = await userService.create(testData.users.build());

    const response = await userApi.createUser(testData.users.build({ email: existing.email.toUpperCase() }));

    await expect(response).toHaveStatus(409);
    expect((await response.parse(apiErrorSchema)).error.code).toBe('EMAIL_CONFLICT');
  });

  test('PATCH with an empty body is rejected', async ({ userApi, userService, testData }) => {
    const user = await userService.create(testData.users.build());

    await expect(await userApi.updateUser(user.id, {})).toHaveStatus(400);
  });

  test('unknown endpoint returns a JSON 404', async ({ userApi }) => {
    const response = await userApi.get('/no-such-resource');

    await expect(response).toHaveStatus(404);
    await expect(response).toMatchSchema(apiErrorSchema);
  });

  test('unknown user id returns 404', async ({ userApi }) => {
    await expect(await userApi.getUser('999999999')).toHaveStatus(404);
  });

  test.describe('boundary values', () => {
    const max = validation.boundaries.nameMaxLength;

    test(`name of exactly ${max} characters is accepted`, async ({ userApi, userService, testData }) => {
      const response = await userApi.createUser(testData.users.build({ firstName: 'A'.repeat(max) }));

      await expect(response).toHaveStatus(201);
      const user = await response.parse(userSchema);
      userService.trackForCleanup(user.id, user.email);
      expect(user.firstName).toHaveLength(max);
    });

    test(`name of ${max + 1} characters is rejected`, async ({ userApi, testData }) => {
      const payload = testData.userBuilder().buildUnchecked((data) => (data.firstName = 'A'.repeat(max + 1)));

      const response = await userApi.createUser(payload);

      await expect(response).toHaveStatus(400);
      expect((await response.parse(apiErrorSchema)).error.details?.[0]?.field).toBe('firstName');
    });

    const pageSizeMax = validation.boundaries.pageSizeMax;
    for (const [pageSize, status] of [
      [1, 200],
      [pageSizeMax, 200],
      [pageSizeMax + 1, 400],
      [0, 400],
      [-1, 400],
    ] as const) {
      test(`pageSize=${pageSize} returns ${status}`, async ({ userApi }) => {
        await expect(await userApi.listUsers({ pageSize })).toHaveStatus(status);
      });
    }
  });
});
