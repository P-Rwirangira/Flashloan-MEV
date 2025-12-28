/**
 * DEX Types
 *
 * Types for DEX-specific interfaces and data structures.
 */

import { BigNumberish } from 'ethers';
import { Address } from './common';

// DEX types
export type DexType = 'uniswap-v3' | 'aerodrome';

// Swap parameters
export interface SwapParams {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: BigNumberish;
  readonly amountOutMinimum: BigNumberish;
  readonly recipient: Address;
  readonly deadline: number;
}

// Uniswap V3 specific swap parameters
export interface UniswapV3SwapParams extends SwapParams {
  readonly fee: number;
  readonly sqrtPriceLimitX96: BigNumberish;
}

// Aerodrome specific swap parameters
export interface AerodromeSwapParams extends SwapParams {
  readonly stable: boolean;
}

// Flash loan parameters
export interface FlashLoanParams {
  readonly pool: Address;
  readonly amount0: BigNumberish;
  readonly amount1: BigNumberish;
  readonly data: string;
}

// DEX quote result
export interface Quote {
  readonly amountOut: BigNumberish;
  readonly gasEstimate: number;
  readonly priceImpact: number;
  readonly route: Address[];
}

// DEX interface
export interface DexInterface {
  readonly type: DexType;
  getQuote(params: SwapParams): Promise<Quote>;
  executeSwap(params: SwapParams): Promise<string>;
  getPoolState(poolAddress: Address): Promise<unknown>;
}
