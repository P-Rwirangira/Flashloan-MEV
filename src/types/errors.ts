/**
 * Error Types
 *
 * Custom error types for the MEV platform.
 */

import { Address } from './common';

// Base MEV platform error
export class MevPlatformError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'MevPlatformError';
  }
}

// Configuration errors
export class ConfigurationError extends MevPlatformError {
  constructor(message: string) {
    super(message, 'CONFIGURATION_ERROR');
    this.name = 'ConfigurationError';
  }
}

// RPC connection errors
export class RpcConnectionError extends MevPlatformError {
  constructor(
    message: string,
    public readonly endpoint: string
  ) {
    super(message, 'RPC_CONNECTION_ERROR');
    this.name = 'RpcConnectionError';
  }
}

// Pool monitoring errors
export class PoolMonitoringError extends MevPlatformError {
  constructor(
    message: string,
    public readonly poolAddress: Address
  ) {
    super(message, 'POOL_MONITORING_ERROR');
    this.name = 'PoolMonitoringError';
  }
}

// Simulation errors
export class SimulationError extends MevPlatformError {
  constructor(
    message: string,
    public readonly opportunityId: string
  ) {
    super(message, 'SIMULATION_ERROR');
    this.name = 'SimulationError';
  }
}

// Transaction submission errors
export class TransactionSubmissionError extends MevPlatformError {
  constructor(
    message: string,
    public readonly txHash?: string
  ) {
    super(message, 'TRANSACTION_SUBMISSION_ERROR');
    this.name = 'TransactionSubmissionError';
  }
}

// Flash loan errors
export class FlashLoanError extends MevPlatformError {
  constructor(
    message: string,
    public readonly poolAddress: Address
  ) {
    super(message, 'FLASH_LOAN_ERROR');
    this.name = 'FlashLoanError';
  }
}

// Insufficient profit error
export class InsufficientProfitError extends MevPlatformError {
  constructor(
    public readonly actualProfit: string,
    public readonly minProfit: string
  ) {
    super(`Insufficient profit: ${actualProfit} < ${minProfit}`, 'INSUFFICIENT_PROFIT');
    this.name = 'InsufficientProfitError';
  }
}

// Slippage exceeded error
export class SlippageExceededError extends MevPlatformError {
  constructor(
    public readonly expectedAmount: string,
    public readonly actualAmount: string
  ) {
    super(
      `Slippage exceeded: expected ${expectedAmount}, got ${actualAmount}`,
      'SLIPPAGE_EXCEEDED'
    );
    this.name = 'SlippageExceededError';
  }
}
