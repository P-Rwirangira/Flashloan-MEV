/**
 * Opportunity Detector
 *
 * Detects arbitrage opportunities from pool state changes across multiple DEXs.
 */

import { EventEmitter } from 'events';
import { BigNumberish, ethers } from 'ethers';
import {
  UniswapV3PoolState,
  AerodromeVolatilePoolState,
  AerodromeStablePoolState,
  PoolType,
} from '../types/pool';
import { Address } from '../types/common';
import { createComponentLogger } from '../utils/logger';

export interface ArbitrageOpportunity {
  readonly id: string;
  readonly type: 'cross-dex' | 'triangular' | 'flash-arbitrage';
  readonly pools: {
    readonly buy: PoolInfo;
    readonly sell: PoolInfo;
  };
  readonly token: {
    readonly address: Address;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly profitEstimate: {
    readonly grossProfit: BigNumberish;
    readonly netProfit: BigNumberish;
    readonly gasCost: BigNumberish;
    readonly slippage: number;
    readonly confidence: number; // 0-1 scale
  };
  readonly execution: {
    readonly buyAmount: BigNumberish;
    readonly sellAmount: BigNumberish;
    readonly route: Address[];
    readonly deadline: number;
  };
  readonly metadata: {
    readonly detectedAt: number;
    readonly blockNumber: number;
    readonly priority: 'low' | 'medium' | 'high' | 'critical';
    readonly riskScore: number; // 0-100 scale
  };
}

export interface PoolInfo {
  readonly address: Address;
  readonly type: PoolType;
  readonly token0: Address;
  readonly token1: Address;
  readonly price: BigNumberish;
  readonly liquidity: BigNumberish;
  readonly fee: number;
}

export interface OpportunityDetectorOptions {
  readonly minProfitThreshold: BigNumberish;
  readonly maxSlippage: number;
  readonly maxGasPrice: BigNumberish;
  readonly confidenceThreshold: number;
  readonly riskTolerance: number; // 0-100 scale
  readonly enableTriangularArbitrage?: boolean;
  readonly enableFlashArbitrage?: boolean;
}

export class OpportunityDetector extends EventEmitter {
  private readonly logger = createComponentLogger('opportunity-detector');
  private readonly options: OpportunityDetectorOptions;
  private readonly maxGasPriceBigInt: bigint;

  // Pool state tracking
  private uniswapPools: Map<Address, UniswapV3PoolState> = new Map();
  private aerodromePools: Map<Address, AerodromeVolatilePoolState | AerodromeStablePoolState> =
    new Map();

  // Opportunity tracking
  private detectedOpportunities: Map<string, ArbitrageOpportunity> = new Map();
  private opportunityCounter = 0;

  constructor(options: OpportunityDetectorOptions) {
    super();

    // Validate and normalize maxGasPrice
    this.maxGasPriceBigInt = this.validateAndNormalizeBigInt(options.maxGasPrice, 'maxGasPrice');

    this.options = {
      enableTriangularArbitrage: true,
      enableFlashArbitrage: true,
      ...options,
    };
  }

  /**
   * Validate and normalize BigInt values from various input types
   */
  private validateAndNormalizeBigInt(value: BigNumberish, fieldName: string): bigint {
    if (value === null || value === undefined) {
      throw new Error(`${fieldName} is required and cannot be null or undefined`);
    }

    if (typeof value === 'bigint') {
      return value;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${fieldName} must be a non-negative finite number`);
      }
      return BigInt(Math.floor(value));
    }

    if (typeof value === 'string') {
      if (!/^\d+$/.test(value)) {
        throw new Error(`${fieldName} string must contain only digits`);
      }
      return BigInt(value);
    }

    throw new Error(`${fieldName} must be a BigInt, number, or numeric string`);
  }

  /**
   * Update Uniswap pool state and detect opportunities
   */
  updateUniswapPool(poolState: UniswapV3PoolState): void {
    const oldState = this.uniswapPools.get(poolState.address);
    this.uniswapPools.set(poolState.address, poolState);

    if (oldState && this.hasSignificantPriceChange(oldState, poolState)) {
      this.detectCrossDexOpportunities(poolState);
    }
  }

  /**
   * Update Aerodrome pool state and detect opportunities
   */
  updateAerodromePool(poolState: AerodromeVolatilePoolState | AerodromeStablePoolState): void {
    const oldState = this.aerodromePools.get(poolState.address);
    this.aerodromePools.set(poolState.address, poolState);

    if (oldState && this.hasSignificantPriceChange(oldState, poolState)) {
      this.detectCrossDexOpportunities(poolState);
    }
  }

  /**
   * Detect cross-DEX arbitrage opportunities
   */
  private detectCrossDexOpportunities(
    updatedPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  ): void {
    const isUniswap = updatedPool.type === PoolType.UNISWAP_V3;
    const otherPools = isUniswap ? this.aerodromePools : this.uniswapPools;

    // Find matching pools with same token pairs
    for (const [poolAddress, otherPool] of otherPools) {
      if (this.areMatchingPools(updatedPool, otherPool)) {
        const opportunity = this.calculateArbitrageOpportunity(updatedPool, otherPool);

        if (opportunity && this.isOpportunityViable(opportunity)) {
          this.emitOpportunity(opportunity);
        }
      }

      // Use poolAddress for logging if needed
      this.logger.debug('Checked pool for arbitrage opportunity', {
        updatedPool: updatedPool.address,
        checkedPool: poolAddress,
        hasMatch: this.areMatchingPools(updatedPool, otherPool),
      });
    }
  }

  /**
   * Calculate arbitrage opportunity between two pools
   */
  private calculateArbitrageOpportunity(
    pool1: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    pool2: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  ): ArbitrageOpportunity | null {
    try {
      // Calculate prices for both pools
      const price1 = this.calculatePoolPrice(pool1);
      const price2 = this.calculatePoolPrice(pool2);

      if (!price1 || !price2) return null;

      // Determine buy/sell pools based on price difference
      const priceDiff = price1 > price2 ? price1 - price2 : price2 - price1;
      const avgPrice = (price1 + price2) / 2n;
      const priceSpread = avgPrice > 0n ? (priceDiff * 10000n) / avgPrice : 0n; // basis points

      if (priceSpread < 50n) return null; // Less than 0.5% spread

      const [buyPool, sellPool, buyPrice, sellPrice] =
        price1 < price2 ? [pool1, pool2, price1, price2] : [pool2, pool1, price2, price1];

      // Calculate optimal trade size
      const optimalAmount = this.calculateOptimalTradeSize(buyPool, sellPool);
      if (!optimalAmount || optimalAmount === 0n) return null;

      // Estimate costs and profits
      const gasCost = this.estimateGasCost();
      const grossProfit = ((sellPrice - buyPrice) * optimalAmount) / ethers.parseEther('1');
      const netProfit = grossProfit > gasCost ? grossProfit - gasCost : 0n;

      // Calculate confidence and risk scores
      const confidence = this.calculateConfidence(buyPool, sellPool, optimalAmount);
      const riskScore = this.calculateRiskScore(buyPool, sellPool, optimalAmount);

      const opportunityId = `arb-${++this.opportunityCounter}-${Date.now()}`;

      return {
        id: opportunityId,
        type: 'cross-dex',
        pools: {
          buy: this.poolToPoolInfo(buyPool),
          sell: this.poolToPoolInfo(sellPool),
        },
        token: {
          address: buyPool.token0, // Assuming token0 is the target token
          symbol: 'TOKEN', // Would need token registry for actual symbol
          decimals: 18,
        },
        profitEstimate: {
          grossProfit,
          netProfit,
          gasCost,
          slippage: this.calculateSlippage(optimalAmount, buyPool, sellPool),
          confidence,
        },
        execution: {
          buyAmount: optimalAmount,
          sellAmount: optimalAmount, // Simplified - would need exact calculation
          route: [buyPool.address, sellPool.address],
          deadline: Date.now() + 300000, // 5 minutes
        },
        metadata: {
          detectedAt: Date.now(),
          blockNumber: Math.max(buyPool.blockNumber, sellPool.blockNumber),
          priority: this.determinePriority(netProfit, confidence, riskScore),
          riskScore,
        },
      };
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'calculate-arbitrage-opportunity',
        pool1: pool1.address,
        pool2: pool2.address,
      });
      return null;
    }
  }

  /**
   * Calculate pool price (simplified implementation)
   */
  private calculatePoolPrice(
    pool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  ): bigint | null {
    try {
      if (pool.type === PoolType.UNISWAP_V3) {
        const uniPool = pool as UniswapV3PoolState;
        // Convert sqrtPriceX96 to regular price
        const sqrtPrice = BigInt(uniPool.sqrtPriceX96.toString());
        const price = (sqrtPrice * sqrtPrice) / 2n ** 192n;
        return price;
      } else {
        const aeroPool = pool as AerodromeVolatilePoolState | AerodromeStablePoolState;
        // Use reserves to calculate price
        const reserve0 = BigInt(aeroPool.reserve0.toString());
        const reserve1 = BigInt(aeroPool.reserve1.toString());
        if (reserve0 === 0n) return null;
        return (reserve1 * ethers.parseEther('1')) / reserve0;
      }
    } catch (error) {
      return null;
    }
  }

  /**
   * Get liquidity equivalent for different pool types
   */
  private getPoolLiquidity(
    pool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  ): bigint {
    if (pool.type === PoolType.UNISWAP_V3) {
      const uniPool = pool as UniswapV3PoolState;
      return BigInt(uniPool.liquidity.toString());
    } else {
      // For Aerodrome pools, use geometric mean of reserves as liquidity proxy
      const aeroPool = pool as AerodromeVolatilePoolState | AerodromeStablePoolState;
      const reserve0 = BigInt(aeroPool.reserve0.toString());
      const reserve1 = BigInt(aeroPool.reserve1.toString());

      if (reserve0 === 0n || reserve1 === 0n) return 0n;

      // Calculate sqrt(reserve0 * reserve1) as liquidity proxy
      try {
        const product = reserve0 * reserve1;
        return this.bigintSqrt(product);
      } catch (error) {
        // If overflow, scale down and try again
        const scaledReserve0 = reserve0 / 1000n;
        const scaledReserve1 = reserve1 / 1000n;
        if (scaledReserve0 > 0n && scaledReserve1 > 0n) {
          return this.bigintSqrt(scaledReserve0 * scaledReserve1) * 1000n;
        }
        return 0n;
      }
    }
  }

  /**
   * Calculate square root of a BigInt using Newton's method
   */
  private bigintSqrt(value: bigint): bigint {
    if (value < 0n) {
      throw new Error('Square root of negative number');
    }
    if (value < 2n) {
      return value;
    }

    // Newton's method for square root
    let x = value;
    let y = (x + 1n) / 2n;

    while (y < x) {
      x = y;
      y = (x + value / x) / 2n;
    }

    return x;
  }
  /**
   * Calculate optimal trade size based on pool liquidity
   */
  private calculateOptimalTradeSize(
    buyPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    sellPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  ): bigint | null {
    try {
      // Simplified calculation - use 1% of smaller pool's liquidity
      const buyLiquidity = this.getPoolLiquidity(buyPool);
      const sellLiquidity = this.getPoolLiquidity(sellPool);

      const minLiquidity = buyLiquidity < sellLiquidity ? buyLiquidity : sellLiquidity;
      return minLiquidity / 100n; // 1% of liquidity
    } catch (error) {
      return null;
    }
  }

  /**
   * Estimate gas cost for arbitrage transaction
   */
  private estimateGasCost(): bigint {
    // Simplified gas estimation
    const gasLimit = 300000n; // 300k gas for flash arbitrage
    return gasLimit * this.maxGasPriceBigInt;
  }

  /**
   * Calculate confidence score for opportunity
   */
  private calculateConfidence(
    buyPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    sellPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    amount: bigint
  ): number {
    // Factors: liquidity depth, price stability, block recency
    const liquidityScore = this.calculateLiquidityScore(buyPool, sellPool, amount);
    const freshnessScore = this.calculateFreshnessScore(buyPool, sellPool);

    return Math.min(1.0, (liquidityScore + freshnessScore) / 2);
  }

  /**
   * Calculate risk score for opportunity
   */
  private calculateRiskScore(
    buyPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    sellPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    amount: bigint
  ): number {
    // Higher score = higher risk
    const liquidityRisk = this.calculateLiquidityRisk(buyPool, sellPool, amount);
    const volatilityRisk = this.calculateVolatilityRisk(buyPool, sellPool);

    return Math.min(100, liquidityRisk + volatilityRisk);
  }

  /**
   * Calculate slippage for the trade
   */
  private calculateSlippage(
    amount: bigint,
    buyPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    sellPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  ): number {
    // Simplified slippage calculation based on amount vs liquidity
    const buyLiquidity = this.getPoolLiquidity(buyPool);
    const sellLiquidity = this.getPoolLiquidity(sellPool);

    const buySlippage = buyLiquidity > 0n ? Number((amount * 10000n) / buyLiquidity) / 10000 : 0;
    const sellSlippage = sellLiquidity > 0n ? Number((amount * 10000n) / sellLiquidity) / 10000 : 0;

    return Math.max(buySlippage, sellSlippage);
  }

  /**
   * Helper methods
   */
  private areMatchingPools(
    pool1: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    pool2: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  ): boolean {
    return (
      (pool1.token0 === pool2.token0 && pool1.token1 === pool2.token1) ||
      (pool1.token0 === pool2.token1 && pool1.token1 === pool2.token0)
    );
  }

  private hasSignificantPriceChange(
    oldState: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    newState: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  ): boolean {
    // Check if price change is significant enough to warrant opportunity detection
    const oldPrice = this.calculatePoolPrice(oldState);
    const newPrice = this.calculatePoolPrice(newState);

    if (!oldPrice || !newPrice || oldPrice === 0n) return false;

    const priceChange = newPrice > oldPrice ? newPrice - oldPrice : oldPrice - newPrice;
    const priceChangePercent = (priceChange * 10000n) / oldPrice;
    return priceChangePercent > 10n; // 0.1% price change threshold
  }

  private isOpportunityViable(opportunity: ArbitrageOpportunity): boolean {
    const minProfitThreshold = BigInt(this.options.minProfitThreshold.toString());
    const netProfit = BigInt(opportunity.profitEstimate.netProfit.toString());

    return (
      netProfit >= minProfitThreshold &&
      opportunity.profitEstimate.slippage <= this.options.maxSlippage &&
      opportunity.profitEstimate.confidence >= this.options.confidenceThreshold &&
      opportunity.metadata.riskScore <= this.options.riskTolerance
    );
  }

  private poolToPoolInfo(
    pool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  ): PoolInfo {
    return {
      address: pool.address,
      type: pool.type,
      token0: pool.token0,
      token1: pool.token1,
      price: this.calculatePoolPrice(pool) || 0n,
      liquidity: this.getPoolLiquidity(pool),
      fee: pool.fee,
    };
  }

  private determinePriority(
    netProfit: bigint,
    confidence: number,
    riskScore: number
  ): 'low' | 'medium' | 'high' | 'critical' {
    const profitScore = Number(netProfit / ethers.parseEther('0.01')); // ETH * 100
    const combinedScore = (profitScore * confidence * (100 - riskScore)) / 100;

    if (combinedScore > 50) return 'critical';
    if (combinedScore > 20) return 'high';
    if (combinedScore > 5) return 'medium';
    return 'low';
  }

  private calculateLiquidityScore(
    buyPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    sellPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    amount: bigint
  ): number {
    const buyLiquidity = this.getPoolLiquidity(buyPool);
    const sellLiquidity = this.getPoolLiquidity(sellPool);
    const minLiquidity = buyLiquidity < sellLiquidity ? buyLiquidity : sellLiquidity;

    if (minLiquidity === 0n) return 0;

    const liquidityRatio = Number((amount * 100n) / minLiquidity);
    return Math.max(0, Math.min(1, (10 - liquidityRatio) / 10));
  }

  private calculateFreshnessScore(
    buyPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    sellPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  ): number {
    const now = Date.now();
    const maxAge = Math.max(now - buyPool.lastUpdated, now - sellPool.lastUpdated);
    const ageInSeconds = maxAge / 1000;

    // Fresh data (< 30s) gets full score, older data gets reduced score
    return Math.max(0, Math.min(1, (30 - ageInSeconds) / 30));
  }

  private calculateLiquidityRisk(
    buyPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    sellPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    amount: bigint
  ): number {
    const liquidityScore = this.calculateLiquidityScore(buyPool, sellPool, amount);
    return (1 - liquidityScore) * 50; // Convert to 0-50 risk scale
  }

  private calculateVolatilityRisk(
    buyPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState,
    sellPool: UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  ): number {
    // Simplified volatility risk - would need historical data for proper calculation
    const freshnessScore = this.calculateFreshnessScore(buyPool, sellPool);
    return (1 - freshnessScore) * 30; // Convert to 0-30 risk scale
  }

  private emitOpportunity(opportunity: ArbitrageOpportunity): void {
    this.detectedOpportunities.set(opportunity.id, opportunity);

    this.logger.info('Arbitrage opportunity detected', {
      id: opportunity.id,
      type: opportunity.type,
      netProfit: opportunity.profitEstimate.netProfit.toString(),
      confidence: opportunity.profitEstimate.confidence,
      riskScore: opportunity.metadata.riskScore,
      priority: opportunity.metadata.priority,
    });

    this.emit('opportunityDetected', opportunity);
  }

  /**
   * Get all detected opportunities
   */
  getDetectedOpportunities(): ArbitrageOpportunity[] {
    return Array.from(this.detectedOpportunities.values());
  }

  /**
   * Clear old opportunities
   */
  clearOldOpportunities(maxAgeMs: number = 300000): void {
    const now = Date.now();
    for (const [id, opportunity] of this.detectedOpportunities) {
      if (now - opportunity.metadata.detectedAt > maxAgeMs) {
        this.detectedOpportunities.delete(id);
      }
    }
  }

  /**
   * Get detection statistics
   */
  getStats() {
    const opportunities = Array.from(this.detectedOpportunities.values());
    return {
      totalDetected: opportunities.length,
      byPriority: {
        critical: opportunities.filter(o => o.metadata.priority === 'critical').length,
        high: opportunities.filter(o => o.metadata.priority === 'high').length,
        medium: opportunities.filter(o => o.metadata.priority === 'medium').length,
        low: opportunities.filter(o => o.metadata.priority === 'low').length,
      },
      avgConfidence:
        opportunities.reduce((sum, o) => sum + o.profitEstimate.confidence, 0) /
          opportunities.length || 0,
      avgRiskScore:
        opportunities.reduce((sum, o) => sum + o.metadata.riskScore, 0) / opportunities.length || 0,
    };
  }
}
