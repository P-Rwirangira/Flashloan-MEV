/**
 * Health Check System
 *
 * Provides health check endpoints and system status monitoring
 * for operational monitoring and load balancer integration
 */

import { EventEmitter } from 'events';
import { createComponentLogger } from '../utils/logger';
import { MetricsCollector } from './metrics-collector';
import { CircuitBreaker, CircuitBreakerState } from './circuit-breaker';

export enum HealthStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy',
}

export interface HealthCheckResult {
  status: HealthStatus;
  timestamp: number;
  uptime: number;
  version: string;
  checks: {
    rpcConnection: ComponentHealth;
    circuitBreaker: ComponentHealth;
    memoryUsage: ComponentHealth;
    opportunityDetection: ComponentHealth;
  };
  metrics?: {
    totalOpportunities: number;
    winRate: number;
    totalProfitUSD: number;
    activePhases: string[];
  };
}

export interface ComponentHealth {
  status: HealthStatus;
  message: string;
  lastCheck: number;
  details?: Record<string, any>;
}

export interface HealthCheckOptions {
  metricsCollector: MetricsCollector;
  circuitBreaker: CircuitBreaker;
  checkIntervalMs?: number;
  unhealthyThreshold?: number;
  degradedThreshold?: number;
}

/**
 * Health Check System
 */
export class HealthCheckSystem extends EventEmitter {
  private readonly logger = createComponentLogger('health-check');
  private readonly metricsCollector: MetricsCollector;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly options: Required<
    Omit<HealthCheckOptions, 'metricsCollector' | 'circuitBreaker'>
  >;

  private readonly startTime: number;
  private currentStatus: HealthStatus = HealthStatus.HEALTHY;
  private lastHealthCheck: HealthCheckResult | undefined;
  private checkInterval: NodeJS.Timeout | undefined;

  // Component health tracking
  private componentHealth: Map<string, ComponentHealth> = new Map();

  constructor(options: HealthCheckOptions) {
    super();

    this.metricsCollector = options.metricsCollector;
    this.circuitBreaker = options.circuitBreaker;
    this.startTime = Date.now();

    this.options = {
      checkIntervalMs: options.checkIntervalMs || 30000, // 30 seconds
      unhealthyThreshold: options.unhealthyThreshold || 3,
      degradedThreshold: options.degradedThreshold || 2,
    };

    this.initializeComponentHealth();
    this.startPeriodicChecks();
  }

  /**
   * Initialize component health tracking
   */
  private initializeComponentHealth(): void {
    const now = Date.now();

    this.componentHealth.set('rpcConnection', {
      status: HealthStatus.HEALTHY,
      message: 'RPC connection operational',
      lastCheck: now,
    });

    this.componentHealth.set('circuitBreaker', {
      status: HealthStatus.HEALTHY,
      message: 'Circuit breaker closed',
      lastCheck: now,
    });

    this.componentHealth.set('memoryUsage', {
      status: HealthStatus.HEALTHY,
      message: 'Memory usage normal',
      lastCheck: now,
    });

    this.componentHealth.set('opportunityDetection', {
      status: HealthStatus.HEALTHY,
      message: 'Opportunity detection active',
      lastCheck: now,
    });
  }

  /**
   * Start periodic health checks
   */
  private startPeriodicChecks(): void {
    this.checkInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.options.checkIntervalMs);

    // Perform initial check
    this.performHealthCheck();
  }

  /**
   * Perform comprehensive health check
   */
  private performHealthCheck(): void {
    const now = Date.now();

    // Check RPC connection
    this.checkRpcConnection();

    // Check circuit breaker
    this.checkCircuitBreaker();

    // Check memory usage
    this.checkMemoryUsage();

    // Check opportunity detection
    this.checkOpportunityDetection();

    // Calculate overall status
    const overallStatus = this.calculateOverallStatus();

    // Get metrics
    const metrics = this.metricsCollector.getOpportunityMetrics();
    const profitMetrics = this.metricsCollector.getProfitMetrics();

    // Create health check result
    const result: HealthCheckResult = {
      status: overallStatus,
      timestamp: now,
      uptime: (now - this.startTime) / 1000, // seconds
      version: process.env['npm_package_version'] || '1.0.0',
      checks: {
        rpcConnection: this.getComponentHealthSafe('rpcConnection'),
        circuitBreaker: this.getComponentHealthSafe('circuitBreaker'),
        memoryUsage: this.getComponentHealthSafe('memoryUsage'),
        opportunityDetection: this.getComponentHealthSafe('opportunityDetection'),
      },
      metrics: {
        totalOpportunities: metrics.totalOpportunities,
        winRate: metrics.winRate,
        totalProfitUSD: profitMetrics.totalProfitUSD,
        activePhases: [], // Will be populated by platform
      },
    };

    this.lastHealthCheck = result;
    this.currentStatus = overallStatus;

    // Emit health check event
    this.emit('healthCheck', result);

    // Log status changes
    if (overallStatus !== HealthStatus.HEALTHY) {
      this.logger.warn('Health check status changed', {
        status: overallStatus,
        checks: result.checks,
      });
    }
  }

  /**
   * Check RPC connection health
   */
  private checkRpcConnection(): void {
    const systemHealth = this.metricsCollector.getSystemHealthMetrics();
    const now = Date.now();

    let status: HealthStatus;
    let message: string;

    if (systemHealth.rpcConnectionHealth) {
      status = HealthStatus.HEALTHY;
      message = 'RPC connection operational';
    } else {
      status = HealthStatus.UNHEALTHY;
      message = 'RPC connection failed';
    }

    this.componentHealth.set('rpcConnection', {
      status,
      message,
      lastCheck: now,
      details: {
        networkLatency: systemHealth.networkLatency,
      },
    });
  }

  /**
   * Check circuit breaker status
   */
  private checkCircuitBreaker(): void {
    const state = this.circuitBreaker.getState();
    const metrics = this.circuitBreaker.getMetrics();
    const now = Date.now();

    let status: HealthStatus;
    let message: string;

    switch (state) {
      case CircuitBreakerState.CLOSED:
        status = HealthStatus.HEALTHY;
        message = 'Circuit breaker closed - normal operation';
        break;
      case CircuitBreakerState.HALF_OPEN:
        status = HealthStatus.DEGRADED;
        message = 'Circuit breaker half-open - testing recovery';
        break;
      case CircuitBreakerState.OPEN:
        status = HealthStatus.UNHEALTHY;
        message = 'Circuit breaker open - blocking requests';
        break;
      default:
        status = HealthStatus.UNHEALTHY;
        message = 'Circuit breaker in unknown state';
    }

    this.componentHealth.set('circuitBreaker', {
      status,
      message,
      lastCheck: now,
      details: {
        state,
        failureCount: metrics.failureCount,
        failureRate: metrics.failureRate,
      },
    });
  }

  /**
   * Check memory usage
   */
  private checkMemoryUsage(): void {
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
    const heapTotalMB = memoryUsage.heapTotal / 1024 / 1024;
    const heapUsagePercent = (heapUsedMB / heapTotalMB) * 100;
    const now = Date.now();

    let status: HealthStatus;
    let message: string;

    if (heapUsagePercent > 90) {
      status = HealthStatus.UNHEALTHY;
      message = `Critical memory usage: ${heapUsagePercent.toFixed(1)}%`;
    } else if (heapUsagePercent > 75) {
      status = HealthStatus.DEGRADED;
      message = `High memory usage: ${heapUsagePercent.toFixed(1)}%`;
    } else {
      status = HealthStatus.HEALTHY;
      message = `Memory usage normal: ${heapUsagePercent.toFixed(1)}%`;
    }

    this.componentHealth.set('memoryUsage', {
      status,
      message,
      lastCheck: now,
      details: {
        heapUsedMB: heapUsedMB.toFixed(2),
        heapTotalMB: heapTotalMB.toFixed(2),
        heapUsagePercent: heapUsagePercent.toFixed(2),
        rss: (memoryUsage.rss / 1024 / 1024).toFixed(2),
      },
    });
  }

  /**
   * Check opportunity detection health
   */
  private checkOpportunityDetection(): void {
    const systemHealth = this.metricsCollector.getSystemHealthMetrics();
    const now = Date.now();
    const timeSinceLastSuccess = now - systemHealth.lastSuccessfulOperation;

    let status: HealthStatus;
    let message: string;

    if (systemHealth.consecutiveFailures >= this.options.unhealthyThreshold) {
      status = HealthStatus.UNHEALTHY;
      message = `${systemHealth.consecutiveFailures} consecutive failures`;
    } else if (systemHealth.consecutiveFailures >= this.options.degradedThreshold) {
      status = HealthStatus.DEGRADED;
      message = `${systemHealth.consecutiveFailures} consecutive failures`;
    } else if (timeSinceLastSuccess > 600000) {
      // No success in 10 minutes
      status = HealthStatus.DEGRADED;
      message = 'No successful operations in 10 minutes';
    } else {
      status = HealthStatus.HEALTHY;
      message = 'Opportunity detection active';
    }

    this.componentHealth.set('opportunityDetection', {
      status,
      message,
      lastCheck: now,
      details: {
        consecutiveFailures: systemHealth.consecutiveFailures,
        timeSinceLastSuccess: Math.floor(timeSinceLastSuccess / 1000),
      },
    });
  }

  /**
   * Calculate overall system status
   */
  private calculateOverallStatus(): HealthStatus {
    const statuses = Array.from(this.componentHealth.values()).map(h => h.status);

    // If any component is unhealthy, system is unhealthy
    if (statuses.includes(HealthStatus.UNHEALTHY)) {
      return HealthStatus.UNHEALTHY;
    }

    // If any component is degraded, system is degraded
    if (statuses.includes(HealthStatus.DEGRADED)) {
      return HealthStatus.DEGRADED;
    }

    return HealthStatus.HEALTHY;
  }

  /**
   * Get current health status
   */
  getHealthStatus(): HealthCheckResult {
    if (!this.lastHealthCheck) {
      // Perform immediate check if none exists
      try {
        this.performHealthCheck();
      } catch (error) {
        // Set a safe default if health check fails
        this.lastHealthCheck = {
          status: HealthStatus.UNHEALTHY,
          timestamp: Date.now(),
          checks: {
            rpcConnection: {
              status: HealthStatus.UNHEALTHY,
              message: 'Health check failed',
              lastCheck: Date.now(),
            },
            circuitBreaker: {
              status: HealthStatus.UNHEALTHY,
              message: 'Health check failed',
              lastCheck: Date.now(),
            },
            memoryUsage: {
              status: HealthStatus.UNHEALTHY,
              message: 'Health check failed',
              lastCheck: Date.now(),
            },
            opportunityDetection: {
              status: HealthStatus.UNHEALTHY,
              message: 'Health check failed',
              lastCheck: Date.now(),
            },
          },
          uptime: process.uptime(),
          version: '1.0.0',
        };
      }
    }

    // Return with fallback to avoid non-null assertion
    return (
      this.lastHealthCheck || {
        status: HealthStatus.UNHEALTHY,
        timestamp: Date.now(),
        checks: {
          rpcConnection: {
            status: HealthStatus.UNHEALTHY,
            message: 'Not initialized',
            lastCheck: Date.now(),
          },
          circuitBreaker: {
            status: HealthStatus.UNHEALTHY,
            message: 'Not initialized',
            lastCheck: Date.now(),
          },
          memoryUsage: {
            status: HealthStatus.UNHEALTHY,
            message: 'Not initialized',
            lastCheck: Date.now(),
          },
          opportunityDetection: {
            status: HealthStatus.UNHEALTHY,
            message: 'Not initialized',
            lastCheck: Date.now(),
          },
        },
        uptime: process.uptime(),
        version: '1.0.0',
      }
    );
  }

  /**
   * Get simple health status (for load balancers)
   */
  isHealthy(): boolean {
    return this.currentStatus === HealthStatus.HEALTHY;
  }

  /**
   * Get readiness status (for Kubernetes readiness probes)
   */
  isReady(): boolean {
    return this.currentStatus !== HealthStatus.UNHEALTHY;
  }

  /**
   * Get liveness status (for Kubernetes liveness probes)
   */
  isAlive(): boolean {
    // System is alive if it's responding (even if unhealthy)
    return true;
  }

  /**
   * Update active phases for metrics
   */
  updateActivePhases(phases: string[]): void {
    if (this.lastHealthCheck && this.lastHealthCheck.metrics) {
      this.lastHealthCheck.metrics = {
        ...this.lastHealthCheck.metrics,
        activePhases: phases,
      };
    }
  }

  /**
   * Stop health checks
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }

    this.logger.info('Health check system stopped');
  }

  /**
   * Get component health details
   */
  getComponentHealth(componentName: string): ComponentHealth | undefined {
    return this.componentHealth.get(componentName);
  }

  /**
   * Get all component health statuses
   */
  getAllComponentHealth(): Map<string, ComponentHealth> {
    return new Map(this.componentHealth);
  }

  /**
   * Safely get component health with fallback
   */
  private getComponentHealthSafe(componentName: string): ComponentHealth {
    const health = this.componentHealth.get(componentName);
    if (health) {
      return health;
    }

    // Return default unhealthy state if component not found
    return {
      status: HealthStatus.UNHEALTHY,
      message: `Component ${componentName} not found`,
      lastCheck: Date.now(),
      details: { error: 'Component not initialized' },
    };
  }
}
