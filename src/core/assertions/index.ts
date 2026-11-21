import { expect as baseExpect } from '@playwright/test';

import { apiMatchers } from '../../api/assertions/api-matchers.js';

/**
 * The framework's `expect`: Playwright's web-first assertions extended with
 * API response matchers (toHaveStatus, toMatchSchema, toRespondWithin, toHaveHeader).
 */
export const expect = baseExpect.extend(apiMatchers);
