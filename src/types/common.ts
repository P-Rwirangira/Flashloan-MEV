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
