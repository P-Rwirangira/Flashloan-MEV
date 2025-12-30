/**
 * Advanced Gas Optimizer
 *
 * Optimizes gas usage and pricing for MEV transactions with dynamic strategies.
 */

import { ethers, BigNumberish } from 'ethers';
import { EventEmitter } from 'events';
import { ArbitrageOpportunity } from '../types/opportunity';
import { GasEstimator, GasEstimate, GasPriceData } from './gas-estimator';
import { createComponentLogger } from '../utils/logger';

export interface GasOptimizationOptions {
  readonly urgency: number; // 0-1 scale, higher = more urgent
  readonly targetBlocks: number; // Target inclusion within N blocks
  readonly maxGasPrice: BigNumberish;
  readonly profitMargin: BigNumberish; // Expected profit for cost/benefit analysis
  readonly competitionLevel?: number; // 0-1 scale, higher = more competition
}

export interface GasOptimizationResult {
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly totalCost: bigint;
  readonly inclusionProbability: number; // 0-1 scale
  readonly costEfficiencyRatio: number; // profit/cost ratio
  readonly strategy: GasStrategy;
  readonly optimizedAt: number;
}

export enum GasStrategy {
  CONSERVATIVE = 'conservative',
  BALANCED = 'balanced',
  AGGRESSIVE = 'aggressive',
  ULTRA_FAST = 'ultra_fast',
}

export interface GasMarketConditions {
  readonly congestion: number; // 0-1 scale
  readonly volatility: number; // 0-1 scale
  readonly trend: 'rising' | 'falling' | 'stable';
  readonly competitionLevel: number; // 0-1 scale
}

export class AdvancedGasOptimizer extends EventEmitter {
  private readonly logger = createComponentLogger('gas-optimizer');
  private readonly gasEstimator: GasEstimator;

  // Market analysis
  private marketConditions?: GasMarketConditions;
  private competitorAnalysis: Map<string, number> = new Map(); // txHash -> gasPrice
  private lastOptimization?: GasOptimizationResult;

  constructor(gasEstimator: GasEstimator) {
    super();
    this.gasEstimator = gasEstimator;

    // Listen for gas price updates to analyze market conditions
    this.gasEstimator.on('gasPriceUpdated', () => {
      this.updateMarketConditions().catch(error => {
        this.logger.logError(error as Error, {
          operation: 'update-market-conditions-listener',
        });
      });
    });
  }

  /**
   * Optimize gas for arbitrage opportunity
   */
  async optimizeGas(
    opportunity: ArbitrageOpportunity,
    options: GasOptimizationOptions
  ): Promise<GasOptimizationResult> {
    try {
      this.logger.debug('Starting gas optimization', {
        opportunityId: opportunity.id,
        urgency: options.urgency,
        targetBlocks: options.targetBlocks,
        profitMargin: options.profitMargin.toString(),
      });

      // Get base gas estimate
      const baseEstimate = await this.gasEstimator.estimateArbitrageGas(opportunity);

      // Analyze market conditions
      await this.updateMarketConditions();

      // Determine optimal strategy
      const strategy = this.determineOptimalStrategy(options, this.marketConditions);

      // Calculate optimized gas parameters
      const optimizedGas = await this.calculateOptimizedGas(
        baseEstimate,
        options,
        strategy,
        this.marketConditions
      );

      // Validate cost-effectiveness
      const costEfficiencyRatio = this.calculateCostEfficiency(
        BigInt(options.profitMargin.toString()),
        optimizedGas.totalCost
      );

      const result: GasOptimizationResult = {
        ...optimizedGas,
        costEfficiencyRatio,
        strategy,
        optimizedAt: Date.now(),
      };

      this.lastOptimization = result;
      this.emit('gasOptimized', result);

      this.logger.info('Gas optimization completed', {
        strategy,
        gasLimit: result.gasLimit.toString(),
        maxFeePerGas: ethers.formatUnits(result.maxFeePerGas, 'gwei'),
        totalCost: ethers.formatEther(result.totalCost),
        inclusionProbability: result.inclusionProbability,
        costEfficiencyRatio: result.costEfficiencyRatio,
      });

      return result;
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'optimize-gas',
        opportunityId: opportunity.id,
      });
      throw error;
    }
  }

  /**
   * Optimize gas for liquidation
   */
  async optimizeLiquidationGas(
    liquidationAmount: BigNumberish,
    collateralTokens: number,
    options: GasOptimizationOptions
  ): Promise<GasOptimizationResult> {
    try {
      // Get base estimate for liquidation
      const baseEstimate = await this.gasEstimator.estimateLiquidationGas(
        liquidationAmount,
        collateralTokens
      );

      // Update market conditions
      await this.updateMarketConditions();

      // Determine strategy (liquidations are typically more urgent)
      const urgentOptions = { ...options, urgency: Math.max(options.urgency, 0.7) };
      const strategy = this.determineOptimalStrategy(urgentOptions, this.marketConditions);

      // Calculate optimized parameters
      const optimizedGas = await this.calculateOptimizedGas(
        baseEstimate,
        urgentOptions,
        strategy,
        this.marketConditions
      );

      const costEfficiencyRatio = this.calculateCostEfficiency(
        BigInt(options.profitMargin.toString()),
        optimizedGas.totalCost
      );

      const result: GasOptimizationResult = {
        ...optimizedGas,
        costEfficiencyRatio,
        strategy,
        optimizedAt: Date.now(),
      };

      this.emit('liquidationGasOptimized', result);
      return result;
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'optimize-liquidation-gas',
        liquidationAmount: liquidationAmount.toString(),
      });
      throw error;
    }
  }

  /**
   * Determine optimal gas strategy based on conditions
   */
  private determineOptimalStrategy(
    options: GasOptimizationOptions,
    marketConditions?: GasMarketConditions
  ): GasStrategy {
    const urgency = options.urgency;
    const competitionLevel = options.competitionLevel ?? marketConditions?.competitionLevel ?? 0.5;
    const congestion = marketConditions?.congestion ?? 0.5;

    // Ultra-fast for high urgency + high competition
    if (urgency > 0.8 && competitionLevel > 0.7) {
      return GasStrategy.ULTRA_FAST;
    }

    // Aggressive for high urgency or high competition
    if (urgency > 0.6 || competitionLevel > 0.6 || congestion > 0.7) {
      return GasStrategy.AGGRESSIVE;
    }

    // Balanced for moderate conditions
    if (urgency > 0.3 || competitionLevel > 0.3) {
      return GasStrategy.BALANCED;
    }

    // Conservative for low urgency and competition
    return GasStrategy.CONSERVATIVE;
  }

  /**
   * Calculate optimized gas parameters
   */
  private async calculateOptimizedGas(
    baseEstimate: GasEstimate,
    options: GasOptimizationOptions,
    strategy: GasStrategy,
    marketConditions?: GasMarketConditions
  ): Promise<Omit<GasOptimizationResult, 'costEfficiencyRatio' | 'strategy' | 'optimizedAt'>> {
    const gasData = await this.gasEstimator.getCurrentGasData();

    // Strategy-based multipliers
    const strategyMultipliers = {
      [GasStrategy.CONSERVATIVE]: { fee: 1.1, priority: 1.0 },
      [GasStrategy.BALANCED]: { fee: 1.25, priority: 1.2 },
      [GasStrategy.AGGRESSIVE]: { fee: 1.5, priority: 1.5 },
      [GasStrategy.ULTRA_FAST]: { fee: 2.0, priority: 2.0 },
    };

    const multipliers = strategyMultipliers[strategy];

    // Calculate base fees
    let maxFeePerGas = (gasData.baseFee * BigInt(Math.floor(multipliers.fee * 100))) / 100n;
    let maxPriorityFeePerGas =
      (gasData.priorityFee * BigInt(Math.floor(multipliers.priority * 100))) / 100n;

    // Adjust for market conditions
    if (marketConditions) {
      // Increase fees during high congestion
      if (marketConditions.congestion > 0.7) {
        const congestionMultiplier = 1 + (marketConditions.congestion - 0.7) * 0.5;
        maxFeePerGas = (maxFeePerGas * BigInt(Math.floor(congestionMultiplier * 100))) / 100n;
        maxPriorityFeePerGas =
          (maxPriorityFeePerGas * BigInt(Math.floor(congestionMultiplier * 100))) / 100n;
      }

      // Adjust for volatility
      if (marketConditions.volatility > 0.5) {
        const volatilityBuffer = 1 + marketConditions.volatility * 0.2;
        maxFeePerGas = (maxFeePerGas * BigInt(Math.floor(volatilityBuffer * 100))) / 100n;
      }
    }

    // Cap at maximum gas price
    const maxGasPrice = BigInt(options.maxGasPrice.toString());
    if (maxFeePerGas > maxGasPrice) {
      maxFeePerGas = maxGasPrice;
      maxPriorityFeePerGas = maxGasPrice / 2n; // Reasonable priority fee
    }

    // Optimize gas limit based on strategy
    let gasLimit = baseEstimate.gasLimit;
    if (strategy === GasStrategy.CONSERVATIVE) {
      gasLimit = (gasLimit * 110n) / 100n; // 10% buffer for conservative
    } else if (strategy === GasStrategy.ULTRA_FAST) {
      gasLimit = (gasLimit * 120n) / 100n; // 20% buffer for ultra-fast
    }

    const totalCost = gasLimit * maxFeePerGas;

    // Calculate inclusion probability
    const inclusionProbability = this.calculateInclusionProbability(
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasData,
      marketConditions
    );

    return {
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      totalCost,
      inclusionProbability,
    };
  }

  /**
   * Calculate inclusion probability based on gas prices and market conditions
   */
  private calculateInclusionProbability(
    maxFeePerGas: bigint,
    maxPriorityFeePerGas: bigint,
    gasData: GasPriceData,
    marketConditions?: GasMarketConditions
  ): number {
    // Base probability from gas price ratio
    const feeRatio = Number(maxFeePerGas) / Number(gasData.gasPrice);
    let baseProbability = Math.min(0.95, Math.max(0.1, feeRatio - 0.5));

    // Adjust for market conditions
    if (marketConditions) {
      // Reduce probability during high congestion
      if (marketConditions.congestion > 0.5) {
        baseProbability *= 1 - (marketConditions.congestion - 0.5) * 0.3;
      }

      // Reduce probability with high competition
      if (marketConditions.competitionLevel > 0.5) {
        baseProbability *= 1 - (marketConditions.competitionLevel - 0.5) * 0.2;
      }
    }

    // Priority fee bonus
    const priorityRatio = Number(maxPriorityFeePerGas) / Number(gasData.priorityFee);
    if (priorityRatio > 1.5) {
      baseProbability = Math.min(0.98, baseProbability * 1.1);
    }

    return Math.max(0.05, Math.min(0.98, baseProbability));
  }

  /**
   * Calculate cost efficiency ratio
   */
  private calculateCostEfficiency(profitMargin: bigint, totalCost: bigint): number {
    if (totalCost === 0n) return Infinity;
    return Number(profitMargin) / Number(totalCost);
  }

  /**
   * Update market conditions analysis
   */
  private async updateMarketConditions(): Promise<void> {
    try {
      const gasStats = this.gasEstimator.getGasPriceStats();

      if (gasStats.samples < 5) {
        return; // Insufficient data
      }

      // Calculate congestion (based on gas price vs historical average)
      const currentPrice = Number(gasStats.current?.gasPrice || 0n);
      const averagePrice = Number(gasStats.average);
      const congestion = Math.min(
        1,
        Math.max(0, (currentPrice - averagePrice) / averagePrice + 0.5)
      );

      // Calculate volatility (based on price range)
      const priceRange = Number(gasStats.max - gasStats.min);
      const volatility = Math.min(1, priceRange / averagePrice);

      // Determine trend using recent price movements
      const trend = this.calculateGasPriceTrend();

      // Estimate competition level (would be enhanced with mempool analysis)
      const competitionLevel = Math.min(1, congestion * 0.7 + volatility * 0.3);

      this.marketConditions = {
        congestion,
        volatility,
        trend,
        competitionLevel,
      };

      this.emit('marketConditionsUpdated', this.marketConditions);
    } catch (error) {
      this.logger.logError(error as Error, { operation: 'update-market-conditions' });
    }
  }

  /**
   * Calculate gas price trend from recent history
   */
  private calculateGasPriceTrend(): 'rising' | 'falling' | 'stable' {
    const gasStats = this.gasEstimator.getGasPriceStats();

    if (gasStats.samples < 10) {
      return 'stable'; // Insufficient data for trend analysis
    }

    // Get recent vs older price comparison
    const currentPrice = Number(gasStats.current?.gasPrice || 0n);
    const averagePrice = Number(gasStats.average);
    const medianPrice = Number(gasStats.median);

    // Calculate trend indicators
    const currentVsAverage = (currentPrice - averagePrice) / averagePrice;
    const currentVsMedian = (currentPrice - medianPrice) / medianPrice;

    // Determine trend based on price position relative to historical data
    const trendThreshold = 0.05; // 5% threshold for trend detection

    if (currentVsAverage > trendThreshold && currentVsMedian > trendThreshold) {
      return 'rising';
    } else if (currentVsAverage < -trendThreshold && currentVsMedian < -trendThreshold) {
      return 'falling';
    } else {
      return 'stable';
    }
  }

  /**
   * Analyze competitor transactions
   */
  analyzeCompetitorTx(txHash: string, gasPrice: bigint): void {
    this.competitorAnalysis.set(txHash, Number(gasPrice));

    // Keep only recent entries (last 100)
    if (this.competitorAnalysis.size > 100) {
      const entries = Array.from(this.competitorAnalysis.entries());
      this.competitorAnalysis.clear();
      entries.slice(-100).forEach(([hash, price]) => {
        this.competitorAnalysis.set(hash, price);
      });
    }

    this.logger.debug('Competitor transaction analyzed', {
      txHash,
      gasPrice: ethers.formatUnits(gasPrice, 'gwei'),
      totalCompetitors: this.competitorAnalysis.size,
    });
  }

  /**
   * Get current market conditions
   */
  getMarketConditions(): GasMarketConditions | undefined {
    return this.marketConditions;
  }

  /**
   * Get last optimization result
   */
  getLastOptimization(): GasOptimizationResult | undefined {
    return this.lastOptimization;
  }

  /**
   * Get optimizer statistics
   */
  getStats() {
    return {
      hasMarketConditions: !!this.marketConditions,
      competitorCount: this.competitorAnalysis.size,
      lastOptimization: this.lastOptimization?.optimizedAt,
      marketConditions: this.marketConditions,
    };
  }
}
