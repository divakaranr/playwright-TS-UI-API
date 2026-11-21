import { tokenResponseSchema } from '../../src/api/schemas/index.js';
import { test, expect, Tags } from '../fixtures/framework.fixture.js';

/** Cross-layer integration: behaviour triggered in one layer is verified in the other. */
test.describe('Registration consistency', { tag: [Tags.integration, Tags.regression] }, () => {
  test('a UI registration produces a least-privilege account usable via API', async ({
    registrationPage,
    userService,
    authApi,
    testData,
  }) => {
    const user = testData.users.build();
    const password = testData.users.password();

    await registrationPage.navigate();
    await registrationPage.register({ ...user, password, country: 'Germany', acceptTerms: true });
    await registrationPage.expectSuccess(user.email);

    const persisted = await userService.trackByEmail(user.email);
    expect(persisted, 'registered user must exist in the backend').toMatchObject({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email.toLowerCase(),
      role: 'viewer', // self-registration must never grant elevated roles
      status: 'active',
    });

    const login = await authApi.login(user.email, password);
    await expect(login).toHaveStatus(200);
    await expect(login).toMatchSchema(tokenResponseSchema);
  });

  test(
    'deactivating an account via API blocks UI sign-in',
    { tag: [Tags.negative] },
    async ({ registrationPage, loginPage, userService, userApi, testData }) => {
      const user = testData.users.build();
      const password = testData.users.password();
      await registrationPage.navigate();
      await registrationPage.register({ ...user, password, country: 'India', acceptTerms: true });
      await registrationPage.expectSuccess(user.email);
      const persisted = (await userService.trackByEmail(user.email))!;

      await expect(await userApi.updateUser(persisted.id, { status: 'inactive' })).toHaveStatus(200);

      await loginPage.navigate();
      await loginPage.login({ username: user.email, password });
      await loginPage.expectError('Invalid username or password');
    },
  );
});
