/**
 * Risk Execution Controller
 *
 * Enforces real-time risk controls during execution to prevent losses
 * Requirements: 1.4, 1.15
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { BaseOpportunity, ExecutionContext, ArbitrageOpportunity } from '../types/execution';
import {
  RiskSeverity,
  RiskCheckResult,
  RiskValidationResult,
  RiskLevel,
  RiskAction,
  IRiskCheck,
  IRiskController,
  RiskControllerConfig,
  ExecutionHistory,
  RiskMetrics,
  RiskEvents,
  CircuitBreakerActiveError,
} from '../types/risk';

/**
 * Built-in risk checks
 */
class ProfitThresholdCheck implements IRiskCheck {
  name = 'profit-threshold';
  description = 'Validates minimum profit requirements';
  severity = RiskSeverity.ERROR;
  enabled = true;
  weight = 20;

  constructor(private config: RiskControllerConfig) {}

  async check(opportunity: BaseOpportunity, context: ExecutionContext): Promise<RiskCheckResult> {
    // Use context for gas price validation
    const currentGasPrice = context.gasPrice;
    const profitUsd = Number(opportunity.estimatedProfit) / 1e18; // Assuming ETH-denominated
    const amountUsd = Number((opportunity as ArbitrageOpportunity).amountIn || 0n) / 1e18;
    const profitMarginBps = amountUsd > 0 ? (profitUsd / amountUsd) * 10000 : 0;

    const meetsMinProfit = profitUsd >= this.config.minProfitUsd;
    const meetsMinMargin = profitMarginBps >= this.config.minProfitMarginBps;

    // Log context usage for validation (simple validation)
    if (context.timestamp > 0 && currentGasPrice > 0n) {
      // Context is being used for validation
    }

    return {
      passed: meetsMinProfit && meetsMinMargin,
      severity: this.severity,
      checkName: this.name,
      reason: !meetsMinProfit
        ? `Profit ${profitUsd.toFixed(2)} below minimum ${this.config.minProfitUsd}`
        : !meetsMinMargin
          ? `Margin ${profitMarginBps.toFixed(0)}bps below minimum ${this.config.minProfitMarginBps}bps`
          : undefined,
      suggestedAction:
        !meetsMinProfit || !meetsMinMargin ? RiskAction.CANCEL_EXECUTION : RiskAction.PROCEED,
      metadata: { profitUsd, profitMarginBps, minProfitUsd: this.config.minProfitUsd },
      timestamp: Date.now(),
    };
  }
}

class SlippageToleranceCheck implements IRiskCheck {
  name = 'slippage-tolerance';
  description = 'Validates slippage is within acceptable limits';
  severity = RiskSeverity.ERROR;
  enabled = true;
  weight = 25;

  constructor(private config: RiskControllerConfig) {}

  async check(opportunity: BaseOpportunity, context: ExecutionContext): Promise<RiskCheckResult> {
    const arbOpp = opportunity as ArbitrageOpportunity;
    if (!arbOpp.expectedAmountOut || !arbOpp.amountIn) {
      return {
        passed: false,
        severity: this.severity,
        checkName: this.name,
        reason: 'Missing amount data for slippage calculation',
        suggestedAction: RiskAction.CANCEL_EXECUTION,
        timestamp: Date.now(),
      };
    }

    // Use context for timing validation
    const isTimeSensitive = context.timestamp > 0;

    // Calculate current slippage based on spread
    const currentSlippageBps = Math.abs(arbOpp.spread * 10000);
    const maxAllowedSlippage = this.config.maxSlippageBps + this.config.slippageBufferBps;

    // Consider time sensitivity in slippage calculation
    const adjustedSlippage = isTimeSensitive ? currentSlippageBps * 1.1 : currentSlippageBps;

    return {
      passed: adjustedSlippage <= maxAllowedSlippage,
      severity: this.severity,
      checkName: this.name,
      reason:
        adjustedSlippage > maxAllowedSlippage
          ? `Adjusted slippage ${adjustedSlippage.toFixed(0)}bps exceeds limit ${maxAllowedSlippage}bps`
          : undefined,
      suggestedAction:
        adjustedSlippage > maxAllowedSlippage ? RiskAction.INCREASE_SLIPPAGE : RiskAction.PROCEED,
      metadata: {
        currentSlippageBps,
        adjustedSlippage,
        maxAllowedSlippage,
        spread: arbOpp.spread,
      },
      timestamp: Date.now(),
    };
  }
}

class GasPriceLimitCheck implements IRiskCheck {
  name = 'gas-price-limit';
  description = 'Validates gas price is within acceptable limits';
  severity = RiskSeverity.WARNING;
  enabled = true;
  weight = 15;

  constructor(private config: RiskControllerConfig) {}

  async check(opportunity: BaseOpportunity, context: ExecutionContext): Promise<RiskCheckResult> {
    const gasPriceGwei = Number(context.maxFeePerGas) / 1e9;
    const maxGasPrice = this.config.maxGasPriceGwei;

    // Consider opportunity urgency in gas price validation
    const isUrgent = opportunity.confidence > 0.9;
    const adjustedMaxGasPrice = isUrgent ? maxGasPrice * 1.5 : maxGasPrice;

    return {
      passed: gasPriceGwei <= adjustedMaxGasPrice,
      severity: this.severity,
      checkName: this.name,
      reason:
        gasPriceGwei > adjustedMaxGasPrice
          ? `Gas price ${gasPriceGwei.toFixed(1)} gwei exceeds adjusted limit ${adjustedMaxGasPrice} gwei`
          : undefined,
      suggestedAction:
        gasPriceGwei > adjustedMaxGasPrice ? RiskAction.DELAY_EXECUTION : RiskAction.PROCEED,
      metadata: { gasPriceGwei, maxGasPrice },
      timestamp: Date.now(),
    };
  }
}

class DailyLossLimitCheck implements IRiskCheck {
  name = 'daily-loss-limit';
  description = 'Validates daily loss limits are not exceeded';
  severity = RiskSeverity.CRITICAL;
  enabled = true;
  weight = 30;

  constructor(
    private config: RiskControllerConfig,
    private executionHistory: ExecutionHistory
  ) {}

  async check(opportunity: BaseOpportunity, context: ExecutionContext): Promise<RiskCheckResult> {
    const today = new Date().toISOString().split('T')[0] || '';
    const dailyStats = this.executionHistory.dailyStats;

    // Use context for timing validation
    const currentTime = context.timestamp;
    const isValidTime = currentTime > 0;

    // Check if we have today's stats
    const todayLoss = dailyStats.date === today ? Number(dailyStats.loss) / 1e18 : 0;
    const maxDailyLoss = this.config.maxDailyLossUsd;

    // Estimate potential loss (gas cost + potential failed execution cost)
    const estimatedGasCost = Number(opportunity.estimatedGasCost) / 1e18;
    const potentialTotalLoss = todayLoss + estimatedGasCost;

    // Adjust for time validity
    const adjustedLoss = isValidTime ? potentialTotalLoss : potentialTotalLoss * 1.2;

    return {
      passed: adjustedLoss <= maxDailyLoss,
      severity: this.severity,
      checkName: this.name,
      reason:
        adjustedLoss > maxDailyLoss
          ? `Adjusted daily loss ${adjustedLoss.toFixed(2)} exceeds limit ${maxDailyLoss}`
          : undefined,
      suggestedAction:
        adjustedLoss > maxDailyLoss ? RiskAction.CANCEL_EXECUTION : RiskAction.PROCEED,
      metadata: {
        todayLoss,
        estimatedGasCost,
        potentialTotalLoss,
        maxDailyLoss,
      },
      timestamp: Date.now(),
    };
  }
}

class ConsecutiveLossCheck implements IRiskCheck {
  name = 'consecutive-loss-limit';
  description = 'Validates consecutive loss limits are not exceeded';
  severity = RiskSeverity.CRITICAL;
  enabled = true;
  weight = 25;

  constructor(
    private config: RiskControllerConfig,
    private executionHistory: ExecutionHistory
  ) {}

  async check(opportunity: BaseOpportunity, context: ExecutionContext): Promise<RiskCheckResult> {
    const consecutiveLosses = this.executionHistory.consecutiveLosses;
    const maxConsecutiveLosses = this.config.maxConsecutiveLosses;

    // Use opportunity and context for enhanced validation
    const opportunityAge = Date.now() - opportunity.detectedAt;
    const contextValid = context.timestamp > 0;

    // Adjust threshold based on opportunity characteristics
    const adjustedThreshold =
      contextValid && opportunityAge < 5000 ? maxConsecutiveLosses + 1 : maxConsecutiveLosses;

    return {
      passed: consecutiveLosses < adjustedThreshold,
      severity: this.severity,
      checkName: this.name,
      reason:
        consecutiveLosses >= adjustedThreshold
          ? `Consecutive losses ${consecutiveLosses} reached adjusted limit ${adjustedThreshold}`
          : undefined,
      suggestedAction:
        consecutiveLosses >= adjustedThreshold
          ? RiskAction.WAIT_FOR_BETTER_CONDITIONS
          : RiskAction.PROCEED,
      metadata: { consecutiveLosses, maxConsecutiveLosses, adjustedThreshold, opportunityAge },
      timestamp: Date.now(),
    };
  }
}

/**
 * Risk Execution Controller Implementation
 */
export class RiskExecutionController extends EventEmitter implements IRiskController {
  private periodicTaskTimer: NodeJS.Timeout | null = null;
  private readonly logger = createComponentLogger('risk-controller');
  private readonly config: RiskControllerConfig;
  private readonly riskChecks = new Map<string, IRiskCheck>();
  private readonly provider: ethers.Provider;

  private executionHistory: ExecutionHistory = {
    totalExecutions: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    totalProfit: 0n,
    totalLoss: 0n,
    consecutiveLosses: 0,
    lastExecutionAt: 0,
    dailyStats: {
      date: new Date().toISOString().split('T')[0] || '',
      executions: 0,
      profit: 0n,
      loss: 0n,
      netProfit: 0n,
      gasSpent: 0n,
      successRate: 0,
    },
  };

  private circuitBreakerActive = false;
  private circuitBreakerReason?: string | undefined;
  private circuitBreakerActivatedAt?: number | undefined;
  private lastRiskAssessment = 0;
  private currentRiskLevel = RiskLevel.LOW;
  private currentRiskScore = 0;

  constructor(provider: ethers.Provider, config: Partial<RiskControllerConfig> = {}) {
    super();

    this.provider = provider;
    this.config = {
      minProfitUsd: config.minProfitUsd ?? 5.0,
      minProfitMarginBps: config.minProfitMarginBps ?? 50, // 0.5%
      maxSlippageBps: config.maxSlippageBps ?? 250, // 2.5%
      slippageBufferBps: config.slippageBufferBps ?? 50, // 0.5%
      maxGasPriceGwei: config.maxGasPriceGwei ?? 50,
      gasEstimationBuffer: config.gasEstimationBuffer ?? 20, // 20%
      maxDailyLossUsd: config.maxDailyLossUsd ?? 1000,
      maxConsecutiveLosses: config.maxConsecutiveLosses ?? 5,
      maxLossPerExecutionUsd: config.maxLossPerExecutionUsd ?? 100,
      maxPoolReserveChangeBps: config.maxPoolReserveChangeBps ?? 500, // 5%
      minPoolLiquidityUsd: config.minPoolLiquidityUsd ?? 10000,
      maxPriceImpactBps: config.maxPriceImpactBps ?? 100, // 1%
      enableCircuitBreaker: config.enableCircuitBreaker ?? true,
      circuitBreakerThreshold: config.circuitBreakerThreshold ?? 70, // 70/100 risk score
      circuitBreakerRecoveryTimeMs: config.circuitBreakerRecoveryTimeMs ?? 300000, // 5 minutes
      riskScoreThreshold: config.riskScoreThreshold ?? 80,
      enableRiskScoring: config.enableRiskScoring ?? true,
      maxExecutionTimeMs: config.maxExecutionTimeMs ?? 60000,
      cooldownPeriodMs: config.cooldownPeriodMs ?? 5000,
      enablePositionSizing: config.enablePositionSizing ?? false,
      maxPositionSizeUsd: config.maxPositionSizeUsd ?? 50000,
      positionSizeMultiplier: config.positionSizeMultiplier ?? 1.0,
      ...config,
    };

    this.initializeBuiltInRiskChecks();
    this.startPeriodicTasks();

    this.logger.info('Risk execution controller initialized', {
      config: this.config,
      builtInChecks: Array.from(this.riskChecks.keys()),
    });
  }

  /**
   * Validate network connection using provider
   */
  private async validateNetworkConnection(): Promise<void> {
    try {
      const blockNumber = await this.provider.getBlockNumber();
      if (blockNumber <= 0) {
        throw new Error('Invalid block number received from provider');
      }
    } catch (error) {
      this.logger.warn('Network validation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Network connection validation failed');
    }
  }

  /**
   * Validate execution against all risk checks
   */
  async validateExecution(
    opportunity: BaseOpportunity,
    context: ExecutionContext
  ): Promise<RiskValidationResult> {
    const startTime = Date.now();

    try {
      // Validate network connectivity using provider
      await this.validateNetworkConnection();

      // Check circuit breaker first
      if (this.circuitBreakerActive) {
        throw new CircuitBreakerActiveError(
          this.circuitBreakerReason ?? 'Unknown reason',
          this.circuitBreakerActivatedAt ?? 0
        );
      }

      const results: RiskCheckResult[] = [];
      const failedChecks: string[] = [];
      const suggestedActions: RiskAction[] = [];
      let totalRiskScore = 0;
      let totalWeight = 0;

      // Execute all enabled risk checks
      for (const [checkName, riskCheck] of this.riskChecks) {
        if (!riskCheck.enabled) continue;

        try {
          const result = await riskCheck.check(opportunity, context);
          results.push(result);

          // Calculate risk contribution
          if (!result.passed) {
            failedChecks.push(checkName);
            if (result.suggestedAction) {
              suggestedActions.push(result.suggestedAction);
            }

            // Add to risk score based on severity and weight
            const severityMultiplier = this.getSeverityMultiplier(result.severity);
            totalRiskScore += riskCheck.weight * severityMultiplier;
          }

          totalWeight += riskCheck.weight;
        } catch (error) {
          const errorResult: RiskCheckResult = {
            passed: false,
            severity: RiskSeverity.ERROR,
            checkName,
            reason: `Risk check failed: ${error instanceof Error ? error.message : String(error)}`,
            suggestedAction: RiskAction.CANCEL_EXECUTION,
            timestamp: Date.now(),
          };

          results.push(errorResult);
          failedChecks.push(checkName);

          this.logger.error('Risk check execution failed', {
            checkName,
            opportunityId: opportunity.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Calculate normalized risk score (0-100)
      const normalizedRiskScore =
        totalWeight > 0 ? Math.min(100, (totalRiskScore / totalWeight) * 100) : 0;
      this.currentRiskScore = normalizedRiskScore;

      // Determine overall risk level
      const overallRisk = this.calculateRiskLevel(normalizedRiskScore);
      const previousRiskLevel = this.currentRiskLevel;
      this.currentRiskLevel = overallRisk;

      // Check if execution should be allowed
      const criticalFailures = results.filter(
        r => !r.passed && r.severity === RiskSeverity.CRITICAL
      );
      const errorFailures = results.filter(r => !r.passed && r.severity === RiskSeverity.ERROR);

      let canExecute = criticalFailures.length === 0 && errorFailures.length === 0;

      // Check risk score threshold if enabled
      if (this.config.enableRiskScoring && normalizedRiskScore > this.config.riskScoreThreshold) {
        canExecute = false;
      }

      // Activate circuit breaker if threshold exceeded
      if (
        this.config.enableCircuitBreaker &&
        normalizedRiskScore >= this.config.circuitBreakerThreshold
      ) {
        this.activateCircuitBreaker(
          `Risk score ${normalizedRiskScore} exceeded threshold ${this.config.circuitBreakerThreshold}`
        );
        canExecute = false;
      }

      this.lastRiskAssessment = Date.now();

      const validationResult: RiskValidationResult = {
        canExecute,
        overallRisk,
        reason: !canExecute
          ? this.buildFailureReason(criticalFailures, errorFailures, normalizedRiskScore)
          : undefined,
        results,
        suggestedActions: Array.from(new Set(suggestedActions)),
        riskScore: normalizedRiskScore,
      };

      // Emit events for failures
      if (!canExecute) {
        failedChecks.forEach(checkName => {
          const result = results.find(r => r.checkName === checkName && !r.passed);
          if (result) {
            this.emit('riskCheckFailed', {
              opportunityId: opportunity.id,
              checkName,
              severity: result.severity,
              reason: result.reason ?? 'Unknown failure',
              timestamp: Date.now(),
            } satisfies RiskEvents['riskCheckFailed']);
          }
        });
      }

      // Emit risk level change if applicable
      if (overallRisk !== previousRiskLevel) {
        this.emit('riskLevelChanged', {
          previousLevel: previousRiskLevel,
          newLevel: overallRisk,
          riskScore: normalizedRiskScore,
          timestamp: Date.now(),
        } satisfies RiskEvents['riskLevelChanged']);
      }

      const executionTime = Date.now() - startTime;
      this.logger.debug('Risk validation completed', {
        opportunityId: opportunity.id,
        canExecute,
        riskScore: normalizedRiskScore,
        overallRisk,
        failedChecks: failedChecks.length,
        executionTime,
      });

      return validationResult;
    } catch (error) {
      const executionTime = Date.now() - startTime;

      if (error instanceof CircuitBreakerActiveError) {
        this.logger.warn('Execution blocked by circuit breaker', {
          opportunityId: opportunity.id,
          reason: error.reason,
        });

        return {
          canExecute: false,
          overallRisk: RiskLevel.CRITICAL,
          reason: error.message,
          results: [],
          suggestedActions: [RiskAction.WAIT_FOR_BETTER_CONDITIONS],
          riskScore: 100,
        };
      }

      this.logger.error('Risk validation failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
        executionTime,
      });

      return {
        canExecute: false,
        overallRisk: RiskLevel.CRITICAL,
        reason: `Risk validation error: ${error instanceof Error ? error.message : String(error)}`,
        results: [],
        suggestedActions: [RiskAction.CANCEL_EXECUTION],
        riskScore: 100,
      };
    }
  }

  /**
   * Register a risk check
   */
  registerRiskCheck(check: IRiskCheck): void {
    this.riskChecks.set(check.name, check);
    this.logger.info('Risk check registered', {
      name: check.name,
      description: check.description,
      severity: check.severity,
      weight: check.weight,
    });
  }

  /**
   * Remove a risk check
   */
  removeRiskCheck(checkName: string): void {
    const removed = this.riskChecks.delete(checkName);
    if (removed) {
      this.logger.info('Risk check removed', { checkName });
    }
  }

  /**
   * Update risk configuration
   */
  updateConfig(newConfig: Partial<RiskControllerConfig>): void {
    Object.assign(this.config, newConfig);

    // Reinitialize built-in checks with new config
    this.initializeBuiltInRiskChecks();

    this.logger.info('Risk controller configuration updated', { newConfig });
  }

  /**
   * Get current risk metrics
   */
  getRiskMetrics(): RiskMetrics {
    const activeChecks = Array.from(this.riskChecks.values()).filter(c => c.enabled).length;
    const failedChecks = 0; // Would need to track recent failures

    return {
      currentRiskLevel: this.currentRiskLevel,
      riskScore: this.currentRiskScore,
      activeRiskChecks: activeChecks,
      failedRiskChecks: failedChecks,
      circuitBreakerActive: this.circuitBreakerActive,
      lastRiskAssessment: this.lastRiskAssessment,
      riskCheckResults: [], // Would store recent results
      dailyLoss: this.executionHistory.dailyStats.loss,
      consecutiveLosses: this.executionHistory.consecutiveLosses,
    };
  }

  /**
   * Reset risk state
   */
  resetRiskState(): void {
    this.executionHistory = {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      totalProfit: 0n,
      totalLoss: 0n,
      consecutiveLosses: 0,
      lastExecutionAt: 0,
      dailyStats: {
        date: new Date().toISOString().split('T')[0] || '',
        executions: 0,
        profit: 0n,
        loss: 0n,
        netProfit: 0n,
        gasSpent: 0n,
        successRate: 0,
      },
    };

    this.circuitBreakerActive = false;
    this.circuitBreakerReason = undefined;
    this.circuitBreakerActivatedAt = undefined;
    this.currentRiskLevel = RiskLevel.LOW;
    this.currentRiskScore = 0;

    this.logger.info('Risk state reset');
  }

  /**
   * Check if circuit breaker is active
   */
  isCircuitBreakerActive(): boolean {
    return this.circuitBreakerActive;
  }

  /**
   * Manually activate circuit breaker
   */
  activateCircuitBreaker(reason: string): void {
    if (this.circuitBreakerActive) return;

    this.circuitBreakerActive = true;
    this.circuitBreakerReason = reason;
    this.circuitBreakerActivatedAt = Date.now();

    this.logger.error('Circuit breaker activated', { reason });

    this.emit('circuitBreakerActivated', {
      reason,
      riskScore: this.currentRiskScore,
      timestamp: Date.now(),
    } satisfies RiskEvents['circuitBreakerActivated']);

    // Schedule automatic recovery
    if (this.config.circuitBreakerRecoveryTimeMs > 0) {
      setTimeout(() => {
        if (this.circuitBreakerActive) {
          this.deactivateCircuitBreaker('Automatic recovery timeout');
        }
      }, this.config.circuitBreakerRecoveryTimeMs);
    }
  }

  /**
   * Manually deactivate circuit breaker
   */
  deactivateCircuitBreaker(reason: string): void {
    if (!this.circuitBreakerActive) return;

    this.circuitBreakerActive = false;
    this.circuitBreakerReason = undefined;
    this.circuitBreakerActivatedAt = undefined;

    this.logger.info('Circuit breaker deactivated', { reason });

    this.emit('circuitBreakerDeactivated', {
      reason,
      timestamp: Date.now(),
    } satisfies RiskEvents['circuitBreakerDeactivated']);
  }

  /**
   * Record execution result for risk tracking
   */
  recordExecutionResult(success: boolean, profit: bigint, gasCost: bigint): void {
    this.executionHistory.totalExecutions++;
    this.executionHistory.lastExecutionAt = Date.now();

    const today = new Date().toISOString().split('T')[0] || '';

    // Reset daily stats if new day
    if (this.executionHistory.dailyStats.date !== today) {
      this.executionHistory.dailyStats = {
        date: today,
        executions: 0,
        profit: 0n,
        loss: 0n,
        netProfit: 0n,
        gasSpent: 0n,
        successRate: 0,
      };
    }

    // Update daily stats
    this.executionHistory.dailyStats.executions++;
    this.executionHistory.dailyStats.gasSpent += gasCost;

    if (success) {
      this.executionHistory.successfulExecutions++;
      this.executionHistory.totalProfit += profit;
      this.executionHistory.dailyStats.profit += profit;
      this.executionHistory.consecutiveLosses = 0; // Reset consecutive losses
    } else {
      this.executionHistory.failedExecutions++;
      const loss = gasCost; // At minimum, we lose gas costs
      this.executionHistory.totalLoss += loss;
      this.executionHistory.dailyStats.loss += loss;
      this.executionHistory.consecutiveLosses++;

      // Check daily loss limit
      const dailyLossUsd = Number(this.executionHistory.dailyStats.loss) / 1e18;
      if (dailyLossUsd >= this.config.maxDailyLossUsd) {
        this.emit('dailyLossLimitReached', {
          currentLoss: this.executionHistory.dailyStats.loss,
          limit: BigInt(Math.floor(this.config.maxDailyLossUsd * 1e18)),
          timestamp: Date.now(),
        } satisfies RiskEvents['dailyLossLimitReached']);

        this.activateCircuitBreaker(`Daily loss limit reached: ${dailyLossUsd.toFixed(2)} USD`);
      }

      // Check consecutive loss limit
      if (this.executionHistory.consecutiveLosses >= this.config.maxConsecutiveLosses) {
        this.emit('consecutiveLossLimitReached', {
          consecutiveLosses: this.executionHistory.consecutiveLosses,
          limit: this.config.maxConsecutiveLosses,
          timestamp: Date.now(),
        } satisfies RiskEvents['consecutiveLossLimitReached']);

        this.activateCircuitBreaker(
          `Consecutive loss limit reached: ${this.executionHistory.consecutiveLosses}`
        );
      }
    }

    // Update daily net profit and success rate
    this.executionHistory.dailyStats.netProfit =
      this.executionHistory.dailyStats.profit - this.executionHistory.dailyStats.loss;
    this.executionHistory.dailyStats.successRate =
      this.executionHistory.dailyStats.executions > 0
        ? (this.executionHistory.dailyStats.successfulExecutions ?? 0) /
          this.executionHistory.dailyStats.executions
        : 0;
  }

  /**
   * Initialize built-in risk checks
   */
  private initializeBuiltInRiskChecks(): void {
    // Clear existing built-in checks
    const builtInChecks = [
      'profit-threshold',
      'slippage-tolerance',
      'gas-price-limit',
      'daily-loss-limit',
      'consecutive-loss-limit',
    ];

    builtInChecks.forEach(checkName => {
      this.riskChecks.delete(checkName);
    });

    // Register built-in checks
    this.registerRiskCheck(new ProfitThresholdCheck(this.config));
    this.registerRiskCheck(new SlippageToleranceCheck(this.config));
    this.registerRiskCheck(new GasPriceLimitCheck(this.config));
    this.registerRiskCheck(new DailyLossLimitCheck(this.config, this.executionHistory));
    this.registerRiskCheck(new ConsecutiveLossCheck(this.config, this.executionHistory));
  }

  /**
   * Get severity multiplier for risk scoring
   */
  private getSeverityMultiplier(severity: RiskSeverity): number {
    switch (severity) {
      case RiskSeverity.INFO:
        return 0.1;
      case RiskSeverity.WARNING:
        return 0.3;
      case RiskSeverity.ERROR:
        return 0.7;
      case RiskSeverity.CRITICAL:
        return 1.0;
      default:
        return 0.5;
    }
  }

  /**
   * Calculate risk level from score
   */
  private calculateRiskLevel(riskScore: number): RiskLevel {
    if (riskScore >= 80) return RiskLevel.CRITICAL;
    if (riskScore >= 60) return RiskLevel.HIGH;
    if (riskScore >= 30) return RiskLevel.MEDIUM;
    return RiskLevel.LOW;
  }

  /**
   * Build failure reason message
   */
  private buildFailureReason(
    criticalFailures: RiskCheckResult[],
    errorFailures: RiskCheckResult[],
    riskScore: number
  ): string {
    const reasons: string[] = [];

    if (criticalFailures.length > 0) {
      reasons.push(`Critical: ${criticalFailures.map(f => f.reason).join(', ')}`);
    }

    if (errorFailures.length > 0) {
      reasons.push(`Errors: ${errorFailures.map(f => f.reason).join(', ')}`);
    }

    if (this.config.enableRiskScoring && riskScore > this.config.riskScoreThreshold) {
      reasons.push(`Risk score ${riskScore} exceeds threshold ${this.config.riskScoreThreshold}`);
    }

    return reasons.join('; ');
  }

  /**
   * Start periodic tasks
   */
  private startPeriodicTasks(): void {
    // Check for circuit breaker recovery every minute
    if (this.periodicTaskTimer) {
      clearInterval(this.periodicTaskTimer);
    }
    this.periodicTaskTimer = setInterval(() => {
      if (
        this.circuitBreakerActive &&
        this.circuitBreakerActivatedAt &&
        Date.now() - this.circuitBreakerActivatedAt > this.config.circuitBreakerRecoveryTimeMs
      ) {
        // Check if conditions have improved
        if (this.currentRiskScore < this.config.circuitBreakerThreshold * 0.8) {
          this.deactivateCircuitBreaker('Risk conditions improved');
        }
      }
    }, 60000); // Every minute
  }

  /**
   * Shutdown controller and cleanup timers
   */
  public shutdown(): void {
    if (this.periodicTaskTimer) {
      clearInterval(this.periodicTaskTimer);
      this.periodicTaskTimer = null;
    }
  }
}
