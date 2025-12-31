/**
 * Execution Types
 *
 * Types for transaction execution and result tracking
 */

import { DexType } from './dex';
import { Address } from './common';

export interface ExecutionResult {
  readonly success: boolean;
  readonly transactionHash?: string | undefined;
  readonly blockNumber?: number | undefined;
  readonly gasUsed?: bigint | undefined;
  readonly effectiveGasPrice?: bigint | undefined;
  readonly profit?: bigint | undefined;
  readonly profitUSD?: number | undefined;
  readonly executionTimeMs: number;
  readonly error?: string | undefined;
  readonly revertReason?: string | undefined;
}

export interface TransactionRequest {
  readonly to: Address;
  readonly data: string;
  readonly value?: bigint | undefined;
  readonly gasLimit?: bigint | undefined;
  readonly maxFeePerGas?: bigint | undefined;
  readonly maxPriorityFeePerGas?: bigint | undefined;
  readonly nonce?: number | undefined;
}

export interface ArbitrageRoute {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly path: ArbitrageStep[];
  readonly expectedProfit: bigint;
  readonly expectedProfitUSD: number;
}

export interface ArbitrageStep {
  readonly protocol: DexType;
  readonly poolAddress: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly direction: boolean; // true for token0->token1, false for token1->token0
  readonly fee?: number | undefined;
}

export interface ExecutionOptions {
  readonly dryRun?: boolean | undefined;
  readonly maxGasPrice?: bigint | undefined;
  readonly gasLimitMultiplier?: number | undefined;
  readonly slippageTolerance?: number | undefined;
  readonly deadline?: number | undefined;
  readonly usePrivateRelay?: boolean | undefined;
}

export interface ExecutionMetrics {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  totalProfit: bigint;
  totalProfitUSD: number;
  totalGasCost: bigint;
  averageExecutionTimeMs: number;
  successRate: number;
}
