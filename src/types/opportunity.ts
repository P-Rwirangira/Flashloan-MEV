/**
 * Opportunity Types
 *
 * Types related to MEV opportunities (arbitrage, liquidation, rebalancing).
 */

import { BigNumberish } from 'ethers';
import { Address } from './common';

// Opportunity types
export type OpportunityType = 'arbitrage' | 'liquidation' | 'rebalance';

// Opportunity status
export enum OpportunityStatus {
  DETECTED = 'detected',
  SIMULATING = 'simulating',
  VALIDATED = 'validated',
  EXECUTING = 'executing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  EXPIRED = 'expired',
}

// Route information for DEX swaps
export interface Route {
  readonly pools: Address[];
  readonly fees: number[];
  readonly directions: boolean[];
  readonly expectedGas: number;
  readonly priceImpact: number; // in basis points
}

// Core opportunity interface
export interface Opportunity {
  readonly id: string;
  readonly timestamp: number;
  readonly type: OpportunityType;
  readonly status: OpportunityStatus;

  // Route information
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: BigNumberish;
  readonly expectedAmountOut: BigNumberish;

  // DEX routing
  readonly route: Route;
  readonly fallbackRoutes: Route[];

  // Profitability
  readonly flashFee: BigNumberish;
  readonly gasEstimate: BigNumberish;
  readonly expectedProfit: BigNumberish;
  readonly minProfit: BigNumberish;
  readonly profitMargin: number; // percentage

  // Execution parameters
  readonly slippageTolerance: number;
  readonly deadline: number;
  readonly maxBribe: BigNumberish;
  readonly priority: number; // 1-10 scale

  // Metadata
  readonly detectedAt: number;
  readonly expiresAt: number;
  readonly source: string;
}

// Arbitrage-specific opportunity
export interface ArbitrageOpportunity extends Opportunity {
  readonly type: 'arbitrage';
  readonly sourcePool: Address;
  readonly targetPool: Address;
  readonly sourceDex: string;
  readonly targetDex: string;
  readonly spread: number; // in basis points
  readonly spreadAfterCosts: number; // in basis points
}

// Liquidation-specific opportunity
export interface LiquidationOpportunity extends Opportunity {
  readonly type: 'liquidation';
  readonly protocol: string;
  readonly borrower: Address;
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly healthFactor: number;
  readonly liquidationBonus: number;
  readonly maxLiquidationAmount: BigNumberish;
  readonly collateralToSeize: BigNumberish;
}

// Rebalancing-specific opportunity
export interface RebalancingOpportunity extends Opportunity {
  readonly type: 'rebalance';
  readonly pool: Address;
  readonly poolType: 'stable' | 'volatile';
  readonly imbalance: number; // in basis points
  readonly incentiveRate: number;
  readonly targetRatio: number[];
  readonly currentRatio: number[];
}

// Opportunity execution result
export interface OpportunityResult {
  readonly opportunityId: string;
  readonly success: boolean;
  readonly txHash?: string;
  readonly actualProfit?: BigNumberish;
  readonly gasUsed?: number;
  readonly executionTime: number;
  readonly error?: string;
  readonly revertReason?: string;
}

// Opportunity metrics for analysis
export interface OpportunityMetrics {
  readonly id: string;
  readonly detectionLatency: number;
  readonly simulationLatency: number;
  readonly executionLatency: number;
  readonly totalLatency: number;
  readonly profitRealized: BigNumberish;
  readonly gasEfficiency: number; // profit per gas
  readonly competitionLevel: number; // 1-10 scale
}
