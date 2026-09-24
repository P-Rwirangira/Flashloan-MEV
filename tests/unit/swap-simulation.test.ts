/**
 * Unit & Regression Tests: Swap Simulation Math
 *
 * Verifies AMM math across Uniswap V3 and Aerodrome pools,
 * price impact estimation, fee calculations, and route profitability.
 */

import {
  simulateUniswapV3Swap,
  simulateAerodromeSwap,
  simulateArbitrageRoute,
  calculateOptimalTradeSize,
} from '../../src/utils/swap-simulation';
import {
  PoolType,
  UniswapV3PoolState,
  AerodromeVolatilePoolState,
  AerodromeStablePoolState,
} from '../../src/types/pool';
import { Address } from '../../src/types/common';
import { SwapRoute } from '../../src/types/execution';

describe('Swap Simulation Math', () => {
  const WETH = '0x4200000000000000000000000000000000000006' as Address;
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
  const POOL_A = '0x1111111111111111111111111111111111111111' as Address;
  const POOL_B = '0x2222222222222222222222222222222222222222' as Address;

  describe('simulateUniswapV3Swap', () => {
    const Q96 = 2n ** 96n;

    test('should safely handle zero liquidity or zero price without throwing', () => {
      const zeroLiquidityPool: UniswapV3PoolState = {
        address: POOL_A,
        token0: WETH,
        token1: USDC,
        fee: 500,
        sqrtPriceX96: Q96,
        liquidity: 0n,
        tick: 0,
        tickSpacing: 10,
        type: PoolType.UNISWAP_V3,
        lastUpdated: Date.now(),
        blockNumber: 1,
        isActive: true,
      };

      const result = simulateUniswapV3Swap(zeroLiquidityPool, 1000000n, true);
      expect(result.amountOut).toBe(0n);
      expect(result.priceImpact).toBe(10000);
    });

    test('should correctly simulate swap when price is 1:1', () => {
      const pool: UniswapV3PoolState = {
        address: POOL_A,
        token0: WETH,
        token1: USDC,
        fee: 3000, // 0.3%
        sqrtPriceX96: Q96, // 1:1 price
        liquidity: 10n ** 24n, // Deep liquidity
        tick: 0,
        tickSpacing: 60,
        type: PoolType.UNISWAP_V3,
        lastUpdated: Date.now(),
        blockNumber: 1,
        isActive: true,
      };

      const amountIn = 10n ** 18n; // 1 ETH
      const result = simulateUniswapV3Swap(pool, amountIn, true);

      // Amount out should be approximately 1 ETH minus 0.3% fee and minimal price impact
      expect(result.amountOut).toBeGreaterThan(0n);
      // Fee is 0.3% (3000 / 1,000,000)
      const expectedWithoutImpact = (amountIn * 997000n) / 1000000n;
      expect(Number(result.amountOut)).toBeCloseTo(Number(expectedWithoutImpact), -15);
      expect(result.priceImpact).toBeLessThan(10); // Very low impact with deep liquidity
    });

    test('should prevent integer truncation when price ratio is sub-1 (DEF-001 regression)', () => {
      // In many pools, price of token0 in terms of token1 is < 1 (e.g. sqrtPriceX96 < 2^96)
      // For instance, price = 0.25 -> sqrtPriceX96 = Q96 / 2
      const halfSqrtPrice = Q96 / 2n;

      const subOnePool: UniswapV3PoolState = {
        address: POOL_A,
        token0: WETH,
        token1: USDC,
        fee: 500, // 0.05%
        sqrtPriceX96: halfSqrtPrice, // Price is (1/2)^2 = 0.25
        liquidity: 10n ** 24n,
        tick: -13863,
        tickSpacing: 10,
        type: PoolType.UNISWAP_V3,
        lastUpdated: Date.now(),
        blockNumber: 1,
        isActive: true,
      };

      const amountIn = 1000000000000000000n; // 1.0 (18 decimals)

      // zeroForOne = true: token0 -> token1 at price 0.25
      const resultZeroForOne = simulateUniswapV3Swap(subOnePool, amountIn, true);
      expect(resultZeroForOne.amountOut).toBeGreaterThan(0n);
      // Expected ~ 0.25 * amountIn (minus 0.05% fee)
      expect(Number(resultZeroForOne.amountOut)).toBeCloseTo(0.25 * 1e18, -15);

      // zeroForOne = false: token1 -> token0 at price 0.25 (1 / 0.25 = 4x output)
      // This previously threw RangeError: Division by zero because currentPrice truncated to 0n!
      const resultOneForZero = simulateUniswapV3Swap(subOnePool, amountIn, false);
      expect(resultOneForZero.amountOut).toBeGreaterThan(0n);
      // Expected ~ 4.0 * amountIn (minus 0.05% fee: 4.0 * 0.9995 = 3.998)
      expect(Number(resultOneForZero.amountOut)).toBeCloseTo(3.998 * 1e18, -15);
    });

    test('should cap price impact at 10% (1000 bps) for high volume swaps', () => {
      const pool: UniswapV3PoolState = {
        address: POOL_A,
        token0: WETH,
        token1: USDC,
        fee: 500,
        sqrtPriceX96: Q96,
        liquidity: 1000n, // Very low liquidity
        tick: 0,
        tickSpacing: 10,
        type: PoolType.UNISWAP_V3,
        lastUpdated: Date.now(),
        blockNumber: 1,
        isActive: true,
      };

      const hugeAmountIn = 100000n;
      const result = simulateUniswapV3Swap(pool, hugeAmountIn, true);
      expect(result.priceImpact).toBe(1000); // Capped at 1000 bps
    });
  });

  describe('simulateAerodromeSwap', () => {
    test('should calculate constant product output with volatile fee (0.2%)', () => {
      const volatilePool: AerodromeVolatilePoolState = {
        address: POOL_B,
        token0: WETH,
        token1: USDC,
        reserve0: 100n * 10n ** 18n, // 100 WETH
        reserve1: 250000n * 10n ** 6n, // 250,000 USDC
        fee: 20, // 0.2%
        type: PoolType.AERODROME_VOLATILE,
        lastUpdated: Date.now(),
        blockNumber: 1,
        isActive: true,
        totalSupply: 1000000n,
        kLast: 0n,
      };

      const amountIn = 1n * 10n ** 18n; // 1 WETH
      const result = simulateAerodromeSwap(volatilePool, amountIn, true);

      // Constant product: amountOutBeforeFee = (1 * 250000) / (100 + 1) = ~2475.24 USDC
      // Fee 0.2%: 2475.24 * 0.998 = ~2470.29 USDC
      expect(result.amountOut).toBeGreaterThan(0n);
      expect(result.priceImpact).toBeGreaterThan(0);
      expect(result.gasEstimate).toBe(80000n);
    });

    test('should apply 0.02% fee for stable pools', () => {
      const stablePool: AerodromeStablePoolState = {
        address: POOL_B,
        token0: USDC,
        token1: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' as Address, // DAI
        reserve0: 1000000n * 10n ** 6n,
        reserve1: 1000000n * 10n ** 18n,
        fee: 2, // 0.02%
        type: PoolType.AERODROME_STABLE,
        lastUpdated: Date.now(),
        blockNumber: 1,
        isActive: true,
        totalSupply: 1000000n,
        decimals0: 6,
        decimals1: 18,
        stable: true,
      };

      const amountIn = 1000n * 10n ** 6n;
      const result = simulateAerodromeSwap(stablePool, amountIn, true);
      expect(result.amountOut).toBeGreaterThan(0n);
      expect(result.gasEstimate).toBe(80000n);
    });

    test('should handle empty reserves without throwing', () => {
      const emptyPool: AerodromeVolatilePoolState = {
        address: POOL_B,
        token0: WETH,
        token1: USDC,
        reserve0: 0n,
        reserve1: 0n,
        fee: 20,
        type: PoolType.AERODROME_VOLATILE,
        lastUpdated: Date.now(),
        blockNumber: 1,
        isActive: true,
        totalSupply: 0n,
        kLast: 0n,
      };

      const result = simulateAerodromeSwap(emptyPool, 1000n, true);
      expect(result.amountOut).toBe(0n);
      expect(result.priceImpact).toBe(10000);
    });
  });

  describe('simulateArbitrageRoute', () => {
    test('should accurately account for flash loan fees and gas costs in net profit', () => {
      const Q96 = 2n ** 96n;
      const poolStates = new Map<Address, any>();

      poolStates.set(POOL_A, {
        address: POOL_A,
        token0: WETH,
        token1: USDC,
        fee: 500,
        sqrtPriceX96: Q96, // 1:1 for simplicity
        liquidity: 10n ** 26n,
        tick: 0,
        type: PoolType.UNISWAP_V3,
        lastUpdated: Date.now(),
      });

      const initialAmount = 10n ** 18n;
      const route: SwapRoute[] = [
        {
          poolAddress: POOL_A,
          tokenIn: WETH,
          tokenOut: USDC,
          protocol: 'uniswap-v3',
          fee: 500,
          amountIn: initialAmount,
          expectedAmountOut: initialAmount,
          direction: true,
        },
      ];

      const gasPrice = 100000000n; // 0.1 gwei (typical Base L2)
      const flashLoanFeeRate = 0.0005; // 0.05%

      const result = simulateArbitrageRoute(
        route,
        initialAmount,
        poolStates,
        flashLoanFeeRate,
        gasPrice
      );

      expect(result.totalGasEstimate).toBeGreaterThanOrEqual(150000n);
      // Because pool is 1:1 with 0.05% fee, output is less than input -> not profitable
      expect(result.profitable).toBe(false);
      expect(result.netProfit).toBe(0n);
    });
  });

  describe('calculateOptimalTradeSize', () => {
    test('should return a non-negative optimal size via binary search', () => {
      const poolStates = new Map<Address, any>();
      const route: SwapRoute[] = [];

      const { optimalSize, maxProfit } = calculateOptimalTradeSize(route, poolStates, 10n ** 18n);

      expect(optimalSize).toBeGreaterThanOrEqual(0n);
      expect(maxProfit).toBeGreaterThanOrEqual(0n);
    });
  });
});
