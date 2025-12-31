/**
 * Risk Management Types
 *
 * Types for risk controls and validation during execution
 * Requirements: 1.4, 1.15
 */

import { Address } from './common';
import { BaseOpportunity, ExecutionContext } from './execution';

/**
 * Risk check severity levels
 */
export enum RiskSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

/**
 * Risk check result
 */
export interface RiskCheckResult {
  passed: boolean;
  severity: RiskSeverity;
  checkName: string;
  reason?: string | undefined;
  suggestedAction?: RiskAction | undefined;
  metadata?: Record<string, any> | undefined;
  timestamp: number;
}

/**
 * Suggested risk actions
 */
export enum RiskAction {
  PROCEED = 'proceed',
  ADJUST_PARAMETERS = 'adjust',
  DELAY_EXECUTION = 'delay',
  CANCEL_EXECUTION = 'cancel',
  REDUCE_POSITION = 'reduce',
  INCREASE_SLIPPAGE = 'increase_slippage',
  WAIT_FOR_BETTER_CONDITIONS = 'wait',
}

/**
 * Risk validation result
 */
export interface RiskValidationResult {
  canExecute: boolean;
  overallRisk: RiskLevel;
  reason?: string | undefined;
  results: RiskCheckResult[];
  suggestedActions: RiskAction[];
  riskScore: number; // 0-100 scale
}

/**
 * Risk levels
 */
export enum RiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

/**
 * Risk check interface
 */
export interface IRiskCheck {
  name: string;
  description: string;
  severity: RiskSeverity;
  enabled: boolean;
  weight: number; // For risk score calculation

  /**
   * Execute the risk check
   */
  check(opportunity: BaseOpportunity, context: ExecutionContext): Promise<RiskCheckResult>;
}

/**
 * Risk controller configuration
 */
export interface RiskControllerConfig {
  // Profit thresholds
  minProfitUsd: number;
  minProfitMarginBps: number; // Basis points

  // Slippage controls
  maxSlippageBps: number;
  slippageBufferBps: number;

  // Gas controls
  maxGasPriceGwei: number;
  gasEstimationBuffer: number; // Percentage

  // Loss limits
  maxDailyLossUsd: number;
  maxConsecutiveLosses: number;
  maxLossPerExecutionUsd: number;

  // Market conditions
  maxPoolReserveChangeBps: number;
  minPoolLiquidityUsd: number;
  maxPriceImpactBps: number;

  // Circuit breaker
  enableCircuitBreaker: boolean;
  circuitBreakerThreshold: number;
  circuitBreakerRecoveryTimeMs: number;

  // Risk scoring
  riskScoreThreshold: number; // 0-100
  enableRiskScoring: boolean;

  // Time-based controls
  maxExecutionTimeMs: number;
  cooldownPeriodMs: number;

  // Position sizing
  enablePositionSizing: boolean;
  maxPositionSizeUsd: number;
  positionSizeMultiplier: number;
}

/**
 * Market condition data
 */
export interface MarketCondition {
  timestamp: number;
  gasPrice: bigint;
  baseFee: bigint;
  networkCongestion: 'low' | 'medium' | 'high';
  volatilityIndex: number; // 0-100
  liquidityIndex: number; // 0-100
}

/**
 * Pool state for risk assessment
 */
export interface PoolState {
  poolAddress: Address;
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
  lastUpdateBlock: number;
  liquidityUsd: number;
  volume24hUsd: number;
  priceImpact: number;
}

/**
 * Execution history for risk assessment
 */
export interface ExecutionHistory {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  totalProfit: bigint;
  totalLoss: bigint;
  consecutiveLosses: number;
  lastExecutionAt: number;
  dailyStats: DailyExecutionStats;
}

/**
 * Daily execution statistics
 */
export interface DailyExecutionStats {
  date: string; // YYYY-MM-DD
  executions: number;
  profit: bigint;
  loss: bigint;
  netProfit: bigint;
  gasSpent: bigint;
  successRate: number;
}

/**
 * Risk metrics
 */
export interface RiskMetrics {
  currentRiskLevel: RiskLevel;
  riskScore: number;
  activeRiskChecks: number;
  failedRiskChecks: number;
  circuitBreakerActive: boolean;
  lastRiskAssessment: number;
  riskCheckResults: RiskCheckResult[];
  dailyLoss: bigint;
  consecutiveLosses: number;
}

/**
 * Risk events
 */
export interface RiskEvents {
  riskCheckFailed: {
    opportunityId: string;
    checkName: string;
    severity: RiskSeverity;
    reason: string;
    timestamp: number;
  };

  circuitBreakerActivated: {
    reason: string;
    riskScore: number;
    timestamp: number;
  };

  circuitBreakerDeactivated: {
    reason: string;
    timestamp: number;
  };

  riskLevelChanged: {
    previousLevel: RiskLevel;
    newLevel: RiskLevel;
    riskScore: number;
    timestamp: number;
  };

  dailyLossLimitReached: {
    currentLoss: bigint;
    limit: bigint;
    timestamp: number;
  };

  consecutiveLossLimitReached: {
    consecutiveLosses: number;
    limit: number;
    timestamp: number;
  };
}

/**
 * Risk controller interface
 */
export interface IRiskController {
  /**
   * Validate execution against all risk checks
   */
  validateExecution(
    opportunity: BaseOpportunity,
    context: ExecutionContext
  ): Promise<RiskValidationResult>;

  /**
   * Register a risk check
   */
  registerRiskCheck(check: IRiskCheck): void;

  /**
   * Remove a risk check
   */
  removeRiskCheck(checkName: string): void;

  /**
   * Update risk configuration
   */
  updateConfig(config: Partial<RiskControllerConfig>): void;

  /**
   * Get current risk metrics
   */
  getRiskMetrics(): RiskMetrics;

  /**
   * Reset risk state (for testing or recovery)
   */
  resetRiskState(): void;

  /**
   * Check if circuit breaker is active
   */
  isCircuitBreakerActive(): boolean;

  /**
   * Manually activate circuit breaker
   */
  activateCircuitBreaker(reason: string): void;

  /**
   * Manually deactivate circuit breaker
   */
  deactivateCircuitBreaker(reason: string): void;
}

/**
 * Risk check error types
 */
export class RiskCheckError extends Error {
  constructor(
    message: string,
    public readonly checkName: string,
    public readonly severity: RiskSeverity
  ) {
    super(message);
    this.name = 'RiskCheckError';
  }
}

export class CircuitBreakerActiveError extends Error {
  constructor(
    public readonly reason: string,
    public readonly activatedAt: number
  ) {
    super(`Circuit breaker is active: ${reason}`);
    this.name = 'CircuitBreakerActiveError';
  }
}

export class RiskThresholdExceededError extends Error {
  constructor(
    public readonly riskScore: number,
    public readonly threshold: number,
    public readonly failedChecks: string[]
  ) {
    super(
      `Risk score ${riskScore} exceeds threshold ${threshold}. Failed checks: ${failedChecks.join(', ')}`
    );
    this.name = 'RiskThresholdExceededError';
  }
}

export class DailyLossLimitExceededError extends Error {
  constructor(
    public readonly currentLoss: bigint,
    public readonly limit: bigint
  ) {
    super(`Daily loss limit exceeded: ${currentLoss} > ${limit}`);
    this.name = 'DailyLossLimitExceededError';
  }
}
