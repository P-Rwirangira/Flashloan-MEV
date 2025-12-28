/**
 * DEX Types
 *
 * Types for DEX-specific interfaces and data structures.
 */

import { BigNumberish } from 'ethers';
import { Address } from './common';

// DEX types
export enum DexType {
  UNISWAP_V3 = 'uniswap-v3',
  AERODROME = 'aerodrome',
}

// Swap direction
export enum SwapDirection {
  TOKEN0_TO_TOKEN1 = 0,
  TOKEN1_TO_TOKEN0 = 1,
}

// Base swap parameters
export interface SwapParams {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: BigNumberish;
  readonly amountOutMinimum: BigNumberish;
  readonly recipient: Address;
  readonly deadline: number;
  readonly slippageTolerance: number;
}

// Uniswap V3 specific swap parameters
export interface UniswapV3SwapParams extends SwapParams {
  readonly fee: number;
  readonly sqrtPriceLimitX96: BigNumberish;
  readonly tickSpacing: number;
}

// Aerodrome specific swap parameters
export interface AerodromeSwapParams extends SwapParams {
  readonly stable: boolean;
  readonly factory: Address;
}

// Flash loan parameters
export interface FlashLoanParams {
  readonly pool: Address;
  readonly amount0: BigNumberish;
  readonly amount1: BigNumberish;
  readonly data: string;
  readonly recipient: Address;
}

// DEX quote result
export interface Quote {
  readonly dex: DexType;
  readonly pool: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: BigNumberish;
  readonly amountOut: BigNumberish;
  readonly gasEstimate: number;
  readonly priceImpact: number; // in basis points
  readonly route: Address[];
  readonly fee: number;
  readonly timestamp: number;
  readonly valid: boolean;
}

// Multi-DEX quote comparison
export interface QuoteComparison {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: BigNumberish;
  readonly quotes: Quote[];
  readonly bestQuote: Quote;
  readonly spread: number; // in basis points
  readonly timestamp: number;
}

// DEX liquidity information
export interface LiquidityInfo {
  readonly pool: Address;
  readonly dex: DexType;
  readonly token0: Address;
  readonly token1: Address;
  readonly liquidity: BigNumberish;
  readonly tvl: BigNumberish;
  readonly volume24h: BigNumberish;
  readonly fees24h: BigNumberish;
  readonly utilization: number;
}

// DEX pool discovery result
export interface PoolDiscovery {
  readonly token0: Address;
  readonly token1: Address;
  readonly pools: {
    readonly address: Address;
    readonly dex: DexType;
    readonly fee: number;
    readonly liquidity: BigNumberish;
    readonly active: boolean;
  }[];
}

// DEX interface for abstraction
export interface DexInterface {
  readonly type: DexType;
  readonly name: string;
  readonly factory: Address;
  readonly router?: Address;

  // Core functions
  getQuote(params: SwapParams): Promise<Quote>;
  executeSwap(params: SwapParams): Promise<string>;
  getPoolState(poolAddress: Address): Promise<unknown>;
  getLiquidity(token0: Address, token1: Address): Promise<LiquidityInfo[]>;

  // Pool discovery
  findPools(token0: Address, token1: Address): Promise<Address[]>;
  getPoolInfo(poolAddress: Address): Promise<LiquidityInfo>;

  // Price functions
  getPrice(tokenIn: Address, tokenOut: Address, amountIn: BigNumberish): Promise<BigNumberish>;
  getPriceImpact(tokenIn: Address, tokenOut: Address, amountIn: BigNumberish): Promise<number>;
}

// Swap execution result
export interface SwapResult {
  readonly success: boolean;
  readonly txHash?: string;
  readonly amountIn: BigNumberish;
  readonly amountOut: BigNumberish;
  readonly gasUsed: number;
  readonly effectivePrice: BigNumberish;
  readonly priceImpact: number;
  readonly error?: string;
}

// DEX aggregator result
export interface AggregatorResult {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: BigNumberish;
  readonly bestRoute: {
    readonly dex: DexType;
    readonly pool: Address;
    readonly amountOut: BigNumberish;
    readonly gasEstimate: number;
    readonly priceImpact: number;
  };
  readonly allRoutes: Quote[];
  readonly savings: BigNumberish; // vs worst route
  readonly timestamp: number;
}
