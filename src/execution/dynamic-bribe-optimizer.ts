/**
 * Dynamic Bribe Optimization System
 *
 * Implements real-time bribe calculation based on network conditions
 * with inclusion probability modeling and relay-specific optimization
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';

export interface DynamicBribeOptimizerConfig {
  readonly maxBribePercentage: number;
  readonly minBribeAmount: bigint;
  readonly maxBribeAmount: bigint;
  readonly targetInclusionProbability: number;
  readonly bribeEscalationFactor: number;
  readonly maxEscalationSteps: number;
  readonly networkConditionUpdateIntervalMs: number;
  readonly bribeEffectivenessWindowMs: number;
  readonly enableAutoCancellation: boolean;
  readonly profitabilityThreshold: number;
}

export interface NetworkConditions {
  readonly currentBaseFee: bigint;
  readonly priorityFeePercentiles: bigint[];
  readonly blockUtilization: number;
  readonly mempoolSize: number;
  readonly competitorGasPrices: bigint[];
  readonly averageBlockTime: number;
  readonly networkCongestion: 'low' | 'medium' | 'high';
  readonly timestamp: number;
}

export interface BribeCalculation {
  readonly opportunityId: string;
  readonly estimatedProfit: bigint;
  readonly recommendedBribe: bigint;
  readonly inclusionProbability: number;
  readonly maxProfitableBribe: bigint;
  readonly networkConditions: NetworkConditions;
  readonly relaySpecificBribes: Map<string, bigint>;
  readonly escalationLevel: number;
  readonly shouldCancel: boolean;
  readonly calculatedAt: number;
}

export interface BribeEffectivenessData {
  readonly bribeAmount: bigint;
  readonly inclusionTime: number;
  readonly blockNumber: number;
  readonly relay: string;
  readonly networkCondition: string;
  readonly success: boolean;
  readonly timestamp: number;
}

export interface RelayPerformanceMetrics {
  readonly relay: string;
  readonly averageInclusionTime: number;
  readonly inclusionRate: number;
  readonly averageBribeRequired: bigint;
  readonly competitiveness: number;
  readonly lastUpdated: number;
}

export class DynamicBribeOptimizer extends EventEmitter {
  private readonly logger = createComponentLogger('dynamic-bribe-optimizer');
  private readonly config: DynamicBribeOptimizerConfig;
  private readonly provider: ethers.Provider;

  // Network monitoring
  private currentNetworkConditions?: NetworkConditions;
  private readonly networkConditionHistory: NetworkConditions[] = [];

  // Bribe effectiveness tracking
  private readonly bribeEffectivenessData: BribeEffectivenessData[] = [];
  private readonly relayPerformanceMetrics = new Map<string, RelayPerformanceMetrics>();

  // Opportunity tracking
  private readonly activeOpportunities = new Map<string, BribeCalculation>();
  private readonly escalationTimers = new Map<string, NodeJS.Timeout>();

  // Interval tracking for cleanup
  private networkMonitoringInterval: NodeJS.Timeout | null = null;
  private bribeTrackingInterval: NodeJS.Timeout | null = null;

  constructor(provider: ethers.Provider, config: DynamicBribeOptimizerConfig) {
    super();
    this.provider = provider;
    this.config = config;

    this.startNetworkMonitoring();
    this.startBribeEffectivenessTracking();

    this.logger.info('Dynamic bribe optimizer initialized', {
      maxBribePercentage: this.config.maxBribePercentage,
      targetInclusionProbability: this.config.targetInclusionProbability,
      enableAutoCancellation: this.config.enableAutoCancellation,
    });
  }

  /**
   * Calculate optimal bribe for opportunity
   */
  async calculateOptimalBribe(
    opportunityId: string,
    estimatedProfit: bigint,
    targetRelay?: string
  ): Promise<BribeCalculation> {
    try {
      this.logger.debug('Calculating optimal bribe', {
        opportunityId,
        estimatedProfit: estimatedProfit.toString(),
        targetRelay,
      });

      // Get current network conditions
      const networkConditions = await this.getCurrentNetworkConditions();

      // Calculate base bribe amount
      const baseBribe = await this.calculateBaseBribe(estimatedProfit, networkConditions);

      // Calculate relay-specific bribes
      const relaySpecificBribes = await this.calculateRelaySpecificBribes(
        baseBribe,
        networkConditions,
        targetRelay
      );

      // Determine recommended bribe
      const recommendedBribe = targetRelay
        ? relaySpecificBribes.get(targetRelay) || baseBribe
        : baseBribe;

      // Calculate inclusion probability
      const inclusionProbability = await this.calculateInclusionProbability(
        recommendedBribe,
        networkConditions
      );

      // Calculate maximum profitable bribe
      const maxProfitableBribe = this.calculateMaxProfitableBribe(estimatedProfit);

      // Check if should cancel
      const shouldCancel = this.shouldCancelOpportunity(
        recommendedBribe,
        estimatedProfit,
        inclusionProbability
      );

      const calculation: BribeCalculation = {
        opportunityId,
        estimatedProfit,
        recommendedBribe,
        inclusionProbability,
        maxProfitableBribe,
        networkConditions,
        relaySpecificBribes,
        escalationLevel: 0,
        shouldCancel,
        calculatedAt: Date.now(),
      };

      // Track active opportunity
      this.activeOpportunities.set(opportunityId, calculation);

      // Set up escalation if needed
      if (!shouldCancel && inclusionProbability < this.config.targetInclusionProbability) {
        this.setupBribeEscalation(opportunityId);
      }

      this.emit('bribeCalculated', calculation);

      return calculation;
    } catch (error) {
      this.logger.error('Failed to calculate optimal bribe', {
        opportunityId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return conservative calculation
      return {
        opportunityId,
        estimatedProfit,
        recommendedBribe: this.config.minBribeAmount,
        inclusionProbability: 0.1,
        maxProfitableBribe: this.calculateMaxProfitableBribe(estimatedProfit),
        networkConditions: this.currentNetworkConditions || this.getDefaultNetworkConditions(),
        relaySpecificBribes: new Map(),
        escalationLevel: 0,
        shouldCancel: true,
        calculatedAt: Date.now(),
      };
    }
  }

  /**
   * Escalate bribe for opportunity
   */
  async escalateBribe(opportunityId: string): Promise<BribeCalculation | null> {
    const currentCalculation = this.activeOpportunities.get(opportunityId);
    if (!currentCalculation) {
      this.logger.warn('Cannot escalate bribe for unknown opportunity', { opportunityId });
      return null;
    }

    try {
      const newEscalationLevel = currentCalculation.escalationLevel + 1;

      if (newEscalationLevel > this.config.maxEscalationSteps) {
        this.logger.warn('Maximum escalation steps reached', {
          opportunityId,
          maxSteps: this.config.maxEscalationSteps,
        });

        // Mark for cancellation
        const cancelledCalculation = {
          ...currentCalculation,
          shouldCancel: true,
          escalationLevel: newEscalationLevel,
        };

        this.activeOpportunities.set(opportunityId, cancelledCalculation);
        this.emit('opportunityCancelled', { opportunityId, reason: 'Maximum escalation reached' });

        return cancelledCalculation;
      }

      // Calculate escalated bribe using bigint-native operations
      const scale = 1_000_000n; // Fixed-point scale for precision
      const scaledMultiplier = BigInt(
        Math.round(this.config.bribeEscalationFactor * Number(scale))
      );
      const escalatedBribe = (currentCalculation.recommendedBribe * scaledMultiplier) / scale;

      // Ensure we don't exceed maximum profitable bribe
      const finalBribe =
        escalatedBribe > currentCalculation.maxProfitableBribe
          ? currentCalculation.maxProfitableBribe
          : escalatedBribe;

      // Check if still profitable
      const shouldCancel = this.shouldCancelOpportunity(
        finalBribe,
        currentCalculation.estimatedProfit,
        currentCalculation.inclusionProbability
      );

      // Update calculation
      const escalatedCalculation: BribeCalculation = {
        ...currentCalculation,
        recommendedBribe: finalBribe,
        escalationLevel: newEscalationLevel,
        shouldCancel,
        calculatedAt: Date.now(),
      };

      this.activeOpportunities.set(opportunityId, escalatedCalculation);

      this.logger.info('Bribe escalated', {
        opportunityId,
        escalationLevel: newEscalationLevel,
        newBribe: finalBribe.toString(),
        shouldCancel,
      });

      this.emit('bribeEscalated', escalatedCalculation);

      // Continue escalation if needed
      if (!shouldCancel && newEscalationLevel < this.config.maxEscalationSteps) {
        this.setupBribeEscalation(opportunityId);
      }

      return escalatedCalculation;
    } catch (error) {
      this.logger.error('Failed to escalate bribe', {
        opportunityId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Record bribe effectiveness data
   */
  recordBribeEffectiveness(
    opportunityId: string,
    bribeAmount: bigint,
    inclusionTime: number,
    blockNumber: number,
    relay: string,
    success: boolean
  ): void {
    try {
      const networkCondition = this.currentNetworkConditions?.networkCongestion || 'medium';

      const effectivenessData: BribeEffectivenessData = {
        bribeAmount,
        inclusionTime,
        blockNumber,
        relay,
        networkCondition,
        success,
        timestamp: Date.now(),
      };

      this.bribeEffectivenessData.push(effectivenessData);

      // Update relay performance metrics
      this.updateRelayPerformanceMetrics(relay, effectivenessData);

      // Clean up old data
      this.cleanupOldEffectivenessData();

      // Remove from active opportunities
      this.activeOpportunities.delete(opportunityId);

      // Clear escalation timer
      const timer = this.escalationTimers.get(opportunityId);
      if (timer) {
        clearTimeout(timer);
        this.escalationTimers.delete(opportunityId);
      }

      this.logger.debug('Bribe effectiveness recorded', {
        opportunityId,
        bribeAmount: bribeAmount.toString(),
        inclusionTime,
        relay,
        success,
      });

      this.emit('effectivenessRecorded', effectivenessData);
    } catch (error) {
      this.logger.error('Failed to record bribe effectiveness', {
        opportunityId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get current network conditions
   */
  private async getCurrentNetworkConditions(): Promise<NetworkConditions> {
    if (
      this.currentNetworkConditions &&
      Date.now() - this.currentNetworkConditions.timestamp <
        this.config.networkConditionUpdateIntervalMs
    ) {
      return this.currentNetworkConditions;
    }

    try {
      // Get latest block for base fee
      const latestBlock = await this.provider.getBlock('latest');
      const currentBaseFee = latestBlock?.baseFeePerGas || 1000000000n; // 1 gwei default

      // Simulate network conditions (in production, would fetch from actual sources)
      const networkConditions: NetworkConditions = {
        currentBaseFee,
        priorityFeePercentiles: [
          currentBaseFee / 10n, // 10th percentile
          currentBaseFee / 5n, // 25th percentile
          currentBaseFee / 2n, // 50th percentile
          currentBaseFee, // 75th percentile
          currentBaseFee * 2n, // 90th percentile
        ],
        blockUtilization: 0.7, // 70% utilization
        mempoolSize: 50000,
        competitorGasPrices: [
          (currentBaseFee * 11n) / 10n, // 110% of base fee
          (currentBaseFee * 12n) / 10n, // 120% of base fee
          (currentBaseFee * 15n) / 10n, // 150% of base fee
        ],
        averageBlockTime: 2000, // 2 seconds for Base
        networkCongestion: this.determineNetworkCongestion(0.7, 50000),
        timestamp: Date.now(),
      };

      this.currentNetworkConditions = networkConditions;
      this.networkConditionHistory.push(networkConditions);

      // Keep only recent history
      if (this.networkConditionHistory.length > 100) {
        this.networkConditionHistory.shift();
      }

      return networkConditions;
    } catch (error) {
      this.logger.error('Failed to get network conditions', {
        error: error instanceof Error ? error.message : String(error),
      });

      return this.currentNetworkConditions || this.getDefaultNetworkConditions();
    }
  }

  /**
   * Calculate base bribe amount
   */
  private async calculateBaseBribe(
    estimatedProfit: bigint,
    networkConditions: NetworkConditions
  ): Promise<bigint> {
    // Start with percentage of profit
    const profitBasedBribe = (estimatedProfit * BigInt(this.config.maxBribePercentage)) / 100n;

    // Adjust based on network conditions
    let networkMultiplier = 1.0;

    switch (networkConditions.networkCongestion) {
      case 'high':
        networkMultiplier = 1.5;
        break;
      case 'medium':
        networkMultiplier = 1.2;
        break;
      case 'low':
        networkMultiplier = 0.8;
        break;
    }

    // Adjust based on competitor gas prices - guard against empty array
    let avgCompetitorGas = 0n;
    let competitorMultiplier = 1.0;

    if (networkConditions.competitorGasPrices.length > 0) {
      avgCompetitorGas =
        networkConditions.competitorGasPrices.reduce((sum, price) => sum + price, 0n) /
        BigInt(networkConditions.competitorGasPrices.length);

      competitorMultiplier = Number(avgCompetitorGas) / Number(networkConditions.currentBaseFee);
    }

    const finalMultiplier = networkMultiplier * Math.min(competitorMultiplier, 2.0);
    const adjustedBribe = BigInt(Math.floor(Number(profitBasedBribe) * finalMultiplier));

    // Apply bounds
    const boundedBribe = this.applyBribeBounds(adjustedBribe);

    this.logger.debug('Base bribe calculated', {
      estimatedProfit: estimatedProfit.toString(),
      profitBasedBribe: profitBasedBribe.toString(),
      networkMultiplier,
      competitorMultiplier,
      finalBribe: boundedBribe.toString(),
    });

    return boundedBribe;
  }

  /**
   * Calculate relay-specific bribes
   */
  private async calculateRelaySpecificBribes(
    baseBribe: bigint,
    networkConditions: NetworkConditions,
    targetRelay?: string
  ): Promise<Map<string, bigint>> {
    const relayBribes = new Map<string, bigint>();

    const relays = targetRelay ? [targetRelay] : ['flashbots', 'bloxroute', 'local'];

    for (const relay of relays) {
      const relayMetrics = this.relayPerformanceMetrics.get(relay);
      let relayMultiplier = 1.0;

      if (relayMetrics) {
        // Adjust based on relay competitiveness
        relayMultiplier = relayMetrics.competitiveness;

        // Adjust based on inclusion rate
        if (relayMetrics.inclusionRate < 0.8) {
          relayMultiplier *= 1.3; // Increase bribe for less reliable relays
        }
      }

      // Use network conditions for additional adjustments
      if (networkConditions.networkCongestion === 'high') {
        relayMultiplier *= 1.2;
      }

      const relayBribe = BigInt(Math.floor(Number(baseBribe) * relayMultiplier));
      relayBribes.set(relay, this.applyBribeBounds(relayBribe));
    }

    return relayBribes;
  }

  /**
   * Calculate inclusion probability
   */
  private async calculateInclusionProbability(
    bribeAmount: bigint,
    networkConditions: NetworkConditions
  ): Promise<number> {
    try {
      // Base probability based on bribe amount relative to network conditions
      const baseFeeRatio = Number(bribeAmount) / Number(networkConditions.currentBaseFee);
      let baseProbability = Math.min(baseFeeRatio / 2.0, 0.9); // Max 90% base probability

      // Adjust for network congestion
      switch (networkConditions.networkCongestion) {
        case 'high':
          baseProbability *= 0.7;
          break;
        case 'medium':
          baseProbability *= 0.85;
          break;
        case 'low':
          baseProbability *= 1.1;
          break;
      }

      // Adjust for competitor activity - guard against empty array
      if (networkConditions.competitorGasPrices.length > 0) {
        const avgCompetitorGas =
          networkConditions.competitorGasPrices.reduce((sum, price) => sum + price, 0n) /
          BigInt(networkConditions.competitorGasPrices.length);

        if (bribeAmount < avgCompetitorGas) {
          baseProbability *= 0.6; // Significantly lower if below competitor average
        }
      }

      // Apply bounds
      const finalProbability = Math.max(0.05, Math.min(0.95, baseProbability));

      return finalProbability;
    } catch (error) {
      this.logger.error('Failed to calculate inclusion probability', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0.5; // Conservative default
    }
  }

  /**
   * Calculate maximum profitable bribe
   */
  private calculateMaxProfitableBribe(estimatedProfit: bigint): bigint {
    // Maximum bribe is profit minus minimum required profit margin
    const minProfitMargin = (estimatedProfit * BigInt(this.config.profitabilityThreshold)) / 100n;
    const maxBribe = estimatedProfit - minProfitMargin;

    return maxBribe > 0n ? maxBribe : 0n;
  }

  /**
   * Check if opportunity should be cancelled
   */
  private shouldCancelOpportunity(
    bribeAmount: bigint,
    estimatedProfit: bigint,
    inclusionProbability: number
  ): boolean {
    if (!this.config.enableAutoCancellation) {
      return false;
    }

    // Cancel if bribe exceeds maximum profitable amount
    const maxProfitableBribe = this.calculateMaxProfitableBribe(estimatedProfit);
    if (bribeAmount >= maxProfitableBribe) {
      return true;
    }

    // Cancel if inclusion probability is too low despite high bribe
    if (inclusionProbability < 0.3 && bribeAmount > estimatedProfit / 4n) {
      return true;
    }

    return false;
  }

  /**
   * Setup bribe escalation timer
   */
  private setupBribeEscalation(opportunityId: string): void {
    // Clear existing timer
    const existingTimer = this.escalationTimers.get(opportunityId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new escalation timer (escalate every 3 seconds)
    const timer = setTimeout(() => {
      this.escalateBribe(opportunityId);
    }, 3000);

    this.escalationTimers.set(opportunityId, timer);
  }

  /**
   * Start network monitoring
   */
  private startNetworkMonitoring(): void {
    // Update network conditions periodically
    this.networkMonitoringInterval = setInterval(async () => {
      try {
        await this.getCurrentNetworkConditions();
      } catch (error) {
        this.logger.error('Network monitoring error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.config.networkConditionUpdateIntervalMs);

    this.logger.info('Network monitoring started');
  }

  /**
   * Start bribe effectiveness tracking
   */
  private startBribeEffectivenessTracking(): void {
    // Clean up old effectiveness data periodically
    this.bribeTrackingInterval = setInterval(() => {
      this.cleanupOldEffectivenessData();
    }, 300000); // Every 5 minutes

    this.logger.info('Bribe effectiveness tracking started');
  }

  /**
   * Dispose of resources and cleanup
   */
  dispose(): void {
    // Clear network monitoring interval
    if (this.networkMonitoringInterval) {
      clearInterval(this.networkMonitoringInterval);
      this.networkMonitoringInterval = null;
    }

    // Clear bribe tracking interval
    if (this.bribeTrackingInterval) {
      clearInterval(this.bribeTrackingInterval);
      this.bribeTrackingInterval = null;
    }

    // Clear all escalation timers
    for (const [_opportunityId, timer] of this.escalationTimers) {
      clearTimeout(timer);
    }
    this.escalationTimers.clear();

    // Clear data structures
    this.activeOpportunities.clear();
    this.bribeEffectivenessData.length = 0;
    this.networkConditionHistory.length = 0;
    this.relayPerformanceMetrics.clear();

    this.logger.info('Dynamic bribe optimizer disposed');
  }

  /**
   * Update relay performance metrics
   */
  private updateRelayPerformanceMetrics(
    relay: string,
    effectivenessData: BribeEffectivenessData
  ): void {
    const existing = this.relayPerformanceMetrics.get(relay);

    if (!existing) {
      this.relayPerformanceMetrics.set(relay, {
        relay,
        averageInclusionTime: effectivenessData.inclusionTime,
        inclusionRate: effectivenessData.success ? 1.0 : 0.0,
        averageBribeRequired: effectivenessData.bribeAmount,
        competitiveness: 1.0,
        lastUpdated: Date.now(),
      });
      return;
    }

    // Update metrics with exponential moving average
    const alpha = 0.1; // Smoothing factor

    const newMetrics: RelayPerformanceMetrics = {
      relay,
      averageInclusionTime:
        existing.averageInclusionTime * (1 - alpha) + effectivenessData.inclusionTime * alpha,
      inclusionRate:
        existing.inclusionRate * (1 - alpha) + (effectivenessData.success ? 1.0 : 0.0) * alpha,
      averageBribeRequired: BigInt(
        Math.floor(
          Number(existing.averageBribeRequired) * (1 - alpha) +
            Number(effectivenessData.bribeAmount) * alpha
        )
      ),
      competitiveness: this.calculateRelayCompetitiveness(existing, effectivenessData),
      lastUpdated: Date.now(),
    };

    this.relayPerformanceMetrics.set(relay, newMetrics);
  }

  /**
   * Calculate relay competitiveness score
   */
  private calculateRelayCompetitiveness(
    existing: RelayPerformanceMetrics,
    newData: BribeEffectivenessData
  ): number {
    // Higher score means more competitive (requires higher bribes)
    let competitiveness = existing.competitiveness;

    if (newData.success) {
      // Successful inclusion with lower bribe = less competitive
      if (newData.bribeAmount < existing.averageBribeRequired) {
        competitiveness *= 0.95;
      } else {
        competitiveness *= 1.05;
      }
    } else {
      // Failed inclusion = more competitive
      competitiveness *= 1.1;
    }

    return Math.max(0.5, Math.min(2.0, competitiveness));
  }

  /**
   * Clean up old effectiveness data
   */
  private cleanupOldEffectivenessData(): void {
    const cutoffTime = Date.now() - this.config.bribeEffectivenessWindowMs;

    const initialLength = this.bribeEffectivenessData.length;

    // Remove old data
    for (let i = this.bribeEffectivenessData.length - 1; i >= 0; i--) {
      const dataPoint = this.bribeEffectivenessData[i];
      if (dataPoint && dataPoint.timestamp < cutoffTime) {
        this.bribeEffectivenessData.splice(i, 1);
      }
    }

    const removedCount = initialLength - this.bribeEffectivenessData.length;
    if (removedCount > 0) {
      this.logger.debug('Cleaned up old effectiveness data', { removedCount });
    }
  }

  /**
   * Apply bribe bounds
   */
  private applyBribeBounds(bribe: bigint): bigint {
    if (bribe < this.config.minBribeAmount) {
      return this.config.minBribeAmount;
    }
    if (bribe > this.config.maxBribeAmount) {
      return this.config.maxBribeAmount;
    }
    return bribe;
  }

  /**
   * Determine network congestion level
   */
  private determineNetworkCongestion(
    blockUtilization: number,
    mempoolSize: number
  ): 'low' | 'medium' | 'high' {
    if (blockUtilization > 0.8 || mempoolSize > 100000) {
      return 'high';
    } else if (blockUtilization > 0.5 || mempoolSize > 25000) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  /**
   * Get default network conditions
   */
  private getDefaultNetworkConditions(): NetworkConditions {
    const defaultBaseFee = 1000000000n; // 1 gwei

    return {
      currentBaseFee: defaultBaseFee,
      priorityFeePercentiles: [
        defaultBaseFee / 10n,
        defaultBaseFee / 5n,
        defaultBaseFee / 2n,
        defaultBaseFee,
        defaultBaseFee * 2n,
      ],
      blockUtilization: 0.5,
      mempoolSize: 25000,
      competitorGasPrices: [(defaultBaseFee * 11n) / 10n],
      averageBlockTime: 2000,
      networkCongestion: 'medium',
      timestamp: Date.now(),
    };
  }

  /**
   * Get bribe optimization statistics
   */
  getBribeStats(): {
    activeOpportunities: number;
    totalCalculations: number;
    averageInclusionProbability: number;
    averageBribeAmount: bigint;
    escalationRate?: number;
    cancellationRate?: number;
  } {
    const totalCalculations = this.bribeEffectivenessData.length;
    const successfulInclusions = this.bribeEffectivenessData.filter(d => d.success).length;

    const avgInclusionProbability =
      totalCalculations > 0 ? successfulInclusions / totalCalculations : 0;

    const avgBribeAmount =
      totalCalculations > 0
        ? this.bribeEffectivenessData.reduce((sum, d) => sum + d.bribeAmount, 0n) /
          BigInt(totalCalculations)
        : 0n;

    // Calculate real metrics if we have data, otherwise omit them
    const stats: {
      activeOpportunities: number;
      totalCalculations: number;
      averageInclusionProbability: number;
      averageBribeAmount: bigint;
      escalationRate?: number;
      cancellationRate?: number;
    } = {
      activeOpportunities: this.activeOpportunities.size,
      totalCalculations,
      averageInclusionProbability: avgInclusionProbability,
      averageBribeAmount: avgBribeAmount,
    };

    // Only include escalation/cancellation rates if we have sufficient data
    if (totalCalculations > 10) {
      // Calculate actual escalation rate from historical data
      const escalations = Array.from(this.activeOpportunities.values()).filter(
        calc => calc.escalationLevel > 0
      ).length;
      stats.escalationRate = escalations / this.activeOpportunities.size;

      // Calculate actual cancellation rate from historical data
      const cancellations = this.bribeEffectivenessData.filter(d => !d.success).length;
      stats.cancellationRate = cancellations / totalCalculations;
    }

    return stats;
  }
}
