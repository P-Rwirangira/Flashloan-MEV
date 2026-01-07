/**
 * Gas Estimator
 *
 * Accurate gas cost prediction for MEV transactions on Base L2
 */

import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { BaseOpportunity, ArbitrageOpportunity } from '../types/execution';

export interface GasEstimate {
  gasLimit: bigint;
  baseFee: bigint;
  priorityFee: bigint;
  maxFeePerGas: bigint;
  totalCost: bigint;
  confidence: number; // 0-1 scale
}

export interface GasEstimatorConfig {
  provider: ethers.Provider;
  safetyBuffer: number; // Percentage buffer for gas estimates
  maxGasPrice: bigint;
  priorityFeeMultiplier: number;
}

/**
 * Gas Estimator for Base L2 transactions
 */
export class GasEstimator {
  private readonly logger = createComponentLogger('gas-estimator');
  private readonly config: GasEstimatorConfig;
  private gasHistory: Array<{ timestamp: number; gasPrice: bigint }> = [];

  constructor(config: GasEstimatorConfig) {
    this.config = {
      ...config,
      safetyBuffer: config.safetyBuffer ?? 0.2, // 20% buffer
      maxGasPrice: config.maxGasPrice ?? ethers.parseUnits('50', 'gwei'), // 50 gwei max
      priorityFeeMultiplier: config.priorityFeeMultiplier ?? 1.1, // 10% above base
    };
  }

  /**
   * Estimate gas for arbitrage opportunity
   */
  async estimateArbitrageGas(opportunity: ArbitrageOpportunity): Promise<GasEstimate> {
    try {
      // Base gas costs for different components
      const flashLoanOverhead = 150000n; // Flash loan setup and callback
      const swapGasPerHop = 120000n; // Uniswap V3 swap
      const aerodromeSwapGas = 80000n; // Aerodrome swap (more efficient)

      let totalGas = flashLoanOverhead;

      // Add gas for each swap in the route
      if (opportunity.route && opportunity.route.length > 0) {
        for (const swap of opportunity.route) {
          if (swap.protocol === 'uniswap-v3') {
            totalGas += swapGasPerHop;
          } else if (swap.protocol === 'aerodrome') {
            totalGas += aerodromeSwapGas;
          } else {
            totalGas += 100000n; // Generic DEX swap
          }
        }
      } else {
        // Fallback: assume 2 swaps for arbitrage
        totalGas += swapGasPerHop + aerodromeSwapGas;
      }

      // Add complexity overhead for multi-hop routes
      const routeLength = opportunity.route?.length || 2;
      if (routeLength > 2) {
        totalGas += BigInt(routeLength - 2) * 30000n;
      }

      // Apply safety buffer
      const bufferedGas =
        totalGas + BigInt(Math.floor(Number(totalGas) * this.config.safetyBuffer));

      // Get current gas pricing
      const gasPricing = await this.getCurrentGasPricing();

      return {
        gasLimit: bufferedGas,
        baseFee: gasPricing.baseFee,
        priorityFee: gasPricing.priorityFee,
        maxFeePerGas: gasPricing.maxFeePerGas,
        totalCost: bufferedGas * gasPricing.maxFeePerGas,
        confidence: 0.85, // High confidence for well-tested patterns
      };
    } catch (error) {
      this.logger.error('Failed to estimate arbitrage gas', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return conservative fallback
      return this.getConservativeFallback();
    }
  }

  /**
   * Estimate gas for generic opportunity
   */
  async estimateGas(opportunity: BaseOpportunity): Promise<GasEstimate> {
    switch (opportunity.type) {
      case 'arbitrage':
        return this.estimateArbitrageGas(opportunity as ArbitrageOpportunity);
      case 'liquidation':
        return this.estimateLiquidationGas(opportunity);
      case 'stable-pool-rebalancing':
        return this.estimateStablePoolGas(opportunity);
      default:
        return this.getConservativeFallback();
    }
  }

  /**
   * Estimate gas for liquidation
   */
  private async estimateLiquidationGas(opportunity: BaseOpportunity): Promise<GasEstimate> {
    // Liquidations are more complex - flash loan + liquidation call + swaps
    const baseGas = 400000n; // Conservative estimate for liquidation complexity
    const bufferedGas = baseGas + BigInt(Math.floor(Number(baseGas) * this.config.safetyBuffer));

    const gasPricing = await this.getCurrentGasPricing();

    // Log opportunity details for monitoring
    this.logger.debug('Estimating liquidation gas', {
      opportunityId: opportunity.id,
      baseGas: baseGas.toString(),
    });

    return {
      gasLimit: bufferedGas,
      baseFee: gasPricing.baseFee,
      priorityFee: gasPricing.priorityFee,
      maxFeePerGas: gasPricing.maxFeePerGas,
      totalCost: bufferedGas * gasPricing.maxFeePerGas,
      confidence: 0.7, // Lower confidence due to complexity
    };
  }

  /**
   * Estimate gas for stable pool rebalancing
   */
  private async estimateStablePoolGas(opportunity: BaseOpportunity): Promise<GasEstimate> {
    // Stable pool operations are typically simpler
    const baseGas = 200000n;
    const bufferedGas = baseGas + BigInt(Math.floor(Number(baseGas) * this.config.safetyBuffer));

    const gasPricing = await this.getCurrentGasPricing();

    // Log opportunity details for monitoring
    this.logger.debug('Estimating stable pool gas', {
      opportunityId: opportunity.id,
      baseGas: baseGas.toString(),
    });

    return {
      gasLimit: bufferedGas,
      baseFee: gasPricing.baseFee,
      priorityFee: gasPricing.priorityFee,
      maxFeePerGas: gasPricing.maxFeePerGas,
      totalCost: bufferedGas * gasPricing.maxFeePerGas,
      confidence: 0.9, // High confidence for simple operations
    };
  }

  /**
   * Get current gas pricing from network
   */
  private async getCurrentGasPricing(): Promise<{
    baseFee: bigint;
    priorityFee: bigint;
    maxFeePerGas: bigint;
  }> {
    try {
      const feeData = await this.config.provider.getFeeData();

      let baseFee = feeData.gasPrice || ethers.parseUnits('2', 'gwei'); // 2 gwei fallback for Base L2
      let priorityFee = feeData.maxPriorityFeePerGas || ethers.parseUnits('0.1', 'gwei'); // 0.1 gwei priority

      // For Base L2, gas prices are typically very low
      if (feeData.maxFeePerGas) {
        baseFee = feeData.maxFeePerGas;
      }

      // Apply priority fee multiplier
      priorityFee = BigInt(Math.floor(Number(priorityFee) * this.config.priorityFeeMultiplier));

      const maxFeePerGas = baseFee + priorityFee;

      // Cap at maximum allowed gas price
      const cappedMaxFee =
        maxFeePerGas > this.config.maxGasPrice ? this.config.maxGasPrice : maxFeePerGas;

      // Update gas history for trend analysis
      this.updateGasHistory(cappedMaxFee);

      return {
        baseFee,
        priorityFee,
        maxFeePerGas: cappedMaxFee,
      };
    } catch (error) {
      this.logger.warn('Failed to get current gas pricing, using fallback', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback pricing for Base L2
      const fallbackBaseFee = ethers.parseUnits('2', 'gwei');
      const fallbackPriorityFee = ethers.parseUnits('0.1', 'gwei');

      return {
        baseFee: fallbackBaseFee,
        priorityFee: fallbackPriorityFee,
        maxFeePerGas: fallbackBaseFee + fallbackPriorityFee,
      };
    }
  }

  /**
   * Get conservative fallback estimate
   */
  private getConservativeFallback(): GasEstimate {
    const conservativeGas = 500000n;
    const conservativeGasPrice = ethers.parseUnits('10', 'gwei'); // 10 gwei conservative

    return {
      gasLimit: conservativeGas,
      baseFee: conservativeGasPrice,
      priorityFee: ethers.parseUnits('1', 'gwei'),
      maxFeePerGas: conservativeGasPrice,
      totalCost: conservativeGas * conservativeGasPrice,
      confidence: 0.5, // Low confidence fallback
    };
  }

  /**
   * Update gas price history for trend analysis
   */
  private updateGasHistory(gasPrice: bigint): void {
    const now = Date.now();
    this.gasHistory.push({ timestamp: now, gasPrice });

    // Keep only last hour of data
    const oneHourAgo = now - 3600000;
    this.gasHistory = this.gasHistory.filter(entry => entry.timestamp > oneHourAgo);
  }

  /**
   * Get gas price trend (increasing, decreasing, stable)
   */
  getGasPriceTrend(): 'increasing' | 'decreasing' | 'stable' {
    if (this.gasHistory.length < 2) {
      return 'stable';
    }

    const recent = this.gasHistory.slice(-5); // Last 5 readings
    if (recent.length < 2) {
      return 'stable';
    }

    const first = recent[0]?.gasPrice || 0n;
    const last = recent[recent.length - 1]?.gasPrice || 0n;

    const change = Number(last - first) / Number(first);

    if (change > 0.1) return 'increasing'; // 10% increase
    if (change < -0.1) return 'decreasing'; // 10% decrease
    return 'stable';
  }

  /**
   * Get average gas price over time window
   */
  getAverageGasPrice(windowMs: number = 300000): bigint {
    // 5 minutes default
    const cutoff = Date.now() - windowMs;
    const relevantEntries = this.gasHistory.filter(entry => entry.timestamp > cutoff);

    if (relevantEntries.length === 0) {
      return ethers.parseUnits('2', 'gwei'); // Base L2 fallback
    }

    const sum = relevantEntries.reduce((acc, entry) => acc + entry.gasPrice, 0n);
    return sum / BigInt(relevantEntries.length);
  }
}
