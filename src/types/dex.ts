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

// Pool information for route optimization
export interface PoolInfo {
  readonly address: Address;
  readonly dex: string;
  readonly token0: Address;
  readonly token1: Address;
  readonly fee?: number;
  readonly liquidity?: bigint;
  readonly reserve0?: bigint;
  readonly reserve1?: bigint;
  readonly active: boolean;
}

// DEX information for route optimization
export interface DEXInfo {
  readonly name: string;
  readonly protocol: string;
  readonly version: string;
  readonly factory: Address;
  readonly router?: Address;
  readonly fee: number;
  readonly gasEstimate: bigint;
  readonly enabled: boolean;
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

// Utility functions for DEX types
export const DexUtils = {
  /**
   * Check if a DEX type is supported
   */
  isSupportedDex: (dex: string): dex is DexType => {
    return Object.values(DexType).includes(dex as DexType);
  },

  /**
   * Get DEX display name
   */
  getDexDisplayName: (dex: DexType): string => {
    switch (dex) {
      case DexType.UNISWAP_V3:
        return 'Uniswap V3';
      case DexType.AERODROME:
        return 'Aerodrome';
      default:
        return 'Unknown DEX';
    }
  },

  /**
   * Determine swap direction from token addresses
   */
  getSwapDirection: (
    tokenIn: Address,
    tokenOut: Address,
    token0: Address,
    token1: Address
  ): SwapDirection => {
    if (
      tokenIn.toLowerCase() === token0.toLowerCase() &&
      tokenOut.toLowerCase() === token1.toLowerCase()
    ) {
      return SwapDirection.TOKEN0_TO_TOKEN1;
    } else if (
      tokenIn.toLowerCase() === token1.toLowerCase() &&
      tokenOut.toLowerCase() === token0.toLowerCase()
    ) {
      return SwapDirection.TOKEN1_TO_TOKEN0;
    }
    throw new Error(
      `Invalid token pair: ${tokenIn}->${tokenOut} not found in pool tokens ${token0}, ${token1}`
    );
  },

  /**
   * Validate swap parameters
   */
  validateSwapParams: (params: SwapParams): void => {
    if (!params.tokenIn || !params.tokenOut) {
      throw new Error('Token addresses are required');
    }
    if (params.tokenIn === params.tokenOut) {
      throw new Error('Cannot swap same token');
    }
    if (!params.amountIn || BigInt(params.amountIn.toString()) <= 0n) {
      throw new Error('Amount in must be greater than 0');
    }
    if (!params.recipient) {
      throw new Error('Recipient address is required');
    }
    if (params.deadline <= Math.floor(Date.now() / 1000)) {
      throw new Error('Deadline must be in the future');
    }
  },

  /**
   * Validate pool discovery parameters
   */
  validatePoolDiscovery: (token0: Address, token1: Address): void => {
    if (!token0 || !token1) {
      throw new Error('Both token addresses are required');
    }
    if (token0 === token1) {
      throw new Error('Token addresses must be different');
    }
  },

  /**
   * Validate quote parameters
   */
  validateQuoteParams: (tokenIn: Address, tokenOut: Address, amountIn: BigNumberish): void => {
    if (!tokenIn || !tokenOut) {
      throw new Error('Token addresses are required for quote');
    }
    if (tokenIn === tokenOut) {
      throw new Error('Cannot quote same token');
    }
    if (!amountIn || BigInt(amountIn.toString()) <= 0n) {
      throw new Error('Amount must be greater than 0 for quote');
    }
  },
};

// Pool state validation utilities
export const PoolUtils = {
  /**
   * Validate pool address and token pair
   */
  validatePoolState: (poolAddress: Address, token0: Address, token1: Address): void => {
    if (!poolAddress) {
      throw new Error('Pool address is required');
    }
    if (!token0 || !token1) {
      throw new Error('Token addresses are required');
    }
    if (token0 === token1) {
      throw new Error('Pool tokens must be different');
    }
  },
};
