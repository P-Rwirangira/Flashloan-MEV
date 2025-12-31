/**
 * Health Check HTTP Server
 *
 * Provides HTTP endpoints for health checks, metrics, and readiness probes
 */

import http from 'http';
import { createComponentLogger } from '../utils/logger';
import { HealthCheckSystem, HealthStatus } from './health-check';
import { MetricsCollector } from './metrics-collector';

export interface HealthServerOptions {
  port?: number;
  host?: string;
  healthCheckSystem: HealthCheckSystem;
  metricsCollector: MetricsCollector;
}

/**
 * Health Check HTTP Server
 */
export class HealthServer {
  private readonly logger = createComponentLogger('health-server');
  private readonly healthCheckSystem: HealthCheckSystem;
  private readonly metricsCollector: MetricsCollector;
  private readonly port: number;
  private readonly host: string;

  private server: http.Server | undefined;

  constructor(options: HealthServerOptions) {
    this.healthCheckSystem = options.healthCheckSystem;
    this.metricsCollector = options.metricsCollector;
    this.port = options.port || 3002;
    this.host = options.host || '0.0.0.0';
  }

  /**
   * Start the health check server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', error => {
        this.logger.logError(error as Error, {
          operation: 'health-server-startup',
        });
        reject(error);
      });

      this.server.listen(this.port, this.host, () => {
        this.logger.info('Health check server started', {
          host: this.host,
          port: this.port,
        });
        resolve();
      });
    });
  }

  /**
   * Handle incoming HTTP requests
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle OPTIONS for CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Only allow GET requests
    if (method !== 'GET') {
      this.sendResponse(res, 405, { error: 'Method not allowed' });
      return;
    }

    // Route requests
    try {
      switch (url) {
        case '/health':
          this.handleHealthCheck(res);
          break;
        case '/ready':
          this.handleReadinessCheck(res);
          break;
        case '/live':
          this.handleLivenessCheck(res);
          break;
        case '/metrics':
          this.handleMetrics(res);
          break;
        case '/status':
          this.handleStatus(res);
          break;
        default:
          this.sendResponse(res, 404, { error: 'Not found' });
      }
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'health-server-request',
        url,
      });
      this.sendResponse(res, 500, { error: 'Internal server error' });
    }
  }

  /**
   * Handle /health endpoint
   */
  private handleHealthCheck(res: http.ServerResponse): void {
    const health = this.healthCheckSystem.getHealthStatus();

    const statusCode = health.status === HealthStatus.HEALTHY ? 200 : 503;

    this.sendResponse(res, statusCode, health);
  }

  /**
   * Handle /ready endpoint (Kubernetes readiness probe)
   */
  private handleReadinessCheck(res: http.ServerResponse): void {
    const isReady = this.healthCheckSystem.isReady();

    if (isReady) {
      this.sendResponse(res, 200, {
        status: 'ready',
        timestamp: Date.now(),
      });
    } else {
      this.sendResponse(res, 503, {
        status: 'not ready',
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Handle /live endpoint (Kubernetes liveness probe)
   */
  private handleLivenessCheck(res: http.ServerResponse): void {
    const isAlive = this.healthCheckSystem.isAlive();

    if (isAlive) {
      this.sendResponse(res, 200, {
        status: 'alive',
        timestamp: Date.now(),
      });
    } else {
      this.sendResponse(res, 503, {
        status: 'not alive',
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Handle /metrics endpoint
   */
  private handleMetrics(res: http.ServerResponse): void {
    const metrics = this.metricsCollector.exportMetrics();

    this.sendResponse(res, 200, metrics);
  }

  /**
   * Handle /status endpoint (simple status check)
   */
  private handleStatus(res: http.ServerResponse): void {
    const health = this.healthCheckSystem.getHealthStatus();

    this.sendResponse(res, 200, {
      status: health.status,
      uptime: health.uptime,
      version: health.version,
      timestamp: Date.now(),
    });
  }

  /**
   * Send JSON response
   */
  private sendResponse(res: http.ServerResponse, statusCode: number, data: any): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify(data, null, 2));
  }

  /**
   * Stop the health check server
   */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(error => {
        if (error) {
          this.logger.logError(error, {
            operation: 'health-server-shutdown',
          });
          reject(error);
        } else {
          this.logger.info('Health check server stopped');
          resolve();
        }
      });
    });
  }
}
