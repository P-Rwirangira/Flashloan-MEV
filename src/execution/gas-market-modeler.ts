import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { OpportunityType } from '../types/execution';

export interface GasMarketModelerConfig {
  readonly predictionWindowMs: number;
  readonly spikeDetectionThreshold: number;
  readonly maxGasPriceGwei: number;
  readonly targetROI: number;
  readonly gasUsageTrackingWindowMs: number;
  readonly forecastAccuracyThreshold: number;
  readonly congestionAdaptationEnabled: boolean;
  readonly priceHistorySize: number;
}

export interface GasPricePrediction {
  readonly timestamp: number;
  readonly currentPrice: bigint;
  readonly predictedPrice: bigint;
  readonly confidence: number;
  readonly trend: 'rising' | 'falling' | 'stable';
  readonly spikeRisk: number;
  readonly timeToSpike: number;
  readonly recommendedAction: 'execute' | 'wait' | 'cancel';
  readonly validUntil: number;
}

export interface GasUsagePattern {
  readonly opportunityType: OpportunityType;
  readonly averageGasUsed: bigint;
  readonly maxGasUsed: bigint;
  readonly minGasUsed: bigint;
  readonly successRate: number;
  readonly optimalGasLimit: bigint;
  readonly lastUpdated: number;
  readonly sampleCount: number;
}

export interface NetworkCongestionMetrics {
  readonly timestamp: number;
  readonly pendingTransactions: number;
  readonly averageGasPrice: bigint;
  readonly medianGasPrice: bigint;
  readonly gasUsageRate: number;
  readonly blockUtilization: number;
  readonly congestionLevel: 'low' | 'medium' | 'high' | 'extreme';
  readonly estimatedClearTime: number;
}

export interface GasOptimizationResult {
  readonly opportunityType: OpportunityType;
  readonly recommendedGasPrice: bigint;
  readonly recommendedGasLimit: bigint;
  readonly estimatedCost: bigint;
  readonly maxCostForROI: bigint;
  readonly executionProbability: number;
  readonly timeWindow: number;
  readonly riskLevel: 'low' | 'medium' | 'high';
}

export class GasMarketModeler extends EventEmitter {
  private readonly logger = createComponentLogger('gas-market-modeler');
  private readonly config: GasMarketModelerConfig;
  private readonly provider: ethers.Provider;
  private readonly gasPriceHistory: Array<{ price: bigint; timestamp: number }> = [];
  private readonly gasUsagePatterns = new Map<OpportunityType, GasUsagePattern>();
  private currentCongestionMetrics: NetworkCongestionMetrics;
  private predictionCount = 0;
  private accuratePredictions = 0;
  private monitoringTimer: NodeJS.Timeout | null = null;

  constructor(provider: ethers.Provider, config: GasMarketModelerConfig) {
    super();
    this.provider = provider;
    this.config = config;

    this.currentCongestionMetrics = {
      timestamp: Date.now(),
      pendingTransactions: 0,
      averageGasPrice: 1000000000n,
      medianGasPrice: 1000000000n,
      gasUsageRate: 0.5,
      blockUtilization: 0.6,
      congestionLevel: 'low',
      estimatedClearTime: 2000,
    };

    this.initializeGasUsagePatterns();
    this.startGasMonitoring();

    this.logger.info('Gas market modeler initialized');
  }

  async getGasPricePrediction(): Promise<GasPricePrediction> {
    const currentPrice = await this.getCurrentGasPrice();
    return {
      timestamp: Date.now(),
      currentPrice,
      predictedPrice: (currentPrice * 110n) / 100n,
      confidence: 0.8,
      trend: 'stable',
      spikeRisk: 0.3,
      timeToSpike: 60000,
      recommendedAction: 'execute',
      validUntil: Date.now() + this.config.predictionWindowMs,
    };
  }

  async optimizeGasParameters(
    opportunityType: OpportunityType,
    expectedProfit: bigint,
    urgency: 'low' | 'medium' | 'high' = 'medium'
  ): Promise<GasOptimizationResult> {
    const prediction = await this.getGasPricePrediction();
    const usagePattern = this.gasUsagePatterns.get(opportunityType);

    if (!usagePattern) {
      throw new Error(`No usage pattern found for opportunity type: ${opportunityType}`);
    }

    const maxCostForROI =
      (expectedProfit * BigInt(Math.floor((1 - this.config.targetROI) * 100))) / 100n;
    let recommendedGasPrice = prediction.currentPrice;

    switch (urgency) {
      case 'high':
        recommendedGasPrice = (prediction.predictedPrice * 120n) / 100n;
        break;
      case 'medium':
        recommendedGasPrice = (prediction.predictedPrice * 110n) / 100n;
        break;
      case 'low':
        recommendedGasPrice = prediction.currentPrice;
        break;
    }

    const maxGasPrice = BigInt(this.config.maxGasPriceGwei) * 1000000000n;
    recommendedGasPrice = recommendedGasPrice > maxGasPrice ? maxGasPrice : recommendedGasPrice;

    const recommendedGasLimit = this.optimizeGasLimit(usagePattern, urgency);
    const estimatedCost = recommendedGasPrice * recommendedGasLimit;

    return {
      opportunityType,
      recommendedGasPrice,
      recommendedGasLimit,
      estimatedCost,
      maxCostForROI,
      executionProbability: 0.85,
      timeWindow: 30000,
      riskLevel: 'medium',
    };
  }

  recordGasUsage(
    opportunityType: OpportunityType,
    gasUsed: bigint,
    gasLimit: bigint,
    success: boolean
  ): void {
    const existing = this.gasUsagePatterns.get(opportunityType);

    if (!existing) {
      this.gasUsagePatterns.set(opportunityType, {
        opportunityType,
        averageGasUsed: gasUsed,
        maxGasUsed: gasUsed,
        minGasUsed: gasUsed,
        successRate: success ? 1.0 : 0.0,
        optimalGasLimit: gasLimit,
        lastUpdated: Date.now(),
        sampleCount: 1,
      });
      return;
    }

    const alpha = 0.1;
    const newSampleCount = existing.sampleCount + 1;
    const newSuccessRate =
      (existing.successRate * existing.sampleCount + (success ? 1 : 0)) / newSampleCount;

    const updatedPattern: GasUsagePattern = {
      opportunityType,
      averageGasUsed: BigInt(
        Math.floor(Number(existing.averageGasUsed) * (1 - alpha) + Number(gasUsed) * alpha)
      ),
      maxGasUsed: gasUsed > existing.maxGasUsed ? gasUsed : existing.maxGasUsed,
      minGasUsed: gasUsed < existing.minGasUsed ? gasUsed : existing.minGasUsed,
      successRate: newSuccessRate,
      optimalGasLimit: gasLimit,
      lastUpdated: Date.now(),
      sampleCount: newSampleCount,
    };

    this.gasUsagePatterns.set(opportunityType, updatedPattern);
  }

  private async getCurrentGasPrice(): Promise<bigint> {
    try {
      const feeData = await this.provider.getFeeData();
      return feeData.gasPrice || 1000000000n;
    } catch (error) {
      return 1000000000n;
    }
  }

  private optimizeGasLimit(
    usagePattern: GasUsagePattern,
    urgency: 'low' | 'medium' | 'high'
  ): bigint {
    let multiplier = 1.1;

    switch (urgency) {
      case 'high':
        multiplier = 1.3;
        break;
      case 'medium':
        multiplier = 1.2;
        break;
      case 'low':
        multiplier = 1.1;
        break;
    }

    return BigInt(Math.floor(Number(usagePattern.averageGasUsed) * multiplier));
  }

  private initializeGasUsagePatterns(): void {
    const defaultPatterns: Array<[OpportunityType, Partial<GasUsagePattern>]> = [
      [OpportunityType.ARBITRAGE, { averageGasUsed: 300000n, optimalGasLimit: 350000n }],
      [OpportunityType.LIQUIDATION, { averageGasUsed: 500000n, optimalGasLimit: 600000n }],
      [
        OpportunityType.STABLE_POOL_REBALANCING,
        { averageGasUsed: 400000n, optimalGasLimit: 480000n },
      ],
      [OpportunityType.MEMPOOL_BACKRUN, { averageGasUsed: 250000n, optimalGasLimit: 300000n }],
    ];

    for (const [type, pattern] of defaultPatterns) {
      this.gasUsagePatterns.set(type, {
        opportunityType: type,
        averageGasUsed: pattern.averageGasUsed || 200000n,
        maxGasUsed: pattern.averageGasUsed || 200000n,
        minGasUsed: pattern.averageGasUsed || 200000n,
        successRate: 0.8,
        optimalGasLimit: pattern.optimalGasLimit || 250000n,
        lastUpdated: Date.now(),
        sampleCount: 1,
      });
    }
  }

  private startGasMonitoring(): void {
    this.monitoringTimer = setInterval(async () => {
      await this.updateNetworkCongestion();
    }, 10000);
  }

  private async updateNetworkCongestion(): Promise<void> {
    const currentPrice = await this.getCurrentGasPrice();
    const blockUtilization = Math.random() * 0.4 + 0.6;

    let congestionLevel: 'low' | 'medium' | 'high' | 'extreme' = 'low';
    if (blockUtilization > 0.95) {
      congestionLevel = 'extreme';
    } else if (blockUtilization > 0.85) {
      congestionLevel = 'high';
    } else if (blockUtilization > 0.75) {
      congestionLevel = 'medium';
    }

    this.currentCongestionMetrics = {
      timestamp: Date.now(),
      pendingTransactions: Math.floor(Math.random() * 2000 + 100),
      averageGasPrice: currentPrice,
      medianGasPrice: currentPrice,
      gasUsageRate: blockUtilization,
      blockUtilization,
      congestionLevel,
      estimatedClearTime: 2000,
    };
  }

  getModelerStats(): {
    predictionCount: number;
    forecastAccuracy: number;
    currentGasPrice: string;
    congestionLevel: string;
  } {
    const currentPrice = this.gasPriceHistory[this.gasPriceHistory.length - 1]?.price || 0n;
    const forecastAccuracy =
      this.predictionCount > 0 ? this.accuratePredictions / this.predictionCount : 0.5;

    return {
      predictionCount: this.predictionCount,
      forecastAccuracy,
      currentGasPrice: currentPrice.toString(),
      congestionLevel: this.currentCongestionMetrics.congestionLevel,
    };
  }

  stop(): void {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
    }

    this.gasPriceHistory.length = 0;
    this.gasUsagePatterns.clear();

    this.logger.info('Gas market modeler stopped');
  }
}
