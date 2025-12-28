/**
 * Opportunity Types
 *
 * Types related to MEV opportunities (arbitrage, liquidation, rebalancing).
 */

import { BigNumberish } from 'ethers';
import { Address } from './common';

// Opportunity types
export type OpportunityType = 'arbitrage' | 'liquidation' | 'rebalance';

// Route information for DEX swaps
export interface Route {
  readonly pools: Address[];
  readonly fees: number[];
  readonly directions: boolean[];
}

// Core opportunity interface
export interface Opportunity {
  readonly id: string;
  readonly timestamp: number;
  readonly type: OpportunityType;

  // Route information
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: BigNumberish;
  readonly expectedAmountOut: BigNumberish;

  // DEX routing
  readonly route: Route;

  // Profitability
  readonly flashFee: BigNumberish;
  readonly gasEstimate: BigNumberish;
  readonly expectedProfit: BigNumberish;
  readonly minProfit: BigNumberish;

  // Execution parameters
  readonly slippageTolerance: number;
  readonly deadline: number;
  readonly maxBribe: BigNumberish;
}

// Arbitrage-specific opportunity
export interface ArbitrageOpportunity extends Opportunity {
  readonly type: 'arbitrage';
  readonly sourcePool: Address;
  readonly targetPool: Address;
  readonly spread: number; // in basis points
}

// Liquidation-specific opportunity
export interface LiquidationOpportunity extends Opportunity {
  readonly type: 'liquidation';
  readonly borrower: Address;
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly healthFactor: number;
  readonly liquidationBonus: number;
}

// Rebalancing-specific opportunity
export interface RebalancingOpportunity extends Opportunity {
  readonly type: 'rebalance';
  readonly pool: Address;
  readonly imbalance: number; // in basis points
  readonly incentiveRate: number;
}
