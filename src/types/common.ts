/**
 * Common Types
 *
 * Shared types used across multiple domains in the MEV platform.
 */

import { BigNumberish } from 'ethers';

// Ethereum address type
export type Address = string;

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
}

// Gas configuration
export interface GasConfig {
  readonly maxGasPrice: BigNumberish;
  readonly gasLimit: number;
  readonly priorityFee: BigNumberish;
}

// Timing configuration
export interface TimingConfig {
  readonly maxLatencyMs: number;
  readonly timeoutMs: number;
  readonly retryDelayMs: number;
  readonly maxRetries: number;
}
