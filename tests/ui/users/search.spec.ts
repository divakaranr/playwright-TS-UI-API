import { test, expect, Tags } from '../../fixtures/framework.fixture.js';

test.describe('Search', { tag: [Tags.ui] }, () => {
  test.use({ role: 'viewer' });

  test(
    'finds a user by unique e-mail and opens the profile',
    { tag: [Tags.regression] },
    async ({ page, userService, testData, searchPage, userDetailPage }) => {
      const user = await userService.create(testData.users.withRole('editor'));
      await searchPage.navigate();

      await searchPage.search(user.email);

      await searchPage.expectResultCount(1);
      await searchPage.openResult(`${user.firstName} ${user.lastName}`);
      await expect(page).toHaveURL(new RegExp(`/users/${user.id}$`));
      await userDetailPage.expectDetails({
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        role: 'editor',
      });
    },
  );

  test(
    'a term with no matches shows zero results',
    { tag: [Tags.regression, Tags.negative] },
    async ({ searchPage }) => {
      await searchPage.navigate();

      await searchPage.search(`no-such-user-${Date.now()}`);

      await searchPage.expectResultCount(0);
    },
  );
});
