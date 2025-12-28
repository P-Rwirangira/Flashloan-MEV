/**
 * Bribe Optimizer
 *
 * Optimizes bribe amounts for transaction inclusion based on network conditions,
 * inclusion probability modeling, and dynamic adjustment algorithms.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';

/**
 * Network congestion levels
 */
export enum CongestionLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  EXTREME = 'extreme',
}

/**
 * Bribe optimization parameters
 */
export interface BribeOptimizationParams {
  baseGasPrice: bigint;
  networkCongestion: CongestionLevel;
  timeUrgency: number; // 0-1 scale
  priority: 'high' | 'medium' | 'low';
  targetInclusionProbability: number; // 0-1 scale
  maxBribe: bigint;
  minBribe: bigint;
}

/**
 * Inclusion probability model
 */
export interface InclusionModel {
  baseProbability: number;
  bribeMultiplier: number;
  congestionPenalty: number;
  timeDecay: number;
}

/**
 * Bribe optimization result
 */
export interface BribeOptimizationResult {
  optimalBribe: bigint;
  expectedInclusionProbability: number;
  confidenceLevel: number;
  reasoning: string[];
}

/**
 * Historical bribe data point
 */
export interface BribeDataPoint {
  timestamp: number;
  bribe: bigint;
  gasPrice: bigint;
  included: boolean;
  blockNumber: number;
  congestionLevel: CongestionLevel;
  inclusionTime?: number;
}

/**
 * Bribe Optimizer class
 */
export class BribeOptimizer extends EventEmitter {
  private readonly historicalData: BribeDataPoint[];
  private readonly inclusionModel: InclusionModel;
  private currentCongestion: CongestionLevel = CongestionLevel.MEDIUM;
  private lastOptimization: number = 0;

  // Congestion level thresholds (in gwei)
  private readonly congestionThresholds = {
    [CongestionLevel.LOW]: 10n,
    [CongestionLevel.MEDIUM]: 25n,
    [CongestionLevel.HIGH]: 50n,
    [CongestionLevel.EXTREME]: 100n,
  };

  constructor(inclusionModel?: Partial<InclusionModel>) {
    super();

    this.historicalData = [];
    this.inclusionModel = {
      baseProbability: 0.7,
      bribeMultiplier: 0.15,
      congestionPenalty: 0.2,
      timeDecay: 0.1,
      ...inclusionModel,
    };
  }

  /**
   * Calculate optimal bribe for given parameters
   */
  calculateOptimalBribe(params: BribeOptimizationParams): BribeOptimizationResult {
    const reasoning: string[] = [];

    // Start with base gas price
    let optimalBribe = params.baseGasPrice;
    reasoning.push(`Base gas price: ${ethers.formatUnits(params.baseGasPrice, 'gwei')} gwei`);

    // Apply congestion multiplier
    const congestionMultiplier = this.getCongestionMultiplier(params.networkCongestion);
    optimalBribe = (optimalBribe * BigInt(Math.floor(congestionMultiplier * 100))) / 100n;
    reasoning.push(`Congestion multiplier (${params.networkCongestion}): ${congestionMultiplier}x`);

    // Apply priority multiplier
    const priorityMultiplier = this.getPriorityMultiplier(params.priority);
    optimalBribe = (optimalBribe * BigInt(Math.floor(priorityMultiplier * 100))) / 100n;
    reasoning.push(`Priority multiplier (${params.priority}): ${priorityMultiplier}x`);

    // Apply time urgency multiplier
    const urgencyMultiplier = 1 + params.timeUrgency;
    optimalBribe = (optimalBribe * BigInt(Math.floor(urgencyMultiplier * 100))) / 100n;
    reasoning.push(`Time urgency multiplier: ${urgencyMultiplier}x`);

    // Apply historical learning adjustment
    const historicalAdjustment = this.getHistoricalAdjustment(params);
    optimalBribe = (optimalBribe * BigInt(Math.floor(historicalAdjustment * 100))) / 100n;
    reasoning.push(`Historical adjustment: ${historicalAdjustment}x`);

    // Apply inclusion probability targeting
    const probabilityAdjustment = this.getInclusionProbabilityAdjustment(
      params.targetInclusionProbability,
      params.networkCongestion
    );
    optimalBribe = (optimalBribe * BigInt(Math.floor(probabilityAdjustment * 100))) / 100n;
    reasoning.push(`Inclusion probability adjustment: ${probabilityAdjustment}x`);

    // Clamp to bounds
    if (optimalBribe < params.minBribe) {
      optimalBribe = params.minBribe;
      reasoning.push(
        `Clamped to minimum bribe: ${ethers.formatUnits(params.minBribe, 'gwei')} gwei`
      );
    }

    if (optimalBribe > params.maxBribe) {
      optimalBribe = params.maxBribe;
      reasoning.push(
        `Clamped to maximum bribe: ${ethers.formatUnits(params.maxBribe, 'gwei')} gwei`
      );
    }

    // Calculate expected inclusion probability
    const expectedInclusionProbability = this.calculateInclusionProbability(
      optimalBribe,
      params.baseGasPrice,
      params.networkCongestion,
      params.timeUrgency
    );

    // Calculate confidence level based on historical data
    const confidenceLevel = this.calculateConfidenceLevel(params);

    this.lastOptimization = Date.now();

    return {
      optimalBribe,
      expectedInclusionProbability,
      confidenceLevel,
      reasoning,
    };
  }

  /**
   * Get congestion multiplier based on network conditions
   */
  private getCongestionMultiplier(congestion: CongestionLevel): number {
    switch (congestion) {
      case CongestionLevel.LOW:
        return 1.0;
      case CongestionLevel.MEDIUM:
        return 1.5;
      case CongestionLevel.HIGH:
        return 2.5;
      case CongestionLevel.EXTREME:
        return 4.0;
      default:
        return 1.5;
    }
  }

  /**
   * Get priority multiplier
   */
  private getPriorityMultiplier(priority: 'high' | 'medium' | 'low'): number {
    switch (priority) {
      case 'high':
        return 2.0;
      case 'medium':
        return 1.5;
      case 'low':
        return 1.0;
      default:
        return 1.5;
    }
  }

  /**
   * Get historical adjustment based on recent performance
   */
  private getHistoricalAdjustment(params: BribeOptimizationParams): number {
    if (this.historicalData.length < 10) {
      return 1.0; // Not enough data
    }

    // Get recent data points (last 24 hours)
    const recentData = this.historicalData.filter(
      point => Date.now() - point.timestamp < 24 * 60 * 60 * 1000
    );

    if (recentData.length === 0) {
      return 1.0;
    }

    // Calculate success rate for similar conditions
    const similarConditions = recentData.filter(
      point => point.congestionLevel === params.networkCongestion
    );

    if (similarConditions.length === 0) {
      return 1.0;
    }

    const successRate =
      similarConditions.filter(point => point.included).length / similarConditions.length;

    // If success rate is low, increase bribe
    if (successRate < 0.5) {
      return 1.3;
    } else if (successRate < 0.7) {
      return 1.1;
    } else if (successRate > 0.9) {
      return 0.9; // Can afford to bid lower
    }

    return 1.0;
  }

  /**
   * Get inclusion probability adjustment
   */
  private getInclusionProbabilityAdjustment(
    targetProbability: number,
    congestion: CongestionLevel
  ): number {
    const baseProbability = this.inclusionModel.baseProbability;
    const congestionPenalty = this.getCongestionPenalty(congestion);

    const currentProbability = baseProbability - congestionPenalty;

    if (targetProbability > currentProbability) {
      // Need to increase bribe to reach target probability
      const probabilityGap = targetProbability - currentProbability;
      return 1 + probabilityGap * 2; // 2x multiplier for probability gap
    }

    return 1.0;
  }

  /**
   * Get congestion penalty for inclusion probability
   */
  private getCongestionPenalty(congestion: CongestionLevel): number {
    switch (congestion) {
      case CongestionLevel.LOW:
        return 0.0;
      case CongestionLevel.MEDIUM:
        return 0.1;
      case CongestionLevel.HIGH:
        return 0.2;
      case CongestionLevel.EXTREME:
        return 0.3;
      default:
        return 0.1;
    }
  }

  /**
   * Calculate expected inclusion probability
   */
  private calculateInclusionProbability(
    bribe: bigint,
    baseGasPrice: bigint,
    congestion: CongestionLevel,
    timeUrgency: number
  ): number {
    const bribeRatio = Number(bribe) / Number(baseGasPrice);
    const bribeBonus = Math.min(0.3, bribeRatio * this.inclusionModel.bribeMultiplier);

    const congestionPenalty = this.getCongestionPenalty(congestion);
    const timeDecay = timeUrgency * this.inclusionModel.timeDecay;

    const probability =
      this.inclusionModel.baseProbability + bribeBonus - congestionPenalty - timeDecay;

    return Math.max(0.1, Math.min(0.95, probability));
  }

  /**
   * Calculate confidence level based on historical data
   */
  private calculateConfidenceLevel(params: BribeOptimizationParams): number {
    const dataPoints = this.historicalData.length;

    // Base confidence from data quantity
    let baseConfidence: number;
    if (dataPoints < 10) {
      baseConfidence = 0.3; // Low confidence with little data
    } else if (dataPoints < 50) {
      baseConfidence = 0.6; // Medium confidence
    } else if (dataPoints < 200) {
      baseConfidence = 0.8; // High confidence
    } else {
      baseConfidence = 0.9; // Very high confidence
    }

    // Adjust confidence based on optimization parameters
    let adjustedConfidence = baseConfidence;

    // Reduce confidence for extreme conditions
    if (params.networkCongestion === CongestionLevel.EXTREME) {
      adjustedConfidence *= 0.8; // Less predictable in extreme congestion
    }

    // Reduce confidence for very high urgency (less time for analysis)
    if (params.timeUrgency > 0.8) {
      adjustedConfidence *= 0.9;
    }

    // Reduce confidence for very high target inclusion probability
    if (params.targetInclusionProbability > 0.9) {
      adjustedConfidence *= 0.85; // Harder to predict at extreme probabilities
    }

    return Math.max(0.1, Math.min(0.95, adjustedConfidence));
  }

  /**
   * Update network congestion level based on gas prices
   */
  updateCongestionLevel(currentGasPrice: bigint): void {
    const gasPriceGwei = currentGasPrice / 1000000000n; // Convert to gwei

    let newCongestion: CongestionLevel;

    if (gasPriceGwei <= this.congestionThresholds[CongestionLevel.LOW]) {
      newCongestion = CongestionLevel.LOW;
    } else if (gasPriceGwei <= this.congestionThresholds[CongestionLevel.MEDIUM]) {
      newCongestion = CongestionLevel.MEDIUM;
    } else if (gasPriceGwei <= this.congestionThresholds[CongestionLevel.HIGH]) {
      newCongestion = CongestionLevel.HIGH;
    } else {
      newCongestion = CongestionLevel.EXTREME;
    }

    if (newCongestion !== this.currentCongestion) {
      const oldCongestion = this.currentCongestion;
      this.currentCongestion = newCongestion;

      this.emit('congestionLevelChanged', {
        oldLevel: oldCongestion,
        newLevel: newCongestion,
        gasPrice: currentGasPrice,
      });
    }
  }

  /**
   * Add historical data point
   */
  addHistoricalData(dataPoint: BribeDataPoint): void {
    this.historicalData.push(dataPoint);

    // Keep only last 1000 data points to prevent memory bloat
    if (this.historicalData.length > 1000) {
      this.historicalData.splice(0, this.historicalData.length - 1000);
    }

    this.emit('historicalDataAdded', dataPoint);
  }

  /**
   * Get current congestion level
   */
  getCurrentCongestion(): CongestionLevel {
    return this.currentCongestion;
  }

  /**
   * Get optimization statistics
   */
  getStats(): {
    totalDataPoints: number;
    recentSuccessRate: number;
    averageBribe: bigint;
    currentCongestion: CongestionLevel;
    lastOptimization: number;
  } {
    const recentData = this.historicalData.filter(
      point => Date.now() - point.timestamp < 24 * 60 * 60 * 1000
    );

    const recentSuccessRate =
      recentData.length > 0
        ? recentData.filter(point => point.included).length / recentData.length
        : 0;

    const totalBribes = this.historicalData.reduce((sum, point) => sum + point.bribe, 0n);
    const averageBribe =
      this.historicalData.length > 0 ? totalBribes / BigInt(this.historicalData.length) : 0n;

    return {
      totalDataPoints: this.historicalData.length,
      recentSuccessRate,
      averageBribe,
      currentCongestion: this.currentCongestion,
      lastOptimization: this.lastOptimization,
    };
  }

  /**
   * Adjust bribe for retry attempt
   */
  adjustBribeForRetry(originalBribe: bigint, attemptNumber: number, maxBribe: bigint): bigint {
    // Exponential backoff with jitter
    const multiplier = Math.pow(1.5, attemptNumber) + (Math.random() * 0.2 - 0.1);
    let newBribe = (originalBribe * BigInt(Math.floor(multiplier * 100))) / 100n;

    // Clamp to maximum
    if (newBribe > maxBribe) {
      newBribe = maxBribe;
    }

    return newBribe;
  }

  /**
   * Predict optimal bribe for future time
   */
  predictOptimalBribe(
    params: BribeOptimizationParams,
    futureTimestamp: number
  ): BribeOptimizationResult {
    // Adjust time urgency based on future timestamp
    const timeToExecution = Math.max(0, futureTimestamp - Date.now());
    const adjustedUrgency = Math.min(1, params.timeUrgency + (30000 - timeToExecution) / 30000);

    const adjustedParams = {
      ...params,
      timeUrgency: adjustedUrgency,
    };

    return this.calculateOptimalBribe(adjustedParams);
  }

  /**
   * Clear historical data
   */
  clearHistoricalData(): void {
    this.historicalData.length = 0;
    this.emit('historicalDataCleared');
  }
}
