import { errorMessage } from '../core/exceptions/index.js';
import type { Logger } from '../utils/logger.js';

interface CleanupTask {
  description: string;
  run: () => Promise<void>;
}

/**
 * Test-scoped LIFO registry of cleanup actions. Tasks are registered at the moment
 * data is created, so cleanup happens even if the test fails halfway. Every task
 * runs even if an earlier one fails; failures are aggregated and re-thrown so
 * leaked data is visible in the report rather than silently ignored.
 */
export class CleanupRegistry {
  private readonly tasks: CleanupTask[] = [];

  constructor(private readonly logger?: Logger) {}

  register(description: string, run: () => Promise<void>): void {
    this.tasks.push({ description, run });
  }

  get pending(): number {
    return this.tasks.length;
  }

  async runAll(): Promise<void> {
    const failures: string[] = [];
    while (this.tasks.length > 0) {
      const task = this.tasks.pop()!;
      try {
        await task.run();
        this.logger?.debug({ cleanup: task.description }, 'cleanup completed');
      } catch (error) {
        failures.push(`${task.description}: ${errorMessage(error)}`);
        this.logger?.error({ cleanup: task.description, err: error }, 'cleanup failed');
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Test data cleanup failed for ${failures.length} item(s):\n - ${failures.join('\n - ')}`,
      );
    }
  }
}
