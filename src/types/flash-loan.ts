/**
 * Flash Loan Types
 *
 * Types for flash loan management and execution
 * Requirements: 1.1, 1.7
 */

import { Address } from './common';

/**
 * Flash loan provider types
 */
export enum FlashLoanProvider {
  UNISWAP_V3 = 'uniswap-v3',
  BALANCER = 'balancer',
  AAVE = 'aave',
}

/**
 * Flash loan source information
 */
export interface FlashLoanSource {
  provider: FlashLoanProvider;
  poolAddress: Address;
  token: Address;
  fee: bigint;
  gasOverhead: bigint;
  maxAmount: bigint;
  available: boolean;
  lastUpdated: number;
}

/**
 * Flash loan request
 */
export interface FlashLoanRequest {
  token: Address;
  amount: bigint;
  recipient: Address;
  calldata: string;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * Flash loan execution result
 */
export interface FlashLoanResult {
  success: boolean;
  transactionHash?: string;
  gasUsed?: bigint;
  feesPaid: bigint;
  profit?: bigint;
  failureReason?: string;
  executionTime: number;
}

/**
 * Flash loan capacity information
 */
export interface FlashLoanCapacity {
  token: Address;
  totalCapacity: bigint;
  availableCapacity: bigint;
  utilizationRate: number;
  sources: FlashLoanSource[];
}

/**
 * Flash loan cost estimate
 */
export interface FlashLoanCostEstimate {
  provider: FlashLoanProvider;
  poolAddress: Address;
  token: Address;
  amount: bigint;
  fee: bigint;
  gasOverhead: bigint;
  totalCost: bigint;
  costPercentage: number;
}

/**
 * Flash loan split allocation
 */
export interface FlashLoanSplit {
  source: FlashLoanSource;
  amount: bigint;
  fee: bigint;
  gasOverhead: bigint;
}

/**
 * Flash loan manager configuration
 */
export interface FlashLoanManagerConfig {
  preferredProvider: FlashLoanProvider;
  maxBorrowAmountUsd: number;
  enableSplitting: boolean;
  maxSplits: number;
  feeThresholdBps: number; // Basis points
  capacityRefreshIntervalMs: number;
  enableFallback: boolean;
  providers: {
    [FlashLoanProvider.UNISWAP_V3]: {
      enabled: boolean;
      feeRate: number;
      factoryAddress: Address;
      quoterAddress: Address;
    };
    [FlashLoanProvider.BALANCER]: {
      enabled: boolean;
      feeRate: number;
      vaultAddress: Address;
    };
    [FlashLoanProvider.AAVE]: {
      enabled: boolean;
      feeRate: number;
      poolAddress: Address;
    };
  };
}

/**
 * Flash loan provider interface
 */
export interface IFlashLoanProvider {
  readonly provider: FlashLoanProvider;

  /**
   * Get available flash loan sources for token
   */
  getAvailableSources(token: Address): Promise<FlashLoanSource[]>;

  /**
   * Check flash loan capacity for token
   */
  getCapacity(token: Address): Promise<bigint>;

  /**
   * Calculate flash loan fee
   */
  calculateFee(token: Address, amount: bigint): Promise<bigint>;

  /**
   * Execute flash loan
   */
  executeFlashLoan(request: FlashLoanRequest): Promise<FlashLoanResult>;

  /**
   * Estimate gas overhead for flash loan
   */
  estimateGasOverhead(token: Address, amount: bigint): Promise<bigint>;
}

/**
 * Flash loan manager interface
 */
export interface IFlashLoanManager {
  /**
   * Get optimal flash loan source for request
   */
  getOptimalSource(token: Address, amount: bigint): Promise<FlashLoanSource>;

  /**
   * Get multiple sources for splitting large loans
   */
  getSplitSources(token: Address, amount: bigint): Promise<FlashLoanSplit[]>;

  /**
   * Check total available capacity for token
   */
  getTotalCapacity(token: Address): Promise<FlashLoanCapacity>;

  /**
   * Execute flash loan with optimal routing
   */
  executeFlashLoan(request: FlashLoanRequest): Promise<FlashLoanResult>;

  /**
   * Get cost estimates from all providers
   */
  getCostEstimates(token: Address, amount: bigint): Promise<FlashLoanCostEstimate[]>;
}

/**
 * Flash loan events
 */
export interface FlashLoanEvents {
  flashLoanExecuted: {
    provider: FlashLoanProvider;
    token: Address;
    amount: bigint;
    fee: bigint;
    success: boolean;
    transactionHash?: string;
  };

  flashLoanFailed: {
    provider: FlashLoanProvider;
    token: Address;
    amount: bigint;
    reason: string;
  };

  capacityUpdated: {
    token: Address;
    provider: FlashLoanProvider;
    newCapacity: bigint;
    timestamp: number;
  };

  providerUnavailable: {
    provider: FlashLoanProvider;
    reason: string;
    timestamp: number;
  };
}

/**
 * Common flash loan tokens on Base
 */
export const FLASH_LOAN_TOKENS = {
  WETH: '0x4200000000000000000000000000000000000006' as Address,
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' as Address,
  USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' as Address,
} as const;

/**
 * Flash loan error types
 */
export class FlashLoanError extends Error {
  constructor(
    message: string,
    public readonly provider: FlashLoanProvider,
    public readonly token: Address,
    public readonly amount: bigint
  ) {
    super(message);
    this.name = 'FlashLoanError';
  }
}

export class InsufficientCapacityError extends FlashLoanError {
  constructor(provider: FlashLoanProvider, token: Address, requested: bigint, available: bigint) {
    super(
      `Insufficient capacity: requested ${requested}, available ${available}`,
      provider,
      token,
      requested
    );
    this.name = 'InsufficientCapacityError';
  }
}

export class FlashLoanExecutionError extends FlashLoanError {
  constructor(
    provider: FlashLoanProvider,
    token: Address,
    amount: bigint,
    public readonly transactionHash?: string,
    public readonly revertReason?: string
  ) {
    super(
      `Flash loan execution failed${revertReason ? `: ${revertReason}` : ''}`,
      provider,
      token,
      amount
    );
    this.name = 'FlashLoanExecutionError';
  }
}

export class ProviderUnavailableError extends FlashLoanError {
  constructor(provider: FlashLoanProvider, reason: string) {
    super(`Provider ${provider} unavailable: ${reason}`, provider, '0x0' as Address, 0n);
    this.name = 'ProviderUnavailableError';
  }
}
