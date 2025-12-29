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
import { ChainlinkPriceOracleImpl } from '../oracles/chainlink-oracle';
import { AdvancedGasOptimizer } from './advanced-gas-optimizer';

export interface ProfitCalculatorOptions {
  readonly gasEstimator: GasEstimator;
  readonly connectionManager: RpcConnectionManager;
  readonly priceOracle?: ChainlinkPriceOracleImpl;
  readonly gasOptimizer?: AdvancedGasOptimizer;
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
  readonly competitionCost: bigint; // Cost to outbid competitors
  readonly netProfit: bigint;
  readonly profitMargin: number; // percentage
  readonly profitUsd: number;
  readonly isViable: boolean;
  readonly breakdownBps: {
    readonly flashLoanFeeBps: number;
    readonly gasCostBps: number;
    readonly slippageBps: number;
    readonly bridgeFeeBps: number;
    readonly competitionBps: number;
  };
  readonly calculatedAt: number;
  readonly confidence: number; // 0-1 scale based on data quality
}

export interface ProfitThresholds {
  readonly minProfitUsd: number;
  readonly minProfitMargin: number;
  readonly maxGasCostPercent: number;
  readonly maxSlippagePercent: number;
}

// Enhanced price oracle implementation with real Chainlink feeds
export class EnhancedPriceOracle implements IPriceOracle {
  private readonly chainlinkOracle: ChainlinkPriceOracleImpl;
  private priceCache: Map<string, { price: number; timestamp: number; confidence: number }> =
    new Map();
  private readonly cacheTimeMs = 30000; // 30 seconds cache for enhanced responsiveness

  constructor(connectionManager: RpcConnectionManager) {
    this.chainlinkOracle = new ChainlinkPriceOracleImpl(connectionManager);
  }

  async getEthUsdPrice(): Promise<number> {
    const cacheKey = 'ETH-USD';
    const cached = this.priceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTimeMs && cached.confidence > 0.8) {
      return cached.price;
    }

    try {
      // Use Chainlink oracle for real price
      const price = await this.chainlinkOracle.getEthUsdPrice();

      this.priceCache.set(cacheKey, {
        price,
        timestamp: Date.now(),
        confidence: 0.95, // High confidence for Chainlink
      });

      return price;
    } catch (error) {
      // Fallback to cached price if available
      if (cached) {
        return cached.price;
      }

      // Ultimate fallback - but this should rarely happen
      console.warn('Failed to get ETH price from Chainlink, using emergency fallback');
      return 3000; // Emergency fallback
    }
  }

  async getTokenUsdPrice(tokenAddress: Address): Promise<number> {
    const cacheKey = `${tokenAddress}-USD`;
    const cached = this.priceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTimeMs && cached.confidence > 0.8) {
      return cached.price;
    }

    try {
      // Use Chainlink oracle for real price
      const price = await this.chainlinkOracle.getTokenUsdPrice(tokenAddress);

      this.priceCache.set(cacheKey, {
        price,
        timestamp: Date.now(),
        confidence: 0.9, // High confidence for Chainlink
      });

      return price;
    } catch (error) {
      // Fallback to cached price if available
      if (cached) {
        return cached.price;
      }

      // Derive from ETH price as fallback
      return this.deriveTokenPriceFromEth(tokenAddress);
    }
  }

  private async deriveTokenPriceFromEth(tokenAddress: Address): Promise<number> {
    const ethPrice = await this.getEthUsdPrice();
    const tokenAddressLower = tokenAddress.toLowerCase();

    // Enhanced token type detection
    if (
      tokenAddressLower.includes('usdc') ||
      tokenAddressLower.includes('dai') ||
      tokenAddressLower.includes('usdt') ||
      tokenAddressLower === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    ) {
      // USDC on Base
      return 1.0;
    }

    if (
      tokenAddressLower.includes('weth') ||
      tokenAddressLower === '0x4200000000000000000000000000000000000006'
    ) {
      // WETH on Base
      return ethPrice;
    }

    // For unknown tokens, use a more conservative approach
    return ethPrice * 0.1; // Assume 10% of ETH value for unknown tokens
  }
}

export class ProfitCalculator extends EventEmitter {
  private readonly gasEstimator: GasEstimator;
  private readonly priceOracle: IPriceOracle;
  private readonly gasOptimizer: AdvancedGasOptimizer | undefined;
  private readonly flashLoanFeeBps: number;
  private readonly minProfitMarginPercent: number;

  // Calculation cache
  private calculationCache: Map<string, DetailedProfitCalculation> = new Map();
  private readonly cacheTimeoutMs = 5000; // 5 seconds for faster response

  constructor(options: ProfitCalculatorOptions) {
    super();

    this.gasEstimator = options.gasEstimator;
    this.priceOracle = options.priceOracle || new EnhancedPriceOracle(options.connectionManager);
    this.gasOptimizer = options.gasOptimizer;
    this.flashLoanFeeBps = options.flashLoanFeeBps || 5; // 0.05% default
    this.minProfitMarginPercent = options.minProfitMarginPercent || 0.5; // Reduced to 0.5% for more opportunities
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
   * Perform the detailed profit calculation with enhanced accuracy
   */
  private async performDetailedCalculation(
    opportunity: ArbitrageOpportunity,
    thresholds?: ProfitThresholds
  ): Promise<DetailedProfitCalculation> {
    const amountIn = BigInt(opportunity.amountIn.toString());
    const expectedAmountOut = BigInt(opportunity.expectedAmountOut.toString());

    // Calculate gross profit
    const grossProfit = expectedAmountOut > amountIn ? expectedAmountOut - amountIn : 0n;

    // Calculate flash loan fee with dynamic optimization
    const flashLoanFee = await this.calculateOptimalFlashLoanFee(amountIn, opportunity);

    // Get enhanced gas estimate
    let gasCost: bigint;
    if (this.gasOptimizer) {
      try {
        const gasOptimization = await this.gasOptimizer.optimizeGas(opportunity, {
          urgency: 0.7, // Medium-high urgency for arbitrage
          targetBlocks: 1,
          maxGasPrice: ethers.parseUnits('50', 'gwei'), // 50 gwei max
          profitMargin: grossProfit,
        });
        gasCost = gasOptimization.totalCost;
      } catch (error) {
        // Fallback to basic gas estimation
        const gasEstimate = await this.gasEstimator.estimateArbitrageGas(opportunity);
        gasCost = gasEstimate.totalCost;
      }
    } else {
      const gasEstimate = await this.gasEstimator.estimateArbitrageGas(opportunity);
      gasCost = gasEstimate.totalCost;
    }

    // Calculate enhanced slippage cost
    const slippageCost = await this.calculateEnhancedSlippageCost(opportunity);

    // Calculate bridge fees (if applicable)
    const bridgeFees = await this.calculateBridgeFees();

    // Calculate competition cost (new feature)
    const competitionCost = await this.calculateCompetitionCost(opportunity, grossProfit);

    // Calculate net profit
    const totalCosts = flashLoanFee + gasCost + slippageCost + bridgeFees + competitionCost;
    const netProfit = grossProfit > totalCosts ? grossProfit - totalCosts : 0n;

    // Calculate profit margin
    const profitMargin = amountIn > 0n ? Number((netProfit * 10000n) / amountIn) / 100 : 0;

    // Calculate USD value with enhanced accuracy
    const { profitUsd, confidence } = await this.calculateProfitUsdWithConfidence(
      netProfit,
      opportunity.tokenOut
    );

    // Calculate enhanced breakdown in basis points
    const breakdownBps = this.calculateEnhancedCostBreakdown(
      amountIn,
      flashLoanFee,
      gasCost,
      slippageCost,
      bridgeFees,
      competitionCost
    );

    // Determine viability with enhanced criteria
    const defaultThresholds: ProfitThresholds = {
      minProfitUsd: 5, // Reduced from $10 to $5 for more opportunities
      minProfitMargin: this.minProfitMarginPercent,
      maxGasCostPercent: 60, // Increased from 50% to 60%
      maxSlippagePercent: 25, // Increased from 20% to 25%
    };

    const activeThresholds = thresholds || defaultThresholds;
    const isViable = this.checkEnhancedViability(
      netProfit,
      profitMargin,
      profitUsd,
      breakdownBps,
      activeThresholds,
      confidence
    );

    return {
      grossProfit,
      flashLoanFee,
      gasCost,
      slippageCost,
      bridgeFees,
      competitionCost,
      netProfit,
      profitMargin,
      profitUsd,
      isViable,
      breakdownBps,
      calculatedAt: Date.now(),
      confidence,
    };
  }

  /**
   * Calculate optimal flash loan fee by comparing sources
   */
  private async calculateOptimalFlashLoanFee(
    amountIn: bigint,
    opportunity: ArbitrageOpportunity
  ): Promise<bigint> {
    // Uniswap V3 flash loan fee (0.05%)
    const uniV3Fee = (amountIn * BigInt(this.flashLoanFeeBps)) / 10000n;

    // Balancer flash loan (0% fee but higher gas) - use opportunity for gas estimation
    const balancerFee = 0n;
    const balancerGasOverhead =
      BigInt(opportunity.route.pools.length) * 25000n * ethers.parseUnits('2', 'gwei');

    // Choose the cheaper option
    return uniV3Fee < balancerGasOverhead ? uniV3Fee : balancerFee;
  }

  /**
   * Calculate enhanced slippage cost with better pool analysis
   */
  private async calculateEnhancedSlippageCost(opportunity: ArbitrageOpportunity): Promise<bigint> {
    const amountIn = BigInt(opportunity.amountIn.toString());

    // Use more sophisticated slippage calculation based on route complexity
    let totalSlippage = 0n;

    // Main route slippage
    const mainRouteSlippage = this.calculateRouteSlippage(opportunity.route, amountIn);
    totalSlippage += mainRouteSlippage;

    // Add buffer for fallback routes (they might be used)
    const fallbackBuffer =
      opportunity.fallbackRoutes.length > 0
        ? mainRouteSlippage / BigInt(opportunity.fallbackRoutes.length * 2)
        : 0n;

    totalSlippage += fallbackBuffer;

    return totalSlippage;
  }

  /**
   * Calculate route-specific slippage
   */
  private calculateRouteSlippage(route: any, amountIn: bigint): bigint {
    // More sophisticated slippage calculation per pool
    const baseSlippageBps = 30n; // 0.3% base slippage
    const complexityMultiplier = BigInt(route.pools.length);

    return (amountIn * baseSlippageBps * complexityMultiplier) / 10000n;
  }

  /**
   * Calculate competition cost (bribe needed to outbid competitors)
   */
  private async calculateCompetitionCost(
    opportunity: ArbitrageOpportunity,
    grossProfit: bigint
  ): Promise<bigint> {
    // Estimate competition based on opportunity attractiveness
    const profitMargin = grossProfit > 0n ? Number(grossProfit) / Number(opportunity.amountIn) : 0;

    if (profitMargin > 0.05) {
      // >5% profit margin attracts competition
      // Assume we need to bid 10-20% of gross profit to win
      const competitionFactor = Math.min(0.2, profitMargin * 2); // Cap at 20%
      return (grossProfit * BigInt(Math.floor(competitionFactor * 100))) / 100n;
    }

    return 0n; // No significant competition for low-margin opportunities
  }

  /**
   * Calculate profit in USD with confidence metrics
   */
  private async calculateProfitUsdWithConfidence(
    profit: bigint,
    tokenAddress: Address
  ): Promise<{ profitUsd: number; confidence: number }> {
    try {
      const tokenPrice = await this.priceOracle.getTokenUsdPrice(tokenAddress);
      const profitEth = Number(ethers.formatEther(profit));
      const profitUsd = profitEth * tokenPrice;

      // Confidence based on price oracle type
      const confidence = this.priceOracle instanceof EnhancedPriceOracle ? 0.9 : 0.6;

      return { profitUsd, confidence };
    } catch (error) {
      return { profitUsd: 0, confidence: 0.1 };
    }
  }

  /**
   * Calculate enhanced cost breakdown
   */
  private calculateEnhancedCostBreakdown(
    amountIn: bigint,
    flashLoanFee: bigint,
    gasCost: bigint,
    slippageCost: bigint,
    bridgeFees: bigint,
    competitionCost: bigint
  ): DetailedProfitCalculation['breakdownBps'] {
    if (amountIn === 0n) {
      return {
        flashLoanFeeBps: 0,
        gasCostBps: 0,
        slippageBps: 0,
        bridgeFeeBps: 0,
        competitionBps: 0,
      };
    }

    return {
      flashLoanFeeBps: Number((flashLoanFee * 10000n) / amountIn),
      gasCostBps: Number((gasCost * 10000n) / amountIn),
      slippageBps: Number((slippageCost * 10000n) / amountIn),
      bridgeFeeBps: Number((bridgeFees * 10000n) / amountIn),
      competitionBps: Number((competitionCost * 10000n) / amountIn),
    };
  }

  /**
   * Enhanced viability check with confidence weighting
   */
  private checkEnhancedViability(
    netProfit: bigint,
    profitMargin: number,
    profitUsd: number,
    breakdownBps: DetailedProfitCalculation['breakdownBps'],
    thresholds: ProfitThresholds,
    confidence: number
  ): boolean {
    // Check minimum profit requirements
    if (netProfit <= 0n) return false;
    if (profitMargin < thresholds.minProfitMargin) return false;

    // Adjust USD threshold based on confidence
    const adjustedMinProfitUsd = thresholds.minProfitUsd / confidence;
    if (profitUsd < adjustedMinProfitUsd) return false;

    // Check cost thresholds with some flexibility for high-confidence opportunities
    const gasCostPercent = breakdownBps.gasCostBps / 100;
    const slippagePercent = breakdownBps.slippageBps / 100;
    const competitionPercent = breakdownBps.competitionBps / 100;

    // Allow higher costs for high-confidence, high-profit opportunities
    const flexibilityMultiplier = confidence > 0.8 && profitMargin > 0.02 ? 1.2 : 1.0;

    if (gasCostPercent > thresholds.maxGasCostPercent * flexibilityMultiplier) return false;
    if (slippagePercent > thresholds.maxSlippagePercent * flexibilityMultiplier) return false;
    if (competitionPercent > 30) return false; // Max 30% for competition

    return true;
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
   * Calculate profit in USD (legacy method - used as fallback)
   */
  private async calculateProfitUsd(profit: bigint, tokenAddress: Address): Promise<number> {
    const { profitUsd } = await this.calculateProfitUsdWithConfidence(profit, tokenAddress);
    return profitUsd;
  }

  /**
   * Calculate cost breakdown (legacy method - used for backward compatibility)
   */
  private calculateCostBreakdown(
    amountIn: bigint,
    flashLoanFee: bigint,
    gasCost: bigint,
    slippageCost: bigint,
    bridgeFees: bigint
  ): Omit<DetailedProfitCalculation['breakdownBps'], 'competitionBps'> {
    const enhanced = this.calculateEnhancedCostBreakdown(
      amountIn,
      flashLoanFee,
      gasCost,
      slippageCost,
      bridgeFees,
      0n
    );

    // Return without competition cost for legacy compatibility
    return {
      flashLoanFeeBps: enhanced.flashLoanFeeBps,
      gasCostBps: enhanced.gasCostBps,
      slippageBps: enhanced.slippageBps,
      bridgeFeeBps: enhanced.bridgeFeeBps,
    };
  }

  /**
   * Check viability (legacy method - used as fallback validation)
   */
  private checkViability(
    netProfit: bigint,
    profitMargin: number,
    profitUsd: number,
    breakdownBps: Omit<DetailedProfitCalculation['breakdownBps'], 'competitionBps'>,
    thresholds: ProfitThresholds
  ): boolean {
    // Use enhanced viability check with default confidence
    const enhancedBreakdown = {
      ...breakdownBps,
      competitionBps: 0, // No competition cost in legacy mode
    };

    return this.checkEnhancedViability(
      netProfit,
      profitMargin,
      profitUsd,
      enhancedBreakdown,
      thresholds,
      0.8
    );
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

  /**
   * Validate opportunity profitability using legacy methods as fallback
   */
  async validateProfitabilityLegacy(
    opportunity: ArbitrageOpportunity,
    thresholds?: ProfitThresholds
  ): Promise<{ isValid: boolean; reason?: string; calculation: DetailedProfitCalculation }> {
    try {
      // Try enhanced calculation first
      const calculation = await this.calculateDetailedProfit(opportunity, thresholds);
      return { isValid: calculation.isViable, calculation };
    } catch (error) {
      // Fallback to legacy methods for compatibility
      const amountIn = BigInt(opportunity.amountIn.toString());
      const expectedAmountOut = BigInt(opportunity.expectedAmountOut.toString());
      const grossProfit = expectedAmountOut > amountIn ? expectedAmountOut - amountIn : 0n;

      const flashLoanFee = (amountIn * BigInt(this.flashLoanFeeBps)) / 10000n;
      const gasEstimate = await this.gasEstimator.estimateArbitrageGas(opportunity);
      const gasCost = gasEstimate.totalCost;
      const slippageCost = await this.calculateEnhancedSlippageCost(opportunity);
      const bridgeFees = await this.calculateBridgeFees();

      const netProfit = grossProfit - (flashLoanFee + gasCost + slippageCost + bridgeFees);
      const profitMargin = amountIn > 0n ? Number((netProfit * 100n) / amountIn) : 0;
      const profitUsd = await this.calculateProfitUsd(netProfit, opportunity.tokenOut);

      const breakdownBps = this.calculateCostBreakdown(
        amountIn,
        flashLoanFee,
        gasCost,
        slippageCost,
        bridgeFees
      );

      const defaultThresholds: ProfitThresholds = {
        minProfitUsd: 10,
        minProfitMargin: this.minProfitMarginPercent,
        maxGasCostPercent: 50,
        maxSlippagePercent: 20,
      };

      const activeThresholds = thresholds || defaultThresholds;
      const isValid = this.checkViability(
        netProfit,
        profitMargin,
        profitUsd,
        breakdownBps,
        activeThresholds
      );

      const legacyCalculation: DetailedProfitCalculation = {
        grossProfit,
        flashLoanFee,
        gasCost,
        slippageCost,
        bridgeFees,
        competitionCost: 0n,
        netProfit,
        profitMargin,
        profitUsd,
        isViable: isValid,
        breakdownBps: { ...breakdownBps, competitionBps: 0 },
        calculatedAt: Date.now(),
        confidence: 0.7, // Lower confidence for legacy calculation
      };

      return {
        isValid,
        ...(isValid ? {} : { reason: 'Legacy calculation failed viability check' }),
        calculation: legacyCalculation,
      };
    }
  }
}
