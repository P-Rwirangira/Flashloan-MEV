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
  readonly feeGrowthGlobal0X128: BigNumberish;
  readonly feeGrowthGlobal1X128: BigNumberish;
  readonly protocolFees: {
    readonly token0: number;
    readonly token1: number;
  };
  readonly observationIndex: number;
  readonly observationCardinality: number;
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
