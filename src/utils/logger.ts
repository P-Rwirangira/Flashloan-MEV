/**
 * Structured Logging Utility
 *
 * Provides structured logging with different levels and formatting
 * for the Base MEV Platform.
 */

import winston from 'winston';

// Performance tracking interface
export interface PerformanceTracker {
  start(): void;
  end(): number;
  mark(label: string): void;
  getMarks(): { [key: string]: number };
}

// Performance tracker implementation
class SimplePerformanceTracker implements PerformanceTracker {
  private startTime: number | undefined;
  private marks: { [key: string]: number } = {};

  start(): void {
    this.startTime = performance.now();
    this.marks = {};
  }

  end(): number {
    if (this.startTime === undefined) {
      throw new Error('Performance tracker not started');
    }
    const duration = performance.now() - this.startTime;
    this.startTime = undefined;
    return duration;
  }

  mark(label: string): void {
    if (this.startTime === undefined) {
      throw new Error('Performance tracker not started');
    }
    this.marks[label] = performance.now() - this.startTime;
  }

  getMarks(): { [key: string]: number } {
    return { ...this.marks };
  }
}

// Debug mode configuration
export interface DebugConfig {
  enabled: boolean;
  components: string[];
  logLevel: string;
  includeStackTrace: boolean;
  performanceProfiling: boolean;
}

// Get debug configuration from environment
const getDebugConfig = (): DebugConfig => {
  return {
    enabled: process.env['DEBUG'] === 'true' || process.env['NODE_ENV'] === 'development',
    components: process.env['DEBUG_COMPONENTS']?.split(',') || ['*'],
    logLevel: process.env['DEBUG_LOG_LEVEL'] || 'debug',
    includeStackTrace: process.env['DEBUG_STACK_TRACE'] === 'true',
    performanceProfiling: process.env['DEBUG_PERFORMANCE'] === 'true',
  };
};

const debugConfig = getDebugConfig();

// Enhanced logger format for debug mode
const debugFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: debugConfig.includeStackTrace }),
  winston.format.printf(({ timestamp, level, message, component, ...meta }) => {
    const componentStr = component ? `[${component}]` : '';
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level.toUpperCase()} ${componentStr} ${message}${metaStr}`;
  })
);

// Production format
const productionFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Create logger instance
export const logger = winston.createLogger({
  level: debugConfig.enabled ? debugConfig.logLevel : process.env['LOG_LEVEL'] || 'info',
  format: debugConfig.enabled ? debugFormat : productionFormat,
  defaultMeta: { service: 'base-mev-platform' },
  transports: [
    // Write all logs with importance level of `error` or less to `error.log`
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    // Write all logs with importance level of `info` or less to `combined.log`
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// If we're not in production, log to the console with appropriate format
if (process.env['NODE_ENV'] !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: debugConfig.enabled
        ? debugFormat
        : winston.format.combine(winston.format.colorize(), winston.format.simple()),
    })
  );
}

// Enhanced component logger with debug capabilities
export class ComponentLogger {
  private logger: winston.Logger;
  private component: string;
  private performanceTrackers: Map<string, PerformanceTracker> = new Map();

  constructor(component: string) {
    this.component = component;
    this.logger = logger.child({ component });
  }

  // Standard logging methods
  error(message: string, meta?: any): void {
    this.logger.error(message, meta);
  }

  warn(message: string, meta?: any): void {
    this.logger.warn(message, meta);
  }

  info(message: string, meta?: any): void {
    this.logger.info(message, meta);
  }

  debug(message: string, meta?: any): void {
    if (this.shouldLog()) {
      this.logger.debug(message, meta);
    }
  }

  // Performance profiling methods
  startPerformanceTracking(operationId: string): void {
    if (!debugConfig.performanceProfiling) return;

    const tracker = new SimplePerformanceTracker();
    tracker.start();
    this.performanceTrackers.set(operationId, tracker);
    this.debug(`Started performance tracking for operation: ${operationId}`);
  }

  markPerformance(operationId: string, label: string): void {
    if (!debugConfig.performanceProfiling) return;

    const tracker = this.performanceTrackers.get(operationId);
    if (tracker) {
      tracker.mark(label);
      this.debug(`Performance mark '${label}' for operation: ${operationId}`);
    }
  }

  endPerformanceTracking(operationId: string): number | undefined {
    if (!debugConfig.performanceProfiling) return undefined;

    const tracker = this.performanceTrackers.get(operationId);
    if (tracker) {
      const duration = tracker.end();
      const marks = tracker.getMarks();
      this.performanceTrackers.delete(operationId);

      this.info(`Performance tracking completed for operation: ${operationId}`, {
        duration: `${duration.toFixed(2)}ms`,
        marks: Object.entries(marks).map(([label, time]) => `${label}: ${time.toFixed(2)}ms`),
      });

      return duration;
    }
    return undefined;
  }

  // Opportunity-specific logging
  logOpportunityDetected(opportunity: any): void {
    this.info('Opportunity detected', {
      opportunityId: opportunity.id,
      type: opportunity.type,
      expectedProfit: opportunity.expectedProfit?.toString(),
      gasEstimate: opportunity.gasEstimate?.toString(),
    });
  }

  logOpportunityProcessed(opportunity: any, result: any): void {
    this.info('Opportunity processed', {
      opportunityId: opportunity.id,
      success: result.success || result.profitable,
      profit: result.profit?.toString() || result.netProfit?.toString(),
      gasUsed: result.gasUsed?.toString(),
      error: result.error?.message,
    });
  }

  logTransactionSubmitted(txHash: string, relay: string, bribe?: bigint): void {
    this.info('Transaction submitted', {
      txHash,
      relay,
      bribe: bribe?.toString(),
    });
  }

  logTransactionIncluded(txHash: string, blockNumber: number, gasUsed: bigint): void {
    this.info('Transaction included', {
      txHash,
      blockNumber,
      gasUsed: gasUsed.toString(),
    });
  }

  // Circuit breaker logging
  logCircuitBreakerStateChange(oldState: string, newState: string, reason?: string): void {
    this.warn('Circuit breaker state changed', {
      oldState,
      newState,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  // Pool monitoring logging
  logPoolUpdate(poolAddress: string, reserves: any, blockNumber: number): void {
    this.debug('Pool state updated', {
      poolAddress,
      reserves: typeof reserves === 'object' ? JSON.stringify(reserves) : reserves,
      blockNumber,
    });
  }

  // Error logging with context
  logError(error: Error, context?: any): void {
    this.error('Error occurred', {
      message: error.message,
      stack: debugConfig.includeStackTrace ? error.stack : undefined,
      context,
    });
  }

  private shouldLog(): boolean {
    if (!debugConfig.enabled) return false;
    if (debugConfig.components.includes('*')) return true;
    return debugConfig.components.includes(this.component);
  }
}

// Create component logger factory
export const createComponentLogger = (component: string): ComponentLogger => {
  return new ComponentLogger(component);
};

// Export debug utilities
export const debugUtils = {
  isDebugEnabled: () => debugConfig.enabled,
  getDebugConfig: () => ({ ...debugConfig }),
  createPerformanceTracker: () => new SimplePerformanceTracker(),
};

// Global performance tracking for critical operations
export const globalPerformanceTracker = {
  trackOperation: async <T>(operationName: string, operation: () => Promise<T>): Promise<T> => {
    if (!debugConfig.performanceProfiling) {
      return operation();
    }

    const tracker = new SimplePerformanceTracker();
    tracker.start();

    try {
      const result = await operation();
      const duration = tracker.end();

      logger.info(`Global operation completed: ${operationName}`, {
        duration: `${duration.toFixed(2)}ms`,
        success: true,
      });

      return result;
    } catch (error) {
      const duration = tracker.end();

      logger.error(`Global operation failed: ${operationName}`, {
        duration: `${duration.toFixed(2)}ms`,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  },
};
