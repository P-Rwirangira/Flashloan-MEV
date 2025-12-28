/**
 * Retry Utilities
 *
 * Retry logic with exponential backoff and jitter.
 */

import { logger } from './logger';

// Retry options
export interface RetryOptions {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly exponentialBase: number;
  readonly jitter: boolean;
}

// Default retry options
export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  exponentialBase: 2,
  jitter: true,
};

// Retry function with exponential backoff
export async function retry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === opts.maxRetries) {
        logger.error(`Retry failed after ${opts.maxRetries} attempts:`, lastError);
        throw lastError;
      }

      const delay = calculateDelay(attempt, opts);
      logger.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms:`, lastError.message);

      await sleep(delay);
    }
  }

  throw lastError!;
}

// Calculate delay with exponential backoff and optional jitter
function calculateDelay(attempt: number, options: RetryOptions): number {
  const exponentialDelay = options.baseDelayMs * Math.pow(options.exponentialBase, attempt);
  const cappedDelay = Math.min(exponentialDelay, options.maxDelayMs);

  if (!options.jitter) {
    return cappedDelay;
  }

  // Add jitter (±25% of the delay)
  const jitterRange = cappedDelay * 0.25;
  const jitter = (Math.random() - 0.5) * 2 * jitterRange;

  return Math.max(0, cappedDelay + jitter);
}

// Sleep utility
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
