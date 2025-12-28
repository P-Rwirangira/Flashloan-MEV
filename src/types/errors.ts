/**
 * Error Types
 *
 * Custom error types for the MEV platform.
 */

import { Address } from './common';

// Error severity levels
export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

// Base MEV platform error
export class MevPlatformError extends Error {
  public readonly severity: ErrorSeverity;
  public readonly timestamp: number;
  public readonly context: Record<string, unknown> | undefined;

  constructor(
    message: string,
    public readonly code: string,
    severity: ErrorSeverity = ErrorSeverity.MEDIUM,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'MevPlatformError';
    this.severity = severity;
    this.timestamp = Date.now();
    this.context = context;
  }
}

// Configuration errors
export class ConfigurationError extends MevPlatformError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIGURATION_ERROR', ErrorSeverity.HIGH, context);
    this.name = 'ConfigurationError';
  }
}

// RPC connection errors
export class RpcConnectionError extends MevPlatformError {
  constructor(
    message: string,
    public readonly endpoint: string,
    context?: Record<string, unknown>
  ) {
    super(message, 'RPC_CONNECTION_ERROR', ErrorSeverity.HIGH, { ...context, endpoint });
    this.name = 'RpcConnectionError';
  }
}

// Pool monitoring errors
export class PoolMonitoringError extends MevPlatformError {
  constructor(
    message: string,
    public readonly poolAddress: Address,
    context?: Record<string, unknown>
  ) {
    super(message, 'POOL_MONITORING_ERROR', ErrorSeverity.MEDIUM, { ...context, poolAddress });
    this.name = 'PoolMonitoringError';
  }
}

// Simulation errors
export class SimulationError extends MevPlatformError {
  constructor(
    message: string,
    public readonly opportunityId: string,
    context?: Record<string, unknown>
  ) {
    super(message, 'SIMULATION_ERROR', ErrorSeverity.MEDIUM, { ...context, opportunityId });
    this.name = 'SimulationError';
  }
}

// Transaction submission errors
export class TransactionSubmissionError extends MevPlatformError {
  constructor(
    message: string,
    public readonly txHash?: string,
    context?: Record<string, unknown>
  ) {
    super(message, 'TRANSACTION_SUBMISSION_ERROR', ErrorSeverity.HIGH, { ...context, txHash });
    this.name = 'TransactionSubmissionError';
  }
}

// Flash loan errors
export class FlashLoanError extends MevPlatformError {
  constructor(
    message: string,
    public readonly poolAddress: Address,
    context?: Record<string, unknown>
  ) {
    super(message, 'FLASH_LOAN_ERROR', ErrorSeverity.HIGH, { ...context, poolAddress });
    this.name = 'FlashLoanError';
  }
}

// Insufficient profit error
export class InsufficientProfitError extends MevPlatformError {
  constructor(
    public readonly actualProfit: string,
    public readonly minProfit: string,
    context?: Record<string, unknown>
  ) {
    super(
      `Insufficient profit: ${actualProfit} < ${minProfit}`,
      'INSUFFICIENT_PROFIT',
      ErrorSeverity.LOW,
      { ...context, actualProfit, minProfit }
    );
    this.name = 'InsufficientProfitError';
  }
}

// Slippage exceeded error
export class SlippageExceededError extends MevPlatformError {
  constructor(
    public readonly expectedAmount: string,
    public readonly actualAmount: string,
    context?: Record<string, unknown>
  ) {
    super(
      `Slippage exceeded: expected ${expectedAmount}, got ${actualAmount}`,
      'SLIPPAGE_EXCEEDED',
      ErrorSeverity.MEDIUM,
      { ...context, expectedAmount, actualAmount }
    );
    this.name = 'SlippageExceededError';
  }
}

// Gas price too high error
export class GasPriceTooHighError extends MevPlatformError {
  constructor(
    public readonly currentGasPrice: string,
    public readonly maxGasPrice: string,
    context?: Record<string, unknown>
  ) {
    super(
      `Gas price too high: ${currentGasPrice} > ${maxGasPrice}`,
      'GAS_PRICE_TOO_HIGH',
      ErrorSeverity.MEDIUM,
      { ...context, currentGasPrice, maxGasPrice }
    );
    this.name = 'GasPriceTooHighError';
  }
}

// Opportunity expired error
export class OpportunityExpiredError extends MevPlatformError {
  constructor(
    public readonly opportunityId: string,
    context?: Record<string, unknown>
  ) {
    super(`Opportunity expired: ${opportunityId}`, 'OPPORTUNITY_EXPIRED', ErrorSeverity.LOW, {
      ...context,
      opportunityId,
    });
    this.name = 'OpportunityExpiredError';
  }
}

// Circuit breaker error
export class CircuitBreakerError extends MevPlatformError {
  constructor(
    message: string,
    public readonly component: string,
    context?: Record<string, unknown>
  ) {
    super(message, 'CIRCUIT_BREAKER_OPEN', ErrorSeverity.HIGH, { ...context, component });
    this.name = 'CircuitBreakerError';
  }
}

// Rate limit error
export class RateLimitError extends MevPlatformError {
  constructor(
    message: string,
    public readonly service: string,
    context?: Record<string, unknown>
  ) {
    super(message, 'RATE_LIMIT_EXCEEDED', ErrorSeverity.MEDIUM, { ...context, service });
    this.name = 'RateLimitError';
  }
}

// Validation error
export class ValidationError extends MevPlatformError {
  constructor(
    message: string,
    public readonly field: string,
    context?: Record<string, unknown>
  ) {
    super(message, 'VALIDATION_ERROR', ErrorSeverity.MEDIUM, { ...context, field });
    this.name = 'ValidationError';
  }
}

// Network error
export class NetworkError extends MevPlatformError {
  constructor(
    message: string,
    public readonly network: string,
    context?: Record<string, unknown>
  ) {
    super(message, 'NETWORK_ERROR', ErrorSeverity.HIGH, { ...context, network });
    this.name = 'NetworkError';
  }
}

// Timeout error
export class TimeoutError extends MevPlatformError {
  constructor(
    message: string,
    public readonly timeoutMs: number,
    context?: Record<string, unknown>
  ) {
    super(message, 'TIMEOUT_ERROR', ErrorSeverity.MEDIUM, { ...context, timeoutMs });
    this.name = 'TimeoutError';
  }
}

// Error aggregation for multiple errors
export class AggregateError extends MevPlatformError {
  constructor(
    message: string,
    public readonly errors: Error[],
    context?: Record<string, unknown>
  ) {
    super(message, 'AGGREGATE_ERROR', ErrorSeverity.HIGH, {
      ...context,
      errorCount: errors.length,
    });
    this.name = 'AggregateError';
  }
}

// Error handler result
export interface ErrorHandlerResult {
  readonly handled: boolean;
  readonly retry: boolean;
  readonly retryAfterMs?: number;
  readonly escalate: boolean;
  readonly context?: Record<string, unknown>;
}
