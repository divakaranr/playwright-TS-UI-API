# UI automation

## Page Object Model

```text
BasePage (navigate, waitUntilLoaded, click/fill/select/check/getText, expectVisible/Enabled,
          waitForUrl, handleDialog, frame, openInNewTab, download, upload, screenshot)
  ├── LoginPage            /login
  ├── DashboardPage        /dashboard   (header, navigation, announcement modal, help iframe, new tab)
  ├── UserManagementPage   /users       (filter, table rows, edit modal, confirm dialog, CSV export/import)
  ├── UserDetailPage       /users/:id
  ├── SearchPage           /search
  └── RegistrationPage     /register    (select, checkbox, validation errors)
Components: HeaderComponent · NavigationComponent · ModalComponent (generic, by dialog title)
Helpers:    ElementActions (contextual errors) · browser.helpers (dialogs, frames, tabs, downloads, uploads)
```

`BasePage` is intentionally thin; it delegates to helpers so the same capabilities are reusable from components
or tests. Application behaviour lives in concrete pages; reusable widgets live in components scoped to a root
locator.

## Locator strategy

1. `getByRole(role, { name })` – mirrors how users and assistive tech perceive the page.
2. `getByLabel` / `getByPlaceholder` for form fields.
3. `getByTestId` when no stable accessible name exists (`testIdAttribute: data-testid`).
4. CSS only as a last resort for non-semantic hooks (e.g. a status element by id); XPath never.

`TestMaintenanceService.audit()` flags XPath, positional selectors, generated class names, `force: true` and hard
waits; the framework's own page objects are checked by a unit test.

**APPLICATION-SPECIFIC**: all labels, roles and test ids in `src/ui` reflect the bundled demo app. Adapt the
constructors of each page object to your application; keep the public method names so specs stay unchanged.

## Waiting & errors

- Actions auto-wait for actionability; assertions are web-first (`await expect(locator).toBeVisible()`).
- `ElementActions` wraps failures in `UiActionError` with action, target locator and URL, preserving the original
  error as `cause` – nothing is swallowed.

## Browser features (all covered by tests in `tests/ui`)

| Feature                     | API                                     | Example test                   |
| --------------------------- | --------------------------------------- | ------------------------------ |
| JS dialogs (confirm)        | `handleDialog(action, { accept })`      | delete user – cancel / confirm |
| iframes                     | `frame(page.getByTitle('Help widget'))` | help widget                    |
| New tab                     | `openInNewTab(action)`                  | release notes                  |
| Downloads                   | `download(action)`                      | CSV export                     |
| Uploads (path or in-memory) | `upload(input, file)`                   | CSV import                     |
| Selects / checkboxes        | `selectOption`, `check`/`uncheck`       | registration                   |
| Modals                      | `ModalComponent`                        | announcement, edit user        |

## Authentication in UI tests

The `setup` project (`tests/fixtures/auth.setup.ts`) logs in through the real login page once per role and saves
`.auth/<env>/<role>.json`. Tests opt in with `test.use({ role: 'admin' })` and still get an isolated context.
Tests that verify login itself do not use a role. `STORAGE_STATE_MAX_AGE_MIN` lets local runs reuse recent
sessions.

## Demo application

`npm run demo:start` → <http://localhost:4000>. Accounts: `admin@demo.local` / `Admin#12345` (admin),
`viewer@demo.local` / `Viewer#12345` (viewer). Pages: login, dashboard, users, user detail, search, register,
release notes. Playwright starts it automatically for `TEST_ENV=local`.
