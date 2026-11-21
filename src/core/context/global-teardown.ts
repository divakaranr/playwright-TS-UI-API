import { getLogger } from '../../utils/logger.js';

/** Runs once after all tests. Flushes the log stream and records completion. */
export default function globalTeardown(): void {
  const logger = getLogger();
  logger.info({ finishedAt: new Date().toISOString() }, 'test run finished');
  logger.flush();
}
