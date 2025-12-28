/**
 * Liquidation Profit Calculator
 *
 * Calculates profitability of liquidation opportunities across
 * different lending protocols on Base.
 */

import { createComponentLogger } from '../utils/logger';
import { LiquidationOpportunity, LendingProtocol } from '../scanner/lending-monitor';

// Liquidation calculation result
export interface LiquidationCalculationResult {
  profitable: boolean;
  netProfit: bigint;
  grossProfit: bigint;
  totalCosts: bigint;
  gasEstimate: bigint;
  gasCost: bigint;
  flashLoanFee: bigint;
  slippageCost: bigint;
  liquidationBonus: bigint;
  collateralReceived: bigint;
  debtRepaid: bigint;
  executionRoute: LiquidationRoute;
  riskScore: number; // 0-100, higher is riskier
}

// Liquidation execution route
export interface LiquidationRoute {
  steps: LiquidationStep[];
  totalGasEstimate: bigint;
  estimatedExecutionTime: number; // milliseconds
  complexity: 'simple' | 'medium' | 'complex';
}

// Individual liquidation step
export interface LiquidationStep {
  type: 'flashloan' | 'liquidate' | 'swap' | 'repay';
  protocol?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: bigint;
  amountOut?: bigint;
  gasEstimate: bigint;
  description: string;
}

// Calculator options
export interface LiquidationCalculatorOptions {
  maxSlippage: number; // Maximum acceptable slippage (e.g., 0.01 = 1%)
  gasPrice: bigint; // Current gas price in wei
  flashLoanFeeRate: number; // Flash loan fee rate (e.g., 0.0009 = 0.09%)
  minProfitMargin: number; // Minimum profit margin required (e.g., 0.1 = 10%)
  riskToleranceScore: number; // Maximum acceptable risk score (0-100)
}

/**
 * Liquidation Profit Calculator
 */
export class LiquidationProfitCalculator {
  private readonly logger = createComponentLogger('liquidation-calculator');
  private readonly options: LiquidationCalculatorOptions;

  constructor(options: LiquidationCalculatorOptions) {
    this.options = options;

    this.logger.info('Liquidation calculator initialized', {
      maxSlippage: `${(options.maxSlippage * 100).toFixed(2)}%`,
      flashLoanFeeRate: `${(options.flashLoanFeeRate * 100).toFixed(3)}%`,
      minProfitMargin: `${(options.minProfitMargin * 100).toFixed(1)}%`,
    });
  }

  /**
   * Calculate liquidation profitability
   */
  async calculateLiquidationProfit(
    opportunity: LiquidationOpportunity
  ): Promise<LiquidationCalculationResult> {
    const operationId = `liquidation-calc-${opportunity.id}`;
    this.logger.startPerformanceTracking(operationId);

    try {
      this.logger.debug('Calculating liquidation profitability', {
        opportunityId: opportunity.id,
        protocol: opportunity.protocol,
        healthFactor: opportunity.healthFactor,
        collateralAmount: opportunity.collateralAmount.toString(),
        debtAmount: opportunity.debtAmount.toString(),
      });

      // Step 1: Calculate optimal liquidation amount
      this.logger.markPerformance(operationId, 'liquidation-amount-calc');
      const liquidationAmount = this.calculateOptimalLiquidationAmount(opportunity);

      // Step 2: Calculate collateral received and liquidation bonus
      this.logger.markPerformance(operationId, 'collateral-calc');
      const { collateralReceived, liquidationBonus } = await this.calculateCollateralReceived(
        opportunity,
        liquidationAmount
      );

      // Step 3: Estimate gas costs
      this.logger.markPerformance(operationId, 'gas-estimation');
      const executionRoute = await this.planExecutionRoute(opportunity, liquidationAmount);
      const gasCost = executionRoute.totalGasEstimate * this.options.gasPrice;

      // Step 4: Calculate flash loan fees
      this.logger.markPerformance(operationId, 'fee-calc');
      const flashLoanFee = BigInt(
        Math.floor(Number(liquidationAmount) * this.options.flashLoanFeeRate)
      );

      // Step 5: Estimate slippage costs
      this.logger.markPerformance(operationId, 'slippage-calc');
      const slippageCost = await this.estimateSlippageCost(
        opportunity.collateralAsset,
        opportunity.debtAsset,
        collateralReceived
      );

      // Step 6: Calculate net profit
      this.logger.markPerformance(operationId, 'profit-calc');
      const grossProfit = liquidationBonus;
      const totalCosts = gasCost + flashLoanFee + slippageCost;
      const netProfit = grossProfit - totalCosts;

      // Step 7: Calculate risk score
      this.logger.markPerformance(operationId, 'risk-assessment');
      const riskScore = this.calculateRiskScore(opportunity, executionRoute);

      const result: LiquidationCalculationResult = {
        profitable: netProfit > 0n && riskScore <= this.options.riskToleranceScore,
        netProfit,
        grossProfit,
        totalCosts,
        gasEstimate: executionRoute.totalGasEstimate,
        gasCost,
        flashLoanFee,
        slippageCost,
        liquidationBonus,
        collateralReceived,
        debtRepaid: liquidationAmount,
        executionRoute,
        riskScore,
      };

      this.logger.info('Liquidation calculation completed', {
        opportunityId: opportunity.id,
        profitable: result.profitable,
        netProfit: result.netProfit.toString(),
        riskScore: result.riskScore,
        gasEstimate: result.gasEstimate.toString(),
      });

      return result;
    } catch (error) {
      this.logger.logError(error as Error, {
        opportunityId: opportunity.id,
        operation: 'liquidation-calculation',
      });
      throw error;
    } finally {
      this.logger.endPerformanceTracking(operationId);
    }
  }

  /**
   * Calculate optimal liquidation amount
   */
  private calculateOptimalLiquidationAmount(opportunity: LiquidationOpportunity): bigint {
    // For most protocols, we can liquidate up to 50% of the debt when health factor < 1
    // This is a simplified calculation - in practice, each protocol has specific rules

    const maxLiquidationPercentage = 0.5; // 50%
    const optimalAmount = BigInt(
      Math.floor(Number(opportunity.debtAmount) * maxLiquidationPercentage)
    );

    // Don't exceed the maximum liquidation amount specified by the protocol
    return optimalAmount > opportunity.maxLiquidationAmount
      ? opportunity.maxLiquidationAmount
      : optimalAmount;
  }

  /**
   * Calculate collateral received from liquidation
   */
  private async calculateCollateralReceived(
    opportunity: LiquidationOpportunity,
    liquidationAmount: bigint
  ): Promise<{ collateralReceived: bigint; liquidationBonus: bigint }> {
    // Simplified calculation - in practice, this would query price oracles
    // and use protocol-specific liquidation formulas

    // Assume 1:1 USD value for simplification (would use real price feeds in production)
    const collateralValue = liquidationAmount;

    // Apply liquidation bonus (e.g., 5% bonus means liquidator gets 105% of debt value in collateral)
    const bonusMultiplier = 1 + opportunity.liquidationBonus;
    const collateralReceived = BigInt(Math.floor(Number(collateralValue) * bonusMultiplier));
    const liquidationBonus = collateralReceived - liquidationAmount;

    return { collateralReceived, liquidationBonus };
  }

  /**
   * Plan the execution route for liquidation
   */
  private async planExecutionRoute(
    opportunity: LiquidationOpportunity,
    liquidationAmount: bigint
  ): Promise<LiquidationRoute> {
    const steps: LiquidationStep[] = [];

    // Step 1: Flash loan to get debt token
    steps.push({
      type: 'flashloan',
      tokenOut: opportunity.debtAsset,
      amountOut: liquidationAmount,
      gasEstimate: 50000n, // Estimated gas for flash loan initiation
      description: `Flash loan ${liquidationAmount.toString()} ${opportunity.debtAsset}`,
    });

    // Step 2: Liquidate position
    steps.push({
      type: 'liquidate',
      protocol: opportunity.protocol,
      tokenIn: opportunity.debtAsset,
      tokenOut: opportunity.collateralAsset,
      amountIn: liquidationAmount,
      gasEstimate: this.getProtocolLiquidationGas(opportunity.protocol),
      description: `Liquidate position on ${opportunity.protocol}`,
    });

    // Step 3: Swap collateral to debt token (if different)
    if (opportunity.collateralAsset !== opportunity.debtAsset) {
      steps.push({
        type: 'swap',
        tokenIn: opportunity.collateralAsset,
        tokenOut: opportunity.debtAsset,
        gasEstimate: 150000n, // Estimated gas for DEX swap
        description: `Swap ${opportunity.collateralAsset} to ${opportunity.debtAsset}`,
      });
    }

    // Step 4: Repay flash loan
    steps.push({
      type: 'repay',
      tokenIn: opportunity.debtAsset,
      amountIn: liquidationAmount,
      gasEstimate: 30000n, // Estimated gas for flash loan repayment
      description: `Repay flash loan`,
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
   * Estimate slippage cost for swapping collateral
   */
  private async estimateSlippageCost(
    collateralAsset: string,
    debtAsset: string,
    amount: bigint
  ): Promise<bigint> {
    // Simplified slippage calculation
    // In practice, this would query DEX pools and calculate actual slippage

    if (collateralAsset === debtAsset) {
      return 0n; // No swap needed, no slippage
    }

    // Estimate slippage as percentage of swap amount
    const slippageAmount = BigInt(Math.floor(Number(amount) * this.options.maxSlippage));

    this.logger.debug('Estimated slippage cost', {
      collateralAsset,
      debtAsset,
      amount: amount.toString(),
      slippageCost: slippageAmount.toString(),
      slippagePercentage: `${(this.options.maxSlippage * 100).toFixed(2)}%`,
    });

    return slippageAmount;
  }

  /**
   * Calculate risk score for liquidation opportunity
   */
  private calculateRiskScore(opportunity: LiquidationOpportunity, route: LiquidationRoute): number {
    let riskScore = 0;

    // Health factor risk (lower health factor = higher risk of being front-run)
    if (opportunity.healthFactor < 1.01) {
      riskScore += 30; // Very high risk
    } else if (opportunity.healthFactor < 1.05) {
      riskScore += 20; // High risk
    } else if (opportunity.healthFactor < 1.1) {
      riskScore += 10; // Medium risk
    }

    // Execution complexity risk
    switch (route.complexity) {
      case 'complex':
        riskScore += 25;
        break;
      case 'medium':
        riskScore += 15;
        break;
      case 'simple':
        riskScore += 5;
        break;
    }

    // Gas cost risk (higher gas = higher risk of failure)
    const gasRisk = Math.min((Number(route.totalGasEstimate) / 1000000) * 10, 20); // Max 20 points
    riskScore += gasRisk;

    // Time sensitivity risk
    const timeToDeadline = opportunity.deadline - Date.now();
    if (timeToDeadline < 30000) {
      // Less than 30 seconds
      riskScore += 25;
    } else if (timeToDeadline < 60000) {
      // Less than 1 minute
      riskScore += 15;
    } else if (timeToDeadline < 300000) {
      // Less than 5 minutes
      riskScore += 5;
    }

    return Math.min(riskScore, 100); // Cap at 100
  }

  /**
   * Get protocol-specific liquidation gas estimate
   */
  private getProtocolLiquidationGas(protocol: LendingProtocol): bigint {
    switch (protocol) {
      case LendingProtocol.MOONWELL:
        return 200000n; // Moonwell liquidation gas estimate
      case LendingProtocol.AAVE_V3:
        return 250000n; // Aave V3 liquidation gas estimate
      case LendingProtocol.SEAMLESS:
        return 180000n; // Seamless liquidation gas estimate
      default:
        return 200000n; // Default estimate
    }
  }

  /**
   * Determine execution complexity
   */
  private determineComplexity(steps: LiquidationStep[]): 'simple' | 'medium' | 'complex' {
    if (steps.length <= 3) return 'simple';
    if (steps.length <= 5) return 'medium';
    return 'complex';
  }

  /**
   * Estimate execution time based on complexity
   */
  private estimateExecutionTime(complexity: 'simple' | 'medium' | 'complex'): number {
    switch (complexity) {
      case 'simple':
        return 15000; // 15 seconds
      case 'medium':
        return 30000; // 30 seconds
      case 'complex':
        return 60000; // 60 seconds
    }
  }

  /**
   * Update calculator options
   */
  updateOptions(newOptions: Partial<LiquidationCalculatorOptions>): void {
    Object.assign(this.options, newOptions);

    this.logger.info('Calculator options updated', {
      maxSlippage: `${(this.options.maxSlippage * 100).toFixed(2)}%`,
      gasPrice: this.options.gasPrice.toString(),
      flashLoanFeeRate: `${(this.options.flashLoanFeeRate * 100).toFixed(3)}%`,
    });
  }
}
