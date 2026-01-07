/**
 * Liquidation Calculator
 *
 * Specialized calculator for liquidation profitability analysis
 */

import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { LiquidationOpportunity } from '../types/opportunity';

export interface LiquidationCalculationResult {
  maxLiquidationAmount: bigint;
  expectedCollateralSeized: bigint;
  liquidationBonus: bigint;
  estimatedProfit: bigint;
  gasEstimate: bigint;
  profitAfterGas: bigint;
  profitable: boolean;
  riskScore: number;
}

export interface LiquidationCalculatorConfig {
  provider: ethers.Provider;
  maxGasPrice: bigint;
  minProfitThreshold: bigint;
  maxRiskScore: number;
}

/**
 * Calculator for liquidation profitability analysis
 */
export class LiquidationCalculator {
  private readonly logger = createComponentLogger('liquidation-calculator');
  private readonly config: LiquidationCalculatorConfig;

  constructor(config: LiquidationCalculatorConfig) {
    this.config = config;
  }

  /**
   * Calculate liquidation profitability
   */
  async calculateLiquidation(
    opportunity: LiquidationOpportunity
  ): Promise<LiquidationCalculationResult> {
    try {
      // Calculate maximum liquidation amount (typically 50% of debt)
      const maxLiquidationAmount = BigInt(opportunity.maxLiquidationAmount.toString()) / 2n;

      // Calculate collateral to be seized
      const collateralValue = BigInt(opportunity.collateralToSeize.toString());

      // Apply liquidation bonus (typically 5-10%)
      const liquidationBonusRate = opportunity.liquidationBonus * 100; // Convert to basis points
      const liquidationBonus = (collateralValue * BigInt(liquidationBonusRate)) / 10000n;
      const expectedCollateralSeized = collateralValue + liquidationBonus;

      // Estimate gas costs
      const gasEstimate = await this.estimateLiquidationGas(opportunity);
      const gasCost = gasEstimate * this.config.maxGasPrice;

      // Calculate profit
      const grossProfit = liquidationBonus;
      const estimatedProfit = grossProfit > gasCost ? grossProfit - gasCost : 0n;

      // Calculate risk score
      const riskScore = this.calculateRiskScore(opportunity);

      const profitable =
        estimatedProfit >= this.config.minProfitThreshold && riskScore <= this.config.maxRiskScore;

      return {
        maxLiquidationAmount,
        expectedCollateralSeized,
        liquidationBonus,
        estimatedProfit: grossProfit,
        gasEstimate,
        profitAfterGas: estimatedProfit,
        profitable,
        riskScore,
      };
    } catch (error) {
      this.logger.error('Failed to calculate liquidation profitability', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      return this.getFailsafeResult();
    }
  }

  /**
   * Estimate gas for liquidation transaction
   */
  private async estimateLiquidationGas(opportunity: LiquidationOpportunity): Promise<bigint> {
    // Base liquidation gas costs
    const baseLiquidationGas = 200000n; // Liquidation call
    const flashLoanGas = 150000n; // Flash loan overhead
    const swapGas = 120000n; // Swap collateral to repay debt

    // Log opportunity for monitoring
    this.logger.debug('Estimating liquidation gas', {
      opportunityId: opportunity.id,
      collateralAsset: opportunity.collateralAsset,
      debtAsset: opportunity.debtAsset,
    });

    return baseLiquidationGas + flashLoanGas + swapGas;
  }

  /**
   * Calculate risk score for liquidation (0-100, lower is better)
   */
  private calculateRiskScore(opportunity: LiquidationOpportunity): number {
    let riskScore = 0;

    // Health factor risk (closer to 1.0 is riskier due to price volatility)
    const healthFactorRisk = Math.max(0, 50 - (opportunity.healthFactor - 1.0) * 100);
    riskScore += healthFactorRisk;

    // Debt size risk (larger positions are riskier)
    const debtSizeRisk = Math.min(30, Number(opportunity.maxLiquidationAmount) / 1e20); // Scale by 100 ETH
    riskScore += debtSizeRisk;

    // Asset volatility risk
    const volatilityRisk = this.getAssetVolatilityRisk(opportunity.collateralAsset.toString());
    riskScore += volatilityRisk;

    return Math.min(100, riskScore);
  }

  /**
   * Get asset volatility risk score
   */
  private getAssetVolatilityRisk(asset: string): number {
    const volatilityScores: Record<string, number> = {
      USDC: 5, // Low volatility
      DAI: 5, // Low volatility
      WETH: 15, // Medium volatility
      WBTC: 20, // Higher volatility
    };

    return volatilityScores[asset] || 25; // Default high volatility
  }

  /**
   * Get failsafe result for error cases
   */
  private getFailsafeResult(): LiquidationCalculationResult {
    return {
      maxLiquidationAmount: 0n,
      expectedCollateralSeized: 0n,
      liquidationBonus: 0n,
      estimatedProfit: 0n,
      gasEstimate: 500000n, // Conservative gas estimate
      profitAfterGas: 0n,
      profitable: false,
      riskScore: 100, // Maximum risk
    };
  }

  /**
   * Update calculator configuration
   */
  updateConfig(newConfig: Partial<LiquidationCalculatorConfig>): void {
    Object.assign(this.config, newConfig);
    this.logger.info('Liquidation calculator configuration updated', { config: this.config });
  }
}
