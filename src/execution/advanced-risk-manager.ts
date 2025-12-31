/**
 * Advanced Risk Management for Maximum Profitability
 *
 * Sophisticated risk management system that enables high-profit/high-risk
 * opportunities while protecting capital through dynamic position sizing,
 * portfolio-level risk limits, and risk-adjusted return optimization
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { BaseOpportunity, OpportunityType, ExecutionResult } from '../types/execution';

export interface AdvancedRiskManagerConfig {
  readonly enabled: boolean;
  readonly maxPortfolioRisk: number;
  readonly targetSharpeRatio: number;
  readonly maxDrawdown: number;
  readonly riskFreeRate: number;
  readonly volatilityLookbackPeriod: number;
  readonly positionSizingModel:
    | 'kelly'
    | 'fixed-fractional'
    | 'volatility-adjusted'
    | 'sharpe-optimal';
  readonly stopLossEnabled: boolean;
  readonly profitTakingEnabled: boolean;
  readonly dynamicHedging: boolean;
  readonly correlationAnalysis: boolean;
  readonly stressTestingEnabled: boolean;
  readonly maxLeverage: number;
  readonly concentrationLimits: ConcentrationLimits;
  readonly riskMetricsUpdateInterval: number;
}

export interface ConcentrationLimits {
  readonly maxSingleOpportunitySize: number;
  readonly maxProtocolExposure: number;
  readonly maxTokenExposure: number;
  readonly maxStrategyExposure: number;
  readonly maxCorrelatedExposure: number;
}

export interface RiskMetrics {
  readonly portfolioValue: bigint;
  readonly totalExposure: bigint;
  readonly availableCapital: bigint;
  readonly currentDrawdown: number;
  readonly maxDrawdownPeriod: number;
  readonly sharpeRatio: number;
  readonly volatility: number;
  readonly var95: bigint; // Value at Risk (95% confidence)
  readonly var99: bigint; // Value at Risk (99% confidence)
  readonly expectedShortfall: bigint;
  readonly betaToMarket: number;
  readonly correlationMatrix: Map<string, Map<string, number>>;
  readonly riskAdjustedReturn: number;
  readonly calmarRatio: number;
  readonly sortinoRatio: number;
  readonly lastUpdated: number;
}

export interface OpportunityRiskAssessment {
  readonly opportunityId: string;
  readonly riskScore: number; // 0-1 scale (0 = low risk, 1 = high risk)
  readonly expectedReturn: bigint;
  readonly expectedVolatility: number;
  readonly maxLoss: bigint;
  readonly probabilityOfLoss: number;
  readonly sharpeContribution: number;
  readonly correlationRisk: number;
  readonly liquidityRisk: number;
  readonly executionRisk: number;
  readonly marketRisk: number;
  readonly protocolRisk: number;
  readonly recommendedPositionSize: bigint;
  readonly maxPositionSize: bigint;
  readonly riskAdjustedExpectedReturn: bigint;
  readonly assessedAt: number;
}

export interface PositionSizing {
  readonly opportunityId: string;
  readonly baseSize: bigint;
  readonly kellySize: bigint;
  readonly volatilityAdjustedSize: bigint;
  readonly sharpeOptimalSize: bigint;
  readonly concentrationAdjustedSize: bigint;
  readonly finalRecommendedSize: bigint;
  readonly confidenceLevel: number;
  readonly reasoning: string[];
}

export interface StopLossConfig {
  readonly enabled: boolean;
  readonly staticStopLoss: number; // Fixed percentage stop loss
  readonly trailingStopLoss: number; // Trailing stop loss percentage
  readonly volatilityBasedStop: boolean; // Use volatility for dynamic stops
  readonly timeBasedStop: number; // Time-based stop (milliseconds)
  readonly drawdownBasedStop: number; // Portfolio drawdown trigger
}

export interface ProfitTakingConfig {
  readonly enabled: boolean;
  readonly targetProfitMultiple: number; // Take profit at X times expected profit
  readonly partialProfitLevels: number[]; // Partial profit taking levels
  readonly trailingProfitStop: number; // Trailing profit stop percentage
  readonly volatilityBasedTarget: boolean; // Use volatility for dynamic targets
  readonly riskRewardRatio: number; // Minimum risk/reward ratio
}

export interface PortfolioPosition {
  readonly opportunityType: OpportunityType;
  readonly protocol: string;
  readonly tokenPair: string;
  readonly size: bigint;
  readonly entryPrice: bigint;
  readonly currentPrice: bigint;
  readonly unrealizedPnL: bigint;
  readonly realizedPnL: bigint;
  readonly duration: number;
  readonly riskContribution: number;
  readonly correlations: Map<string, number>;
  readonly openedAt: number;
  readonly lastUpdated: number;
}

export interface RiskAlert {
  readonly id: string;
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly type:
    | 'concentration'
    | 'drawdown'
    | 'volatility'
    | 'correlation'
    | 'liquidity'
    | 'execution';
  readonly message: string;
  readonly currentValue: number;
  readonly threshold: number;
  readonly recommendedAction: string;
  readonly affectedPositions: string[];
  readonly triggeredAt: number;
}

export interface StressTestScenario {
  readonly name: string;
  readonly description: string;
  readonly marketShock: number; // Market movement percentage
  readonly volatilityShock: number; // Volatility increase multiplier
  readonly liquidityShock: number; // Liquidity reduction percentage
  readonly correlationShock: number; // Correlation increase
  readonly protocolRisk: number; // Protocol failure probability
  expectedLoss: bigint;
  worstCaseLoss: bigint;
  readonly recoveryTime: number;
}

export class AdvancedRiskManager extends EventEmitter {
  private readonly logger = createComponentLogger('advanced-risk-manager');
  private readonly config: AdvancedRiskManagerConfig;
  private readonly provider: ethers.Provider;

  // Risk state
  private currentRiskMetrics: RiskMetrics;
  private portfolioPositions = new Map<string, PortfolioPosition>();
  private riskAssessments = new Map<string, OpportunityRiskAssessment>();
  private activeAlerts = new Map<string, RiskAlert>();

  // Historical data for calculations
  private priceHistory = new Map<string, number[]>();
  private returnHistory = new Map<string, number[]>();
  private volatilityHistory = new Map<string, number[]>();
  private portfolioValueHistory: bigint[] = [];

  // Performance tracking
  private totalReturns = 0n;
  private executionCount = 0;
  private stopLossTriggered = 0;
  private profitTakingTriggered = 0;

  constructor(provider: ethers.Provider, config: AdvancedRiskManagerConfig) {
    super();
    this.provider = provider;
    this.config = config;

    // Initialize risk metrics
    this.currentRiskMetrics = this.initializeRiskMetrics();

    if (this.config.enabled) {
      this.startRiskMonitoring();
    }

    // Use provider for blockchain queries if needed
    this.getCurrentBlockNumber();

    this.logger.info('Advanced risk manager initialized', {
      enabled: this.config.enabled,
      maxPortfolioRisk: this.config.maxPortfolioRisk,
      targetSharpeRatio: this.config.targetSharpeRatio,
      positionSizingModel: this.config.positionSizingModel,
    });
  }

  /**
   * Get current block number from provider
   */
  private async getCurrentBlockNumber(): Promise<number> {
    try {
      return await this.provider.getBlockNumber();
    } catch (error) {
      this.logger.warn('Failed to get block number', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Assess risk for a high-profit opportunity
   */
  async assessOpportunityRisk(opportunity: BaseOpportunity): Promise<OpportunityRiskAssessment> {
    try {
      this.logger.debug('Assessing opportunity risk', {
        opportunityId: opportunity.id,
        type: opportunity.type,
        estimatedProfit: opportunity.estimatedProfit.toString(),
      });

      // Calculate base risk metrics
      const expectedReturn = opportunity.estimatedProfit;
      const expectedVolatility = await this.calculateOpportunityVolatility(opportunity);
      const maxLoss = await this.calculateMaxLoss(opportunity);
      const probabilityOfLoss = await this.calculateLossProbability(opportunity);

      // Calculate risk components
      const correlationRisk = await this.calculateCorrelationRisk(opportunity);
      const liquidityRisk = await this.calculateLiquidityRisk(opportunity);
      const executionRisk = await this.calculateExecutionRisk(opportunity);
      const marketRisk = await this.calculateMarketRisk(opportunity);
      const protocolRisk = await this.calculateProtocolRisk(opportunity);

      // Composite risk score
      const riskScore = this.calculateCompositeRiskScore({
        correlationRisk,
        liquidityRisk,
        executionRisk,
        marketRisk,
        protocolRisk,
        volatility: expectedVolatility,
      });

      // Calculate Sharpe contribution
      const sharpeContribution = await this.calculateSharpeContribution(
        expectedReturn,
        expectedVolatility,
        riskScore
      );

      // Calculate position sizing
      const positionSizing = await this.calculateOptimalPositionSize(
        opportunity,
        expectedReturn,
        expectedVolatility,
        riskScore
      );

      // Risk-adjusted expected return
      const riskAdjustedExpectedReturn =
        (expectedReturn * BigInt(Math.floor((1 - riskScore) * 10000))) / 10000n;

      const assessment: OpportunityRiskAssessment = {
        opportunityId: opportunity.id,
        riskScore,
        expectedReturn,
        expectedVolatility,
        maxLoss,
        probabilityOfLoss,
        sharpeContribution,
        correlationRisk,
        liquidityRisk,
        executionRisk,
        marketRisk,
        protocolRisk,
        recommendedPositionSize: positionSizing.finalRecommendedSize,
        maxPositionSize: positionSizing.concentrationAdjustedSize,
        riskAdjustedExpectedReturn,
        assessedAt: Date.now(),
      };

      this.riskAssessments.set(opportunity.id, assessment);

      this.emit('riskAssessmentCompleted', {
        opportunity,
        assessment,
      });

      return assessment;
    } catch (error) {
      this.logger.error('Risk assessment failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return conservative assessment on error
      return {
        opportunityId: opportunity.id,
        riskScore: 0.9, // High risk
        expectedReturn: opportunity.estimatedProfit,
        expectedVolatility: 0.5, // High volatility assumption
        maxLoss: opportunity.estimatedProfit, // Assume total loss possible
        probabilityOfLoss: 0.3, // 30% loss probability
        sharpeContribution: -0.1, // Negative Sharpe contribution
        correlationRisk: 0.5,
        liquidityRisk: 0.5,
        executionRisk: 0.5,
        marketRisk: 0.5,
        protocolRisk: 0.5,
        recommendedPositionSize: 0n, // No position recommended
        maxPositionSize: 0n,
        riskAdjustedExpectedReturn: 0n,
        assessedAt: Date.now(),
      };
    }
  }

  /**
   * Calculate optimal position size using multiple models
   */
  async calculateOptimalPositionSize(
    opportunity: BaseOpportunity,
    expectedReturn: bigint,
    volatility: number,
    riskScore: number
  ): Promise<PositionSizing> {
    try {
      const availableCapital = this.currentRiskMetrics.availableCapital;
      const reasoning: string[] = [];

      // Base size (percentage of available capital)
      const baseSize = (availableCapital * BigInt(Math.floor(0.1 * 10000))) / 10000n; // 10% base
      reasoning.push('Base size: 10% of available capital');

      // Kelly Criterion sizing
      const winProbability = 1 - riskScore;
      const avgWin = Number(expectedReturn) / 1e18;
      const avgLoss = avgWin * 0.5; // Assume 50% of expected return as potential loss
      const kellyFraction = winProbability - (1 - winProbability) / (avgWin / avgLoss);
      const kellySize =
        (availableCapital *
          BigInt(Math.floor(Math.max(0, Math.min(0.25, kellyFraction)) * 10000))) /
        10000n;
      reasoning.push(`Kelly fraction: ${kellyFraction.toFixed(4)}`);

      // Volatility-adjusted sizing
      const volatilityAdjustment = Math.max(0.1, Math.min(1.0, 1 / (1 + volatility * 2)));
      const volatilityAdjustedSize =
        (baseSize * BigInt(Math.floor(volatilityAdjustment * 10000))) / 10000n;
      reasoning.push(`Volatility adjustment: ${volatilityAdjustment.toFixed(4)}`);

      // Sharpe-optimal sizing
      const targetSharpe = this.config.targetSharpeRatio;
      const currentSharpe = this.currentRiskMetrics.sharpeRatio;
      const sharpeAdjustment = Math.max(
        0.1,
        Math.min(2.0, targetSharpe / Math.max(0.1, currentSharpe))
      );
      const sharpeOptimalSize = (baseSize * BigInt(Math.floor(sharpeAdjustment * 10000))) / 10000n;
      reasoning.push(`Sharpe adjustment: ${sharpeAdjustment.toFixed(4)}`);

      // Concentration limits
      const maxSingleSize =
        (availableCapital *
          BigInt(Math.floor(this.config.concentrationLimits.maxSingleOpportunitySize * 10000))) /
        10000n;
      const concentrationAdjustedSize = kellySize > maxSingleSize ? maxSingleSize : kellySize;
      reasoning.push(
        `Concentration limit: ${this.config.concentrationLimits.maxSingleOpportunitySize * 100}%`
      );

      // Final recommended size based on model
      let finalRecommendedSize: bigint;
      let confidenceLevel: number;

      switch (this.config.positionSizingModel) {
        case 'kelly':
          finalRecommendedSize = concentrationAdjustedSize;
          confidenceLevel = winProbability;
          reasoning.push('Using Kelly criterion model');
          break;
        case 'volatility-adjusted':
          finalRecommendedSize = volatilityAdjustedSize;
          confidenceLevel = volatilityAdjustment;
          reasoning.push('Using volatility-adjusted model');
          break;
        case 'sharpe-optimal':
          finalRecommendedSize = sharpeOptimalSize;
          confidenceLevel = Math.min(1.0, sharpeAdjustment / 2);
          reasoning.push('Using Sharpe-optimal model');
          break;
        default: // fixed-fractional
          finalRecommendedSize = baseSize;
          confidenceLevel = 0.7;
          reasoning.push('Using fixed-fractional model');
      }

      // Apply risk score adjustment
      const riskAdjustment = 1 - riskScore * 0.5; // Reduce size for higher risk
      finalRecommendedSize =
        (finalRecommendedSize * BigInt(Math.floor(riskAdjustment * 10000))) / 10000n;
      reasoning.push(`Risk adjustment: ${riskAdjustment.toFixed(4)}`);

      return {
        opportunityId: opportunity.id,
        baseSize,
        kellySize,
        volatilityAdjustedSize,
        sharpeOptimalSize,
        concentrationAdjustedSize,
        finalRecommendedSize,
        confidenceLevel,
        reasoning,
      };
    } catch (error) {
      this.logger.error('Position sizing calculation failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return conservative sizing
      const conservativeSize = (this.currentRiskMetrics.availableCapital * 1n) / 100n; // 1%
      return {
        opportunityId: opportunity.id,
        baseSize: conservativeSize,
        kellySize: conservativeSize,
        volatilityAdjustedSize: conservativeSize,
        sharpeOptimalSize: conservativeSize,
        concentrationAdjustedSize: conservativeSize,
        finalRecommendedSize: conservativeSize,
        confidenceLevel: 0.1,
        reasoning: ['Conservative sizing due to calculation error'],
      };
    }
  }

  /**
   * Check if opportunity should be executed based on risk limits
   */
  async shouldExecuteOpportunity(
    opportunity: BaseOpportunity,
    assessment: OpportunityRiskAssessment
  ): Promise<{ shouldExecute: boolean; reason: string; adjustedSize?: bigint }> {
    try {
      // Check portfolio risk limits
      if (this.currentRiskMetrics.currentDrawdown > this.config.maxDrawdown) {
        return {
          shouldExecute: false,
          reason: `Portfolio drawdown (${this.currentRiskMetrics.currentDrawdown.toFixed(2)}%) exceeds limit (${this.config.maxDrawdown * 100}%)`,
        };
      }

      // Check Sharpe ratio requirements
      if (
        assessment.sharpeContribution < 0 &&
        this.currentRiskMetrics.sharpeRatio > this.config.targetSharpeRatio
      ) {
        return {
          shouldExecute: false,
          reason: 'Opportunity would reduce portfolio Sharpe ratio below target',
        };
      }

      // Check risk score threshold
      if (assessment.riskScore > 0.8) {
        return {
          shouldExecute: false,
          reason: `Risk score (${assessment.riskScore.toFixed(2)}) too high`,
        };
      }

      // Check concentration limits
      const currentExposure = this.calculateCurrentExposure(opportunity.type);
      const maxExposure =
        (this.currentRiskMetrics.portfolioValue *
          BigInt(Math.floor(this.config.concentrationLimits.maxStrategyExposure * 10000))) /
        10000n;

      if (currentExposure + assessment.recommendedPositionSize > maxExposure) {
        const adjustedSize = maxExposure - currentExposure;
        if (adjustedSize > 0n) {
          return {
            shouldExecute: true,
            reason: 'Position size adjusted for concentration limits',
            adjustedSize,
          };
        } else {
          return {
            shouldExecute: false,
            reason: 'Strategy concentration limit exceeded',
          };
        }
      }

      // Check minimum risk-adjusted return
      const minReturn =
        (this.currentRiskMetrics.portfolioValue * BigInt(Math.floor(0.001 * 10000))) / 10000n; // 0.1% minimum
      if (assessment.riskAdjustedExpectedReturn < minReturn) {
        return {
          shouldExecute: false,
          reason: 'Risk-adjusted return below minimum threshold',
        };
      }

      return {
        shouldExecute: true,
        reason: 'All risk checks passed',
      };
    } catch (error) {
      this.logger.error('Risk check failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        shouldExecute: false,
        reason: 'Risk check failed due to error',
      };
    }
  }

  /**
   * Update risk metrics after execution
   */
  async updateRiskMetricsAfterExecution(
    opportunity: BaseOpportunity,
    result: ExecutionResult,
    positionSize: bigint
  ): Promise<void> {
    try {
      this.executionCount++;

      // Update portfolio value
      const profit = result.profit || 0n;
      const gasCost = result.gasCost || 0n;
      const netResult = profit - gasCost;

      this.totalReturns += netResult;
      this.portfolioValueHistory.push(this.currentRiskMetrics.portfolioValue + netResult);

      // Update position tracking
      if (result.success && profit > 0n) {
        await this.updatePortfolioPosition(opportunity, positionSize, profit);
      }

      // Recalculate risk metrics
      await this.calculateRiskMetrics();

      // Check for risk alerts
      await this.checkRiskAlerts();

      this.emit('riskMetricsUpdated', {
        opportunity,
        result,
        newMetrics: this.currentRiskMetrics,
      });
    } catch (error) {
      this.logger.error('Risk metrics update failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Implement sophisticated stop-loss mechanism
   */
  async checkStopLoss(
    position: PortfolioPosition
  ): Promise<{ shouldStop: boolean; reason: string }> {
    if (!this.config.stopLossEnabled) {
      return { shouldStop: false, reason: 'Stop-loss disabled' };
    }

    try {
      const unrealizedLossPercent = Number(position.unrealizedPnL) / Number(position.size);

      // Static stop-loss
      if (unrealizedLossPercent < -0.1) {
        // 10% loss
        this.stopLossTriggered++;
        return { shouldStop: true, reason: 'Static stop-loss triggered (10% loss)' };
      }

      // Volatility-based stop-loss
      const volatility = this.volatilityHistory.get(position.tokenPair)?.[0] || 0.1;
      const dynamicStopLevel = -volatility * 2; // 2x volatility

      if (unrealizedLossPercent < dynamicStopLevel) {
        this.stopLossTriggered++;
        return {
          shouldStop: true,
          reason: `Volatility-based stop-loss triggered (${dynamicStopLevel.toFixed(2)}%)`,
        };
      }

      // Time-based stop-loss
      const positionAge = Date.now() - position.openedAt;
      if (positionAge > 300000 && unrealizedLossPercent < -0.05) {
        // 5 minutes and 5% loss
        this.stopLossTriggered++;
        return { shouldStop: true, reason: 'Time-based stop-loss triggered' };
      }

      // Portfolio drawdown stop-loss
      if (this.currentRiskMetrics.currentDrawdown > this.config.maxDrawdown * 0.8) {
        this.stopLossTriggered++;
        return { shouldStop: true, reason: 'Portfolio drawdown stop-loss triggered' };
      }

      return { shouldStop: false, reason: 'No stop-loss conditions met' };
    } catch (error) {
      this.logger.error('Stop-loss check failed', {
        positionId: `${position.opportunityType}-${position.tokenPair}`,
        error: error instanceof Error ? error.message : String(error),
      });

      return { shouldStop: false, reason: 'Stop-loss check failed' };
    }
  }

  /**
   * Implement profit-taking mechanism
   */
  async checkProfitTaking(
    position: PortfolioPosition
  ): Promise<{ shouldTakeProfit: boolean; reason: string; percentage?: number }> {
    if (!this.config.profitTakingEnabled) {
      return { shouldTakeProfit: false, reason: 'Profit-taking disabled' };
    }

    try {
      const unrealizedProfitPercent = Number(position.unrealizedPnL) / Number(position.size);

      // Target profit multiple
      if (unrealizedProfitPercent > 0.2) {
        // 20% profit
        this.profitTakingTriggered++;
        return { shouldTakeProfit: true, reason: 'Target profit reached (20%)', percentage: 0.5 };
      }

      // Partial profit taking
      if (unrealizedProfitPercent > 0.1) {
        // 10% profit
        this.profitTakingTriggered++;
        return { shouldTakeProfit: true, reason: 'Partial profit taking (10%)', percentage: 0.25 };
      }

      // Volatility-based profit taking
      const volatility = this.volatilityHistory.get(position.tokenPair)?.[0] || 0.1;
      const dynamicProfitLevel = volatility * 3; // 3x volatility

      if (unrealizedProfitPercent > dynamicProfitLevel) {
        this.profitTakingTriggered++;
        return {
          shouldTakeProfit: true,
          reason: `Volatility-based profit taking (${dynamicProfitLevel.toFixed(2)}%)`,
          percentage: 0.75,
        };
      }

      return { shouldTakeProfit: false, reason: 'No profit-taking conditions met' };
    } catch (error) {
      this.logger.error('Profit-taking check failed', {
        positionId: `${position.opportunityType}-${position.tokenPair}`,
        error: error instanceof Error ? error.message : String(error),
      });

      return { shouldTakeProfit: false, reason: 'Profit-taking check failed' };
    }
  }

  /**
   * Run stress tests on current portfolio
   */
  async runStressTests(): Promise<StressTestScenario[]> {
    const scenarios: StressTestScenario[] = [
      {
        name: 'Market Crash',
        description: '30% market decline with increased volatility',
        marketShock: -0.3,
        volatilityShock: 2.0,
        liquidityShock: 0.5,
        correlationShock: 0.3,
        protocolRisk: 0.1,
        expectedLoss: 0n,
        worstCaseLoss: 0n,
        recoveryTime: 86400000, // 24 hours
      },
      {
        name: 'Flash Crash',
        description: '10% rapid decline with liquidity crisis',
        marketShock: -0.1,
        volatilityShock: 5.0,
        liquidityShock: 0.8,
        correlationShock: 0.5,
        protocolRisk: 0.05,
        expectedLoss: 0n,
        worstCaseLoss: 0n,
        recoveryTime: 3600000, // 1 hour
      },
      {
        name: 'Protocol Failure',
        description: 'Major protocol exploit or failure',
        marketShock: -0.05,
        volatilityShock: 1.5,
        liquidityShock: 0.3,
        correlationShock: 0.2,
        protocolRisk: 0.5,
        expectedLoss: 0n,
        worstCaseLoss: 0n,
        recoveryTime: 604800000, // 7 days
      },
    ];

    // Calculate losses for each scenario
    for (const scenario of scenarios) {
      const { expectedLoss, worstCaseLoss } = await this.calculateScenarioLoss(scenario);
      scenario.expectedLoss = expectedLoss;
      scenario.worstCaseLoss = worstCaseLoss;
    }

    this.emit('stressTestCompleted', { scenarios });

    return scenarios;
  }

  /**
   * Calculate current Sharpe ratio
   */
  calculateCurrentSharpeRatio(): number {
    if (this.portfolioValueHistory.length < 2) {
      return 0;
    }

    try {
      // Calculate returns
      const returns: number[] = [];
      for (let i = 1; i < this.portfolioValueHistory.length; i++) {
        const prevValue = Number(this.portfolioValueHistory[i - 1]);
        const currentValue = Number(this.portfolioValueHistory[i]);
        if (prevValue > 0) {
          returns.push((currentValue - prevValue) / prevValue);
        }
      }

      if (returns.length === 0) {
        return 0;
      }

      // Calculate mean return
      const meanReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;

      // Calculate standard deviation
      const variance =
        returns.reduce((sum, ret) => sum + Math.pow(ret - meanReturn, 2), 0) / returns.length;
      const stdDev = Math.sqrt(variance);

      if (stdDev === 0) {
        return meanReturn > 0 ? Infinity : 0;
      }

      // Sharpe ratio = (mean return - risk-free rate) / standard deviation
      return (meanReturn - this.config.riskFreeRate) / stdDev;
    } catch (error) {
      this.logger.error('Sharpe ratio calculation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Helper methods for risk calculations
   */
  private async calculateOpportunityVolatility(opportunity: BaseOpportunity): Promise<number> {
    // Simplified volatility calculation based on opportunity type
    const baseVolatility = {
      [OpportunityType.ARBITRAGE]: 0.1,
      [OpportunityType.LIQUIDATION]: 0.2,
      [OpportunityType.STABLE_POOL_REBALANCING]: 0.05,
      [OpportunityType.MEMPOOL_BACKRUN]: 0.3,
    };

    return baseVolatility[opportunity.type] || 0.15;
  }

  private async calculateMaxLoss(opportunity: BaseOpportunity): Promise<bigint> {
    // Estimate maximum possible loss (simplified)
    const lossMultiplier = {
      [OpportunityType.ARBITRAGE]: 0.1, // 10% max loss
      [OpportunityType.LIQUIDATION]: 0.15, // 15% max loss
      [OpportunityType.STABLE_POOL_REBALANCING]: 0.05, // 5% max loss
      [OpportunityType.MEMPOOL_BACKRUN]: 0.2, // 20% max loss
    };

    const multiplier = lossMultiplier[opportunity.type] || 0.1;
    return (opportunity.estimatedProfit * BigInt(Math.floor(multiplier * 10000))) / 10000n;
  }

  private async calculateLossProbability(opportunity: BaseOpportunity): Promise<number> {
    // Estimate probability of loss based on opportunity type and confidence
    const baseProbability = {
      [OpportunityType.ARBITRAGE]: 0.05,
      [OpportunityType.LIQUIDATION]: 0.1,
      [OpportunityType.STABLE_POOL_REBALANCING]: 0.03,
      [OpportunityType.MEMPOOL_BACKRUN]: 0.15,
    };

    const base = baseProbability[opportunity.type] || 0.1;
    const confidenceAdjustment = (1 - opportunity.confidence) * 0.2;

    return Math.min(0.5, base + confidenceAdjustment);
  }

  private async calculateCorrelationRisk(_opportunity: BaseOpportunity): Promise<number> {
    // Simplified correlation risk calculation
    return 0.1; // 10% correlation risk
  }

  private async calculateLiquidityRisk(opportunity: BaseOpportunity): Promise<number> {
    // Higher liquidity risk for larger opportunities
    const sizeRisk = Math.min(0.3, Number(opportunity.estimatedProfit) / 1e20); // Scale with size
    return sizeRisk;
  }

  private async calculateExecutionRisk(opportunity: BaseOpportunity): Promise<number> {
    // Higher execution risk for complex opportunities
    const complexityRisk = {
      [OpportunityType.ARBITRAGE]: 0.05,
      [OpportunityType.LIQUIDATION]: 0.1,
      [OpportunityType.STABLE_POOL_REBALANCING]: 0.03,
      [OpportunityType.MEMPOOL_BACKRUN]: 0.2,
    };

    return complexityRisk[opportunity.type] || 0.1;
  }

  private async calculateMarketRisk(_opportunity: BaseOpportunity): Promise<number> {
    // Market risk based on current volatility
    return Math.min(0.3, this.currentRiskMetrics.volatility);
  }

  private async calculateProtocolRisk(opportunity: BaseOpportunity): Promise<number> {
    // Protocol risk based on opportunity metadata
    const protocol = opportunity.metadata?.['protocol'] || 'unknown';
    const protocolRisks: Record<string, number> = {
      'uniswap-v3': 0.02,
      aerodrome: 0.03,
      moonwell: 0.05,
      aave: 0.02,
      unknown: 0.1,
    };

    return protocolRisks[protocol] || 0.1;
  }

  private calculateCompositeRiskScore(risks: {
    correlationRisk: number;
    liquidityRisk: number;
    executionRisk: number;
    marketRisk: number;
    protocolRisk: number;
    volatility: number;
  }): number {
    // Weighted composite risk score
    const weights = {
      correlation: 0.15,
      liquidity: 0.25,
      execution: 0.2,
      market: 0.2,
      protocol: 0.1,
      volatility: 0.1,
    };

    return (
      risks.correlationRisk * weights.correlation +
      risks.liquidityRisk * weights.liquidity +
      risks.executionRisk * weights.execution +
      risks.marketRisk * weights.market +
      risks.protocolRisk * weights.protocol +
      risks.volatility * weights.volatility
    );
  }

  private async calculateSharpeContribution(
    expectedReturn: bigint,
    volatility: number,
    riskScore: number
  ): Promise<number> {
    const returnPercent = Number(expectedReturn) / Number(this.currentRiskMetrics.portfolioValue);
    const riskAdjustedReturn = returnPercent * (1 - riskScore);
    const riskAdjustedVolatility = volatility * (1 + riskScore);

    if (riskAdjustedVolatility === 0) {
      return riskAdjustedReturn > 0 ? 1 : -1;
    }

    return (riskAdjustedReturn - this.config.riskFreeRate) / riskAdjustedVolatility;
  }

  private calculateCurrentExposure(opportunityType: OpportunityType): bigint {
    let exposure = 0n;
    for (const position of this.portfolioPositions.values()) {
      if (position.opportunityType === opportunityType) {
        exposure += position.size;
      }
    }
    return exposure;
  }

  private async updatePortfolioPosition(
    opportunity: BaseOpportunity,
    size: bigint,
    profit: bigint
  ): Promise<void> {
    const positionKey = `${opportunity.type}-${opportunity.metadata?.['tokenPair'] || 'unknown'}`;

    const position: PortfolioPosition = {
      opportunityType: opportunity.type,
      protocol: opportunity.metadata?.['protocol'] || 'unknown',
      tokenPair: opportunity.metadata?.['tokenPair'] || 'unknown',
      size,
      entryPrice: 0n, // Simplified
      currentPrice: 0n, // Simplified
      unrealizedPnL: profit,
      realizedPnL: profit,
      duration: Date.now() - opportunity.detectedAt,
      riskContribution: 0.1, // Simplified
      correlations: new Map(),
      openedAt: opportunity.detectedAt,
      lastUpdated: Date.now(),
    };

    this.portfolioPositions.set(positionKey, position);
  }

  private async calculateRiskMetrics(): Promise<void> {
    try {
      const portfolioValue =
        this.portfolioValueHistory[this.portfolioValueHistory.length - 1] || 1000000n;
      const totalExposure = Array.from(this.portfolioPositions.values()).reduce(
        (sum, pos) => sum + pos.size,
        0n
      );

      const availableCapital = portfolioValue - totalExposure;

      // Calculate drawdown
      const peak = this.portfolioValueHistory.reduce((max, val) => (val > max ? val : max), 0n);
      const currentDrawdown = peak > 0n ? Number(peak - portfolioValue) / Number(peak) : 0;

      // Calculate other metrics
      const sharpeRatio = this.calculateCurrentSharpeRatio();
      const volatility = this.calculatePortfolioVolatility();

      this.currentRiskMetrics = {
        portfolioValue,
        totalExposure,
        availableCapital,
        currentDrawdown,
        maxDrawdownPeriod: 0, // Simplified
        sharpeRatio,
        volatility,
        var95: (portfolioValue * 5n) / 100n, // 5% VaR
        var99: (portfolioValue * 10n) / 100n, // 10% VaR
        expectedShortfall: (portfolioValue * 15n) / 100n, // 15% ES
        betaToMarket: 1.0, // Simplified
        correlationMatrix: new Map(),
        riskAdjustedReturn: sharpeRatio * volatility,
        calmarRatio: sharpeRatio / Math.max(0.01, currentDrawdown),
        sortinoRatio: sharpeRatio * 1.2, // Simplified
        lastUpdated: Date.now(),
      };
    } catch (error) {
      this.logger.error('Risk metrics calculation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private calculatePortfolioVolatility(): number {
    if (this.portfolioValueHistory.length < 2) {
      return 0.1; // Default volatility
    }

    const returns: number[] = [];
    for (let i = 1; i < this.portfolioValueHistory.length; i++) {
      const prevValue = Number(this.portfolioValueHistory[i - 1]);
      const currentValue = Number(this.portfolioValueHistory[i]);
      if (prevValue > 0) {
        returns.push((currentValue - prevValue) / prevValue);
      }
    }

    if (returns.length === 0) {
      return 0.1;
    }

    const mean = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance =
      returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;

    return Math.sqrt(variance);
  }

  private async checkRiskAlerts(): Promise<void> {
    const alerts: RiskAlert[] = [];

    // Drawdown alert
    if (this.currentRiskMetrics.currentDrawdown > this.config.maxDrawdown * 0.8) {
      alerts.push({
        id: `drawdown-${Date.now()}`,
        severity: 'high',
        type: 'drawdown',
        message: 'Portfolio drawdown approaching limit',
        currentValue: this.currentRiskMetrics.currentDrawdown,
        threshold: this.config.maxDrawdown,
        recommendedAction: 'Reduce position sizes and risk exposure',
        affectedPositions: Array.from(this.portfolioPositions.keys()),
        triggeredAt: Date.now(),
      });
    }

    // Volatility alert
    if (this.currentRiskMetrics.volatility > 0.3) {
      alerts.push({
        id: `volatility-${Date.now()}`,
        severity: 'medium',
        type: 'volatility',
        message: 'Portfolio volatility elevated',
        currentValue: this.currentRiskMetrics.volatility,
        threshold: 0.3,
        recommendedAction: 'Consider reducing position sizes',
        affectedPositions: [],
        triggeredAt: Date.now(),
      });
    }

    // Process new alerts
    for (const alert of alerts) {
      if (!this.activeAlerts.has(alert.id)) {
        this.activeAlerts.set(alert.id, alert);
        this.emit('riskAlert', alert);
      }
    }
  }

  private async calculateScenarioLoss(
    scenario: StressTestScenario
  ): Promise<{ expectedLoss: bigint; worstCaseLoss: bigint }> {
    const portfolioValue = this.currentRiskMetrics.portfolioValue;

    // Simplified scenario loss calculation
    const expectedLossPercent = Math.abs(scenario.marketShock) * 0.5 + scenario.protocolRisk * 0.3;
    const worstCaseLossPercent = Math.abs(scenario.marketShock) + scenario.protocolRisk;

    const expectedLoss =
      (portfolioValue * BigInt(Math.floor(expectedLossPercent * 10000))) / 10000n;
    const worstCaseLoss =
      (portfolioValue * BigInt(Math.floor(worstCaseLossPercent * 10000))) / 10000n;

    return { expectedLoss, worstCaseLoss };
  }

  private initializeRiskMetrics(): RiskMetrics {
    return {
      portfolioValue: 1000000n, // $1M initial
      totalExposure: 0n,
      availableCapital: 1000000n,
      currentDrawdown: 0,
      maxDrawdownPeriod: 0,
      sharpeRatio: 0,
      volatility: 0.1,
      var95: 50000n, // 5% of portfolio
      var99: 100000n, // 10% of portfolio
      expectedShortfall: 150000n, // 15% of portfolio
      betaToMarket: 1.0,
      correlationMatrix: new Map(),
      riskAdjustedReturn: 0,
      calmarRatio: 0,
      sortinoRatio: 0,
      lastUpdated: Date.now(),
    };
  }

  private startRiskMonitoring(): void {
    // Update risk metrics periodically
    setInterval(async () => {
      await this.calculateRiskMetrics();
      await this.checkRiskAlerts();
    }, this.config.riskMetricsUpdateInterval);

    // Run stress tests periodically
    setInterval(async () => {
      if (this.config.stressTestingEnabled) {
        await this.runStressTests();
      }
    }, 3600000); // Every hour

    this.logger.info('Risk monitoring started');
  }

  /**
   * Get comprehensive risk manager statistics
   */
  getRiskManagerStats(): {
    enabled: boolean;
    currentMetrics: RiskMetrics;
    executionCount: number;
    totalReturns: string;
    stopLossTriggered: number;
    profitTakingTriggered: number;
    activeAlerts: number;
    portfolioPositions: number;
    riskAssessments: number;
  } {
    return {
      enabled: this.config.enabled,
      currentMetrics: this.currentRiskMetrics,
      executionCount: this.executionCount,
      totalReturns: this.totalReturns.toString(),
      stopLossTriggered: this.stopLossTriggered,
      profitTakingTriggered: this.profitTakingTriggered,
      activeAlerts: this.activeAlerts.size,
      portfolioPositions: this.portfolioPositions.size,
      riskAssessments: this.riskAssessments.size,
    };
  }

  /**
   * Stop advanced risk manager
   */
  stop(): void {
    this.portfolioPositions.clear();
    this.riskAssessments.clear();
    this.activeAlerts.clear();
    this.priceHistory.clear();
    this.returnHistory.clear();
    this.volatilityHistory.clear();
    this.portfolioValueHistory.length = 0;

    this.logger.info('Advanced risk manager stopped');
  }
}
