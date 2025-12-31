/**
 * Real-Time Profitability Optimization Engine
 *
 * Continuously recalculates profit and optimizes execution parameters
 * with real-time market condition monitoring
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { Address } from '../types/common';
import { OpportunityType } from '../types/execution';

export interface ProfitabilityOptimizerConfig {
  readonly minProfitThresholdUsd: number;
  readonly maxRiskLevel: number;
  readonly recalculationIntervalMs: number;
  readonly marketConditionUpdateMs: number;
  readonly positionSizingEnabled: boolean;
  readonly riskAdjustedReturns: boolean;
  readonly executionProbabilityWeight: number;
  readonly volatilityAdjustmentFactor: number;
  readonly liquidityDepthThreshold: number;
}

export interface MarketCondition {
  readonly timestamp: number;
  readonly gasPrice: bigint;
  readonly networkCongestion: number;
  readonly volatilityIndex: number;
  readonly liquidityIndex: number;
  readonly competitionLevel: number;
  readonly blockTime: number;
  readonly mempoolSize: number;
}

export interface ProfitabilityMetrics {
  readonly opportunityId: string;
  readonly grossProfit: bigint;
  readonly netProfit: bigint;
  readonly profitUsd: number;
  readonly gasCost: bigint;
  readonly executionProbability: number;
  readonly riskAdjustedReturn: number;
  readonly sharpeRatio: number;
  readonly expectedValue: number;
  readonly confidenceInterval: {
    readonly lower: number;
    readonly upper: number;
  };
  readonly calculatedAt: number;
}

export interface OptimizationResult {
  readonly opportunityId: string;
  readonly originalMetrics: ProfitabilityMetrics;
  readonly optimizedMetrics: ProfitabilityMetrics;
  readonly recommendations: OptimizationRecommendation[];
  readonly shouldExecute: boolean;
  readonly shouldCancel: boolean;
  readonly positionSize: bigint;
  readonly maxSlippage: number;
  readonly gasLimit: bigint;
  readonly optimizedAt: number;
}

export interface OptimizationRecommendation {
  readonly type: 'position-size' | 'timing' | 'gas-price' | 'slippage' | 'cancel' | 'wait';
  readonly description: string;
  readonly impact: 'high' | 'medium' | 'low';
  readonly confidence: number;
  readonly parameters?: Record<string, unknown>;
}

export interface OpportunityState {
  readonly id: string;
  readonly type: OpportunityType;
  readonly token: Address;
  readonly originalAmount: bigint;
  readonly currentAmount: bigint;
  readonly targetProfit: bigint;
  readonly maxRisk: number;
  readonly createdAt: number;
  readonly lastOptimized: number;
  readonly optimizationCount: number;
  readonly profitHistory: ProfitabilityMetrics[];
  status: 'active' | 'optimizing' | 'cancelled' | 'executed';
}

export interface RiskMetrics {
  readonly volatilityRisk: number;
  readonly liquidityRisk: number;
  readonly executionRisk: number;
  readonly competitionRisk: number;
  readonly slippageRisk: number;
  readonly gasRisk: number;
  readonly overallRisk: number;
}

export class ProfitabilityOptimizer extends EventEmitter {
  private readonly logger = createComponentLogger('profitability-optimizer');
  private readonly config: ProfitabilityOptimizerConfig;
  private readonly provider: ethers.Provider;

  // Market condition tracking
  private currentMarketCondition: MarketCondition;
  private marketConditionHistory: MarketCondition[] = [];

  // Opportunity tracking
  private readonly activeOpportunities = new Map<string, OpportunityState>();
  private readonly profitabilityCache = new Map<string, ProfitabilityMetrics>();

  // Optimization timers
  private recalculationTimer: NodeJS.Timeout | null = null;
  private marketUpdateTimer: NodeJS.Timeout | null = null;

  // Performance tracking
  private optimizationCount = 0;
  private cancelledOpportunities = 0;
  private executedOpportunities = 0;

  constructor(provider: ethers.Provider, config: ProfitabilityOptimizerConfig) {
    super();
    this.provider = provider;
    this.config = config;

    // Initialize market condition
    this.currentMarketCondition = {
      timestamp: Date.now(),
      gasPrice: 20000000000n, // 20 gwei default
      networkCongestion: 0.5,
      volatilityIndex: 0.3,
      liquidityIndex: 0.8,
      competitionLevel: 0.6,
      blockTime: 2000, // 2 seconds for Base
      mempoolSize: 1000,
    };

    this.startOptimizationEngine();

    this.logger.info('Profitability optimizer initialized', {
      minProfitThresholdUsd: this.config.minProfitThresholdUsd,
      maxRiskLevel: this.config.maxRiskLevel,
      recalculationIntervalMs: this.config.recalculationIntervalMs,
    });
  }

  /**
   * Add opportunity for optimization
   */
  async addOpportunity(
    id: string,
    type: OpportunityType,
    token: Address,
    amount: bigint,
    targetProfit: bigint,
    maxRisk: number = this.config.maxRiskLevel
  ): Promise<void> {
    try {
      this.logger.debug('Adding opportunity for optimization', {
        id,
        type,
        token,
        amount: amount.toString(),
        targetProfit: targetProfit.toString(),
      });

      const opportunity: OpportunityState = {
        id,
        type,
        token,
        originalAmount: amount,
        currentAmount: amount,
        targetProfit,
        maxRisk,
        createdAt: Date.now(),
        lastOptimized: 0,
        optimizationCount: 0,
        profitHistory: [],
        status: 'active',
      };

      this.activeOpportunities.set(id, opportunity);

      // Perform initial optimization
      await this.optimizeOpportunity(id);

      this.emit('opportunityAdded', opportunity);
    } catch (error) {
      this.logger.error('Failed to add opportunity', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Remove opportunity from optimization
   */
  removeOpportunity(id: string): void {
    const opportunity = this.activeOpportunities.get(id);
    if (opportunity) {
      this.activeOpportunities.delete(id);
      this.profitabilityCache.delete(id);

      this.emit('opportunityRemoved', { id, opportunity });

      this.logger.debug('Opportunity removed from optimization', { id });
    }
  }

  /**
   * Optimize specific opportunity
   */
  async optimizeOpportunity(opportunityId: string): Promise<OptimizationResult | null> {
    const opportunity = this.activeOpportunities.get(opportunityId);
    if (!opportunity || opportunity.status !== 'active') {
      return null;
    }

    try {
      this.logger.debug('Optimizing opportunity', { opportunityId });

      // Update opportunity status
      opportunity.status = 'optimizing';
      this.activeOpportunities.set(opportunityId, opportunity);

      // Calculate current profitability
      const originalMetrics = await this.calculateProfitability(opportunity);

      // Optimize parameters
      const optimizedMetrics = await this.optimizeParameters(opportunity, originalMetrics);

      // Generate recommendations
      const recommendations = await this.generateRecommendations(
        opportunity,
        originalMetrics,
        optimizedMetrics
      );

      // Determine execution decision
      const shouldExecute = this.shouldExecuteOpportunity(optimizedMetrics, opportunity);
      const shouldCancel = this.shouldCancelOpportunity(optimizedMetrics, opportunity);

      // Calculate optimal position size
      const positionSize = this.calculateOptimalPositionSize(opportunity, optimizedMetrics);

      // Calculate optimal parameters
      const maxSlippage = this.calculateOptimalSlippage(opportunity, optimizedMetrics);
      const gasLimit = this.calculateOptimalGasLimit(opportunity);

      const result: OptimizationResult = {
        opportunityId,
        originalMetrics,
        optimizedMetrics,
        recommendations,
        shouldExecute,
        shouldCancel,
        positionSize,
        maxSlippage,
        gasLimit,
        optimizedAt: Date.now(),
      };

      // Update opportunity state
      const updatedOpportunity: OpportunityState = {
        ...opportunity,
        currentAmount: positionSize,
        lastOptimized: Date.now(),
        optimizationCount: opportunity.optimizationCount + 1,
        profitHistory: [...opportunity.profitHistory, optimizedMetrics].slice(-10), // Keep last 10
        status: shouldCancel ? 'cancelled' : 'active',
      };

      this.activeOpportunities.set(opportunityId, updatedOpportunity);
      this.profitabilityCache.set(opportunityId, optimizedMetrics);

      // Update counters
      this.optimizationCount++;
      if (shouldCancel) {
        this.cancelledOpportunities++;
      }

      this.emit('opportunityOptimized', result);

      this.logger.info('Opportunity optimization completed', {
        opportunityId,
        shouldExecute,
        shouldCancel,
        profitUsd: optimizedMetrics.profitUsd,
        riskAdjustedReturn: optimizedMetrics.riskAdjustedReturn,
      });

      return result;
    } catch (error) {
      // Reset opportunity status on error
      opportunity.status = 'active';
      this.activeOpportunities.set(opportunityId, opportunity);

      this.logger.error('Opportunity optimization failed', {
        opportunityId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Calculate profitability metrics
   */
  private async calculateProfitability(
    opportunity: OpportunityState
  ): Promise<ProfitabilityMetrics> {
    try {
      // Get current market conditions
      await this.updateMarketConditions();

      // Calculate gross profit (simplified - would use actual DEX calculations)
      const grossProfit = this.estimateGrossProfit(opportunity);

      // Calculate gas cost
      const gasCost = await this.estimateGasCost(opportunity);

      // Calculate net profit
      const netProfit = grossProfit > gasCost ? grossProfit - gasCost : 0n;

      // Convert to USD (simplified - would use price oracle)
      const profitUsd = (Number(netProfit) / 1e18) * 2000; // Assume $2000 ETH

      // Calculate execution probability
      const executionProbability = this.calculateExecutionProbability(opportunity);

      // Calculate risk metrics
      const riskMetrics = this.calculateRiskMetrics(opportunity);

      // Calculate risk-adjusted return
      const riskAdjustedReturn = this.config.riskAdjustedReturns
        ? profitUsd * executionProbability * (1 - riskMetrics.overallRisk)
        : profitUsd * executionProbability;

      // Calculate Sharpe ratio
      const sharpeRatio = this.calculateSharpeRatio(opportunity, riskAdjustedReturn, riskMetrics);

      // Calculate expected value
      const expectedValue = riskAdjustedReturn * this.config.executionProbabilityWeight;

      // Calculate confidence interval
      const confidenceInterval = this.calculateConfidenceInterval(
        riskAdjustedReturn,
        riskMetrics.overallRisk
      );

      return {
        opportunityId: opportunity.id,
        grossProfit,
        netProfit,
        profitUsd,
        gasCost,
        executionProbability,
        riskAdjustedReturn,
        sharpeRatio,
        expectedValue,
        confidenceInterval,
        calculatedAt: Date.now(),
      };
    } catch (error) {
      this.logger.error('Profitability calculation failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return conservative estimates
      return {
        opportunityId: opportunity.id,
        grossProfit: 0n,
        netProfit: 0n,
        profitUsd: 0,
        gasCost: 100000n * this.currentMarketCondition.gasPrice,
        executionProbability: 0.5,
        riskAdjustedReturn: 0,
        sharpeRatio: 0,
        expectedValue: 0,
        confidenceInterval: { lower: 0, upper: 0 },
        calculatedAt: Date.now(),
      };
    }
  }

  /**
   * Optimize parameters for better profitability
   */
  private async optimizeParameters(
    opportunity: OpportunityState,
    originalMetrics: ProfitabilityMetrics
  ): Promise<ProfitabilityMetrics> {
    let bestMetrics = originalMetrics;

    // Try different position sizes if enabled
    if (this.config.positionSizingEnabled) {
      const sizeVariations = [0.5, 0.75, 1.0, 1.25, 1.5];

      for (const sizeMultiplier of sizeVariations) {
        const testOpportunity: OpportunityState = {
          ...opportunity,
          currentAmount: BigInt(Math.floor(Number(opportunity.originalAmount) * sizeMultiplier)),
        };

        const testMetrics = await this.calculateProfitability(testOpportunity);

        if (testMetrics.riskAdjustedReturn > bestMetrics.riskAdjustedReturn) {
          bestMetrics = testMetrics;
        }
      }
    }

    // Optimize for current market conditions
    const marketOptimizedMetrics = await this.optimizeForMarketConditions(opportunity, bestMetrics);

    if (marketOptimizedMetrics.riskAdjustedReturn > bestMetrics.riskAdjustedReturn) {
      bestMetrics = marketOptimizedMetrics;
    }

    return bestMetrics;
  }

  /**
   * Optimize for current market conditions
   */
  private async optimizeForMarketConditions(
    opportunity: OpportunityState,
    currentMetrics: ProfitabilityMetrics
  ): Promise<ProfitabilityMetrics> {
    // Adjust for network congestion
    let adjustedMetrics = { ...currentMetrics };

    // High congestion - reduce position size, increase gas
    if (this.currentMarketCondition.networkCongestion > 0.8) {
      const adjustedAmount = (opportunity.currentAmount * 80n) / 100n; // Reduce by 20%
      const adjustedOpportunity = { ...opportunity, currentAmount: adjustedAmount };
      adjustedMetrics = await this.calculateProfitability(adjustedOpportunity);
    }

    // High volatility - adjust risk parameters
    if (this.currentMarketCondition.volatilityIndex > 0.7) {
      adjustedMetrics.riskAdjustedReturn *= 1 - this.config.volatilityAdjustmentFactor;
    }

    // Low liquidity - reduce position size
    if (this.currentMarketCondition.liquidityIndex < this.config.liquidityDepthThreshold) {
      const liquidityAdjustment =
        this.currentMarketCondition.liquidityIndex / this.config.liquidityDepthThreshold;
      adjustedMetrics.riskAdjustedReturn *= liquidityAdjustment;
    }

    return adjustedMetrics;
  }

  /**
   * Generate optimization recommendations
   */
  private async generateRecommendations(
    opportunity: OpportunityState,
    originalMetrics: ProfitabilityMetrics,
    optimizedMetrics: ProfitabilityMetrics
  ): Promise<OptimizationRecommendation[]> {
    const recommendations: OptimizationRecommendation[] = [];

    // Position size recommendations
    if (this.config.positionSizingEnabled) {
      const optimalSize = this.calculateOptimalPositionSize(opportunity, optimizedMetrics);
      if (optimalSize !== opportunity.currentAmount) {
        recommendations.push({
          type: 'position-size',
          description: `Adjust position size to ${optimalSize.toString()} for optimal risk-adjusted return`,
          impact: 'high',
          confidence: 0.8,
          parameters: { optimalSize: optimalSize.toString() },
        });
      }
    }

    // Timing recommendations
    if (this.currentMarketCondition.networkCongestion > 0.8) {
      recommendations.push({
        type: 'timing',
        description: 'High network congestion detected - consider waiting for better conditions',
        impact: 'medium',
        confidence: 0.7,
      });
    }

    // Gas price recommendations
    if (optimizedMetrics.gasCost > (originalMetrics.gasCost * 120n) / 100n) {
      recommendations.push({
        type: 'gas-price',
        description: 'Gas costs are high - consider reducing gas price or waiting',
        impact: 'medium',
        confidence: 0.6,
      });
    }

    // Slippage recommendations
    const optimalSlippage = this.calculateOptimalSlippage(opportunity, optimizedMetrics);
    recommendations.push({
      type: 'slippage',
      description: `Set slippage tolerance to ${(optimalSlippage * 100).toFixed(2)}% for optimal execution`,
      impact: 'medium',
      confidence: 0.8,
      parameters: { optimalSlippage },
    });

    // Cancel recommendations
    if (optimizedMetrics.profitUsd < this.config.minProfitThresholdUsd) {
      recommendations.push({
        type: 'cancel',
        description: `Profit ${optimizedMetrics.profitUsd.toFixed(2)} USD below threshold ${this.config.minProfitThresholdUsd} USD`,
        impact: 'high',
        confidence: 0.9,
      });
    }

    // Wait recommendations
    if (this.currentMarketCondition.competitionLevel > 0.8) {
      recommendations.push({
        type: 'wait',
        description: 'High competition detected - consider waiting for better opportunity',
        impact: 'low',
        confidence: 0.6,
      });
    }

    return recommendations;
  }

  /**
   * Determine if opportunity should be executed
   */
  private shouldExecuteOpportunity(
    metrics: ProfitabilityMetrics,
    opportunity: OpportunityState
  ): boolean {
    // Check minimum profit threshold
    if (metrics.profitUsd < this.config.minProfitThresholdUsd) {
      return false;
    }

    // Check execution probability
    if (metrics.executionProbability < 0.7) {
      return false;
    }

    // Check risk level
    const riskMetrics = this.calculateRiskMetrics(opportunity);
    if (riskMetrics.overallRisk > opportunity.maxRisk) {
      return false;
    }

    // Check Sharpe ratio
    if (this.config.riskAdjustedReturns && metrics.sharpeRatio < 1.0) {
      return false;
    }

    return true;
  }

  /**
   * Determine if opportunity should be cancelled
   */
  private shouldCancelOpportunity(
    metrics: ProfitabilityMetrics,
    opportunity: OpportunityState
  ): boolean {
    // Cancel if profit is negative
    if (metrics.netProfit <= 0n) {
      return true;
    }

    // Cancel if profit dropped significantly
    if (opportunity.profitHistory.length > 0) {
      const lastProfit =
        opportunity.profitHistory[opportunity.profitHistory.length - 1]?.profitUsd || 0;
      if (metrics.profitUsd < lastProfit * 0.5) {
        // 50% drop
        return true;
      }
    }

    // Cancel if execution probability is too low
    if (metrics.executionProbability < 0.3) {
      return true;
    }

    // Cancel if opportunity is too old
    const ageMs = Date.now() - opportunity.createdAt;
    if (ageMs > 300000) {
      // 5 minutes
      return true;
    }

    return false;
  }

  /**
   * Calculate optimal position size
   */
  private calculateOptimalPositionSize(
    opportunity: OpportunityState,
    metrics: ProfitabilityMetrics
  ): bigint {
    if (!this.config.positionSizingEnabled) {
      return opportunity.originalAmount;
    }

    // Kelly criterion for optimal position sizing
    const winProbability = metrics.executionProbability;
    const winAmount = Number(metrics.netProfit) / Number(opportunity.originalAmount);
    const lossAmount = 1.0; // Assume total loss if failed

    const kellyFraction =
      (winProbability * winAmount - (1 - winProbability) * lossAmount) / winAmount;
    const optimalFraction = Math.max(0.1, Math.min(1.0, kellyFraction)); // Clamp between 10% and 100%

    return BigInt(Math.floor(Number(opportunity.originalAmount) * optimalFraction));
  }

  /**
   * Calculate optimal slippage tolerance
   */
  private calculateOptimalSlippage(
    _opportunity: OpportunityState,
    metrics: ProfitabilityMetrics
  ): number {
    // Base slippage
    let slippage = 0.005; // 0.5%

    // Adjust for market conditions
    slippage += this.currentMarketCondition.volatilityIndex * 0.01; // Add up to 1% for volatility
    slippage += (1 - this.currentMarketCondition.liquidityIndex) * 0.02; // Add up to 2% for low liquidity

    // Adjust for execution probability
    if (metrics.executionProbability < 0.8) {
      slippage += (0.8 - metrics.executionProbability) * 0.05; // Add up to 4% for low probability
    }

    return Math.min(0.05, slippage); // Cap at 5%
  }

  /**
   * Calculate optimal gas limit
   */
  private calculateOptimalGasLimit(opportunity: OpportunityState): bigint {
    // Base gas limit by opportunity type
    let baseGas = 200000n;

    switch (opportunity.type) {
      case OpportunityType.ARBITRAGE:
        baseGas = 300000n;
        break;
      case OpportunityType.LIQUIDATION:
        baseGas = 500000n;
        break;
      case OpportunityType.STABLE_POOL_REBALANCING:
        baseGas = 400000n;
        break;
      case OpportunityType.MEMPOOL_BACKRUN:
        baseGas = 250000n;
        break;
    }

    // Adjust for network congestion
    const congestionMultiplier = 1 + this.currentMarketCondition.networkCongestion * 0.5;

    return BigInt(Math.floor(Number(baseGas) * congestionMultiplier));
  }

  /**
   * Helper calculation methods
   */
  private estimateGrossProfit(opportunity: OpportunityState): bigint {
    // Simplified profit estimation - would use actual DEX calculations in production
    const baseReturn = 0.02; // 2% base return
    const sizeAdjustment = Math.min(
      1.0,
      Number(opportunity.currentAmount) / Number(ethers.parseEther('100'))
    );
    const marketAdjustment = this.currentMarketCondition.liquidityIndex;

    const profitRate = baseReturn * sizeAdjustment * marketAdjustment;
    return BigInt(Math.floor(Number(opportunity.currentAmount) * profitRate));
  }

  private async estimateGasCost(opportunity: OpportunityState): Promise<bigint> {
    const gasLimit = this.calculateOptimalGasLimit(opportunity);
    const gasPrice = await this.getCurrentGasPrice();
    return gasLimit * gasPrice;
  }

  private async getCurrentGasPrice(): Promise<bigint> {
    try {
      const feeData = await this.provider.getFeeData();
      return feeData.gasPrice || this.currentMarketCondition.gasPrice;
    } catch (error) {
      this.logger.warn('Failed to get current gas price', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.currentMarketCondition.gasPrice;
    }
  }

  private calculateExecutionProbability(opportunity: OpportunityState): number {
    let probability = 0.8; // Base probability

    // Adjust for market conditions
    probability *= 1 - this.currentMarketCondition.networkCongestion * 0.3;
    probability *= this.currentMarketCondition.liquidityIndex;
    probability *= 1 - this.currentMarketCondition.competitionLevel * 0.2;

    // Adjust for opportunity age
    const ageMs = Date.now() - opportunity.createdAt;
    const ageFactor = Math.max(0.5, 1 - ageMs / 300000); // Decrease over 5 minutes
    probability *= ageFactor;

    return Math.max(0.1, Math.min(1.0, probability));
  }

  private calculateRiskMetrics(opportunity: OpportunityState): RiskMetrics {
    const volatilityRisk = this.currentMarketCondition.volatilityIndex;
    const liquidityRisk = 1 - this.currentMarketCondition.liquidityIndex;
    const executionRisk = this.currentMarketCondition.networkCongestion;
    const competitionRisk = this.currentMarketCondition.competitionLevel;

    // Size-based slippage risk
    const sizeRatio = Number(opportunity.currentAmount) / Number(ethers.parseEther('1000'));
    const slippageRisk = Math.min(0.8, sizeRatio * 0.5);

    // Gas price risk
    const gasRisk = Math.min(0.5, Number(this.currentMarketCondition.gasPrice) / 50000000000); // Risk increases above 50 gwei

    const overallRisk =
      (volatilityRisk + liquidityRisk + executionRisk + competitionRisk + slippageRisk + gasRisk) /
      6;

    return {
      volatilityRisk,
      liquidityRisk,
      executionRisk,
      competitionRisk,
      slippageRisk,
      gasRisk,
      overallRisk,
    };
  }

  private calculateSharpeRatio(
    _opportunity: OpportunityState,
    riskAdjustedReturn: number,
    riskMetrics: RiskMetrics
  ): number {
    const riskFreeRate = 0.05; // 5% annual risk-free rate
    const excessReturn = riskAdjustedReturn - riskFreeRate;
    const volatility = riskMetrics.overallRisk;

    return volatility > 0 ? excessReturn / volatility : 0;
  }

  private calculateConfidenceInterval(
    expectedReturn: number,
    risk: number
  ): { lower: number; upper: number } {
    const standardDeviation = expectedReturn * risk;
    const confidenceLevel = 1.96; // 95% confidence interval

    return {
      lower: expectedReturn - confidenceLevel * standardDeviation,
      upper: expectedReturn + confidenceLevel * standardDeviation,
    };
  }

  /**
   * Update market conditions
   */
  private async updateMarketConditions(): Promise<void> {
    try {
      // Get current gas price
      const gasPrice = await this.getCurrentGasPrice();

      // Simulate other market metrics (would use real data sources in production)
      const networkCongestion = Math.random() * 0.4 + 0.3; // 0.3-0.7
      const volatilityIndex = Math.random() * 0.6 + 0.2; // 0.2-0.8
      const liquidityIndex = Math.random() * 0.4 + 0.6; // 0.6-1.0
      const competitionLevel = Math.random() * 0.6 + 0.2; // 0.2-0.8

      this.currentMarketCondition = {
        timestamp: Date.now(),
        gasPrice,
        networkCongestion,
        volatilityIndex,
        liquidityIndex,
        competitionLevel,
        blockTime: 2000, // Base L2 block time
        mempoolSize: Math.floor(Math.random() * 2000 + 500), // 500-2500
      };

      // Add to history
      this.marketConditionHistory.push(this.currentMarketCondition);

      // Keep only last 100 entries
      if (this.marketConditionHistory.length > 100) {
        this.marketConditionHistory = this.marketConditionHistory.slice(-100);
      }

      this.emit('marketConditionsUpdated', this.currentMarketCondition);
    } catch (error) {
      this.logger.error('Failed to update market conditions', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Start optimization engine
   */
  private startOptimizationEngine(): void {
    // Start recalculation timer
    this.recalculationTimer = setInterval(async () => {
      await this.recalculateAllOpportunities();
    }, this.config.recalculationIntervalMs);

    // Start market condition updates
    this.marketUpdateTimer = setInterval(async () => {
      await this.updateMarketConditions();
    }, this.config.marketConditionUpdateMs);

    this.logger.info('Optimization engine started');
  }

  /**
   * Recalculate all active opportunities
   */
  private async recalculateAllOpportunities(): Promise<void> {
    const activeIds = Array.from(this.activeOpportunities.keys()).filter(
      id => this.activeOpportunities.get(id)?.status === 'active'
    );

    this.logger.debug('Recalculating opportunities', { count: activeIds.length });

    for (const opportunityId of activeIds) {
      try {
        await this.optimizeOpportunity(opportunityId);
      } catch (error) {
        this.logger.error('Failed to recalculate opportunity', {
          opportunityId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Get optimizer statistics
   */
  getOptimizerStats(): {
    activeOpportunities: number;
    optimizationCount: number;
    cancelledOpportunities: number;
    executedOpportunities: number;
    averageProfit: number;
    currentMarketCondition: MarketCondition;
  } {
    const profits = Array.from(this.profitabilityCache.values()).map(m => m.profitUsd);
    const averageProfit =
      profits.length > 0 ? profits.reduce((a, b) => a + b, 0) / profits.length : 0;

    return {
      activeOpportunities: this.activeOpportunities.size,
      optimizationCount: this.optimizationCount,
      cancelledOpportunities: this.cancelledOpportunities,
      executedOpportunities: this.executedOpportunities,
      averageProfit,
      currentMarketCondition: this.currentMarketCondition,
    };
  }

  /**
   * Get opportunity state
   */
  getOpportunityState(id: string): OpportunityState | null {
    return this.activeOpportunities.get(id) || null;
  }

  /**
   * Mark opportunity as executed
   */
  markOpportunityExecuted(id: string): void {
    const opportunity = this.activeOpportunities.get(id);
    if (opportunity) {
      opportunity.status = 'executed';
      this.activeOpportunities.set(id, opportunity);
      this.executedOpportunities++;

      this.emit('opportunityExecuted', { id, opportunity });
    }
  }

  /**
   * Stop optimizer
   */
  stop(): void {
    if (this.recalculationTimer) {
      clearInterval(this.recalculationTimer);
      this.recalculationTimer = null;
    }

    if (this.marketUpdateTimer) {
      clearInterval(this.marketUpdateTimer);
      this.marketUpdateTimer = null;
    }

    this.activeOpportunities.clear();
    this.profitabilityCache.clear();

    this.logger.info('Profitability optimizer stopped');
  }
}
