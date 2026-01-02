/**
 * Stable Pool Calculator
 *
 * Mathematical calculations for stable pool rebalancing opportunities
 */

import { createComponentLogger } from '../utils/logger';
import { RebalancingOpportunity } from '../types/opportunity';

export interface StablePoolCalculationResult {
  optimalTradeAmount: bigint;
  expectedOutput: bigint;
  priceImpact: number;
  estimatedProfit: bigint;
  gasEstimate: bigint;
  profitAfterGas: bigint;
  profitable: boolean;
  newRatio: number;
  efficiencyScore: number;
}

export interface StablePoolCalculatorConfig {
  maxPriceImpact: number; // Maximum acceptable price impact (%)
  minProfitThreshold: bigint;
  gasPrice: bigint;
  targetEfficiencyScore: number;
}

/**
 * Calculator for stable pool rebalancing math
 */
export class StablePoolCalculator {
  private readonly logger = createComponentLogger('stable-pool-calculator');
  private readonly config: StablePoolCalculatorConfig;

  constructor(config: Partial<StablePoolCalculatorConfig> = {}) {
    this.config = {
      maxPriceImpact: config.maxPriceImpact ?? 0.5, // 0.5%
      minProfitThreshold: config.minProfitThreshold ?? BigInt(1e16), // 0.01 ETH
      gasPrice: config.gasPrice ?? 2000000000n, // 2 gwei
      targetEfficiencyScore: config.targetEfficiencyScore ?? 80,
      ...config,
    };
  }

  /**
   * Calculate optimal rebalancing trade
   */
  calculateRebalancing(opportunity: RebalancingOpportunity): StablePoolCalculationResult {
    try {
      // Calculate optimal trade amount using stable swap math
      const optimalTradeAmount = this.calculateOptimalTradeAmount(opportunity);

      // Calculate expected output using StableSwap invariant
      const expectedOutput = this.calculateStableSwapOutput(opportunity, optimalTradeAmount);

      // Calculate price impact
      const priceImpact = this.calculatePriceImpact(
        opportunity,
        optimalTradeAmount,
        expectedOutput
      );

      // Estimate gas costs
      const gasEstimate = this.estimateRebalancingGas();
      const gasCost = gasEstimate * this.config.gasPrice;

      // Calculate profit from rebalancing incentives
      const estimatedProfit = this.calculateRebalancingProfit(opportunity, optimalTradeAmount);

      const profitAfterGas = estimatedProfit > gasCost ? estimatedProfit - gasCost : 0n;

      // Calculate new pool ratio after trade
      const newRatio = this.calculateNewRatio(opportunity, optimalTradeAmount, expectedOutput);

      // Calculate efficiency score
      const efficiencyScore = this.calculateEfficiencyScore(
        opportunity.currentRatio[0] || 0.5,
        newRatio,
        opportunity.targetRatio[0] || 0.5
      );

      const profitable =
        profitAfterGas >= this.config.minProfitThreshold &&
        priceImpact <= this.config.maxPriceImpact &&
        efficiencyScore >= this.config.targetEfficiencyScore;

      return {
        optimalTradeAmount,
        expectedOutput,
        priceImpact,
        estimatedProfit,
        gasEstimate,
        profitAfterGas,
        profitable,
        newRatio,
        efficiencyScore,
      };
    } catch (error) {
      this.logger.error('Failed to calculate stable pool rebalancing', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      return this.getFailsafeResult();
    }
  }

  /**
   * Calculate optimal trade amount for rebalancing
   */
  private calculateOptimalTradeAmount(opportunity: RebalancingOpportunity): bigint {
    // Use the amountIn from the opportunity as base trade amount
    const baseAmount = BigInt(opportunity.amountIn.toString());

    // Calculate imbalance based on current vs target ratios
    const currentRatio = opportunity.currentRatio[0] || 0.5;
    const targetRatio = opportunity.targetRatio[0] || 0.5;
    const imbalancePercent = Math.abs(currentRatio - targetRatio);

    // Use a fraction of the base amount based on imbalance severity
    const tradeFraction = Math.min(0.5, imbalancePercent * 2); // Max 50% of base amount

    // Log calculation details for monitoring
    this.logger.debug('Calculating optimal trade amount', {
      opportunityId: opportunity.id,
      currentRatio,
      targetRatio,
      imbalancePercent,
      tradeFraction,
    });

    return BigInt(Math.floor(Number(baseAmount) * tradeFraction));
  }

  /**
   * Calculate StableSwap output using simplified curve math
   */
  private calculateStableSwapOutput(
    opportunity: RebalancingOpportunity,
    inputAmount: bigint
  ): bigint {
    // Simplified StableSwap calculation (actual implementation would use curve invariant)
    // For stable pairs, output is approximately 1:1 minus fees
    const fee = 20; // 0.02% fee in basis points
    const feeAmount = (inputAmount * BigInt(fee)) / 10000n;

    // Log calculation for monitoring
    this.logger.debug('Calculating stable swap output', {
      opportunityId: opportunity.id,
      inputAmount: inputAmount.toString(),
      poolType: opportunity.poolType,
      pool: opportunity.pool.toString(),
    });

    // For stable pools, output is approximately 1:1 minus fees
    const outputAmount = inputAmount - feeAmount;
    return outputAmount;
  }

  /**
   * Calculate price impact of the trade
   */
  private calculatePriceImpact(
    opportunity: RebalancingOpportunity,
    inputAmount: bigint,
    outputAmount: bigint
  ): number {
    // For stable pools, price impact should be minimal
    const expectedOutput = inputAmount; // 1:1 expected for stable pairs
    const actualSlippage = Number(expectedOutput - outputAmount) / Number(expectedOutput);

    // Log price impact calculation
    this.logger.debug('Calculating price impact', {
      opportunityId: opportunity.id,
      inputAmount: inputAmount.toString(),
      outputAmount: outputAmount.toString(),
      actualSlippage,
    });

    return actualSlippage * 100; // Convert to percentage
  }

  /**
   * Calculate profit from rebalancing incentives
   */
  private calculateRebalancingProfit(
    opportunity: RebalancingOpportunity,
    tradeAmount: bigint
  ): bigint {
    // Use the incentive rate from the opportunity
    const incentiveRate = opportunity.incentiveRate;
    const incentiveAmount = BigInt(Math.floor(Number(tradeAmount) * incentiveRate));

    // Log profit calculation for monitoring
    this.logger.debug('Calculating rebalancing profit', {
      opportunityId: opportunity.id,
      tradeAmount: tradeAmount.toString(),
      incentiveRate,
      incentiveAmount: incentiveAmount.toString(),
    });

    return incentiveAmount;
  }

  /**
   * Calculate new pool ratio after trade
   */
  private calculateNewRatio(
    opportunity: RebalancingOpportunity,
    inputAmount: bigint,
    outputAmount: bigint
  ): number {
    // Simplified calculation - in reality would need pool reserves
    const currentRatio = opportunity.currentRatio[0] || 0.5;
    const targetRatio = opportunity.targetRatio[0] || 0.5;

    // Estimate how much closer we get to target ratio
    const improvement = 0.1; // Assume 10% improvement toward target
    const newRatio = currentRatio + (targetRatio - currentRatio) * improvement;

    // Log calculation for monitoring
    this.logger.debug('Calculating new ratio', {
      opportunityId: opportunity.id,
      currentRatio,
      targetRatio,
      newRatio,
      inputAmount: inputAmount.toString(),
      outputAmount: outputAmount.toString(),
    });

    return newRatio;
  }

  /**
   * Calculate efficiency score (how much closer to target ratio)
   */
  private calculateEfficiencyScore(
    currentRatio: number,
    newRatio: number,
    targetRatio: number
  ): number {
    const currentDistance = Math.abs(currentRatio - targetRatio);
    const newDistance = Math.abs(newRatio - targetRatio);

    if (currentDistance === 0) return 100; // Already at target

    const improvement = (currentDistance - newDistance) / currentDistance;
    return Math.max(0, Math.min(100, improvement * 100));
  }

  /**
   * Estimate gas for rebalancing transaction
   */
  private estimateRebalancingGas(): bigint {
    // Stable pool rebalancing is typically simpler than arbitrage
    const baseSwapGas = 80000n; // Aerodrome stable swap
    const incentiveClaimGas = 50000n; // Claim rebalancing rewards

    return baseSwapGas + incentiveClaimGas;
  }

  /**
   * Get failsafe result for error cases
   */
  private getFailsafeResult(): StablePoolCalculationResult {
    return {
      optimalTradeAmount: 0n,
      expectedOutput: 0n,
      priceImpact: 100, // Maximum price impact
      estimatedProfit: 0n,
      gasEstimate: 200000n,
      profitAfterGas: 0n,
      profitable: false,
      newRatio: 0,
      efficiencyScore: 0,
    };
  }

  /**
   * Update calculator configuration
   */
  updateConfig(newConfig: Partial<StablePoolCalculatorConfig>): void {
    Object.assign(this.config, newConfig);
    this.logger.info('Stable pool calculator configuration updated', { config: this.config });
  }

  /**
   * Get current configuration
   */
  getConfig(): StablePoolCalculatorConfig {
    return { ...this.config };
  }
}
