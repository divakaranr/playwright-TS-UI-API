import { test, expect, Tags } from '../../fixtures/framework.fixture.js';

test.describe('Dashboard', { tag: [Tags.ui] }, () => {
  test.use({ role: 'admin' });

  test.beforeEach(async ({ dashboardPage }) => {
    await dashboardPage.navigate();
  });

  test(
    'shows personalised welcome and statistics',
    { tag: [Tags.smoke, Tags.mobile] },
    async ({ dashboardPage }) => {
      await expect(dashboardPage.welcomeMessage).toHaveText('Welcome, Ada Admin');
      expect(await dashboardPage.totalUsers()).toBeGreaterThanOrEqual(2);
    },
  );

  test('announcement modal opens and closes', { tag: [Tags.regression] }, async ({ dashboardPage }) => {
    await dashboardPage.openAnnouncement();
    await expect(dashboardPage.announcement.root).toContainText('Scheduled maintenance');

    await dashboardPage.acknowledgeAnnouncement();
  });

  test('help widget inside an iframe is usable', { tag: [Tags.regression] }, async ({ dashboardPage }) => {
    expect(await dashboardPage.contactSupport()).toBe('Support request sent');
  });

  test('release notes open in a new tab', { tag: [Tags.regression] }, async ({ dashboardPage }) => {
    const notes = await dashboardPage.openReleaseNotes();

    await expect(notes).toHaveURL(/\/release-notes$/);
    await expect(notes.getByRole('heading', { name: 'Release Notes' })).toBeVisible();
    await notes.close();
  });

  test('primary navigation reaches each section', { tag: [Tags.sanity] }, async ({ page, dashboardPage }) => {
    await dashboardPage.navigation.goTo('Users');
    await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible();

    await dashboardPage.navigation.goTo('Search');
    await expect(page.getByRole('heading', { name: 'Search', level: 1 })).toBeVisible();

    await dashboardPage.navigation.goTo('Dashboard');
    await dashboardPage.waitUntilLoaded();
  });
});
