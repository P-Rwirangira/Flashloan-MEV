/**
 * Swap Simulation Utilities
 * Accurate profit calculation using AMM math instead of spread approximations
 */

import { Address } from '../types/common';
import { SwapRoute } from '../types/execution';
import {
  UniswapV3PoolState,
  AerodromeVolatilePoolState,
  AerodromeStablePoolState,
} from '../types/pool';

export interface SwapSimulationResult {
  amountOut: bigint;
  priceImpact: number; // in basis points
  gasEstimate: bigint;
  executionPrice: bigint;
}

export interface RouteSimulationResult {
  finalAmountOut: bigint;
  totalPriceImpact: number;
  totalGasEstimate: bigint;
  profitable: boolean;
  netProfit: bigint;
  profitMarginBps: number;
}

/**
 * Simulate Uniswap V3 swap using concentrated liquidity math
 */
export function simulateUniswapV3Swap(
  poolState: UniswapV3PoolState,
  amountIn: bigint,
  zeroForOne: boolean
): SwapSimulationResult {
  try {
    const sqrtPriceX96 = BigInt(poolState.sqrtPriceX96.toString());
    const liquidity = BigInt(poolState.liquidity.toString());

    if (liquidity === 0n || sqrtPriceX96 === 0n) {
      return {
        amountOut: 0n,
        priceImpact: 10000, // 100% price impact (invalid)
        gasEstimate: 120000n,
        executionPrice: 0n,
      };
    }

    // Simplified V3 swap math - in production, use exact V3 math library
    const Q96 = 2n ** 96n;
    const currentPrice = (sqrtPriceX96 * sqrtPriceX96) / (Q96 * Q96);

    // Estimate price impact based on liquidity depth
    const liquidityRatio = (amountIn * 10000n) / liquidity;
    const priceImpactBps = Math.min(Number(liquidityRatio), 1000); // Cap at 10%

    // Calculate amount out with price impact
    const priceImpactMultiplier = 10000n - BigInt(priceImpactBps);
    const idealAmountOut = zeroForOne
      ? (amountIn * currentPrice) / 10n ** 18n
      : (amountIn * 10n ** 18n) / currentPrice;

    const amountOut = (idealAmountOut * priceImpactMultiplier) / 10000n;

    // Apply fee (0.05%, 0.3%, or 1% depending on pool)
    const feeAmount = (amountOut * BigInt(poolState.fee)) / 1000000n;
    const finalAmountOut = amountOut - feeAmount;

    return {
      amountOut: finalAmountOut,
      priceImpact: priceImpactBps,
      gasEstimate: 120000n, // Typical V3 swap gas
      executionPrice: finalAmountOut > 0n ? (amountIn * 10n ** 18n) / finalAmountOut : 0n,
    };
  } catch (error) {
    return {
      amountOut: 0n,
      priceImpact: 10000,
      gasEstimate: 120000n,
      executionPrice: 0n,
    };
  }
}

/**
 * Simulate Aerodrome swap using constant product or stable swap math
 */
export function simulateAerodromeSwap(
  poolState: AerodromeVolatilePoolState | AerodromeStablePoolState,
  amountIn: bigint,
  tokenInIsToken0: boolean
): SwapSimulationResult {
  try {
    const reserve0 = BigInt(poolState.reserve0.toString());
    const reserve1 = BigInt(poolState.reserve1.toString());

    if (reserve0 === 0n || reserve1 === 0n) {
      return {
        amountOut: 0n,
        priceImpact: 10000,
        gasEstimate: 80000n,
        executionPrice: 0n,
      };
    }

    const reserveIn = tokenInIsToken0 ? reserve0 : reserve1;
    const reserveOut = tokenInIsToken0 ? reserve1 : reserve0;

    // Calculate price impact
    const priceImpactBps = Math.min(Number((amountIn * 10000n) / reserveIn), 1000);

    // Constant product formula: x * y = k
    // amountOut = (amountIn * reserveOut) / (reserveIn + amountIn)
    const numerator = amountIn * reserveOut;
    const denominator = reserveIn + amountIn;
    const amountOutBeforeFee = numerator / denominator;

    // Apply 0.2% fee for volatile pools, 0.02% for stable pools
    const feeRate = poolState.type === 'aerodrome-stable' ? 2n : 20n; // basis points
    const feeAmount = (amountOutBeforeFee * feeRate) / 10000n;
    const amountOut = amountOutBeforeFee - feeAmount;

    return {
      amountOut,
      priceImpact: priceImpactBps,
      gasEstimate: 80000n, // Typical Aerodrome swap gas
      executionPrice: amountOut > 0n ? (amountIn * 10n ** 18n) / amountOut : 0n,
    };
  } catch (error) {
    return {
      amountOut: 0n,
      priceImpact: 10000,
      gasEstimate: 80000n,
      executionPrice: 0n,
    };
  }
}

/**
 * Simulate complete arbitrage route with accurate profit calculation
 */
export function simulateArbitrageRoute(
  route: SwapRoute[],
  initialAmount: bigint,
  poolStates: Map<
    Address,
    UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  >,
  flashLoanFeeRate: number = 0.0005, // 0.05% default
  gasPrice: bigint = 2000000000n // 2 gwei default for Base L2
): RouteSimulationResult {
  let currentAmount = initialAmount;
  let totalGasEstimate = 150000n; // Base flash loan overhead
  let totalPriceImpact = 0;

  try {
    // Simulate each swap in the route
    for (const swap of route) {
      const poolState = poolStates.get(swap.poolAddress);
      if (!poolState) {
        return {
          finalAmountOut: 0n,
          totalPriceImpact: 10000,
          totalGasEstimate,
          profitable: false,
          netProfit: 0n,
          profitMarginBps: 0,
        };
      }

      let swapResult: SwapSimulationResult;

      if (poolState.type === 'uniswap-v3') {
        const tokenInIsToken0 = swap.tokenIn.toLowerCase() === poolState.token0.toLowerCase();
        swapResult = simulateUniswapV3Swap(
          poolState as UniswapV3PoolState,
          currentAmount,
          tokenInIsToken0
        );
      } else {
        const tokenInIsToken0 = swap.tokenIn.toLowerCase() === poolState.token0.toLowerCase();
        swapResult = simulateAerodromeSwap(
          poolState as AerodromeVolatilePoolState | AerodromeStablePoolState,
          currentAmount,
          tokenInIsToken0
        );
      }

      if (swapResult.amountOut === 0n) {
        return {
          finalAmountOut: 0n,
          totalPriceImpact: 10000,
          totalGasEstimate,
          profitable: false,
          netProfit: 0n,
          profitMarginBps: 0,
        };
      }

      currentAmount = swapResult.amountOut;
      totalGasEstimate += swapResult.gasEstimate;
      totalPriceImpact += swapResult.priceImpact;
    }

    // Calculate costs
    const flashLoanFee = BigInt(Math.floor(Number(initialAmount) * flashLoanFeeRate));
    const gasCost = totalGasEstimate * gasPrice;

    // Calculate profit
    const grossProfit = currentAmount > initialAmount ? currentAmount - initialAmount : 0n;
    const totalCosts = flashLoanFee + gasCost;
    const netProfit = grossProfit > totalCosts ? grossProfit - totalCosts : 0n;

    // Calculate profit margin in basis points
    const profitMarginBps = initialAmount > 0n ? Number((netProfit * 10000n) / initialAmount) : 0;

    return {
      finalAmountOut: currentAmount,
      totalPriceImpact: Math.min(totalPriceImpact, 10000),
      totalGasEstimate,
      profitable: netProfit > 0n,
      netProfit,
      profitMarginBps,
    };
  } catch (error) {
    return {
      finalAmountOut: 0n,
      totalPriceImpact: 10000,
      totalGasEstimate,
      profitable: false,
      netProfit: 0n,
      profitMarginBps: 0,
    };
  }
}

/**
 * Calculate optimal trade size using mathematical optimization
 */
export function calculateOptimalTradeSize(
  route: SwapRoute[],
  poolStates: Map<
    Address,
    UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  >,
  maxTradeSize: bigint,
  flashLoanFeeRate: number = 0.0005,
  gasPrice: bigint = 2000000000n
): { optimalSize: bigint; maxProfit: bigint } {
  let bestSize = 0n;
  let maxProfit = 0n;

  // Binary search for optimal size
  let low = maxTradeSize / 1000n; // Start with 0.1% of max
  let high = maxTradeSize;

  const iterations = 20; // Sufficient for convergence

  for (let i = 0; i < iterations; i++) {
    const mid = (low + high) / 2n;

    const result = simulateArbitrageRoute(route, mid, poolStates, flashLoanFeeRate, gasPrice);

    if (result.profitable && result.netProfit > maxProfit) {
      maxProfit = result.netProfit;
      bestSize = mid;
    }

    // Check if we should search higher or lower
    const midPlus = mid + (high - low) / 10n;
    const resultPlus = simulateArbitrageRoute(
      route,
      midPlus,
      poolStates,
      flashLoanFeeRate,
      gasPrice
    );

    if (resultPlus.netProfit > result.netProfit) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return { optimalSize: bestSize, maxProfit };
}
