/**
 * Uniswap V3 Contracts
 *
 * TypeScript interfaces for Uniswap V3 contracts.
 */

import { BigNumberish } from 'ethers';
import { Address } from '../types/common';

/**
 * Uniswap V3 Pool interface
 */
export interface IUniswapV3Pool {
  /**
   * Get pool token addresses
   */
  token0(): Promise<Address>;
  token1(): Promise<Address>;

  /**
   * Get pool fee tier
   */
  fee(): Promise<number>;

  /**
   * Get current pool state
   */
  slot0(): Promise<{
    sqrtPriceX96: BigNumberish;
    tick: number;
    observationIndex: number;
    observationCardinality: number;
    observationCardinalityNext: number;
    feeProtocol: number;
    unlocked: boolean;
  }>;

  /**
   * Get pool liquidity
   */
  liquidity(): Promise<BigNumberish>;

  /**
   * Execute flash loan
   * @param recipient Address to receive flash loan
   * @param amount0 Amount of token0 to flash loan
   * @param amount1 Amount of token1 to flash loan
   * @param data Callback data
   */
  flash(
    recipient: Address,
    amount0: BigNumberish,
    amount1: BigNumberish,
    data: string
  ): Promise<void>;

  /**
   * Execute swap
   * @param recipient Address to receive output tokens
   * @param zeroForOne Direction of swap (token0 -> token1 if true)
   * @param amountSpecified Amount to swap (negative for exact output)
   * @param sqrtPriceLimitX96 Price limit for swap
   * @param data Callback data
   */
  swap(
    recipient: Address,
    zeroForOne: boolean,
    amountSpecified: BigNumberish,
    sqrtPriceLimitX96: BigNumberish,
    data: string
  ): Promise<{
    amount0: BigNumberish;
    amount1: BigNumberish;
  }>;

  /**
   * Get tick spacing for pool
   */
  tickSpacing(): Promise<number>;

  /**
   * Get pool reserves at specific tick
   */
  ticks(tick: number): Promise<{
    liquidityGross: BigNumberish;
    liquidityNet: BigNumberish;
    feeGrowthOutside0X128: BigNumberish;
    feeGrowthOutside1X128: BigNumberish;
    tickCumulativeOutside: BigNumberish;
    secondsPerLiquidityOutsideX128: BigNumberish;
    secondsOutside: number;
    initialized: boolean;
  }>;
}

/**
 * Uniswap V3 Factory interface
 */
export interface IUniswapV3Factory {
  /**
   * Get pool address for token pair and fee
   * @param tokenA First token address
   * @param tokenB Second token address
   * @param fee Fee tier
   */
  getPool(tokenA: Address, tokenB: Address, fee: number): Promise<Address>;

  /**
   * Create new pool
   * @param tokenA First token address
   * @param tokenB Second token address
   * @param fee Fee tier
   */
  createPool(tokenA: Address, tokenB: Address, fee: number): Promise<Address>;

  /**
   * Get fee amount for fee tier
   * @param fee Fee tier
   */
  feeAmountTickSpacing(fee: number): Promise<number>;

  /**
   * Get pool creation parameters
   */
  parameters(): Promise<{
    factory: Address;
    token0: Address;
    token1: Address;
    fee: number;
    tickSpacing: number;
  }>;
}

/**
 * Uniswap V3 Flash Callback interface
 * Must be implemented by contracts receiving flash loans
 */
export interface IUniswapV3FlashCallback {
  /**
   * Called by Uniswap V3 pool during flash loan
   * @param fee0 Fee for token0 flash loan
   * @param fee1 Fee for token1 flash loan
   * @param data Callback data passed to flash function
   */
  uniswapV3FlashCallback(
    fee0: BigNumberish,
    fee1: BigNumberish,
    data: string
  ): Promise<void>;
}

/**
 * Uniswap V3 Swap Callback interface
 * Must be implemented by contracts executing swaps
 */
export interface IUniswapV3SwapCallback {
  /**
   * Called by Uniswap V3 pool during swap
   * @param amount0Delta Change in token0 balance
   * @param amount1Delta Change in token1 balance
   * @param data Callback data passed to swap function
   */
  uniswapV3SwapCallback(
    amount0Delta: BigNumberish,
    amount1Delta: BigNumberish,
    data: string
  ): Promise<void>;
}

/**
 * Uniswap V3 pool state information
 */
export interface UniswapV3PoolState {
  readonly address: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly sqrtPriceX96: BigNumberish;
  readonly tick: number;
  readonly liquidity: BigNumberish;
  readonly feeGrowthGlobal0X128: BigNumberish;
  readonly feeGrowthGlobal1X128: BigNumberish;
  readonly lastUpdated: number;
}

/**
 * Flash loan parameters
 */
export interface FlashLoanParams {
  readonly pool: Address;
  readonly amount0: BigNumberish;
  readonly amount1: BigNumberish;
  readonly recipient: Address;
  readonly callbackData: string;
}

/**
 * Swap parameters
 */
export interface SwapParams {
  readonly pool: Address;
  readonly recipient: Address;
  readonly zeroForOne: boolean;
  readonly amountSpecified: BigNumberish;
  readonly sqrtPriceLimitX96: BigNumberish;
  readonly callbackData: string;
}

/**
 * Pool creation parameters
 */
export interface PoolCreationParams {
  readonly tokenA: Address;
  readonly tokenB: Address;
  readonly fee: number;
  readonly initialPrice?: BigNumberish;
}

/**
 * Uniswap V3 constants
 */
export const UNISWAP_V3_CONSTANTS = {
  // Fee tiers (in hundredths of a bip)
  FEE_TIERS: {
    LOW: 500, // 0.05%
    MEDIUM: 3000, // 0.3%
    HIGH: 10000, // 1%
  },
  
  // Tick spacing for each fee tier
  TICK_SPACINGS: {
    500: 10,
    3000: 60,
    10000: 200,
  },
  
  // Price limits
  MIN_SQRT_RATIO: 4295128739n,
  MAX_SQRT_RATIO: 1461446703485210103287273052203988822378723970342n,
  
  // Pool initialization code hash
  POOL_INIT_CODE_HASH: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
} as const;
