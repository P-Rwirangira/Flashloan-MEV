/**
 * Pool State Types
 *
 * Types for tracking DEX pool states and reserves.
 */

import { BigNumberish } from 'ethers';
import { Address } from './common';

// Base pool state interface
export interface PoolState {
  readonly address: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly lastUpdated: number;
}

// Uniswap V3 specific pool state
export interface UniswapV3PoolState extends PoolState {
  readonly sqrtPriceX96: BigNumberish;
  readonly tick: number;
  readonly liquidity: BigNumberish;
  readonly feeGrowthGlobal0X128: BigNumberish;
  readonly feeGrowthGlobal1X128: BigNumberish;
}

// Aerodrome specific pool state
export interface AerodromePoolState extends PoolState {
  readonly reserve0: BigNumberish;
  readonly reserve1: BigNumberish;
  readonly stable: boolean;
  readonly totalSupply: BigNumberish;
}

// Pool update event
export interface PoolUpdateEvent {
  readonly poolAddress: Address;
  readonly blockNumber: number;
  readonly timestamp: number;
  readonly eventType: 'swap' | 'mint' | 'burn' | 'sync';
  readonly data: Record<string, unknown>;
}

// Pool metrics for monitoring
export interface PoolMetrics {
  readonly address: Address;
  readonly tvl: BigNumberish;
  readonly volume24h: BigNumberish;
  readonly fees24h: BigNumberish;
  readonly apr: number;
  readonly utilization: number;
}
