import { test as base, request as playwrightRequest, type APIRequestContext } from '@playwright/test';

import { AuthApiClient } from '../../api/clients/auth-api.client.js';
import { BaseApiClient, type ApiClientOptions } from '../../api/clients/base-api.client.js';
import { UserApiClient } from '../../api/clients/user-api.client.js';
import { UserService } from '../../api/services/user.service.js';
import { AuthService } from '../../auth/auth.service.js';
import { StorageStateManager } from '../../auth/storage-state.manager.js';
import { TokenManager } from '../../auth/token.manager.js';
import {
  getConfig,
  getCredentials,
  isTestAllowedInEnvironment,
  type Credentials,
  type FrameworkConfig,
} from '../../config/index.js';
import { CleanupRegistry } from '../../data/cleanup.registry.js';
import { TestDataService } from '../../data/fixtures/test-data.service.js';
import {
  DashboardPage,
  LoginPage,
  RegistrationPage,
  SearchPage,
  UserDetailPage,
  UserManagementPage,
} from '../../ui/index.js';
import { getLogger, type Logger } from '../../utils/logger.js';
import { redactSensitive } from '../../utils/sanitizer.js';
import { expect } from '../assertions/index.js';
import { createTestContext, type TestContext } from '../context/test-context.js';
import { ApiCallRecorder } from '../diagnostics/api-call.recorder.js';
import { BrowserDiagnostics } from '../diagnostics/browser-diagnostics.js';

type WorkerFixtures = {
  config: FrameworkConfig;
  workerLogger: Logger;
  storageStates: StorageStateManager;
};

type OptionFixtures = {
  /** Role whose stored browser session the test starts with (e.g. test.use({ role: 'admin' })). */
  role: string | undefined;
};

type TestFixtures = {
  testContext: TestContext;
  logger: Logger;
  apiRecorder: ApiCallRecorder;
  browserDiagnostics: BrowserDiagnostics;
  failureDiagnostics: void;
  environmentGuard: void;
  cleanup: CleanupRegistry;
  testData: TestDataService;
  credentials: (role: string) => Credentials;
  apiRequest: APIRequestContext;
  apiClientOptions: ApiClientOptions;
  tokenManager: TokenManager;
  authService: AuthService;
  apiClient: BaseApiClient;
  authApi: AuthApiClient;
  authenticatedApiClient: BaseApiClient;
  userApi: UserApiClient;
  apiAs: (role: string) => UserApiClient;
  userService: UserService;
  loginPage: LoginPage;
  dashboardPage: DashboardPage;
  userManagementPage: UserManagementPage;
  userDetailPage: UserDetailPage;
  searchPage: SearchPage;
  registrationPage: RegistrationPage;
};

/** Role used for API clients that need write access in examples/tests. */
const DEFAULT_API_ROLE = 'admin';

/**
 * Framework fixtures (dependency injection for tests).
 *
 * Scopes:
 *  - worker: validated config, worker logger, storage-state manager (immutable, safe to share)
 *  - test:   everything stateful (API contexts, tokens, cleanup, diagnostics, page objects),
 *            so tests are isolated and parallel-safe.
 *
 * Auto fixtures:
 *  - environmentGuard   skips tests not allowed in read-only environments (prod)
 *  - failureDiagnostics logs test lifecycle and attaches API/browser evidence on failure
 */
export const test = base.extend<TestFixtures & OptionFixtures, WorkerFixtures>({
  // ---- worker scope ---------------------------------------------------------------------
  config: [async ({}, use) => use(getConfig()), { scope: 'worker' }],

  workerLogger: [
    // `env` is already part of the root logger's base fields.
    async ({}, use, workerInfo) =>
      use(getLogger().child({ worker: workerInfo.workerIndex, project: workerInfo.project.name })),
    { scope: 'worker' },
  ],

  storageStates: [
    async ({ config }, use) => use(new StorageStateManager(config.environment.name)),
    { scope: 'worker' },
  ],

  // ---- options -------------------------------------------------------------------------------
  role: [undefined, { option: true }],

  storageState: async ({ role, storageStates, storageState }, use) => {
    if (!role) return use(storageState);
    if (!storageStates.exists(role)) {
      throw new Error(
        `No stored session for role "${role}". Run via a browser project (depends on 'setup') or 'npx playwright test --project=setup'.`,
      );
    }
    await use(storageStates.pathFor(role));
  },

  // ---- context, logging & diagnostics ---------------------------------------------------
  testContext: async ({ config }, use, testInfo) => use(createTestContext(testInfo, config.environment.name)),

  logger: async ({ workerLogger, testContext }, use) =>
    use(
      workerLogger.child({
        testId: testContext.testId,
        test: testContext.title,
        correlationId: testContext.correlationId,
      }),
    ),

  apiRecorder: async ({}, use) => use(new ApiCallRecorder()),

  browserDiagnostics: async ({}, use) => use(new BrowserDiagnostics()),

  context: async ({ context, browserDiagnostics }, use) => {
    browserDiagnostics.attach(context);
    await use(context);
  },

  environmentGuard: [
    async ({ config }, use, testInfo) => {
      testInfo.skip(
        !isTestAllowedInEnvironment(config, testInfo.tags),
        `Environment "${config.environment.name}" is read-only: only @prod-safe tests may run`,
      );
      await use();
    },
    { auto: true },
  ],

  failureDiagnostics: [
    async ({ logger, testContext, apiRecorder, browserDiagnostics }, use, testInfo) => {
      logger.info({ ...testContext }, 'test started');
      await use();
      const failed = testInfo.status !== testInfo.expectedStatus;
      const summary = {
        status: testInfo.status,
        expectedStatus: testInfo.expectedStatus,
        durationMs: testInfo.duration,
        retry: testInfo.retry,
        apiCalls: apiRecorder.size,
      };
      if (failed) {
        // Logged at info: the reporter already surfaces failures on the console; the file log keeps the detail.
        logger.info({ ...summary, errors: testInfo.errors.map((e) => e.message) }, 'test failed');
        const diagnostics = redactSensitive({
          context: testContext,
          summary,
          errors: testInfo.errors.map((e) => ({ message: e.message, stack: e.stack })),
          apiCalls: apiRecorder.all(),
          browser: browserDiagnostics.snapshot(),
        });
        await testInfo.attach('failure-diagnostics.json', {
          body: JSON.stringify(diagnostics, null, 2),
          contentType: 'application/json',
        });
      } else {
        logger.info(summary, 'test finished');
      }
    },
    { auto: true },
  ],

  // ---- data -------------------------------------------------------------------------------
  // Depends on apiRequest so Playwright tears cleanup down *before* the API context is disposed,
  // regardless of the order in which a test destructures its fixtures.
  cleanup: async ({ logger, apiRequest: _apiRequest }, use) => {
    const registry = new CleanupRegistry(logger);
    await use(registry);
    await registry.runAll();
  },

  testData: async ({ config }, use) => use(new TestDataService(config.environment.name)),

  credentials: async ({ config }, use) => use((role: string) => getCredentials(config, role)),

  // ---- API ---------------------------------------------------------------------------------
  apiRequest: async ({ config }, use) => {
    // A dedicated context per test: no cookies/state leak between tests.
    const context = await playwrightRequest.newContext({ timeout: config.environment.timeouts.apiMs });
    await use(context);
    await context.dispose();
  },

  apiClientOptions: async ({ config, logger, apiRecorder }, use) =>
    use({ baseUrl: config.environment.apiBaseUrl, config, logger, recorder: apiRecorder }),

  tokenManager: async ({ logger }, use) => use(new TokenManager({ logger })),

  authApi: async ({ apiRequest, apiClientOptions }, use) =>
    use(new AuthApiClient(apiRequest, apiClientOptions)),

  authService: async ({ config, authApi, tokenManager }, use) =>
    use(new AuthService(config, authApi, tokenManager)),

  apiClient: async ({ apiRequest, apiClientOptions }, use) =>
    use(new BaseApiClient(apiRequest, apiClientOptions)),

  authenticatedApiClient: async ({ apiRequest, apiClientOptions, authService }, use) =>
    use(
      new BaseApiClient(apiRequest, { ...apiClientOptions, auth: authService.bearerFor(DEFAULT_API_ROLE) }),
    ),

  userApi: async ({ apiRequest, apiClientOptions, authService }, use) =>
    use(
      new UserApiClient(apiRequest, { ...apiClientOptions, auth: authService.bearerFor(DEFAULT_API_ROLE) }),
    ),

  apiAs: async ({ apiRequest, apiClientOptions, authService }, use) =>
    use(
      (role: string) =>
        new UserApiClient(apiRequest, { ...apiClientOptions, auth: authService.bearerFor(role) }),
    ),

  userService: async ({ userApi, cleanup }, use) => use(new UserService(userApi, cleanup)),

  // ---- page objects -----------------------------------------------------------------------
  loginPage: async ({ page }, use) => use(new LoginPage(page)),
  dashboardPage: async ({ page }, use) => use(new DashboardPage(page)),
  userManagementPage: async ({ page }, use) => use(new UserManagementPage(page)),
  userDetailPage: async ({ page }, use) => use(new UserDetailPage(page)),
  searchPage: async ({ page }, use) => use(new SearchPage(page)),
  registrationPage: async ({ page }, use) => use(new RegistrationPage(page)),
});

export { expect };
