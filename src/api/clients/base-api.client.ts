import type { APIRequestContext, APIResponse } from '@playwright/test';

import { assertWriteAllowed, type FrameworkConfig } from '../../config/index.js';
import type { ApiCallRecorder } from '../../core/diagnostics/api-call.recorder.js';
import { ApiRequestError, EnvironmentPolicyError, errorMessage } from '../../core/exceptions/index.js';
import type { Logger } from '../../utils/logger.js';
import { correlationId as newCorrelationId } from '../../utils/random.util.js';
import { NoAuthProvider, type AuthProvider } from '../auth/auth-provider.js';
import { ApiResponse } from './api-response.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface ApiClientOptions {
  /** API base URL, e.g. https://api-qa.example.com or http://localhost:4000/api */
  baseUrl: string;
  config: FrameworkConfig;
  auth?: AuthProvider;
  logger?: Logger;
  recorder?: ApiCallRecorder;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
}

export interface RequestOptions {
  params?: QueryParams;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Override the client's auth provider for one call (e.g. negative auth tests). */
  auth?: AuthProvider;
  /** Use a specific correlation id (otherwise one is generated). */
  correlationId?: string;
}

/**
 * Reusable API client built on Playwright's APIRequestContext.
 *
 * Responsibilities: URL building, auth headers, correlation ids, timeouts,
 * environment write-policy enforcement, structured logging and diagnostics
 * recording. It never throws on HTTP error statuses – status handling belongs
 * to the test (via `expect(response).toHaveStatus()`), so negative tests stay simple.
 * Transport failures (DNS, connection refused, timeout) raise ApiRequestError.
 */
export class BaseApiClient {
  constructor(
    protected readonly request: APIRequestContext,
    protected readonly options: ApiClientOptions,
  ) {}

  /** Returns a copy of this client using a different auth provider. */
  withAuth(auth: AuthProvider): this {
    const Ctor = this.constructor as new (request: APIRequestContext, options: ApiClientOptions) => this;
    return new Ctor(this.request, { ...this.options, auth });
  }

  get(endpoint: string, options?: RequestOptions): Promise<ApiResponse> {
    return this.send('GET', endpoint, undefined, options);
  }

  post(endpoint: string, data?: unknown, options?: RequestOptions): Promise<ApiResponse> {
    return this.send('POST', endpoint, data, options);
  }

  put(endpoint: string, data?: unknown, options?: RequestOptions): Promise<ApiResponse> {
    return this.send('PUT', endpoint, data, options);
  }

  patch(endpoint: string, data?: unknown, options?: RequestOptions): Promise<ApiResponse> {
    return this.send('PATCH', endpoint, data, options);
  }

  delete(endpoint: string, options?: RequestOptions): Promise<ApiResponse> {
    return this.send('DELETE', endpoint, undefined, options);
  }

  /** Builds an absolute URL. Endpoints are always resolved relative to the API base path. */
  buildUrl(endpoint: string): URL {
    const base = new URL(
      this.options.baseUrl.endsWith('/') ? this.options.baseUrl : `${this.options.baseUrl}/`,
    );
    if (/^[a-z][a-z0-9+.-]*:/i.test(endpoint)) {
      const absolute = new URL(endpoint);
      if (absolute.origin !== base.origin) {
        throw new ApiRequestError(
          `Refusing cross-origin request to ${absolute.origin} (API base is ${base.origin})`,
        );
      }
      return absolute;
    }
    return new URL(endpoint.replace(/^\/+/, ''), base);
  }

  /** Sends a request with any method (used for HEAD/OPTIONS and custom verbs). */
  async send(
    method: HttpMethod,
    endpoint: string,
    data: unknown,
    options: RequestOptions = {},
  ): Promise<ApiResponse> {
    const url = this.buildUrl(endpoint);
    const basePath = new URL(this.options.baseUrl).pathname.replace(/\/$/, '');
    const relativePath = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length) || '/'
      : url.pathname;

    // Environment safety: throws before any network traffic for blocked writes.
    assertWriteAllowed(this.options.config, method, relativePath);

    const correlationId = options.correlationId ?? newCorrelationId();
    const auth = options.auth ?? this.options.auth ?? new NoAuthProvider();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Correlation-Id': correlationId,
      ...this.options.defaultHeaders,
      ...(await auth.headers()),
      ...options.headers,
    };
    const params = Object.fromEntries(
      Object.entries(options.params ?? {})
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
    const timeout =
      options.timeoutMs ?? this.options.timeoutMs ?? this.options.config.environment.timeouts.apiMs;
    const started = performance.now();
    const logContext = { method, url: url.toString(), correlationId, auth: auth.scheme };

    let raw: APIResponse;
    try {
      raw = await this.request.fetch(url.toString(), {
        method,
        headers,
        params,
        timeout,
        failOnStatusCode: false,
        ...(data !== undefined ? { data } : {}),
      });
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      this.options.recorder?.record({
        timestamp: new Date().toISOString(),
        method,
        url: url.toString(),
        durationMs,
        correlationId,
        requestHeaders: headers,
        requestBody: data,
        error: errorMessage(error),
      });
      this.options.logger?.error({ ...logContext, durationMs, err: error }, 'API request failed (transport)');
      if (error instanceof EnvironmentPolicyError) throw error;
      throw new ApiRequestError(`${method} ${url.toString()} failed: ${errorMessage(error).split('\n')[0]}`, {
        cause: error,
        details: { ...logContext, durationMs },
      });
    }

    const durationMs = Math.round(performance.now() - started);
    const status = raw.status();
    if (this.options.recorder) {
      this.options.recorder.record({
        timestamp: new Date().toISOString(),
        method,
        url: url.toString(),
        status,
        durationMs,
        correlationId,
        requestHeaders: headers,
        requestBody: data,
        responseHeaders: raw.headers(),
        responseBody: await raw.text().catch(() => '<unreadable body>'),
      });
    }
    const level = status >= 500 ? 'warn' : 'debug';
    this.options.logger?.[level](
      { ...logContext, status, durationMs },
      `API ${method} ${url.pathname} -> ${status}`,
    );
    return new ApiResponse(raw, { method, url: url.toString(), durationMs, correlationId });
  }
}
