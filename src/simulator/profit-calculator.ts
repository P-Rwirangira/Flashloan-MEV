/**
 * Profit Calculator
 *
 * Accurate profit estimation and validation for MEV opportunities
 */

import { createComponentLogger } from '../utils/logger';
import { ArbitrageOpportunity } from '../types/execution';

export interface ProfitBreakdown {
  grossProfit: bigint;
  flashLoanFee: bigint;
  gasCost: bigint;
  dexFees: bigint;
  slippageCost: bigint;
  bribeCost: bigint;
  netProfit: bigint;
  profitMarginBps: number;
}

export interface ProfitCalculationConfig {
  flashLoanFeeRate: number; // 0.0005 = 0.05%
  gasPrice: bigint;
  maxSlippageBps: number;
  bribeMultiplier: number; // Multiplier for competitive bribes
}

/**
 * Profit Calculator for MEV opportunities
 */
export class ProfitCalculator {
  private readonly logger = createComponentLogger('profit-calculator');
  private readonly config: ProfitCalculationConfig;

  constructor(config: Partial<ProfitCalculationConfig> = {}) {
    this.config = {
      flashLoanFeeRate: config.flashLoanFeeRate ?? 0.0005, // 0.05%
      gasPrice: config.gasPrice ?? 2000000000n, // 2 gwei for Base L2
      maxSlippageBps: config.maxSlippageBps ?? 250, // 2.5%
      bribeMultiplier: config.bribeMultiplier ?? 1.1, // 10% above base
      ...config,
    };
  }

  /**
   * Calculate detailed profit breakdown for arbitrage
   */
  calculateArbitrageProfit(
    opportunity: ArbitrageOpportunity,
    gasEstimate: bigint,
    currentGasPrice?: bigint
  ): ProfitBreakdown {
    const gasPrice = currentGasPrice || this.config.gasPrice;
    const tradeAmount = opportunity.amountIn;
    const expectedOutput = opportunity.expectedAmountOut || 0n;

    // Calculate costs
    const flashLoanFee = BigInt(Math.floor(Number(tradeAmount) * this.config.flashLoanFeeRate));
    const gasCost = gasEstimate * gasPrice;

    // Estimate DEX fees (simplified)
    const dexFees = this.estimateDexFees(opportunity);

    // Estimate slippage cost
    const slippageCost = this.estimateSlippageCost(tradeAmount, opportunity.spread);

    // Estimate bribe cost (for competitive execution)
    const bribeCost = BigInt(Math.floor(Number(gasCost) * (this.config.bribeMultiplier - 1)));

    // Calculate gross and net profit
    const grossProfit = expectedOutput > tradeAmount ? expectedOutput - tradeAmount : 0n;
    const totalCosts = flashLoanFee + gasCost + dexFees + slippageCost + bribeCost;
    const netProfit = grossProfit > totalCosts ? grossProfit - totalCosts : 0n;

    // Calculate profit margin in basis points
    const profitMarginBps = tradeAmount > 0n ? Number((netProfit * 10000n) / tradeAmount) : 0;

    return {
      grossProfit,
      flashLoanFee,
      gasCost,
      dexFees,
      slippageCost,
      bribeCost,
      netProfit,
      profitMarginBps,
    };
  }

  /**
   * Validate if opportunity meets minimum profit requirements
   */
  validateProfitability(
    breakdown: ProfitBreakdown,
    minProfitUsd: number,
    ethUsdPrice: number
  ): {
    profitable: boolean;
    reason?: string;
    profitUsd: number;
  } {
    const profitUsd = (Number(breakdown.netProfit) / 1e18) * ethUsdPrice;

    if (breakdown.netProfit <= 0n) {
      return {
        profitable: false,
        reason: 'Net profit is negative or zero',
        profitUsd,
      };
    }

    if (profitUsd < minProfitUsd) {
      return {
        profitable: false,
        reason: `Profit ${profitUsd.toFixed(2)} USD below minimum ${minProfitUsd} USD`,
        profitUsd,
      };
    }

    return {
      profitable: true,
      profitUsd,
    };
  }

  /**
   * Estimate optimal trade size for maximum profit
   */
  estimateOptimalTradeSize(baseAmount: bigint, spread: number, poolLiquidity: bigint): bigint {
    // Simplified optimal sizing based on spread and liquidity
    const spreadMultiplier = Math.min(2, Math.max(0.5, spread / 100));
    const liquidityFactor =
      poolLiquidity > 0n ? Math.min(1, Number(baseAmount) / Number(poolLiquidity)) : 0;

    const optimalMultiplier = spreadMultiplier * (1 - liquidityFactor * 0.5);
    const optimalAmount = BigInt(Math.floor(Number(baseAmount) * optimalMultiplier));

    // Ensure minimum viable size
    const minAmount = BigInt(1e16); // 0.01 ETH minimum
    return optimalAmount > minAmount ? optimalAmount : minAmount;
  }

  /**
   * Calculate break-even gas price
   */
  calculateBreakEvenGasPrice(grossProfit: bigint, gasEstimate: bigint, otherCosts: bigint): bigint {
    const availableForGas = grossProfit > otherCosts ? grossProfit - otherCosts : 0n;
    return gasEstimate > 0n ? availableForGas / gasEstimate : 0n;
  }

  /**
   * Estimate DEX fees for the route
   */
  private estimateDexFees(opportunity: ArbitrageOpportunity): bigint {
    if (!opportunity.route || opportunity.route.length === 0) {
      return 0n;
    }

    let totalFees = 0n;
    const tradeAmount = opportunity.amountIn;

    for (const swap of opportunity.route) {
      // Uniswap V3: 0.05%, 0.3%, or 1%
      if (swap.protocol === 'uniswap-v3') {
        const feeRate = swap.fee || 3000; // Default to 0.3%
        const fee = (tradeAmount * BigInt(feeRate)) / 1000000n;
        totalFees += fee;
      }
      // Aerodrome: ~0.2% for volatile, ~0.02% for stable
      else if (swap.protocol === 'aerodrome') {
        const feeRate = 2000; // 0.2% default
        const fee = (tradeAmount * BigInt(feeRate)) / 1000000n;
        totalFees += fee;
      }
    }

    return totalFees;
  }

  /**
   * Estimate slippage cost based on trade size and spread
   */
  private estimateSlippageCost(tradeAmount: bigint, spread: number): bigint {
    // Slippage increases with trade size and decreases with spread
    const baseSlippageBps = Math.min(this.config.maxSlippageBps, Math.max(10, 100 - spread * 10));
    return (tradeAmount * BigInt(baseSlippageBps)) / 10000n;
  }

  /**
   * Update calculation configuration
   */
  updateConfig(newConfig: Partial<ProfitCalculationConfig>): void {
    Object.assign(this.config, newConfig);
    this.logger.info('Profit calculator configuration updated', { config: this.config });
  }

  /**
   * Get current configuration
   */
  getConfig(): ProfitCalculationConfig {
    return { ...this.config };
  }
}
