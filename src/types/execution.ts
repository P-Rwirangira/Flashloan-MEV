/**
 * Execution Types
 *
 * Core types for the execution engine system
 * Requirements: 1.1, 1.12, 1.15
 */

import { Address } from './common';
import { OpportunityState } from './execution-state';

/**
 * Base opportunity interface
 */
export interface BaseOpportunity {
  id: string;
  type: OpportunityType;
  phase: OpportunityPhase;
  detectedAt: number;
  expiresAt?: number;
  estimatedProfit: bigint;
  estimatedGasCost: bigint;
  confidence: number; // 0-1 scale
  metadata: Record<string, any>;
}

/**
 * Opportunity types
 */
export enum OpportunityType {
  ARBITRAGE = 'arbitrage',
  LIQUIDATION = 'liquidation',
  STABLE_POOL_REBALANCING = 'stable-pool-rebalancing',
  MEMPOOL_BACKRUN = 'mempool-backrun',
}

/**
 * Opportunity phases
 */
export enum OpportunityPhase {
  CROSS_DEX = 'cross-dex',
  LIQUIDATIONS = 'liquidations',
  STABLE_POOLS = 'stable-pools',
}

/**
 * Arbitrage opportunity
 */
export interface ArbitrageOpportunity extends BaseOpportunity {
  type: OpportunityType.ARBITRAGE;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  expectedAmountOut: bigint;
  route: SwapRoute[];
  spread: number;
}

/**
 * Liquidation opportunity
 */
export interface LiquidationOpportunity extends BaseOpportunity {
  type: OpportunityType.LIQUIDATION;
  protocol: string;
  borrower: Address;
  collateralToken: Address;
  debtToken: Address;
  collateralAmount: bigint;
  debtAmount: bigint;
  liquidationBonus: number;
  healthFactor: number;
}

/**
 * Stable pool rebalancing opportunity
 */
export interface StablePoolRebalancingOpportunity extends BaseOpportunity {
  type: OpportunityType.STABLE_POOL_REBALANCING;
  poolAddress: Address;
  token0: Address;
  token1: Address;
  imbalanceRatio: number;
  rebalanceAmount: bigint;
  incentiveReward: bigint;
}

/**
 * Swap route definition
 */
export interface SwapRoute {
  protocol: 'uniswap-v3' | 'aerodrome';
  poolAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
  expectedAmountOut: bigint;
}

/**
 * Execution result
 */
export interface ExecutionResult {
  opportunityId: string;
  success: boolean;
  profit?: bigint;
  gasCost?: bigint;
  executionTime: number;
  failureReason?: string;
  transactionHash?: string;
  blockNumber?: number;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
}

/**
 * Execution context
 */
export interface ExecutionContext {
  gasPrice: bigint;
  gasLimit: bigint;
  blockNumber: number;
  timestamp: number;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * Execution status
 */
export interface ExecutionStatus {
  isRunning: boolean;
  activeOpportunities: number;
  queuedOpportunities: number;
  successRate: number;
  avgLatency: number;
  circuitBreakerActive: boolean;
  circuitBreakerReason?: string;
  lastExecutionAt?: number;
}

/**
 * Execution capacity
 */
export interface ExecutionCapacity {
  maxConcurrentExecutions: number;
  currentExecutions: number;
  availableCapacity: number;
  queueLength: number;
  estimatedWaitTime: number;
}

/**
 * Execution priority levels
 */
export enum ExecutionPriority {
  LOW = 1,
  NORMAL = 2,
  HIGH = 3,
  CRITICAL = 4,
}

/**
 * Queued opportunity
 */
export interface QueuedOpportunity {
  opportunity: BaseOpportunity;
  priority: ExecutionPriority;
  queuedAt: number;
  estimatedExecutionTime: number;
}

/**
 * Execution engine interface
 */
export interface IExecutionEngine {
  canExecute(opportunity: BaseOpportunity): Promise<boolean>;
  execute(opportunity: BaseOpportunity, context: ExecutionContext): Promise<ExecutionResult>;
  estimateGas(opportunity: BaseOpportunity): Promise<bigint>;
  estimateExecutionTime(opportunity: BaseOpportunity): Promise<number>;
}

/**
 * Execution orchestrator configuration
 */
export interface ExecutionOrchestratorConfig {
  maxConcurrentExecutions: number;
  executionTimeoutMs: number;
  queueMaxSize: number;
  priorityWeights: Record<ExecutionPriority, number>;
  enableCircuitBreaker: boolean;
  circuitBreakerThreshold: number;
  circuitBreakerRecoveryTimeMs: number;
  enableGracefulShutdown: boolean;
  shutdownTimeoutMs: number;
}

/**
 * Resource allocation
 */
export interface ResourceAllocation {
  opportunityId: string;
  allocatedAt: number;
  estimatedDuration: number;
  resources: {
    gasLimit: bigint;
    flashLoanCapacity: bigint;
    relayCapacity: number;
  };
}

/**
 * Execution metrics
 */
export interface ExecutionMetrics {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  totalProfit: bigint;
  totalGasCost: bigint;
  avgExecutionTime: number;
  successRate: number;
  profitPerExecution: bigint;
  executionsByType: Record<OpportunityType, number>;
  executionsByPhase: Record<OpportunityPhase, number>;
}
