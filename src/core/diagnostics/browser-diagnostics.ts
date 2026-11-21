import type { BrowserContext } from '@playwright/test';

import { maskSensitiveText, truncate } from '../../utils/sanitizer.js';

export interface BrowserDiagnosticsSnapshot {
  consoleErrors: Array<{ text: string; location?: string; timestamp: string }>;
  pageErrors: Array<{ message: string; stack?: string; timestamp: string }>;
  failedRequests: Array<{
    method: string;
    url: string;
    status?: number;
    failure?: string;
    timestamp: string;
  }>;
}

const LIMIT = 100;

/**
 * Collects browser-side evidence for failure diagnostics: console errors,
 * uncaught page errors, failed network requests and HTTP >= 400 responses.
 * Attached at the context level so pages opened in new tabs are covered too.
 */
export class BrowserDiagnostics {
  private readonly data: BrowserDiagnosticsSnapshot = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };

  attach(context: BrowserContext): void {
    context.on('console', (message) => {
      if (message.type() !== 'error') return;
      const { url, lineNumber } = message.location();
      this.push(this.data.consoleErrors, {
        text: truncate(maskSensitiveText(message.text()), 2000),
        location: url ? `${url}:${lineNumber}` : undefined,
        timestamp: new Date().toISOString(),
      });
    });
    context.on('weberror', (webError) => {
      const error = webError.error();
      this.push(this.data.pageErrors, {
        message: maskSensitiveText(error.message),
        stack: error.stack ? truncate(maskSensitiveText(error.stack), 4000) : undefined,
        timestamp: new Date().toISOString(),
      });
    });
    context.on('requestfailed', (request) => {
      this.push(this.data.failedRequests, {
        method: request.method(),
        url: maskSensitiveText(request.url()),
        failure: request.failure()?.errorText,
        timestamp: new Date().toISOString(),
      });
    });
    context.on('response', (response) => {
      if (response.status() < 400) return;
      this.push(this.data.failedRequests, {
        method: response.request().method(),
        url: maskSensitiveText(response.url()),
        status: response.status(),
        timestamp: new Date().toISOString(),
      });
    });
  }

  snapshot(): BrowserDiagnosticsSnapshot {
    return structuredClone(this.data);
  }

  get isEmpty(): boolean {
    return (
      this.data.consoleErrors.length === 0 &&
      this.data.pageErrors.length === 0 &&
      this.data.failedRequests.length === 0
    );
  }

  private push<T>(list: T[], item: T): void {
    list.push(item);
    if (list.length > LIMIT) list.shift();
  }
}
