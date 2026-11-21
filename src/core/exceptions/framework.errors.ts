/**
 * Framework error hierarchy.
 *
 * Every error raised by framework code carries a stable machine-readable `code`
 * so that reporters, MCP tools and AI failure analysis can classify failures
 * without parsing free-text messages. Messages must never contain secrets.
 */
export class FrameworkError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    if (options?.details) this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** Invalid or missing configuration. Raised at startup (fail-fast). */
export class ConfigurationError extends FrameworkError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFIGURATION_ERROR', message, details ? { details } : undefined);
  }
}

/** A write/destructive operation was attempted against a read-only environment. */
export class EnvironmentPolicyError extends FrameworkError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('ENVIRONMENT_POLICY_VIOLATION', message, details ? { details } : undefined);
  }
}

/** Authentication / token acquisition failed. */
export class AuthenticationError extends FrameworkError {
  constructor(message: string, options?: { cause?: unknown; details?: Record<string, unknown> }) {
    super('AUTHENTICATION_ERROR', message, options);
  }
}

/** A transport-level API failure (network, timeout, unexpected exception). */
export class ApiRequestError extends FrameworkError {
  constructor(message: string, options?: { cause?: unknown; details?: Record<string, unknown> }) {
    super('API_REQUEST_ERROR', message, options);
  }
}

/** Runtime data did not match its declared schema. */
export class SchemaValidationError extends FrameworkError {
  readonly issues: readonly string[];

  constructor(subject: string, issues: readonly string[]) {
    super('SCHEMA_VALIDATION_ERROR', `${subject} failed schema validation:\n - ${issues.join('\n - ')}`, {
      details: { subject, issues },
    });
    this.issues = issues;
  }
}

/** A UI interaction failed. Wraps the Playwright error with business context. */
export class UiActionError extends FrameworkError {
  constructor(action: string, context: { url?: string; target?: string }, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message.split('\n')[0] : String(cause);
    super(
      'UI_ACTION_ERROR',
      `UI action failed: ${action}${context.target ? ` [target: ${context.target}]` : ''}${
        context.url ? ` [url: ${context.url}]` : ''
      } -> ${causeMessage}`,
      { cause, details: { action, ...context } },
    );
  }
}

/** Test data could not be loaded, built or cleaned up. */
export class TestDataError extends FrameworkError {
  constructor(message: string, options?: { cause?: unknown; details?: Record<string, unknown> }) {
    super('TEST_DATA_ERROR', message, options);
  }
}

/** An operation exceeded its time budget. */
export class OperationTimeoutError extends FrameworkError {
  constructor(operation: string, timeoutMs: number) {
    super('OPERATION_TIMEOUT', `${operation} timed out after ${timeoutMs}ms`, {
      details: { operation, timeoutMs },
    });
  }
}

export const isFrameworkError = (error: unknown): error is FrameworkError => error instanceof FrameworkError;

/** Normalises any thrown value into a message string without leaking non-error objects. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
