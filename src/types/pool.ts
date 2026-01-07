/**
 * Pool State Types
 *
 * Types for tracking DEX pool states and reserves.
 */

import { BigNumberish } from 'ethers';
import { Address } from './common';

// Pool types
export enum PoolType {
  UNISWAP_V3 = 'uniswap-v3',
  AERODROME_VOLATILE = 'aerodrome-volatile',
  AERODROME_STABLE = 'aerodrome-stable',
}

// Base pool state interface
export interface PoolState {
  readonly address: Address;
  readonly type: PoolType;
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly lastUpdated: number;
  readonly blockNumber: number;
  readonly isActive: boolean;
}

// Uniswap V3 specific pool state
export interface UniswapV3PoolState extends PoolState {
  readonly type: PoolType.UNISWAP_V3;
  readonly sqrtPriceX96: BigNumberish;
  readonly tick: number;
  readonly liquidity: BigNumberish;
  readonly tickSpacing: number;
  readonly feeGrowthGlobal0X128?: BigNumberish;
  readonly feeGrowthGlobal1X128?: BigNumberish;
  readonly protocolFees?: {
    readonly token0: number;
    readonly token1: number;
  };
  readonly observationIndex?: number;
  readonly observationCardinality?: number;
}

// Aerodrome volatile pool state
export interface AerodromeVolatilePoolState extends PoolState {
  readonly type: PoolType.AERODROME_VOLATILE;
  readonly reserve0: BigNumberish;
  readonly reserve1: BigNumberish;
  readonly totalSupply: BigNumberish;
  readonly kLast: BigNumberish;
}

// Aerodrome stable pool state
export interface AerodromeStablePoolState extends PoolState {
  readonly type: PoolType.AERODROME_STABLE;
  readonly reserve0: BigNumberish;
  readonly reserve1: BigNumberish;
  readonly totalSupply: BigNumberish;
  readonly decimals0: number;
  readonly decimals1: number;
  readonly stable: true;
}

// Union type for all pool states
export type AnyPoolState =
  | UniswapV3PoolState
  | AerodromeVolatilePoolState
  | AerodromeStablePoolState;

// Pool update event
export interface PoolUpdateEvent {
  readonly poolAddress: Address;
  readonly poolType: PoolType;
  readonly blockNumber: number;
  readonly timestamp: number;
  readonly transactionHash: string;
  readonly eventType: 'swap' | 'mint' | 'burn' | 'sync' | 'collect';
  readonly data: Record<string, unknown>;
}

// Pool metrics for monitoring
export interface PoolMetrics {
  readonly address: Address;
  readonly type: PoolType;
  readonly tvl: BigNumberish;
  readonly volume24h: BigNumberish;
  readonly fees24h: BigNumberish;
  readonly apr: number;
  readonly utilization: number;
  readonly priceImpact1000: number; // Price impact for $1000 trade
  readonly lastTradeTimestamp: number;
}

// Pool configuration for monitoring
export interface PoolConfig {
  readonly address: Address;
  readonly type: PoolType;
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly minTvl: BigNumberish;
  readonly maxSlippage: number;
  readonly priority: number;
  readonly enabled: boolean;
}

// Pool price information
export interface PoolPrice {
  readonly poolAddress: Address;
  readonly token0Price: BigNumberish; // Price of token0 in terms of token1
  readonly token1Price: BigNumberish; // Price of token1 in terms of token0
  readonly timestamp: number;
  readonly blockNumber: number;
  readonly confidence: number; // 0-1 scale based on liquidity
}

// Pool type utilities
export const PoolTypeUtils = {
  /**
   * Check if pool type is supported
   */
  isSupportedPoolType: (type: string): type is PoolType => {
    return Object.values(PoolType).includes(type as PoolType);
  },

  /**
   * Get pool type display name
   */
  getPoolTypeDisplayName: (type: PoolType): string => {
    switch (type) {
      case PoolType.UNISWAP_V3:
        return 'Uniswap V3';
      case PoolType.AERODROME_VOLATILE:
        return 'Aerodrome Volatile';
      case PoolType.AERODROME_STABLE:
        return 'Aerodrome Stable';
      default:
        return 'Unknown Pool Type';
    }
  },

  /**
   * Check if pool type uses constant product formula
   */
  isConstantProductPool: (type: PoolType): boolean => {
    return type === PoolType.AERODROME_VOLATILE;
  },

  /**
   * Check if pool type uses stable swap formula
   */
  isStableSwapPool: (type: PoolType): boolean => {
    return type === PoolType.AERODROME_STABLE;
  },

  /**
   * Check if pool type uses concentrated liquidity
   */
  isConcentratedLiquidityPool: (type: PoolType): boolean => {
    return type === PoolType.UNISWAP_V3;
  },

  /**
   * Get default fee for pool type
   */
  getDefaultFee: (type: PoolType): number => {
    switch (type) {
      case PoolType.UNISWAP_V3:
        throw new Error('Fee bps not configured for pool type');
      case PoolType.AERODROME_VOLATILE:
        throw new Error('Fee bps not configured for pool type');
      case PoolType.AERODROME_STABLE:
        return 200; // 0.02%
      default:
        throw new Error('Fee bps not configured for pool type');
    }
  },

  /**
   * Validate pool state based on type
   */
  validatePoolState: (state: AnyPoolState): boolean => {
    if (!state.address || !state.token0 || !state.token1) {
      return false;
    }
    if (state.token0 === state.token1) {
      return false;
    }
    if (state.fee < 0) {
      return false;
    }
    if (state.lastUpdated <= 0 || state.blockNumber <= 0) {
      return false;
    }

    // Type-specific validation
    switch (state.type) {
      case PoolType.UNISWAP_V3: {
        const v3State = state as UniswapV3PoolState;
        return (
          BigInt(v3State.sqrtPriceX96.toString()) > 0n && BigInt(v3State.liquidity.toString()) >= 0n
        );
      }

      case PoolType.AERODROME_VOLATILE: {
        const volatileState = state as AerodromeVolatilePoolState;
        return (
          BigInt(volatileState.reserve0.toString()) >= 0n &&
          BigInt(volatileState.reserve1.toString()) >= 0n
        );
      }

      case PoolType.AERODROME_STABLE: {
        const stableState = state as AerodromeStablePoolState;
        return (
          BigInt(stableState.reserve0.toString()) >= 0n &&
          BigInt(stableState.reserve1.toString()) >= 0n &&
          stableState.decimals0 > 0 &&
          stableState.decimals1 > 0
        );
      }

      default:
        return false;
    }
  },

  /**
   * Get pool type priority for routing
   */
  getPoolTypePriority: (type: PoolType): number => {
    switch (type) {
      case PoolType.UNISWAP_V3:
        return 3; // Highest priority - concentrated liquidity
      case PoolType.AERODROME_VOLATILE:
        return 2; // Medium priority - volatile pairs
      case PoolType.AERODROME_STABLE:
        return 1; // Lower priority - stable pairs only
      default:
        return 0;
    }
  },
};
