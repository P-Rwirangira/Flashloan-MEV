/**
 * Common Types
 *
 * Shared types used across multiple domains in the MEV platform.
 */

import { BigNumberish } from 'ethers';

// Ethereum address type
export type Address = `0x${string}`;

// Result type for operations that can fail
export type Result<T, E = Error> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: E;
    };

// Async result type
export type AsyncResult<T, E = Error> = Promise<Result<T, E>>;

// Network configuration
export interface NetworkConfig {
  readonly chainId: number;
  readonly name: string;
  readonly rpcUrl: string;
  readonly wsUrl?: string;
  readonly fallbackRpcs: string[];
}

// Gas configuration
export interface GasConfig {
  readonly maxGasPrice: BigNumberish;
  readonly gasLimit: number;
  readonly priorityFee: BigNumberish;
  readonly baseFeeMultiplier: number;
}

// Timing configuration
export interface TimingConfig {
  readonly maxLatencyMs: number;
  readonly timeoutMs: number;
  readonly retryDelayMs: number;
  readonly maxRetries: number;
  readonly simulationTimeoutMs: number;
}

// Health status for components
export enum HealthStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy',
  UNKNOWN = 'unknown',
}

// Component health information
export interface HealthInfo {
  readonly status: HealthStatus;
  readonly lastCheck: number;
  readonly latencyMs?: number;
  readonly errorCount: number;
  readonly message?: string;
}

// Token information
export interface TokenInfo {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly chainId: number;
}

// Price information
export interface PriceInfo {
  readonly price: BigNumberish;
  readonly timestamp: number;
  readonly source: string;
  readonly confidence: number; // 0-1 scale
}

// Health monitoring utilities
export const HealthUtils = {
  /**
   * Determine health status based on error rate and latency
   */
  calculateHealthStatus: (
    errorRate: number,
    latencyMs: number,
    maxLatency: number
  ): HealthStatus => {
    if (errorRate > 0.5 || latencyMs > maxLatency * 2) {
      return HealthStatus.UNHEALTHY;
    }
    if (errorRate > 0.1 || latencyMs > maxLatency) {
      return HealthStatus.DEGRADED;
    }
    if (latencyMs >= 0 && errorRate >= 0) {
      return HealthStatus.HEALTHY;
    }
    return HealthStatus.UNKNOWN;
  },

  /**
   * Check if a component is operational
   */
  isOperational: (status: HealthStatus): boolean => {
    return status === HealthStatus.HEALTHY || status === HealthStatus.DEGRADED;
  },

  /**
   * Get health status display message
   */
  getHealthMessage: (status: HealthStatus, errorCount: number, latencyMs?: number): string => {
    switch (status) {
      case HealthStatus.HEALTHY:
        return `System healthy - ${errorCount} errors, ${latencyMs || 0}ms latency`;
      case HealthStatus.DEGRADED:
        return `System degraded - ${errorCount} errors, ${latencyMs || 0}ms latency`;
      case HealthStatus.UNHEALTHY:
        return `System unhealthy - ${errorCount} errors, ${latencyMs || 0}ms latency`;
      case HealthStatus.UNKNOWN:
        return `System status unknown - ${errorCount} errors`;
      default:
        return 'Invalid health status';
    }
  },

  /**
   * Validate health info structure
   */
  validateHealthInfo: (health: HealthInfo): void => {
    if (!Object.values(HealthStatus).includes(health.status)) {
      throw new Error(`Invalid health status: ${health.status}`);
    }
    if (health.lastCheck <= 0) {
      throw new Error('Last check timestamp must be positive');
    }
    if (health.errorCount < 0) {
      throw new Error('Error count cannot be negative');
    }
    if (health.latencyMs !== undefined && health.latencyMs < 0) {
      throw new Error('Latency cannot be negative');
    }
  },
};
