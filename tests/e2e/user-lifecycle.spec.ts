import { userSchema } from '../../src/api/schemas/index.js';
import { test, expect, Tags } from '../fixtures/framework.fixture.js';

/**
 * Hybrid business workflow (UI + API):
 *   API setup -> UI login -> UI search & verify -> UI update -> API verify -> API cleanup.
 *
 * API is used for fast, reliable setup and verification; the UI is used for the
 * behaviour under test (login, search, edit). Cleanup is registered at creation
 * time, so it runs even if any step fails.
 */
test.describe('User lifecycle', { tag: [Tags.e2e, Tags.critical, Tags.regression] }, () => {
  test('admin finds, edits and verifies a user across UI and API', async ({
    userService,
    userApi,
    testData,
    credentials,
    loginPage,
    dashboardPage,
    searchPage,
    userDetailPage,
    userManagementPage,
    testContext,
    logger,
  }) => {
    const seed = testData.users.withRole('viewer');
    const user = await test.step('1. create user via API', async () => {
      const created = await userService.create(seed);
      logger.info({ userId: created.id, correlationId: testContext.correlationId }, 'test user created');
      return created;
    });
    const fullName = `${user.firstName} ${user.lastName}`;

    await test.step('2. log in through the UI', async () => {
      await loginPage.navigate();
      await loginPage.login(credentials('admin'));
      await dashboardPage.waitUntilLoaded();
    });

    await test.step('3. search for the user and validate details', async () => {
      await dashboardPage.navigation.goTo('Search');
      await searchPage.search(user.email);
      await searchPage.expectResultCount(1);
      await searchPage.openResult(fullName);
      await userDetailPage.expectDetails({
        name: fullName,
        email: user.email,
        role: 'viewer',
        status: 'active',
      });
    });

    const changes = { lastName: `${user.lastName}-Updated`, role: 'editor', status: 'inactive' } as const;
    await test.step('4. update the user through the UI', async () => {
      await userDetailPage.page.getByRole('link', { name: 'Back to users' }).click();
      await userManagementPage.filter(user.email);
      await userManagementPage.editUser(fullName, changes);
      await userManagementPage.expectUpdateConfirmed();
      expect(await userManagementPage.readRow(user.email)).toEqual({
        name: `${user.firstName} ${changes.lastName}`,
        email: user.email,
        role: changes.role,
        status: changes.status,
      });
    });

    await test.step('5. verify the update through the API', async () => {
      const response = await userApi.getUser(user.id);
      await expect(response).toHaveStatus(200);
      const persisted = await response.parse(userSchema);
      expect(persisted).toMatchObject({
        ...changes,
        id: user.id,
        email: user.email,
        firstName: user.firstName,
      });
      expect(Date.parse(persisted.updatedAt)).toBeGreaterThan(Date.parse(user.updatedAt));
    });

    await test.step('6. delete the user through the API', async () => {
      await expect(await userApi.deleteUser(user.id)).toHaveStatus(204);
      await expect(await userApi.getUser(user.id)).toHaveStatus(404);
    });
  });
});
