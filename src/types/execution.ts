/**
 * Execution Types
 *
 * Core types for the execution engine system
 * Requirements: 1.1, 1.12, 1.15
 */

import { Address } from './common';

/**
 * Transaction request interface
 */
export interface TransactionRequest {
  to: Address;
  data: string;
  value?: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * Arbitrage route for execution
 */
export interface ArbitrageRoute {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  expectedAmountOut: bigint;
  swaps: SwapRoute[];
  path: SwapRoute[]; // Alias for swaps for backward compatibility
  estimatedGasCost: bigint;
  estimatedProfit: bigint;
  expectedProfit: bigint; // Alias for estimatedProfit for backward compatibility
  expectedProfitUSD?: number; // USD value of expected profit
}

/**
 * Execution options
 */
export interface ExecutionOptions {
  maxSlippageBps: number;
  gasLimitBuffer: number;
  priorityFeeMultiplier: number;
  usePrivateRelay: boolean;
  timeoutMs: number;
  slippageTolerance?: number; // 0-1 scale
  gasLimitMultiplier?: number; // Gas limit multiplier
  maxGasPrice?: bigint; // Maximum gas price
  maxPriorityFeePerGas?: bigint; // Maximum priority fee per gas
  dryRun?: boolean; // Dry run mode for testing
}

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
  maxLiquidationAmount: bigint;
  collateralToSeize: bigint;
  debtAsset: Address;
  collateralAsset: Address;
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
  currentImbalance: number;
  swapDirection: 'token0_to_token1' | 'token1_to_token0';
  expectedIncentives: bigint;
}

/**
 * Mempool backrun opportunity
 */
export interface MempoolBackrunOpportunity extends BaseOpportunity {
  type: OpportunityType.MEMPOOL_BACKRUN;
  targetTransaction: string;
  backrunType: 'arbitrage' | 'liquidation' | 'rebalancing' | 'sandwich' | 'frontrun';
  tokenIn?: Address;
  tokenOut?: Address;
  backrunAmount?: bigint;
  expectedAmountOut?: bigint;
  dexProtocol?: string;
  poolAddress?: Address;
  gasEstimate?: bigint;
  gasPrice?: bigint;
  timingRisk?: number;
  slippageRisk?: number;
  gasPriceVolatility?: number;
  liquidityRisk?: number;
  competitionRisk?: number;
  slippageImprovement?: number;
  targetTransactionValue?: bigint;
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
  direction: boolean; // Direction for swap (true for token0->token1, false for token1->token0)
}

/**
 * Execution result
 */
export interface ExecutionResult {
  opportunityId?: string;
  success: boolean;
  profit?: bigint | undefined;
  profitUSD?: number | undefined; // USD value of profit
  gasCost?: bigint | undefined;
  executionTime: number;
  executionTimeMs?: number | undefined; // Alias for executionTime for backward compatibility
  failureReason?: string | undefined;
  revertReason?: string | undefined; // Revert reason for failed transactions
  transactionHash?: string | undefined;
  blockNumber?: number | undefined;
  gasUsed?: bigint | undefined;
  effectiveGasPrice?: bigint | undefined;
  error?: string | undefined; // Error message for failed executions
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
  circuitBreakerReason?: string | undefined;
  lastExecutionAt?: number | undefined;
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
export interface ExecutionEngine {
  executeOpportunity(opportunity: BaseOpportunity): Promise<ExecutionResult>;
  getSupportedOpportunityTypes(): OpportunityType[];
  canHandleOpportunity(opportunity: any): boolean;
}

/**
 * Execution engine interface (legacy)
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
  totalProfitUSD?: number | undefined; // USD value of total profit
  totalGasCost: bigint;
  avgExecutionTime: number;
  averageExecutionTimeMs?: number | undefined; // Alias for avgExecutionTime for backward compatibility
  successRate: number;
  profitPerExecution: bigint;
  executionsByType: Record<OpportunityType, number>;
  executionsByPhase: Record<OpportunityPhase, number>;
}
