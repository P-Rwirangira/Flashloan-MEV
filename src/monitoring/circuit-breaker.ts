/**
 * Circuit Breaker
 *
 * Implements circuit breaker pattern to prevent cascading failures
 * and provide automatic recovery mechanisms
 */

import { EventEmitter } from 'events';

/**
 * Circuit breaker states
 */
export enum CircuitBreakerState {
  CLOSED = 'closed', // Normal operation
  OPEN = 'open', // Blocking requests
  HALF_OPEN = 'half_open', // Testing recovery
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  failureThreshold: number; // Number of failures to trigger open state
  recoveryTimeout: number; // Time to wait before trying half-open (ms)
  successThreshold: number; // Number of successes needed to close from half-open
  monitoringWindow: number; // Time window for failure counting (ms)
  minimumRequests: number; // Minimum requests before considering failure rate
}

/**
 * Circuit breaker metrics
 */
export interface CircuitBreakerMetrics {
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  totalRequests: number;
  failureRate: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  stateChangedTime: number;
  timeInCurrentState: number;
}

/**
 * Request result
 */
export interface RequestResult {
  success: boolean;
  error?: Error;
  duration: number;
  timestamp: number;
}

/**
 * Circuit Breaker class
 */
export class CircuitBreaker extends EventEmitter {
  private readonly config: CircuitBreakerConfig;
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;

  private failureCount = 0;
  private successCount = 0;
  private totalRequests = 0;
  private lastFailureTime = 0;
  private lastSuccessTime = 0;
  private stateChangedTime = Date.now();

  private readonly requestHistory: RequestResult[] = [];
  private recoveryTimer: NodeJS.Timeout | undefined;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    super();

    this.config = {
      failureThreshold: 5,
      recoveryTimeout: 60000, // 1 minute
      successThreshold: 3,
      monitoringWindow: 300000, // 5 minutes
      minimumRequests: 10,
      ...config,
    };
  }

  /**
   * Execute a request through the circuit breaker
   */
  async execute<T>(request: () => Promise<T>): Promise<T> {
    if (this.state === CircuitBreakerState.OPEN) {
      const error = new Error('Circuit breaker is OPEN - request blocked');
      this.emit('requestBlocked', { state: this.state, error });
      throw error;
    }

    const startTime = Date.now();
    let result: RequestResult;

    try {
      const response = await request();

      result = {
        success: true,
        duration: Date.now() - startTime,
        timestamp: startTime,
      };

      this.recordSuccess(result);
      return response;
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - startTime,
        timestamp: startTime,
      };

      this.recordFailure(result);
      throw error;
    }
  }

  /**
   * Record successful request
   */
  private recordSuccess(result: RequestResult): void {
    this.successCount++;
    this.totalRequests++;
    this.lastSuccessTime = result.timestamp;

    this.addToHistory(result);
    this.cleanupHistory();

    // Handle state transitions
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      if (this.successCount >= this.config.successThreshold) {
        this.transitionTo(CircuitBreakerState.CLOSED);
      }
    }

    this.emit('requestSuccess', result);
  }

  /**
   * Record failed request
   */
  private recordFailure(result: RequestResult): void {
    this.failureCount++;
    this.totalRequests++;
    this.lastFailureTime = result.timestamp;

    this.addToHistory(result);
    this.cleanupHistory();

    // Handle state transitions
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      // In HALF_OPEN state, any failure should immediately trip to OPEN
      this.transitionTo(CircuitBreakerState.OPEN);
    } else if (this.state === CircuitBreakerState.CLOSED) {
      // In CLOSED state, use threshold-based logic
      const recentFailures = this.getRecentFailureCount();
      const recentRequests = this.getRecentRequestCount();

      if (
        recentRequests >= this.config.minimumRequests &&
        recentFailures >= this.config.failureThreshold
      ) {
        this.transitionTo(CircuitBreakerState.OPEN);
      }
    }

    this.emit('requestFailure', result);
  }

  /**
   * Transition to new state
   */
  private transitionTo(newState: CircuitBreakerState): void {
    const oldState = this.state;
    this.state = newState;
    this.stateChangedTime = Date.now();

    // Reset counters on state change
    if (newState === CircuitBreakerState.CLOSED) {
      this.failureCount = 0;
      this.successCount = 0;
    } else if (newState === CircuitBreakerState.HALF_OPEN) {
      this.successCount = 0;
    }

    // Clear any existing recovery timer
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }

    // Set recovery timer for OPEN state
    if (newState === CircuitBreakerState.OPEN) {
      this.recoveryTimer = setTimeout(() => {
        this.transitionTo(CircuitBreakerState.HALF_OPEN);
      }, this.config.recoveryTimeout);
    }

    this.emit('stateChanged', {
      oldState,
      newState,
      timestamp: this.stateChangedTime,
      metrics: this.getMetrics(),
    });
  }

  /**
   * Add request result to history
   */
  private addToHistory(result: RequestResult): void {
    this.requestHistory.push(result);

    // Keep history size manageable
    if (this.requestHistory.length > 1000) {
      this.requestHistory.splice(0, this.requestHistory.length - 1000);
    }
  }

  /**
   * Clean up old history entries
   */
  private cleanupHistory(): void {
    const cutoff = Date.now() - this.config.monitoringWindow;
    const firstValidIndex = this.requestHistory.findIndex(result => result.timestamp >= cutoff);

    if (firstValidIndex > 0) {
      this.requestHistory.splice(0, firstValidIndex);
    }
  }

  /**
   * Get recent failure count within monitoring window
   */
  private getRecentFailureCount(): number {
    const cutoff = Date.now() - this.config.monitoringWindow;
    return this.requestHistory.filter(result => result.timestamp >= cutoff && !result.success)
      .length;
  }

  /**
   * Get recent request count within monitoring window
   */
  private getRecentRequestCount(): number {
    const cutoff = Date.now() - this.config.monitoringWindow;
    return this.requestHistory.filter(result => result.timestamp >= cutoff).length;
  }

  /**
   * Get current metrics
   */
  getMetrics(): CircuitBreakerMetrics {
    const now = Date.now();
    const recentRequests = this.getRecentRequestCount();
    const recentFailures = this.getRecentFailureCount();
    const failureRate = recentRequests > 0 ? recentFailures / recentRequests : 0;

    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalRequests: this.totalRequests,
      failureRate,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      stateChangedTime: this.stateChangedTime,
      timeInCurrentState: now - this.stateChangedTime,
    };
  }

  /**
   * Get current state
   */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * Check if circuit breaker allows requests
   */
  isRequestAllowed(): boolean {
    return this.state !== CircuitBreakerState.OPEN;
  }

  /**
   * Force state transition (for testing/manual control)
   */
  forceState(state: CircuitBreakerState): void {
    this.transitionTo(state);
    this.emit('stateForced', { state, timestamp: Date.now() });
  }

  /**
   * Reset circuit breaker to initial state
   */
  reset(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }

    this.state = CircuitBreakerState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.totalRequests = 0;
    this.lastFailureTime = 0;
    this.lastSuccessTime = 0;
    this.stateChangedTime = Date.now();
    this.requestHistory.length = 0;

    this.emit('reset', { timestamp: Date.now() });
  }

  /**
   * Get request history for analysis
   */
  getRequestHistory(limit?: number): RequestResult[] {
    const history = [...this.requestHistory];
    return limit ? history.slice(-limit) : history;
  }

  /**
   * Get failure rate over time windows
   */
  getFailureRateOverTime(windowSizes: number[] = [60000, 300000, 900000]): Record<string, number> {
    const now = Date.now();
    const rates: Record<string, number> = {};

    windowSizes.forEach(windowSize => {
      const cutoff = now - windowSize;
      const windowRequests = this.requestHistory.filter(result => result.timestamp >= cutoff);

      const failures = windowRequests.filter(result => !result.success).length;
      const rate = windowRequests.length > 0 ? failures / windowRequests.length : 0;

      const windowLabel = `${windowSize / 1000}s`;
      rates[windowLabel] = rate;
    });

    return rates;
  }

  /**
   * Get average response times
   */
  getAverageResponseTimes(): {
    overall: number;
    successful: number;
    failed: number;
  } {
    if (this.requestHistory.length === 0) {
      return { overall: 0, successful: 0, failed: 0 };
    }

    const successful = this.requestHistory.filter(r => r.success);
    const failed = this.requestHistory.filter(r => !r.success);

    const overallAvg =
      this.requestHistory.reduce((sum, r) => sum + r.duration, 0) / this.requestHistory.length;
    const successfulAvg =
      successful.length > 0
        ? successful.reduce((sum, r) => sum + r.duration, 0) / successful.length
        : 0;
    const failedAvg =
      failed.length > 0 ? failed.reduce((sum, r) => sum + r.duration, 0) / failed.length : 0;

    return {
      overall: overallAvg,
      successful: successfulAvg,
      failed: failedAvg,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<CircuitBreakerConfig>): void {
    Object.assign(this.config, newConfig);
    this.emit('configUpdated', { config: this.config, timestamp: Date.now() });
  }

  /**
   * Get current configuration
   */
  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }

    this.removeAllListeners();
    this.requestHistory.length = 0;
  }
}

/**
 * Circuit Breaker Manager
 * Manages multiple circuit breakers for different services/operations
 */
export class CircuitBreakerManager extends EventEmitter {
  private readonly circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private readonly defaultConfig: CircuitBreakerConfig;

  constructor(defaultConfig?: Partial<CircuitBreakerConfig>) {
    super();

    this.defaultConfig = {
      failureThreshold: 5,
      recoveryTimeout: 60000,
      successThreshold: 3,
      monitoringWindow: 300000,
      minimumRequests: 10,
      ...defaultConfig,
    };
  }

  /**
   * Get or create circuit breaker for a service
   */
  getCircuitBreaker(serviceName: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    let circuitBreaker = this.circuitBreakers.get(serviceName);

    if (!circuitBreaker) {
      const finalConfig = { ...this.defaultConfig, ...config };
      circuitBreaker = new CircuitBreaker(finalConfig);

      // Forward events with service name
      circuitBreaker.on('stateChanged', data => {
        this.emit('stateChanged', { serviceName, ...data });
      });

      circuitBreaker.on('requestBlocked', data => {
        this.emit('requestBlocked', { serviceName, ...data });
      });

      this.circuitBreakers.set(serviceName, circuitBreaker);
      this.emit('circuitBreakerCreated', { serviceName, config: finalConfig });
    }

    return circuitBreaker;
  }

  /**
   * Execute request through named circuit breaker
   */
  async execute<T>(
    serviceName: string,
    request: () => Promise<T>,
    config?: Partial<CircuitBreakerConfig>
  ): Promise<T> {
    const circuitBreaker = this.getCircuitBreaker(serviceName, config);
    return circuitBreaker.execute(request);
  }

  /**
   * Get all circuit breaker metrics
   */
  getAllMetrics(): Record<string, CircuitBreakerMetrics> {
    const metrics: Record<string, CircuitBreakerMetrics> = {};

    this.circuitBreakers.forEach((circuitBreaker, serviceName) => {
      metrics[serviceName] = circuitBreaker.getMetrics();
    });

    return metrics;
  }

  /**
   * Get circuit breaker states summary
   */
  getStatesSummary(): {
    total: number;
    closed: number;
    open: number;
    halfOpen: number;
  } {
    const summary = { total: 0, closed: 0, open: 0, halfOpen: 0 };

    this.circuitBreakers.forEach(circuitBreaker => {
      summary.total++;
      const state = circuitBreaker.getState();

      switch (state) {
        case CircuitBreakerState.CLOSED:
          summary.closed++;
          break;
        case CircuitBreakerState.OPEN:
          summary.open++;
          break;
        case CircuitBreakerState.HALF_OPEN:
          summary.halfOpen++;
          break;
      }
    });

    return summary;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    this.circuitBreakers.forEach((circuitBreaker, serviceName) => {
      circuitBreaker.reset();
      this.emit('circuitBreakerReset', { serviceName });
    });
  }

  /**
   * Remove circuit breaker
   */
  removeCircuitBreaker(serviceName: string): boolean {
    const circuitBreaker = this.circuitBreakers.get(serviceName);
    if (circuitBreaker) {
      circuitBreaker.cleanup();
      this.circuitBreakers.delete(serviceName);
      this.emit('circuitBreakerRemoved', { serviceName });
      return true;
    }
    return false;
  }

  /**
   * Cleanup all resources
   */
  cleanup(): void {
    this.circuitBreakers.forEach(circuitBreaker => {
      circuitBreaker.cleanup();
    });

    this.circuitBreakers.clear();
    this.removeAllListeners();
  }
}

// Circuit breaker utility functions
export const CircuitBreakerUtils = {
  /**
   * Check if circuit breaker state allows requests
   */
  allowsRequests: (state: CircuitBreakerState): boolean => {
    return state === CircuitBreakerState.CLOSED || state === CircuitBreakerState.HALF_OPEN;
  },

  /**
   * Get state display name
   */
  getStateDisplayName: (state: CircuitBreakerState): string => {
    switch (state) {
      case CircuitBreakerState.CLOSED:
        return 'Closed (Normal)';
      case CircuitBreakerState.OPEN:
        return 'Open (Blocking)';
      case CircuitBreakerState.HALF_OPEN:
        return 'Half-Open (Testing)';
      default:
        return 'Unknown State';
    }
  },

  /**
   * Get state priority for monitoring (higher = more critical)
   */
  getStatePriority: (state: CircuitBreakerState): number => {
    switch (state) {
      case CircuitBreakerState.OPEN:
        return 3; // Most critical - blocking requests
      case CircuitBreakerState.HALF_OPEN:
        return 2; // Medium - testing recovery
      case CircuitBreakerState.CLOSED:
        return 1; // Normal operation
      default:
        return 0;
    }
  },

  /**
   * Validate state transition
   */
  isValidTransition: (from: CircuitBreakerState, to: CircuitBreakerState): boolean => {
    switch (from) {
      case CircuitBreakerState.CLOSED:
        return to === CircuitBreakerState.OPEN;
      case CircuitBreakerState.OPEN:
        return to === CircuitBreakerState.HALF_OPEN;
      case CircuitBreakerState.HALF_OPEN:
        return to === CircuitBreakerState.CLOSED || to === CircuitBreakerState.OPEN;
      default:
        return false;
    }
  },

  /**
   * Get recommended action for state
   */
  getRecommendedAction: (state: CircuitBreakerState, metrics: CircuitBreakerMetrics): string => {
    switch (state) {
      case CircuitBreakerState.CLOSED:
        return metrics.failureRate > 0.1
          ? 'Monitor closely - elevated failure rate'
          : 'Normal operation';
      case CircuitBreakerState.OPEN:
        return 'Service degraded - investigate and fix underlying issues';
      case CircuitBreakerState.HALF_OPEN:
        return 'Testing recovery - monitor success rate carefully';
      default:
        return 'Unknown state - manual intervention required';
    }
  },

  /**
   * Format state for logging
   */
  formatStateForLogging: (
    state: CircuitBreakerState,
    serviceName: string,
    timestamp: number
  ): string => {
    const time = new Date(timestamp).toISOString();
    const displayName = CircuitBreakerUtils.getStateDisplayName(state);
    return `[${time}] Circuit Breaker for ${serviceName}: ${displayName}`;
  },
};
