/**
 * Advanced Gas Market Modeling
 *
 * Predicts Base L2 gas price movements and optimizes gas usage
 * with network congestion adaptation
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { OpportunityType } from '../types/execution';

export interface GasMarketModelerConfig {
  readonly predictionWindowMs: number;
  readonly spikeDetectionThreshold: number;
  readonly maxGasPrice: bigint;
  readonly targetROI: number;
  readonly congestionThreshold: number;
  readonly forecastAccuracy: number;
  readonly adaptationSpeed: number;
  readonly gasUsageTrackingWindow: number;
}

export interface GasPricePrediction {
  readonly timestamp: number;
  readonly currentPrice: bigint;
  readonly predictedPrice: bigint;
  readonly confidence: number;
  readonly trend: 'rising' | 'falling' | 'stable';
  readonly volatility: number;
  readonly timeHorizon: number;
  readonly factors: {
    readonly networkCongestion: number;
    readonly blockUtilization: number;
    readonly pendingTransactions: number;
    readonly historicalPattern: number;
  };
}

export interface GasSpike {
  readonly detectedAt: number;
  readonly peakPrice: bigint;
  readonly basePrice: bigint;
  readonly magnitude: number;
  duration: number;
  readonly cause: 'congestion' | 'arbitrage' | 'liquidation' | 'unknown';
  recovered: boolean;
  recoveryTime?: number;
}

export interface GasOptimization {
  readonly opportunityType: OpportunityType;
  readonly recommendedGasPrice: bigint;
  readonly recommendedGasLimit: bigint;
  readonly estimatedCost: bigint;
  readonly maxAcceptableCost: bigint;
  readonly urgency: 'low' | 'medium' | 'high';
  readonly timing: {
    readonly executeNow: boolean;
    readonly waitForBetter: boolean;
    readonly estimatedWaitTime?: number;
  };
  readonly reasoning: string[];
}

export interface NetworkCongestion {
  readonly timestamp: number;
  readonly level: number;
  readonly blockUtilization: number;
  readonly pendingTxCount: number;
  readonly averageGasPrice: bigint;
  readonly medianGasPrice: bigint;
  readonly gasUsedPerSecond: bigint;
  readonly congestionScore: number;
}

export interface GasUsagePattern {
  readonly opportunityType: OpportunityType;
  readonly averageGasUsed: bigint;
  readonly medianGasUsed: bigint;
  readonly maxGasUsed: bigint;
  readonly successRate: number;
  readonly averageCost: bigint;
  readonly efficiency: number;
  readonly sampleSize: number;
  readonly lastUpdated: number;
}

export class GasMarketModeler extends EventEmitter {
  private readonly logger = createComponentLogger('gas-market-modeler');
  private readonly config: GasMarketModelerConfig;
  private readonly provider: ethers.Provider;

  // Gas price tracking
  private readonly gasPriceHistory: Array<{ timestamp: number; price: bigint }> = [];
  private readonly gasSpikes: GasSpike[] = [];
  private currentGasPrice: bigint = 20000000000n; // 20 gwei default

  // Network monitoring
  private readonly congestionHistory: NetworkCongestion[] = [];
  private currentCongestion: NetworkCongestion;

  // Usage pattern tracking
  private readonly gasUsagePatterns = new Map<OpportunityType, GasUsagePattern>();
  private readonly recentUsage: Array<{
    type: OpportunityType;
    gasUsed: bigint;
    gasPrice: bigint;
    success: boolean;
    timestamp: number;
  }> = [];

  // Prediction models
  private readonly predictionModels = new Map<string, (data: number[]) => number>();

  // Timers
  private monitoringTimer: NodeJS.Timeout | null = null;
  private predictionTimer: NodeJS.Timeout | null = null;

  constructor(provider: ethers.Provider, config: GasMarketModelerConfig) {
    super();
    this.provider = provider;
    this.config = config;

    // Initialize current congestion
    this.currentCongestion = {
      timestamp: Date.now(),
      level: 0.5,
      blockUtilization: 0.7,
      pendingTxCount: 1000,
      averageGasPrice: 20000000000n,
      medianGasPrice: 18000000000n,
      gasUsedPerSecond: 1000000n,
      congestionScore: 0.5,
    };

    this.initializePredictionModels();
    this.startGasMonitoring();

    this.logger.info('Gas market modeler initialized', {
      predictionWindowMs: this.config.predictionWindowMs,
      spikeDetectionThreshold: this.config.spikeDetectionThreshold,
      maxGasPrice: this.config.maxGasPrice.toString(),
    });
  }

  /**
   * Predict gas price movements
   */
  async predictGasPrice(timeHorizonMs: number = 60000): Promise<GasPricePrediction> {
    try {
      await this.updateCurrentGasPrice();
      await this.updateNetworkCongestion();

      const currentPrice = this.currentGasPrice;
      const historicalPrices = this.gasPriceHistory.slice(-20).map(h => Number(h.price));

      // Apply prediction models
      const trendModel = this.predictionModels.get('trend');
      const volatilityModel = this.predictionModels.get('volatility');
      const congestionModel = this.predictionModels.get('congestion');

      if (!trendModel || !volatilityModel || !congestionModel) {
        throw new Error('Prediction models not initialized');
      }

      const trendFactor = trendModel(historicalPrices);
      const volatilityFactor = volatilityModel(historicalPrices);
      const congestionFactor = congestionModel([this.currentCongestion.congestionScore]);

      // Combine factors for prediction
      const combinedFactor = trendFactor * 0.4 + congestionFactor * 0.4 + volatilityFactor * 0.2;
      const predictedPrice = BigInt(Math.floor(Number(currentPrice) * (1 + combinedFactor)));

      // Determine trend
      const recentPrices = historicalPrices.slice(-5);
      const trend = this.determineTrend(recentPrices);

      // Calculate confidence based on model accuracy
      const confidence = Math.min(
        0.95,
        this.config.forecastAccuracy * (1 - Math.abs(volatilityFactor))
      );

      const prediction: GasPricePrediction = {
        timestamp: Date.now(),
        currentPrice,
        predictedPrice,
        confidence,
        trend,
        volatility: volatilityFactor,
        timeHorizon: timeHorizonMs,
        factors: {
          networkCongestion: this.currentCongestion.congestionScore,
          blockUtilization: this.currentCongestion.blockUtilization,
          pendingTransactions: this.currentCongestion.pendingTxCount,
          historicalPattern: trendFactor,
        },
      };

      this.emit('gasPricePredicted', prediction);

      return prediction;
    } catch (error) {
      this.logger.error('Gas price prediction failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Return conservative prediction
      return {
        timestamp: Date.now(),
        currentPrice: this.currentGasPrice,
        predictedPrice: this.currentGasPrice,
        confidence: 0.5,
        trend: 'stable',
        volatility: 0.3,
        timeHorizon: timeHorizonMs,
        factors: {
          networkCongestion: 0.5,
          blockUtilization: 0.7,
          pendingTransactions: 1000,
          historicalPattern: 0,
        },
      };
    }
  }

  /**
   * Detect gas price spikes
   */
  async detectGasSpikes(): Promise<GasSpike[]> {
    const activeSpikes: GasSpike[] = [];

    try {
      if (this.gasPriceHistory.length < 10) {
        return activeSpikes;
      }

      const recentPrices = this.gasPriceHistory.slice(-10);
      const basePrice = this.calculateBasePrice(recentPrices);
      const currentPrice = this.currentGasPrice;

      const spikeRatio = Number(currentPrice) / Number(basePrice);

      if (spikeRatio > this.config.spikeDetectionThreshold) {
        // Detect new spike
        const existingSpike = this.gasSpikes.find(
          s => !s.recovered && Date.now() - s.detectedAt < 300000
        ); // 5 minutes

        if (!existingSpike) {
          const spike: GasSpike = {
            detectedAt: Date.now(),
            peakPrice: currentPrice,
            basePrice,
            magnitude: spikeRatio,
            duration: 0,
            cause: this.determineSpikeCase(spikeRatio),
            recovered: false,
          };

          this.gasSpikes.push(spike);
          activeSpikes.push(spike);

          this.emit('gasSpikeDetected', spike);

          this.logger.warn('Gas price spike detected', {
            currentPrice: currentPrice.toString(),
            basePrice: basePrice.toString(),
            magnitude: spikeRatio,
          });
        }
      } else {
        // Check for spike recovery
        for (const spike of this.gasSpikes) {
          if (!spike.recovered && spikeRatio < 1.2) {
            // 20% above base
            spike.recovered = true;
            spike.recoveryTime = Date.now() - spike.detectedAt;
            spike.duration = spike.recoveryTime;

            this.emit('gasSpikeRecovered', spike);

            this.logger.info('Gas price spike recovered', {
              duration: spike.duration,
              recoveryTime: spike.recoveryTime,
            });
          }
        }
      }

      return activeSpikes;
    } catch (error) {
      this.logger.error('Gas spike detection failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return activeSpikes;
    }
  }

  /**
   * Optimize gas parameters for opportunity
   */
  async optimizeGasForOpportunity(
    opportunityType: OpportunityType,
    expectedProfit: bigint,
    urgency: 'low' | 'medium' | 'high' = 'medium'
  ): Promise<GasOptimization> {
    try {
      const prediction = await this.predictGasPrice();

      // Calculate recommended gas limit
      const baseGasLimit = this.getBaseGasLimit(opportunityType);
      const congestionMultiplier = 1 + this.currentCongestion.level * 0.3;
      const recommendedGasLimit = BigInt(Math.floor(Number(baseGasLimit) * congestionMultiplier));

      // Calculate recommended gas price based on urgency
      let recommendedGasPrice = prediction.predictedPrice;

      switch (urgency) {
        case 'high':
          recommendedGasPrice = (recommendedGasPrice * 120n) / 100n; // +20%
          break;
        case 'low':
          recommendedGasPrice = (recommendedGasPrice * 90n) / 100n; // -10%
          break;
        default:
          // Use predicted price as-is
          break;
      }

      // Cap gas price
      if (recommendedGasPrice > this.config.maxGasPrice) {
        recommendedGasPrice = this.config.maxGasPrice;
      }

      const estimatedCost = recommendedGasLimit * recommendedGasPrice;

      // Calculate maximum acceptable cost based on target ROI
      const maxAcceptableCost =
        (expectedProfit * BigInt(Math.floor((1 / this.config.targetROI) * 100))) / 100n;

      // Determine timing recommendations
      const executeNow = estimatedCost <= maxAcceptableCost && urgency !== 'low';
      const waitForBetter = !executeNow && prediction.trend === 'falling';

      const reasoning: string[] = [];

      if (estimatedCost > maxAcceptableCost) {
        reasoning.push(
          `Gas cost ${estimatedCost.toString()} exceeds max acceptable ${maxAcceptableCost.toString()}`
        );
      }

      if (prediction.trend === 'rising') {
        reasoning.push('Gas prices trending upward - consider executing soon');
      } else if (prediction.trend === 'falling') {
        reasoning.push('Gas prices trending downward - may wait for better prices');
      }

      if (this.currentCongestion.level > this.config.congestionThreshold) {
        reasoning.push('High network congestion detected');
      }

      const optimization: GasOptimization = {
        opportunityType,
        recommendedGasPrice,
        recommendedGasLimit,
        estimatedCost,
        maxAcceptableCost,
        urgency,
        timing: {
          executeNow,
          waitForBetter,
          ...(waitForBetter && { estimatedWaitTime: this.estimateWaitTime(prediction) }),
        },
        reasoning,
      };

      this.emit('gasOptimized', optimization);

      return optimization;
    } catch (error) {
      this.logger.error('Gas optimization failed', {
        opportunityType,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return conservative optimization
      const baseGasLimit = this.getBaseGasLimit(opportunityType);
      const conservativeGasPrice = (this.currentGasPrice * 110n) / 100n; // +10%

      return {
        opportunityType,
        recommendedGasPrice: conservativeGasPrice,
        recommendedGasLimit: baseGasLimit,
        estimatedCost: baseGasLimit * conservativeGasPrice,
        maxAcceptableCost: expectedProfit / 2n, // 50% of profit
        urgency,
        timing: {
          executeNow: true,
          waitForBetter: false,
        },
        reasoning: ['Using conservative estimates due to prediction failure'],
      };
    }
  }

  /**
   * Record gas usage for pattern learning
   */
  recordGasUsage(
    opportunityType: OpportunityType,
    gasUsed: bigint,
    gasPrice: bigint,
    success: boolean
  ): void {
    const usage = {
      type: opportunityType,
      gasUsed,
      gasPrice,
      success,
      timestamp: Date.now(),
    };

    this.recentUsage.push(usage);

    // Keep only recent usage data
    const cutoff = Date.now() - this.config.gasUsageTrackingWindow;
    while (this.recentUsage.length > 0 && this.recentUsage[0]!.timestamp < cutoff) {
      this.recentUsage.shift();
    }

    // Update usage patterns
    this.updateUsagePattern(opportunityType);

    this.logger.debug('Gas usage recorded', {
      opportunityType,
      gasUsed: gasUsed.toString(),
      gasPrice: gasPrice.toString(),
      success,
    });
  }

  /**
   * Adapt strategy based on network conditions
   */
  async adaptToNetworkConditions(): Promise<void> {
    try {
      await this.updateNetworkCongestion();

      const congestionLevel = this.currentCongestion.level;
      const adaptationNeeded = Math.abs(congestionLevel - 0.5) > 0.2; // Significant deviation

      if (adaptationNeeded) {
        this.logger.info('Adapting to network conditions', {
          congestionLevel,
          blockUtilization: this.currentCongestion.blockUtilization,
        });

        // Adjust thresholds based on congestion
        if (congestionLevel > 0.8) {
          // High congestion - be more conservative
          this.emit('strategyAdaptation', {
            type: 'conservative',
            reason: 'High network congestion',
            recommendations: [
              'Increase gas prices by 20-30%',
              'Reduce position sizes',
              'Prioritize high-profit opportunities only',
            ],
          });
        } else if (congestionLevel < 0.3) {
          // Low congestion - be more aggressive
          this.emit('strategyAdaptation', {
            type: 'aggressive',
            reason: 'Low network congestion',
            recommendations: [
              'Use standard gas prices',
              'Consider larger position sizes',
              'Execute lower-profit opportunities',
            ],
          });
        }
      }
    } catch (error) {
      this.logger.error('Network adaptation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Helper methods
   */
  private async updateCurrentGasPrice(): Promise<void> {
    try {
      const feeData = await this.provider.getFeeData();
      const newPrice = feeData.gasPrice || this.currentGasPrice;

      this.gasPriceHistory.push({
        timestamp: Date.now(),
        price: newPrice,
      });

      // Keep only recent history
      if (this.gasPriceHistory.length > 1000) {
        this.gasPriceHistory.splice(0, this.gasPriceHistory.length - 1000);
      }

      this.currentGasPrice = newPrice;
    } catch (error) {
      this.logger.warn('Failed to update gas price', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async updateNetworkCongestion(): Promise<void> {
    try {
      // Simulate network congestion metrics (would use real data in production)
      const blockUtilization = 0.6 + Math.random() * 0.3; // 0.6-0.9
      const pendingTxCount = Math.floor(Math.random() * 2000 + 500); // 500-2500
      const gasUsedPerSecond = BigInt(Math.floor(Math.random() * 2000000 + 500000)); // 500K-2.5M

      const congestionScore =
        blockUtilization * 0.4 +
        Math.min(1, pendingTxCount / 2000) * 0.3 +
        Math.min(1, Number(gasUsedPerSecond) / 2000000) * 0.3;

      this.currentCongestion = {
        timestamp: Date.now(),
        level: congestionScore,
        blockUtilization,
        pendingTxCount,
        averageGasPrice: this.currentGasPrice,
        medianGasPrice: (this.currentGasPrice * 95n) / 100n,
        gasUsedPerSecond,
        congestionScore,
      };

      this.congestionHistory.push(this.currentCongestion);

      // Keep only recent history
      if (this.congestionHistory.length > 100) {
        this.congestionHistory.splice(0, this.congestionHistory.length - 100);
      }
    } catch (error) {
      this.logger.error('Failed to update network congestion', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private initializePredictionModels(): void {
    // Simple moving average trend model
    this.predictionModels.set('trend', (prices: number[]) => {
      if (prices.length < 5) return 0;

      const recent = prices.slice(-5);
      const older = prices.slice(-10, -5);

      const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;

      return (recentAvg - olderAvg) / olderAvg;
    });

    // Volatility model
    this.predictionModels.set('volatility', (prices: number[]) => {
      if (prices.length < 5) return 0.3;

      const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
      const variance =
        prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;

      return Math.sqrt(variance) / mean;
    });

    // Congestion model
    this.predictionModels.set('congestion', (congestionScores: number[]) => {
      const score = congestionScores[0] || 0.5;
      return (score - 0.5) * 0.5; // -0.25 to +0.25 factor
    });

    this.logger.info('Prediction models initialized');
  }

  private determineTrend(prices: number[]): 'rising' | 'falling' | 'stable' {
    if (prices.length < 3) return 'stable';

    const first = prices[0]!;
    const last = prices[prices.length - 1]!;
    const change = (last - first) / first;

    if (change > 0.05) return 'rising';
    if (change < -0.05) return 'falling';
    return 'stable';
  }

  private calculateBasePrice(priceHistory: Array<{ timestamp: number; price: bigint }>): bigint {
    const prices = priceHistory.map(h => h.price);
    prices.sort((a, b) => Number(a) - Number(b));

    // Use median as base price
    const midIndex = Math.floor(prices.length / 2);
    return prices[midIndex] || this.currentGasPrice;
  }

  private determineSpikeCase(
    magnitude: number
  ): 'congestion' | 'arbitrage' | 'liquidation' | 'unknown' {
    if (magnitude > 3) return 'liquidation';
    if (magnitude > 2) return 'arbitrage';
    if (magnitude > 1.5) return 'congestion';
    return 'unknown';
  }

  private getBaseGasLimit(opportunityType: OpportunityType): bigint {
    switch (opportunityType) {
      case OpportunityType.ARBITRAGE:
        return 300000n;
      case OpportunityType.LIQUIDATION:
        return 500000n;
      case OpportunityType.STABLE_POOL_REBALANCING:
        return 400000n;
      case OpportunityType.MEMPOOL_BACKRUN:
        return 250000n;
      default:
        return 200000n;
    }
  }

  private estimateWaitTime(prediction: GasPricePrediction): number {
    if (prediction.trend === 'falling') {
      return Math.min(300000, prediction.volatility * 600000); // Max 5 minutes
    }
    return 60000; // 1 minute default
  }

  private updateUsagePattern(opportunityType: OpportunityType): void {
    const relevantUsage = this.recentUsage.filter(u => u.type === opportunityType);

    if (relevantUsage.length === 0) return;

    const gasUsedValues = relevantUsage.map(u => u.gasUsed);
    const costs = relevantUsage.map(u => u.gasUsed * u.gasPrice);
    const successCount = relevantUsage.filter(u => u.success).length;

    gasUsedValues.sort((a, b) => Number(a) - Number(b));
    costs.sort((a, b) => Number(a) - Number(b));

    const averageGasUsed =
      gasUsedValues.reduce((sum, gas) => sum + gas, 0n) / BigInt(gasUsedValues.length);
    const medianGasUsed = gasUsedValues[Math.floor(gasUsedValues.length / 2)] || 0n;
    const maxGasUsed = gasUsedValues[gasUsedValues.length - 1] || 0n;
    const averageCost = costs.reduce((sum, cost) => sum + cost, 0n) / BigInt(costs.length);
    const successRate = successCount / relevantUsage.length;
    const efficiency = successRate * (1 / Number(averageGasUsed)) * 1000000; // Efficiency metric

    const pattern: GasUsagePattern = {
      opportunityType,
      averageGasUsed,
      medianGasUsed,
      maxGasUsed,
      successRate,
      averageCost,
      efficiency,
      sampleSize: relevantUsage.length,
      lastUpdated: Date.now(),
    };

    this.gasUsagePatterns.set(opportunityType, pattern);
  }

  private startGasMonitoring(): void {
    // Monitor gas prices and network conditions
    this.monitoringTimer = setInterval(async () => {
      await this.updateCurrentGasPrice();
      await this.updateNetworkCongestion();
      await this.detectGasSpikes();
    }, 10000); // Every 10 seconds

    // Generate predictions periodically
    this.predictionTimer = setInterval(async () => {
      await this.predictGasPrice();
      await this.adaptToNetworkConditions();
    }, 30000); // Every 30 seconds

    this.logger.info('Gas monitoring started');
  }

  /**
   * Get modeler statistics
   */
  getModelerStats(): {
    currentGasPrice: bigint;
    gasPriceHistory: number;
    activeSpikes: number;
    congestionLevel: number;
    usagePatterns: number;
    predictionAccuracy: number;
  } {
    const activeSpikes = this.gasSpikes.filter(s => !s.recovered).length;

    return {
      currentGasPrice: this.currentGasPrice,
      gasPriceHistory: this.gasPriceHistory.length,
      activeSpikes,
      congestionLevel: this.currentCongestion.level,
      usagePatterns: this.gasUsagePatterns.size,
      predictionAccuracy: this.config.forecastAccuracy,
    };
  }

  /**
   * Stop modeler
   */
  stop(): void {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
    }

    if (this.predictionTimer) {
      clearInterval(this.predictionTimer);
      this.predictionTimer = null;
    }

    this.logger.info('Gas market modeler stopped');
  }
}
