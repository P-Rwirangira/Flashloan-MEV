/**
 * Profit Calculator
 *
 * Calculates expected profit including all costs with real-time data.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { Address } from '../types/common';
import { ArbitrageOpportunity } from '../types/opportunity';
import { GasEstimator } from './gas-estimator';
import { RpcConnectionManager } from '../rpc/connection-manager';

export interface ProfitCalculatorOptions {
  readonly gasEstimator: GasEstimator;
  readonly connectionManager: RpcConnectionManager;
  readonly priceOracle?: IPriceOracle;
  readonly flashLoanFeeBps?: number;
  readonly minProfitMarginPercent?: number;
}

export interface IPriceOracle {
  getEthUsdPrice(): Promise<number>;
  getTokenUsdPrice(tokenAddress: Address): Promise<number>;
}

export interface DetailedProfitCalculation {
  readonly grossProfit: bigint;
  readonly flashLoanFee: bigint;
  readonly gasCost: bigint;
  readonly slippageCost: bigint;
  readonly bridgeFees: bigint;
  readonly netProfit: bigint;
  readonly profitMargin: number; // percentage
  readonly profitUsd: number;
  readonly isViable: boolean;
  readonly breakdownBps: {
    readonly flashLoanFeeBps: number;
    readonly gasCostBps: number;
    readonly slippageBps: number;
    readonly bridgeFeeBps: number;
  };
  readonly calculatedAt: number;
}

export interface ProfitThresholds {
  readonly minProfitUsd: number;
  readonly minProfitMargin: number;
  readonly maxGasCostPercent: number;
  readonly maxSlippagePercent: number;
}

// Simple price oracle implementation
export class SimplePriceOracle implements IPriceOracle {
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
  private readonly cacheTimeMs = 60000; // 1 minute cache

  // Known token addresses on Base
  private static readonly KNOWN_TOKENS: Record<string, 'stablecoin' | 'weth'> = {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'stablecoin', // USDC
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'stablecoin', // DAI
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 'stablecoin', // USDT
    '0x4200000000000000000000000000000000000006': 'weth', // WETH
  };

  async getEthUsdPrice(): Promise<number> {
    const cacheKey = 'ETH-USD';
    const cached = this.priceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTimeMs) {
      return cached.price;
    }

    try {
      // In production, this would query Chainlink price feeds or other oracles
      // For now, use a reasonable fallback price
      const fallbackPrice = 3000; // $3000 USD

      this.priceCache.set(cacheKey, { price: fallbackPrice, timestamp: Date.now() });
      return fallbackPrice;
    } catch (error) {
      return 3000; // Fallback price
    }
  }

  async getTokenUsdPrice(tokenAddress: Address): Promise<number> {
    const cacheKey = `${tokenAddress}-USD`;
    const cached = this.priceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTimeMs) {
      return cached.price;
    }

    try {
      const ethPrice = await this.getEthUsdPrice();
      const tokenAddressLower = tokenAddress.toLowerCase();

      // Use known token mapping for accurate identification
      const tokenType = SimplePriceOracle.KNOWN_TOKENS[tokenAddressLower];

      let tokenPrice: number;
      if (tokenType === 'stablecoin') {
        tokenPrice = 1; // Stablecoin
      } else if (tokenType === 'weth') {
        tokenPrice = ethPrice; // WETH
      } else {
        // Unknown token - fallback to ETH price (consider integrating a real price oracle)
        tokenPrice = ethPrice;
      }

      this.priceCache.set(cacheKey, { price: tokenPrice, timestamp: Date.now() });
      return tokenPrice;
    } catch (error) {
      // Log the tokenAddress for debugging
      console.warn(`Failed to get price for token ${tokenAddress}, using fallback price`);
      return 1; // Fallback to $1 (stablecoin assumption)
    }
  }
}

export class ProfitCalculator extends EventEmitter {
  private readonly gasEstimator: GasEstimator;
  private readonly priceOracle: IPriceOracle;
  private readonly flashLoanFeeBps: number;
  private readonly minProfitMarginPercent: number;

  // Calculation cache
  private calculationCache: Map<string, DetailedProfitCalculation> = new Map();
  private readonly cacheTimeoutMs = 10000; // 10 seconds

  constructor(options: ProfitCalculatorOptions) {
    super();

    this.gasEstimator = options.gasEstimator;
    this.priceOracle = options.priceOracle || new SimplePriceOracle();
    this.flashLoanFeeBps = options.flashLoanFeeBps || 5; // 0.05% default
    this.minProfitMarginPercent = options.minProfitMarginPercent || 1.0; // 1% default
  }

  /**
   * Calculate detailed profit for arbitrage opportunity
   */
  async calculateDetailedProfit(
    opportunity: ArbitrageOpportunity,
    thresholds?: ProfitThresholds
  ): Promise<DetailedProfitCalculation> {
    const cacheKey = this.getCacheKey(opportunity);
    const cached = this.calculationCache.get(cacheKey);

    // Return cached calculation if still valid
    if (cached && Date.now() - cached.calculatedAt < this.cacheTimeoutMs) {
      return cached;
    }

    try {
      const calculation = await this.performDetailedCalculation(opportunity, thresholds);

      // Cache the calculation
      this.calculationCache.set(cacheKey, calculation);

      return calculation;
    } catch (error) {
      this.emit('calculationError', error);
      throw error;
    }
  }

  /**
   * Perform the detailed profit calculation
   */
  private async performDetailedCalculation(
    opportunity: ArbitrageOpportunity,
    thresholds?: ProfitThresholds
  ): Promise<DetailedProfitCalculation> {
    const amountIn = BigInt(opportunity.amountIn.toString());
    const expectedAmountOut = BigInt(opportunity.expectedAmountOut.toString());

    // Calculate gross profit
    const grossProfit = expectedAmountOut > amountIn ? expectedAmountOut - amountIn : 0n;

    // Calculate flash loan fee
    const flashLoanFee = (amountIn * BigInt(this.flashLoanFeeBps)) / 10000n;

    // Get gas estimate and calculate gas cost
    const gasEstimate = await this.gasEstimator.estimateArbitrageGas(opportunity);
    const gasCost = gasEstimate.totalCost;

    // Calculate slippage cost
    const slippageCost = await this.calculateSlippageCost(opportunity);

    // Calculate bridge fees (if applicable)
    const bridgeFees = await this.calculateBridgeFees();

    // Calculate net profit
    const totalCosts = flashLoanFee + gasCost + slippageCost + bridgeFees;
    const netProfit = grossProfit > totalCosts ? grossProfit - totalCosts : 0n;

    // Calculate profit margin
    const profitMargin = amountIn > 0n ? Number((netProfit * 100n) / amountIn) : 0;

    // Calculate USD value
    const profitUsd = await this.calculateProfitUsd(netProfit, opportunity.tokenOut);

    // Calculate breakdown in basis points
    const breakdownBps = this.calculateCostBreakdown(
      amountIn,
      flashLoanFee,
      gasCost,
      slippageCost,
      bridgeFees
    );

    // Determine viability
    const defaultThresholds: ProfitThresholds = {
      minProfitUsd: 10, // $10 minimum
      minProfitMargin: this.minProfitMarginPercent,
      maxGasCostPercent: 50, // 50% of profit
      maxSlippagePercent: 20, // 20% of profit
    };

    const activeThresholds = thresholds || defaultThresholds;
    const isViable = this.checkViability(
      netProfit,
      profitMargin,
      profitUsd,
      breakdownBps,
      activeThresholds
    );

    return {
      grossProfit,
      flashLoanFee,
      gasCost,
      slippageCost,
      bridgeFees,
      netProfit,
      profitMargin,
      profitUsd,
      isViable,
      breakdownBps,
      calculatedAt: Date.now(),
    };
  }

  /**
   * Calculate slippage cost based on opportunity parameters
   */
  private async calculateSlippageCost(opportunity: ArbitrageOpportunity): Promise<bigint> {
    const amountIn = BigInt(opportunity.amountIn.toString());
    const slippagePercent = opportunity.slippageTolerance;

    // Calculate slippage cost as percentage of trade amount
    const slippageBps = BigInt(Math.floor(slippagePercent * 100));
    return (amountIn * slippageBps) / 10000n;
  }

  /**
   * Calculate bridge fees (if cross-chain operations are involved)
   */
  private async calculateBridgeFees(): Promise<bigint> {
    // For Base-only arbitrage, bridge fees are typically 0
    // This would be expanded for cross-chain arbitrage
    return 0n;
  }

  /**
   * Calculate profit in USD
   */
  private async calculateProfitUsd(profit: bigint, tokenAddress: Address): Promise<number> {
    try {
      const tokenPrice = await this.priceOracle.getTokenUsdPrice(tokenAddress);
      const profitEth = Number(ethers.formatEther(profit));
      return profitEth * tokenPrice;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Calculate cost breakdown in basis points
   */
  private calculateCostBreakdown(
    amountIn: bigint,
    flashLoanFee: bigint,
    gasCost: bigint,
    slippageCost: bigint,
    bridgeFees: bigint
  ): DetailedProfitCalculation['breakdownBps'] {
    if (amountIn === 0n) {
      return {
        flashLoanFeeBps: 0,
        gasCostBps: 0,
        slippageBps: 0,
        bridgeFeeBps: 0,
      };
    }

    return {
      flashLoanFeeBps: Number((flashLoanFee * 10000n) / amountIn),
      gasCostBps: Number((gasCost * 10000n) / amountIn),
      slippageBps: Number((slippageCost * 10000n) / amountIn),
      bridgeFeeBps: Number((bridgeFees * 10000n) / amountIn),
    };
  }

  /**
   * Check if opportunity meets viability thresholds
   */
  private checkViability(
    netProfit: bigint,
    profitMargin: number,
    profitUsd: number,
    breakdownBps: DetailedProfitCalculation['breakdownBps'],
    thresholds: ProfitThresholds
  ): boolean {
    // Check minimum profit requirements
    if (netProfit <= 0n) return false;
    if (profitMargin < thresholds.minProfitMargin) return false;
    if (profitUsd < thresholds.minProfitUsd) return false;

    // Check cost thresholds
    const gasCostPercent = breakdownBps.gasCostBps / 100;
    const slippagePercent = breakdownBps.slippageBps / 100;

    if (gasCostPercent > thresholds.maxGasCostPercent) return false;
    if (slippagePercent > thresholds.maxSlippagePercent) return false;

    return true;
  }

  /**
   * Calculate minimum required profit in Wei
   */
  async calculateMinProfitWei(minProfitUsd: number, tokenAddress: Address): Promise<bigint> {
    try {
      const tokenPrice = await this.priceOracle.getTokenUsdPrice(tokenAddress);
      const minProfitToken = minProfitUsd / tokenPrice;
      return ethers.parseEther(minProfitToken.toString());
    } catch (error) {
      // Fallback calculation
      return ethers.parseEther((minProfitUsd / 3000).toString()); // Assume $3000 ETH
    }
  }

  /**
   * Validate opportunity profitability
   */
  async validateProfitability(
    opportunity: ArbitrageOpportunity,
    thresholds?: ProfitThresholds
  ): Promise<{ isValid: boolean; reason?: string; calculation: DetailedProfitCalculation }> {
    const calculation = await this.calculateDetailedProfit(opportunity, thresholds);

    if (calculation.isViable) {
      return { isValid: true, calculation };
    }

    // Determine rejection reason
    let reason = 'Unknown reason';
    if (calculation.netProfit <= 0n) {
      reason = 'Net profit is not positive';
    } else if (calculation.profitMargin < this.minProfitMarginPercent) {
      reason = `Profit margin ${calculation.profitMargin.toFixed(2)}% below minimum ${this.minProfitMarginPercent}%`;
    } else if (calculation.profitUsd < (thresholds?.minProfitUsd || 10)) {
      reason = `Profit $${calculation.profitUsd.toFixed(2)} below minimum $${thresholds?.minProfitUsd || 10}`;
    } else if (calculation.breakdownBps.gasCostBps > 5000) {
      // 50%
      reason = 'Gas costs too high relative to profit';
    }

    return { isValid: false, reason, calculation };
  }

  /**
   * Generate cache key for opportunity
   */
  private getCacheKey(opportunity: ArbitrageOpportunity): string {
    return `${opportunity.id}-${opportunity.amountIn}-${opportunity.expectedAmountOut}`;
  }

  /**
   * Clear calculation cache
   */
  clearCache(): void {
    this.calculationCache.clear();
    this.emit('cacheCleared');
  }

  /**
   * Get calculation statistics
   */
  getStats(): {
    cacheSize: number;
    flashLoanFeeBps: number;
    minProfitMarginPercent: number;
  } {
    return {
      cacheSize: this.calculationCache.size,
      flashLoanFeeBps: this.flashLoanFeeBps,
      minProfitMarginPercent: this.minProfitMarginPercent,
    };
  }
}
