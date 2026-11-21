import { apiErrorSchema, userSchema } from '../../../src/api/schemas/index.js';
import { test, expect, Tags } from '../../fixtures/framework.fixture.js';

/** Role-based access control matrix for the /users resource. */
test.describe('Authorization (RBAC)', { tag: [Tags.api, Tags.regression] }, () => {
  test('viewer can read users', async ({ apiAs, userService, testData }) => {
    const user = await userService.create(testData.users.build());

    const response = await apiAs('viewer').getUser(user.id);

    await expect(response).toHaveStatus(200);
    await expect(response).toMatchSchema(userSchema);
  });

  test(
    'viewer cannot create, update or delete users',
    { tag: [Tags.negative] },
    async ({ apiAs, userApi, userService, testData }) => {
      const viewer = apiAs('viewer');
      const user = await userService.create(testData.users.build());

      const attempts = {
        create: await viewer.createUser(testData.users.build()),
        update: await viewer.updateUser(user.id, { role: 'admin' }),
        replace: await viewer.replaceUser(user.id, testData.users.build()),
        delete: await viewer.deleteUser(user.id),
      };

      for (const [action, response] of Object.entries(attempts)) {
        await expect(response, `viewer ${action}`).toHaveStatus(403);
        expect((await response.parse(apiErrorSchema)).error.code).toBe('FORBIDDEN');
      }
      // Side-effect check: nothing changed.
      const unchanged = await (await userApi.getUser(user.id)).parse(userSchema);
      expect(unchanged).toEqual(user);
    },
  );

  test('admin can perform every operation', async ({ userApi, userService, testData }) => {
    const created = await userApi.createUser(testData.users.build());
    await expect(created).toHaveStatus(201);
    const user = await created.parse(userSchema);
    userService.trackForCleanup(user.id, user.email); // safety net if a later step fails (404 is tolerated)

    await expect(await userApi.updateUser(user.id, { role: 'editor' })).toHaveStatus(200);
    await expect(await userApi.deleteUser(user.id)).toHaveStatus(204);
  });

  test('built-in accounts are protected from deletion', { tag: [Tags.negative] }, async ({ userApi }) => {
    const response = await userApi.deleteUser('1');

    await expect(response).toHaveStatus(409);
  });
});
