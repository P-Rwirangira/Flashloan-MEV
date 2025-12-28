/**
 * Aerodrome Contracts
 *
 * TypeScript interfaces for Aerodrome contracts.
 */

import { BigNumberish } from 'ethers';
import { Address } from '../types/common';

/**
 * Aerodrome Pair interface (for both volatile and stable pools)
 */
export interface IAerodromePair {
  /**
   * Get pair token addresses
   */
  token0(): Promise<Address>;
  token1(): Promise<Address>;

  /**
   * Check if pair is stable (uses stable swap formula)
   */
  stable(): Promise<boolean>;

  /**
   * Get current reserves
   */
  getReserves(): Promise<{
    reserve0: BigNumberish;
    reserve1: BigNumberish;
    blockTimestampLast: number;
  }>;

  /**
   * Execute swap
   * @param amount0Out Amount of token0 to receive
   * @param amount1Out Amount of token1 to receive
   * @param to Address to receive output tokens
   * @param data Callback data (empty for direct swaps)
   */
  swap(
    amount0Out: BigNumberish,
    amount1Out: BigNumberish,
    to: Address,
    data: string
  ): Promise<void>;

  /**
   * Get amount out for given input (view function)
   * @param amountIn Input amount
   * @param tokenIn Input token address
   */
  getAmountOut(amountIn: BigNumberish, tokenIn: Address): Promise<BigNumberish>;

  /**
   * Sync reserves with actual balances
   */
  sync(): Promise<void>;

  /**
   * Skim excess tokens to address
   * @param to Address to receive excess tokens
   */
  skim(to: Address): Promise<void>;

  /**
   * Get current price (token1 per token0)
   */
  current(tokenIn: Address, amountIn: BigNumberish): Promise<BigNumberish>;

  /**
   * Get sample price over time window
   * @param tokenIn Input token
   * @param amountIn Input amount
   * @param points Number of sample points
   * @param window Time window in seconds
   */
  sample(
    tokenIn: Address,
    amountIn: BigNumberish,
    points: number,
    window: number
  ): Promise<BigNumberish[]>;

  /**
   * Get pair metadata
   */
  metadata(): Promise<{
    dec0: number;
    dec1: number;
    r0: BigNumberish;
    r1: BigNumberish;
    st: boolean;
    t0: Address;
    t1: Address;
  }>;
}

/**
 * Aerodrome Factory interface
 */
export interface IAerodromeFactory {
  /**
   * Get pair address for token pair
   * @param tokenA First token address
   * @param tokenB Second token address
   * @param stable Whether to use stable swap formula
   */
  getPair(tokenA: Address, tokenB: Address, stable: boolean): Promise<Address>;

  /**
   * Create new pair
   * @param tokenA First token address
   * @param tokenB Second token address
   * @param stable Whether to use stable swap formula
   */
  createPair(tokenA: Address, tokenB: Address, stable: boolean): Promise<Address>;

  /**
   * Check if pair exists
   * @param tokenA First token address
   * @param tokenB Second token address
   * @param stable Whether stable pair
   */
  isPair(tokenA: Address, tokenB: Address, stable: boolean): Promise<boolean>;

  /**
   * Get all pairs length
   */
  allPairsLength(): Promise<number>;

  /**
   * Get pair at index
   * @param index Pair index
   */
  allPairs(index: number): Promise<Address>;

  /**
   * Get fee for pair type
   * @param stable Whether stable pair
   */
  getFee(stable: boolean): Promise<number>;
}

/**
 * Aerodrome Router interface (for reference, but we'll use direct swaps)
 */
export interface IAerodromeRouter {
  /**
   * Get amounts out for swap path
   * @param amountIn Input amount
   * @param routes Swap route array
   */
  getAmountsOut(amountIn: BigNumberish, routes: SwapRoute[]): Promise<BigNumberish[]>;

  /**
   * Execute exact input swap
   * @param amountIn Input amount
   * @param amountOutMin Minimum output amount
   * @param routes Swap routes
   * @param to Recipient address
   * @param deadline Transaction deadline
   */
  swapExactTokensForTokens(
    amountIn: BigNumberish,
    amountOutMin: BigNumberish,
    routes: SwapRoute[],
    to: Address,
    deadline: number
  ): Promise<BigNumberish[]>;
}

/**
 * Aerodrome swap route structure
 */
export interface SwapRoute {
  readonly from: Address;
  readonly to: Address;
  readonly stable: boolean;
}

/**
 * Aerodrome pair state information
 */
export interface AerodromePairState {
  readonly address: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly stable: boolean;
  readonly reserve0: BigNumberish;
  readonly reserve1: BigNumberish;
  readonly totalSupply: BigNumberish;
  readonly fee: number;
  readonly lastUpdated: number;
}

/**
 * Stable swap calculation parameters
 */
export interface StableSwapParams {
  readonly reserve0: BigNumberish;
  readonly reserve1: BigNumberish;
  readonly decimals0: number;
  readonly decimals1: number;
  readonly amountIn: BigNumberish;
  readonly tokenIn: Address;
}

/**
 * Volatile swap calculation parameters
 */
export interface VolatileSwapParams {
  readonly reserve0: BigNumberish;
  readonly reserve1: BigNumberish;
  readonly amountIn: BigNumberish;
  readonly tokenIn: Address;
  readonly fee: number;
}

/**
 * Aerodrome pair creation parameters
 */
export interface PairCreationParams {
  readonly tokenA: Address;
  readonly tokenB: Address;
  readonly stable: boolean;
}

/**
 * Swap execution parameters for direct pair interaction
 */
export interface DirectSwapParams {
  readonly pair: Address;
  readonly amountIn: BigNumberish;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly to: Address;
  readonly stable: boolean;
}

/**
 * Aerodrome constants
 */
export const AERODROME_CONSTANTS = {
  // Fee rates (in basis points)
  FEES: {
    VOLATILE: 30, // 0.3%
    STABLE: 1, // 0.01%
  },

  // Minimum liquidity for new pairs
  MINIMUM_LIQUIDITY: 1000n,

  // Maximum fee (in basis points)
  MAX_FEE: 10000, // 100%

  // Stable swap A parameter (amplification coefficient)
  STABLE_A: 85n,

  // Precision for stable swap calculations
  STABLE_PRECISION: 10n ** 18n,
} as const;

/**
 * Aerodrome gauge interface (for incentivized pools)
 */
export interface IAerodromeGauge {
  /**
   * Get staking token (LP token)
   */
  stakingToken(): Promise<Address>;

  /**
   * Get rewards token
   */
  rewardsToken(): Promise<Address>;

  /**
   * Get total supply of staked tokens
   */
  totalSupply(): Promise<BigNumberish>;

  /**
   * Get user staked balance
   * @param account User address
   */
  balanceOf(account: Address): Promise<BigNumberish>;

  /**
   * Get current reward rate
   */
  rewardRate(): Promise<BigNumberish>;

  /**
   * Get earned rewards for user
   * @param account User address
   */
  earned(account: Address): Promise<BigNumberish>;

  /**
   * Stake LP tokens
   * @param amount Amount to stake
   */
  stake(amount: BigNumberish): Promise<void>;

  /**
   * Withdraw staked tokens
   * @param amount Amount to withdraw
   */
  withdraw(amount: BigNumberish): Promise<void>;

  /**
   * Claim rewards
   */
  getReward(): Promise<void>;
}

/**
 * Gauge information for incentivized pools
 */
export interface GaugeInfo {
  readonly address: Address;
  readonly stakingToken: Address;
  readonly rewardsToken: Address;
  readonly totalSupply: BigNumberish;
  readonly rewardRate: BigNumberish;
  readonly periodFinish: number;
  readonly lastUpdateTime: number;
  readonly rewardPerTokenStored: BigNumberish;
}

/**
 * Aerodrome validation utilities
 */
export const AerodromeUtils = {
  /**
   * Validate swap parameters
   */
  validateSwapParams: (
    amount0Out: BigNumberish,
    amount1Out: BigNumberish,
    to: Address,
    data: string
  ): boolean => {
    if (BigInt(amount0Out.toString()) < 0n || BigInt(amount1Out.toString()) < 0n) {
      return false;
    }
    if (BigInt(amount0Out.toString()) === 0n && BigInt(amount1Out.toString()) === 0n) {
      return false;
    }
    if (!to || to === '0x0000000000000000000000000000000000000000') {
      return false;
    }
    // Data can be empty for direct swaps
    return typeof data === 'string';
  },

  /**
   * Validate amount out parameters
   */
  validateAmountOut: (amountIn: BigNumberish, tokenIn: Address): boolean => {
    if (BigInt(amountIn.toString()) <= 0n) {
      return false;
    }
    if (!tokenIn || tokenIn === '0x0000000000000000000000000000000000000000') {
      return false;
    }
    return true;
  },

  /**
   * Validate skim parameters
   */
  validateSkimParams: (to: Address): boolean => {
    return to !== '0x0000000000000000000000000000000000000000';
  },

  /**
   * Validate current price parameters
   */
  validateCurrentParams: (tokenIn: Address, amountIn: BigNumberish): boolean => {
    if (!tokenIn || tokenIn === '0x0000000000000000000000000000000000000000') {
      return false;
    }
    return BigInt(amountIn.toString()) > 0n;
  },

  /**
   * Validate sample parameters
   */
  validateSampleParams: (
    tokenIn: Address,
    amountIn: BigNumberish,
    points: number,
    window: number
  ): boolean => {
    if (!tokenIn || tokenIn === '0x0000000000000000000000000000000000000000') {
      return false;
    }
    if (BigInt(amountIn.toString()) <= 0n) {
      return false;
    }
    if (points <= 0 || points > 100) {
      return false;
    }
    if (window <= 0 || window > 86400) {
      // Max 24 hours
      return false;
    }
    return true;
  },

  /**
   * Validate factory pair parameters
   */
  validatePairParams: (tokenA: Address, tokenB: Address, stable: boolean): boolean => {
    if (!tokenA || !tokenB) {
      return false;
    }
    if (tokenA === tokenB) {
      return false;
    }
    if (
      tokenA === '0x0000000000000000000000000000000000000000' ||
      tokenB === '0x0000000000000000000000000000000000000000'
    ) {
      return false;
    }
    return typeof stable === 'boolean';
  },

  /**
   * Validate factory index parameter
   */
  validateIndexParam: (index: number): boolean => {
    return index >= 0 && Number.isInteger(index);
  },

  /**
   * Validate stable parameter for fee calculation
   */
  validateStableParam: (stable: boolean): boolean => {
    return typeof stable === 'boolean';
  },

  /**
   * Validate router swap parameters
   */
  validateRouterSwapParams: (amountIn: BigNumberish, routes: any[]): boolean => {
    if (BigInt(amountIn.toString()) <= 0n) {
      return false;
    }
    if (!Array.isArray(routes) || routes.length === 0) {
      return false;
    }
    return true;
  },

  /**
   * Validate exact tokens for tokens swap parameters
   */
  validateExactTokensSwapParams: (
    amountIn: BigNumberish,
    amountOutMin: BigNumberish,
    routes: any[],
    to: Address,
    deadline: number
  ): boolean => {
    if (BigInt(amountIn.toString()) <= 0n || BigInt(amountOutMin.toString()) < 0n) {
      return false;
    }
    if (!Array.isArray(routes) || routes.length === 0) {
      return false;
    }
    if (!to || to === '0x0000000000000000000000000000000000000000') {
      return false;
    }
    if (deadline <= Date.now() / 1000) {
      return false;
    }
    return true;
  },

  /**
   * Validate gauge account parameter
   */
  validateAccountParam: (account: Address): boolean => {
    return account !== '0x0000000000000000000000000000000000000000';
  },

  /**
   * Validate gauge amount parameter
   */
  validateAmountParam: (amount: BigNumberish): boolean => {
    return BigInt(amount.toString()) > 0n;
  },
};
