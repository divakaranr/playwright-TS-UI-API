import { test, expect, Tags } from '../../fixtures/framework.fixture.js';

/**
 * Regression guard: `cleanup` is destructured before `userApi`, which used to let the API
 * request context be disposed before cleanup ran. Cleanup must still delete the user.
 */
let createdId: string | undefined;

test.describe.serial('cleanup teardown order', { tag: [Tags.api, Tags.regression] }, () => {
  test('registers cleanup before the API client is created', async ({ cleanup, userApi, testData }) => {
    const response = await userApi.createUser(testData.users.build());
    await expect(response).toHaveStatus(201);
    createdId = ((await response.json()) as { id: string }).id;
    cleanup.register(`delete user ${createdId}`, async () => {
      await expect(await userApi.deleteUser(createdId!)).toHaveStatus(204);
    });
  });

  test('the user was deleted by cleanup', async ({ userApi }) => {
    await expect(await userApi.getUser(createdId!)).toHaveStatus(404);
  });
});
