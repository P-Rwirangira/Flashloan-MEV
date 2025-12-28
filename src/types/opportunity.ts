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

// Opportunity status utilities
export const OpportunityUtils = {
  /**
   * Check if opportunity is in a terminal state
   */
  isTerminalStatus: (status: OpportunityStatus): boolean => {
    return (
      status === OpportunityStatus.COMPLETED ||
      status === OpportunityStatus.FAILED ||
      status === OpportunityStatus.EXPIRED
    );
  },

  /**
   * Check if opportunity is actively being processed
   */
  isActiveStatus: (status: OpportunityStatus): boolean => {
    return status === OpportunityStatus.SIMULATING || status === OpportunityStatus.EXECUTING;
  },

  /**
   * Check if opportunity can be executed
   */
  canExecute: (status: OpportunityStatus): boolean => {
    return status === OpportunityStatus.VALIDATED;
  },

  /**
   * Get next valid status transitions
   */
  getValidTransitions: (currentStatus: OpportunityStatus): OpportunityStatus[] => {
    switch (currentStatus) {
      case OpportunityStatus.DETECTED:
        return [OpportunityStatus.SIMULATING, OpportunityStatus.EXPIRED];
      case OpportunityStatus.SIMULATING:
        return [OpportunityStatus.VALIDATED, OpportunityStatus.FAILED, OpportunityStatus.EXPIRED];
      case OpportunityStatus.VALIDATED:
        return [OpportunityStatus.EXECUTING, OpportunityStatus.EXPIRED];
      case OpportunityStatus.EXECUTING:
        return [OpportunityStatus.COMPLETED, OpportunityStatus.FAILED];
      case OpportunityStatus.COMPLETED:
      case OpportunityStatus.FAILED:
      case OpportunityStatus.EXPIRED:
        return []; // Terminal states
      default:
        return [];
    }
  },

  /**
   * Validate status transition
   */
  isValidTransition: (from: OpportunityStatus, to: OpportunityStatus): boolean => {
    return OpportunityUtils.getValidTransitions(from).includes(to);
  },

  /**
   * Get status priority for processing order
   */
  getStatusPriority: (status: OpportunityStatus): number => {
    switch (status) {
      case OpportunityStatus.VALIDATED:
        return 5; // Highest priority - ready to execute
      case OpportunityStatus.EXECUTING:
        return 4; // High priority - currently executing
      case OpportunityStatus.SIMULATING:
        return 3; // Medium priority - being validated
      case OpportunityStatus.DETECTED:
        return 2; // Lower priority - needs simulation
      case OpportunityStatus.FAILED:
      case OpportunityStatus.EXPIRED:
      case OpportunityStatus.COMPLETED:
        return 1; // Lowest priority - terminal states
      default:
        return 0;
    }
  },

  /**
   * Format status for display
   */
  formatStatus: (status: OpportunityStatus): string => {
    switch (status) {
      case OpportunityStatus.DETECTED:
        return 'Detected';
      case OpportunityStatus.SIMULATING:
        return 'Simulating';
      case OpportunityStatus.VALIDATED:
        return 'Validated';
      case OpportunityStatus.EXECUTING:
        return 'Executing';
      case OpportunityStatus.COMPLETED:
        return 'Completed';
      case OpportunityStatus.FAILED:
        return 'Failed';
      case OpportunityStatus.EXPIRED:
        return 'Expired';
      default:
        return 'Unknown';
    }
  },

  /**
   * Check if opportunity has expired
   */
  isExpired: (opportunity: Opportunity): boolean => {
    return Date.now() > opportunity.expiresAt || opportunity.status === OpportunityStatus.EXPIRED;
  },

  /**
   * Calculate opportunity age in milliseconds
   */
  getAge: (opportunity: Opportunity): number => {
    return Date.now() - opportunity.detectedAt;
  },
};
