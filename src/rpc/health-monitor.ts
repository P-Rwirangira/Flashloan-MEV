/**
 * Health Monitor
 *
 * Monitors the health of RPC connections and services.
 */

import { EventEmitter } from 'events';
import { createComponentLogger } from '../utils/logger';

export interface HealthCheckResult {
  service: string;
  healthy: boolean;
  latency?: number;
  error?: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface HealthMonitorOptions {
  checkInterval?: number;
  timeout?: number;
  retries?: number;
  services: HealthCheckConfig[];
}

export interface HealthCheckConfig {
  name: string;
  type: 'rpc' | 'websocket' | 'http' | 'custom';
  url?: string;
  checkFunction?: () => Promise<boolean>;
  timeout?: number;
  enabled: boolean;
}

export class HealthMonitor extends EventEmitter {
  private readonly logger = createComponentLogger('health-monitor');
  private readonly options: Required<Omit<HealthMonitorOptions, 'services'>> & {
    services: HealthCheckConfig[];
  };

  private isMonitoring = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private healthStatus: Map<string, HealthCheckResult> = new Map();

  constructor(options: HealthMonitorOptions) {
    super();
    this.options = {
      checkInterval: 30000, // 30 seconds
      timeout: 5000, // 5 seconds
      retries: 2,
      ...options,
    };
  }

  start(): void {
    if (this.isMonitoring) {
      this.logger.warn('Health monitor is already running');
      return;
    }

    this.logger.info('Starting health monitor', {
      services: this.options.services.length,
      checkInterval: this.options.checkInterval,
    });

    this.isMonitoring = true;

    // Initial health check
    this.performHealthChecks().catch(error => {
      this.logger.logError(error as Error, { operation: 'initial-health-check' });
    });

    // Schedule periodic checks
    this.checkInterval = setInterval(() => {
      this.performHealthChecks().catch(error => {
        this.logger.logError(error as Error, { operation: 'periodic-health-check' });
      });
    }, this.options.checkInterval);
  }

  stop(): void {
    if (!this.isMonitoring) {
      this.logger.warn('Health monitor is not running');
      return;
    }

    this.logger.info('Stopping health monitor');
    this.isMonitoring = false;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private async performHealthChecks(): Promise<void> {
    const enabledServices = this.options.services.filter(service => service.enabled);

    this.logger.debug('Performing health checks', {
      totalServices: enabledServices.length,
    });

    const checkPromises = enabledServices.map(service => this.checkServiceHealth(service));
    const results = await Promise.allSettled(checkPromises);

    let healthyCount = 0;
    let unhealthyCount = 0;

    results.forEach((result, index) => {
      const service = enabledServices[index];
      if (!service) return; // Skip if service is undefined

      if (result.status === 'fulfilled') {
        this.healthStatus.set(service.name, result.value);

        if (result.value.healthy) {
          healthyCount++;
        } else {
          unhealthyCount++;
          this.emit('serviceUnhealthy', result.value);
        }
      } else {
        const errorResult: HealthCheckResult = {
          service: service.name,
          healthy: false,
          error: result.reason?.message || 'Unknown error',
          timestamp: Date.now(),
        };

        this.healthStatus.set(service.name, errorResult);
        unhealthyCount++;
        this.emit('serviceUnhealthy', errorResult);
      }
    });

    this.logger.info('Health check completed', {
      healthy: healthyCount,
      unhealthy: unhealthyCount,
      total: enabledServices.length,
    });

    this.emit('healthCheckCompleted', {
      healthy: healthyCount,
      unhealthy: unhealthyCount,
      total: enabledServices.length,
      results: Array.from(this.healthStatus.values()),
    });
  }

  private async checkServiceHealth(service: HealthCheckConfig): Promise<HealthCheckResult> {
    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      try {
        this.logger.debug('Checking service health', {
          service: service.name,
          type: service.type,
          attempt: attempt + 1,
        });

        const healthy = await this.executeHealthCheck(service);
        const latency = Date.now() - startTime;

        const result: HealthCheckResult = {
          service: service.name,
          healthy,
          latency,
          timestamp: Date.now(),
          metadata: {
            type: service.type,
            url: service.url,
            attempt: attempt + 1,
          },
        };

        if (healthy) {
          this.logger.debug('Service health check passed', {
            service: service.name,
            latency,
          });
          return result;
        } else {
          throw new Error('Health check returned false');
        }
      } catch (error) {
        lastError = error as Error;

        if (attempt < this.options.retries) {
          this.logger.debug('Service health check failed, retrying', {
            service: service.name,
            attempt: attempt + 1,
            error: lastError.message,
          });

          // Brief delay before retry
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    const latency = Date.now() - startTime;

    this.logger.warn('Service health check failed after all retries', {
      service: service.name,
      error: lastError?.message,
      attempts: this.options.retries + 1,
    });

    return {
      service: service.name,
      healthy: false,
      latency,
      error: lastError?.message || 'Unknown error',
      timestamp: Date.now(),
      metadata: {
        type: service.type,
        url: service.url,
        attempts: this.options.retries + 1,
      },
    };
  }

  private async executeHealthCheck(service: HealthCheckConfig): Promise<boolean> {
    const timeout = service.timeout || this.options.timeout;

    const checkPromise = this.performSpecificHealthCheck(service);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Health check timeout')), timeout);
    });

    return Promise.race([checkPromise, timeoutPromise]);
  }

  private async performSpecificHealthCheck(service: HealthCheckConfig): Promise<boolean> {
    switch (service.type) {
      case 'rpc':
        return this.checkRpcHealth(service.url!);

      case 'websocket':
        return this.checkWebSocketHealth(service.url!);

      case 'http':
        return this.checkHttpHealth(service.url!);

      case 'custom':
        if (!service.checkFunction) {
          throw new Error('Custom health check requires checkFunction');
        }
        return service.checkFunction();

      default:
        throw new Error(`Unsupported health check type: ${service.type}`);
    }
  }

  private async checkRpcHealth(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1,
        }),
      });

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as { result?: string | boolean };
      return Boolean(data.result && typeof data.result === 'string');
    } catch (error) {
      return false;
    }
  }

  private async checkWebSocketHealth(url: string): Promise<boolean> {
    return new Promise(resolve => {
      try {
        const WebSocket = require('ws');
        const ws = new WebSocket(url);

        const timeout = setTimeout(() => {
          ws.close();
          resolve(false);
        }, 3000);

        ws.on('open', () => {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        });

        ws.on('error', () => {
          clearTimeout(timeout);
          resolve(false);
        });
      } catch (error) {
        resolve(false);
      }
    });
  }

  private async checkHttpHealth(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  getHealthStatus(): Map<string, HealthCheckResult> {
    return new Map(this.healthStatus);
  }

  getOverallHealth(): { healthy: boolean; services: number; healthyServices: number } {
    const services = Array.from(this.healthStatus.values());
    const healthyServices = services.filter(s => s.healthy).length;

    return {
      healthy: healthyServices === services.length && services.length > 0,
      services: services.length,
      healthyServices,
    };
  }

  addService(service: HealthCheckConfig): void {
    this.options.services.push(service);
    this.logger.info('Added health check service', { name: service.name, type: service.type });
  }

  removeService(serviceName: string): void {
    this.options.services = this.options.services.filter(s => s.name !== serviceName);
    this.healthStatus.delete(serviceName);
    this.logger.info('Removed health check service', { name: serviceName });
  }
}
