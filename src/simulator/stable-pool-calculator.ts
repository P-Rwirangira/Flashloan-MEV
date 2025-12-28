/**
 * Stable Pool Rebalancing Calculator
 *
 * Calculates optimal rebalancing strategies for Aerodrome stable pools
 * and estimates profitability including incentives and costs.
 */

import { createComponentLogger } from '../utils/logger';
import { StablePoolOpportunity } from '../scanner/stable-pool-monitor';

// Rebalancing calculation result
export interface RebalancingCalculationResult {
  profitable: boolean;
  netProfit: bigint;
  grossProfit: bigint;
  totalCosts: bigint;
  gasEstimate: bigint;
  gasCost: bigint;
  slippageCost: bigint;
  incentiveReward: bigint;
  optimalSwapAmount: bigint;
  expectedOutputAmount: bigint;
  priceImpact: number; // Percentage
  executionRoute: RebalancingRoute;
  riskScore: number; // 0-100, higher is riskier
}

// Rebalancing execution route
export interface RebalancingRoute {
  steps: RebalancingStep[];
  totalGasEstimate: bigint;
  estimatedExecutionTime: number; // milliseconds
  complexity: 'simple' | 'medium' | 'complex';
}

// Individual rebalancing step
export interface RebalancingStep {
  type: 'swap' | 'claim_incentive' | 'add_liquidity' | 'remove_liquidity';
  poolAddress?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: bigint;
  amountOut?: bigint;
  gasEstimate: bigint;
  description: string;
}

// Calculator options
export interface StablePoolCalculatorOptions {
  maxSlippage: number; // Maximum acceptable slippage (e.g., 0.005 = 0.5%)
  gasPrice: bigint; // Current gas price in wei
  minProfitMargin: number; // Minimum profit margin required (e.g., 0.05 = 5%)
  maxPriceImpact: number; // Maximum acceptable price impact (e.g., 0.01 = 1%)
  incentiveMultiplier: number; // Multiplier for incentive calculations (e.g., 1.0 = 100%)
}

/**
 * Stable Pool Rebalancing Calculator
 */
export class StablePoolRebalancingCalculator {
  private readonly logger = createComponentLogger('stable-pool-calculator');
  private readonly options: StablePoolCalculatorOptions;

  constructor(options: StablePoolCalculatorOptions) {
    this.options = options;

    this.logger.info('Stable pool calculator initialized', {
      maxSlippage: `${(options.maxSlippage * 100).toFixed(2)}%`,
      maxPriceImpact: `${(options.maxPriceImpact * 100).toFixed(2)}%`,
      minProfitMargin: `${(options.minProfitMargin * 100).toFixed(1)}%`,
      incentiveMultiplier: `${(options.incentiveMultiplier * 100).toFixed(0)}%`,
    });
  }

  /**
   * Calculate rebalancing profitability
   */
  async calculateRebalancingProfit(
    opportunity: StablePoolOpportunity
  ): Promise<RebalancingCalculationResult> {
    const operationId = `rebalancing-calc-${opportunity.id}`;
    this.logger.startPerformanceTracking(operationId);

    try {
      this.logger.debug('Calculating rebalancing profitability', {
        opportunityId: opportunity.id,
        poolAddress: opportunity.poolAddress,
        imbalanceRatio: `${(opportunity.imbalanceRatio * 100).toFixed(2)}%`,
        direction: opportunity.rebalanceDirection,
        estimatedAmount: opportunity.optimalRebalanceAmount.toString(),
      });

      // Step 1: Calculate optimal swap amount and expected output
      this.logger.markPerformance(operationId, 'swap-calculation');
      const { optimalSwapAmount, expectedOutputAmount, priceImpact } =
        await this.calculateOptimalSwap(opportunity);

      // Step 2: Estimate gas costs
      this.logger.markPerformance(operationId, 'gas-estimation');
      const executionRoute = await this.planExecutionRoute(opportunity, optimalSwapAmount);
      const gasCost = executionRoute.totalGasEstimate * this.options.gasPrice;

      // Step 3: Calculate slippage costs
      this.logger.markPerformance(operationId, 'slippage-calculation');
      const slippageCost = await this.estimateSlippageCost(
        opportunity,
        optimalSwapAmount,
        expectedOutputAmount
      );

      // Step 4: Calculate incentive rewards
      this.logger.markPerformance(operationId, 'incentive-calculation');
      const incentiveReward = this.calculateIncentiveReward(opportunity, optimalSwapAmount);

      // Step 5: Calculate net profit
      this.logger.markPerformance(operationId, 'profit-calculation');
      const grossProfit = incentiveReward;
      const totalCosts = gasCost + slippageCost;
      const netProfit = grossProfit - totalCosts;

      // Step 6: Calculate risk score
      this.logger.markPerformance(operationId, 'risk-assessment');
      const riskScore = this.calculateRiskScore(opportunity, priceImpact, executionRoute);

      const result: RebalancingCalculationResult = {
        profitable: netProfit > 0n && this.meetsMinimumProfitMargin(netProfit, grossProfit),
        netProfit,
        grossProfit,
        totalCosts,
        gasEstimate: executionRoute.totalGasEstimate,
        gasCost,
        slippageCost,
        incentiveReward,
        optimalSwapAmount,
        expectedOutputAmount,
        priceImpact,
        executionRoute,
        riskScore,
      };

      this.logger.info('Rebalancing calculation completed', {
        opportunityId: opportunity.id,
        profitable: result.profitable,
        netProfit: result.netProfit.toString(),
        priceImpact: `${(result.priceImpact * 100).toFixed(3)}%`,
        riskScore: result.riskScore,
      });

      return result;
    } catch (error) {
      this.logger.logError(error as Error, {
        opportunityId: opportunity.id,
        operation: 'rebalancing-calculation',
      });
      throw error;
    } finally {
      this.logger.endPerformanceTracking(operationId);
    }
  }

  /**
   * Calculate optimal swap parameters
   */
  private async calculateOptimalSwap(opportunity: StablePoolOpportunity): Promise<{
    optimalSwapAmount: bigint;
    expectedOutputAmount: bigint;
    priceImpact: number;
  }> {
    // Use the opportunity's suggested amount as starting point
    let optimalSwapAmount = opportunity.optimalRebalanceAmount;

    // Calculate expected output using stable swap formula
    const expectedOutputAmount = this.calculateStableSwapOutput(opportunity, optimalSwapAmount);

    // Calculate price impact
    const priceImpact = this.calculatePriceImpact(
      opportunity,
      optimalSwapAmount,
      expectedOutputAmount
    );

    // If price impact is too high, reduce swap amount
    if (priceImpact > this.options.maxPriceImpact) {
      const adjustmentFactor = this.options.maxPriceImpact / priceImpact;
      optimalSwapAmount = BigInt(Math.floor(Number(optimalSwapAmount) * adjustmentFactor));

      // Recalculate with adjusted amount
      const adjustedOutput = this.calculateStableSwapOutput(opportunity, optimalSwapAmount);
      const adjustedPriceImpact = this.calculatePriceImpact(
        opportunity,
        optimalSwapAmount,
        adjustedOutput
      );

      return {
        optimalSwapAmount,
        expectedOutputAmount: adjustedOutput,
        priceImpact: adjustedPriceImpact,
      };
    }

    return {
      optimalSwapAmount,
      expectedOutputAmount,
      priceImpact,
    };
  }

  /**
   * Calculate stable swap output using Aerodrome stable formula
   */
  private calculateStableSwapOutput(opportunity: StablePoolOpportunity, amountIn: bigint): bigint {
    // Simplified stable swap calculation
    // Real implementation would use Aerodrome's exact stable swap math

    const { reserve0, reserve1 } = opportunity;
    const fee = 0.0005; // 0.05% fee for stable pools

    let reserveIn: bigint;
    let reserveOut: bigint;

    if (opportunity.rebalanceDirection === 'token0_to_token1') {
      reserveIn = reserve0;
      reserveOut = reserve1;
    } else {
      reserveIn = reserve1;
      reserveOut = reserve0;
    }

    // Apply fee
    const amountInWithFee = BigInt(Math.floor(Number(amountIn) * (1 - fee)));

    // Stable swap formula (simplified)
    // Real formula: x^3*y + y^3*x >= k
    // Approximation for small swaps: constant product with lower slippage
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn + amountInWithFee;

    return numerator / denominator;
  }

  /**
   * Calculate price impact
   */
  private calculatePriceImpact(
    opportunity: StablePoolOpportunity,
    amountIn: bigint,
    amountOut: bigint
  ): number {
    const { reserve0, reserve1 } = opportunity;

    let reserveIn: bigint;
    let reserveOut: bigint;

    if (opportunity.rebalanceDirection === 'token0_to_token1') {
      reserveIn = reserve0;
      reserveOut = reserve1;
    } else {
      reserveIn = reserve1;
      reserveOut = reserve0;
    }

    // Calculate current price (reserve ratio)
    const currentPrice = Number(reserveOut) / Number(reserveIn);

    // Calculate execution price
    const executionPrice = Number(amountOut) / Number(amountIn);

    // Price impact = (execution_price - current_price) / current_price
    return Math.abs((executionPrice - currentPrice) / currentPrice);
  }

  /**
   * Plan execution route for rebalancing
   */
  private async planExecutionRoute(
    opportunity: StablePoolOpportunity,
    swapAmount: bigint
  ): Promise<RebalancingRoute> {
    const steps: RebalancingStep[] = [];

    // Step 1: Swap to rebalance pool
    steps.push({
      type: 'swap',
      poolAddress: opportunity.poolAddress,
      tokenIn:
        opportunity.rebalanceDirection === 'token0_to_token1'
          ? opportunity.token0
          : opportunity.token1,
      tokenOut:
        opportunity.rebalanceDirection === 'token0_to_token1'
          ? opportunity.token1
          : opportunity.token0,
      amountIn: swapAmount,
      gasEstimate: 180000n, // Estimated gas for stable pool swap
      description: `Swap ${swapAmount.toString()} to rebalance pool`,
    });

    // Step 2: Claim incentive (if applicable)
    steps.push({
      type: 'claim_incentive',
      poolAddress: opportunity.poolAddress,
      gasEstimate: 120000n, // Estimated gas for incentive claim
      description: 'Claim rebalancing incentive reward',
    });

    const totalGasEstimate = steps.reduce((sum, step) => sum + step.gasEstimate, 0n);
    const complexity = this.determineComplexity(steps);

    return {
      steps,
      totalGasEstimate,
      estimatedExecutionTime: this.estimateExecutionTime(complexity),
      complexity,
    };
  }

  /**
   * Estimate slippage cost
   */
  private async estimateSlippageCost(
    opportunity: StablePoolOpportunity,
    swapAmount: bigint,
    expectedOutput: bigint
  ): Promise<bigint> {
    // Calculate slippage as percentage of expected output
    const slippageAmount = BigInt(Math.floor(Number(expectedOutput) * this.options.maxSlippage));

    this.logger.debug('Estimated slippage cost', {
      poolAddress: opportunity.poolAddress,
      swapAmount: swapAmount.toString(),
      expectedOutput: expectedOutput.toString(),
      slippageCost: slippageAmount.toString(),
      slippagePercentage: `${(this.options.maxSlippage * 100).toFixed(2)}%`,
    });

    return slippageAmount;
  }

  /**
   * Calculate incentive reward
   */
  private calculateIncentiveReward(opportunity: StablePoolOpportunity, swapAmount: bigint): bigint {
    // Use the estimated incentive from the opportunity, adjusted by multiplier
    const baseIncentive = opportunity.estimatedIncentive;
    const adjustedIncentive = BigInt(
      Math.floor(Number(baseIncentive) * this.options.incentiveMultiplier)
    );

    this.logger.debug('Calculated incentive reward', {
      poolAddress: opportunity.poolAddress,
      swapAmount: swapAmount.toString(),
      baseIncentive: baseIncentive.toString(),
      adjustedIncentive: adjustedIncentive.toString(),
      multiplier: this.options.incentiveMultiplier,
    });

    return adjustedIncentive;
  }

  /**
   * Calculate risk score for rebalancing opportunity
   */
  private calculateRiskScore(
    opportunity: StablePoolOpportunity,
    priceImpact: number,
    route: RebalancingRoute
  ): number {
    let riskScore = 0;

    // Price impact risk
    if (priceImpact > 0.005) {
      // > 0.5%
      riskScore += 20;
    } else if (priceImpact > 0.002) {
      // > 0.2%
      riskScore += 10;
    } else if (priceImpact > 0.001) {
      // > 0.1%
      riskScore += 5;
    }

    // Imbalance severity risk (higher imbalance = higher risk of competition)
    const imbalanceSeverity = Math.abs(opportunity.imbalanceRatio);
    if (imbalanceSeverity > 0.15) {
      // > 15%
      riskScore += 25;
    } else if (imbalanceSeverity > 0.1) {
      // > 10%
      riskScore += 15;
    } else if (imbalanceSeverity > 0.05) {
      // > 5%
      riskScore += 5;
    }

    // Execution complexity risk
    switch (route.complexity) {
      case 'complex':
        riskScore += 20;
        break;
      case 'medium':
        riskScore += 10;
        break;
      case 'simple':
        riskScore += 2;
        break;
    }

    // Time sensitivity risk
    const timeToDeadline = opportunity.deadline - Date.now();
    if (timeToDeadline < 60000) {
      // Less than 1 minute
      riskScore += 20;
    } else if (timeToDeadline < 180000) {
      // Less than 3 minutes
      riskScore += 10;
    } else if (timeToDeadline < 300000) {
      // Less than 5 minutes
      riskScore += 5;
    }

    // Pool priority adjustment
    switch (opportunity.priority) {
      case 'high':
        riskScore -= 5; // Lower risk for high priority pools
        break;
      case 'low':
        riskScore += 5; // Higher risk for low priority pools
        break;
    }

    return Math.max(0, Math.min(riskScore, 100)); // Clamp between 0-100
  }

  /**
   * Check if profit meets minimum margin requirement
   */
  private meetsMinimumProfitMargin(netProfit: bigint, grossProfit: bigint): boolean {
    if (grossProfit === 0n) return false;

    const profitMargin = Number(netProfit) / Number(grossProfit);
    return profitMargin >= this.options.minProfitMargin;
  }

  /**
   * Determine execution complexity
   */
  private determineComplexity(steps: RebalancingStep[]): 'simple' | 'medium' | 'complex' {
    if (steps.length <= 2) return 'simple';
    if (steps.length <= 4) return 'medium';
    return 'complex';
  }

  /**
   * Estimate execution time based on complexity
   */
  private estimateExecutionTime(complexity: 'simple' | 'medium' | 'complex'): number {
    switch (complexity) {
      case 'simple':
        return 10000; // 10 seconds
      case 'medium':
        return 20000; // 20 seconds
      case 'complex':
        return 40000; // 40 seconds
    }
  }

  /**
   * Update calculator options
   */
  updateOptions(newOptions: Partial<StablePoolCalculatorOptions>): void {
    Object.assign(this.options, newOptions);

    this.logger.info('Calculator options updated', {
      maxSlippage: `${(this.options.maxSlippage * 100).toFixed(2)}%`,
      gasPrice: this.options.gasPrice.toString(),
      maxPriceImpact: `${(this.options.maxPriceImpact * 100).toFixed(2)}%`,
      minProfitMargin: `${(this.options.minProfitMargin * 100).toFixed(1)}%`,
    });
  }
}
