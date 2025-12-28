/**
 * Gas Estimator
 *
 * Estimates gas costs for transactions with real-time pricing.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { ArbitrageOpportunity } from '../types/opportunity';
import { RpcConnectionManager } from '../rpc/connection-manager';

export interface GasEstimatorOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly updateIntervalMs?: number;
  readonly maxGasPriceGwei?: number;
  readonly fallbackGasPriceGwei?: number;
}

export interface GasEstimate {
  readonly gasLimit: bigint;
  readonly gasPrice: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly totalCost: bigint;
  readonly estimatedAt: number;
}

export interface GasPriceData {
  readonly gasPrice: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly baseFeePerGas: bigint;
  readonly timestamp: number;
}

export class GasEstimator extends EventEmitter {
  private readonly connectionManager: RpcConnectionManager;
  private readonly updateIntervalMs: number;
  private readonly maxGasPriceGwei: bigint;
  private readonly fallbackGasPriceGwei: bigint;

  // Gas price tracking
  private currentGasPrices?: GasPriceData;
  private priceUpdateInterval: ReturnType<typeof setInterval> | undefined;
  private isTracking = false;

  // Gas estimation cache
  private estimationCache: Map<string, GasEstimate> = new Map();
  private readonly cacheTimeoutMs = 30000; // 30 seconds

  constructor(options: GasEstimatorOptions) {
    super();

    this.connectionManager = options.connectionManager;
    this.updateIntervalMs = options.updateIntervalMs || 5000; // 5 seconds
    this.maxGasPriceGwei = ethers.parseUnits((options.maxGasPriceGwei || 100).toString(), 'gwei');
    this.fallbackGasPriceGwei = ethers.parseUnits(
      (options.fallbackGasPriceGwei || 2).toString(),
      'gwei'
    );
  }

  /**
   * Start gas price tracking
   */
  async startTracking(): Promise<void> {
    if (this.isTracking) {
      return;
    }

    try {
      // Initial gas price fetch
      await this.updateGasPrices();

      // Start periodic updates
      this.priceUpdateInterval = setInterval(async () => {
        try {
          await this.updateGasPrices();
        } catch (error) {
          this.emit('error', error);
        }
      }, this.updateIntervalMs);

      this.isTracking = true;
      this.emit('trackingStarted');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop gas price tracking
   */
  stopTracking(): void {
    if (!this.isTracking) {
      return;
    }

    if (this.priceUpdateInterval) {
      clearInterval(this.priceUpdateInterval);
      this.priceUpdateInterval = undefined;
    }

    this.isTracking = false;
    this.estimationCache.clear();
    this.emit('trackingStopped');
  }

  /**
   * Estimate gas for arbitrage opportunity
   */
  async estimateArbitrageGas(opportunity: ArbitrageOpportunity): Promise<GasEstimate> {
    const cacheKey = this.getCacheKey(opportunity);
    const cached = this.estimationCache.get(cacheKey);

    // Return cached estimate if still valid
    if (cached && Date.now() - cached.estimatedAt < this.cacheTimeoutMs) {
      return cached;
    }

    try {
      const gasLimit = await this.calculateArbitrageGasLimit(opportunity);
      const gasPrices = await this.getCurrentGasPrices();

      const estimate: GasEstimate = {
        gasLimit,
        gasPrice: gasPrices.gasPrice,
        maxFeePerGas: gasPrices.maxFeePerGas,
        maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
        totalCost: gasLimit * gasPrices.maxFeePerGas,
        estimatedAt: Date.now(),
      };

      // Cache the estimate
      this.estimationCache.set(cacheKey, estimate);

      return estimate;
    } catch (error) {
      // Return fallback estimate on error
      return this.getFallbackEstimate(opportunity);
    }
  }

  /**
   * Get current gas prices
   */
  async getCurrentGasPrices(): Promise<GasPriceData> {
    // Return cached prices if available and recent
    if (this.currentGasPrices && Date.now() - this.currentGasPrices.timestamp < 10000) {
      return this.currentGasPrices;
    }

    // Fetch fresh prices
    await this.updateGasPrices();
    return this.currentGasPrices || this.getFallbackGasPrices();
  }

  /**
   * Calculate gas limit for arbitrage transaction
   */
  private async calculateArbitrageGasLimit(opportunity: ArbitrageOpportunity): Promise<bigint> {
    // Base gas costs for different operations
    const baseGas = 21000n; // Base transaction cost
    const flashLoanGas = 50000n; // Flash loan initiation and callback
    const swapGasPerPool = 100000n; // Gas per swap operation
    const transferGas = 25000n; // Token transfer operations
    const validationGas = 30000n; // Profit validation and safety checks

    // Calculate gas based on route complexity
    const mainRouteSwaps = BigInt(opportunity.route.pools.length);
    const fallbackRouteSwaps = opportunity.fallbackRoutes.reduce(
      (total, route) => total + BigInt(route.pools.length),
      0n
    );

    // Main route gas
    const mainRouteGas = flashLoanGas + swapGasPerPool * mainRouteSwaps + transferGas * 2n;

    // Fallback route overhead (10% of fallback complexity)
    const fallbackOverhead = (swapGasPerPool * fallbackRouteSwaps) / 10n;

    // Total gas with safety buffer (20%)
    const totalGas = baseGas + mainRouteGas + fallbackOverhead + validationGas;
    const gasWithBuffer = (totalGas * 120n) / 100n;

    return gasWithBuffer;
  }

  /**
   * Update current gas prices from network
   */
  private async updateGasPrices(): Promise<void> {
    try {
      const provider = this.connectionManager.getProvider();
      const feeData = await provider.getFeeData();

      // Get base fee for EIP-1559 calculations
      const latestBlock = await provider.getBlock('latest');
      const baseFeePerGas = latestBlock?.baseFeePerGas || 0n;

      // Use legacy gas price if EIP-1559 data not available
      const gasPrice = feeData.gasPrice || this.fallbackGasPriceGwei;
      const maxFeePerGas = feeData.maxFeePerGas || gasPrice;
      const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei');

      // Apply maximum gas price limit
      const cappedMaxFeePerGas =
        maxFeePerGas > this.maxGasPriceGwei ? this.maxGasPriceGwei : maxFeePerGas;
      const cappedGasPrice = gasPrice > this.maxGasPriceGwei ? this.maxGasPriceGwei : gasPrice;

      this.currentGasPrices = {
        gasPrice: cappedGasPrice,
        maxFeePerGas: cappedMaxFeePerGas,
        maxPriorityFeePerGas,
        baseFeePerGas,
        timestamp: Date.now(),
      };

      this.emit('gasPricesUpdated', this.currentGasPrices);
    } catch (error) {
      // Use fallback prices on error
      this.currentGasPrices = this.getFallbackGasPrices();
      this.emit('gasPriceError', error);
    }
  }

  /**
   * Get fallback gas prices
   */
  private getFallbackGasPrices(): GasPriceData {
    return {
      gasPrice: this.fallbackGasPriceGwei,
      maxFeePerGas: this.fallbackGasPriceGwei,
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      baseFeePerGas: ethers.parseUnits('1', 'gwei'),
      timestamp: Date.now(),
    };
  }

  /**
   * Get fallback gas estimate
   */
  private getFallbackEstimate(opportunity: ArbitrageOpportunity): GasEstimate {
    const fallbackGasLimit = 400000n; // Conservative 400k gas
    const gasPrices = this.getFallbackGasPrices();

    // Log fallback usage for monitoring
    this.emit('fallbackEstimateUsed', {
      opportunityId: opportunity.id,
      opportunityType: opportunity.type,
      routeComplexity: opportunity.route.pools.length,
      fallbackGasLimit: fallbackGasLimit.toString(),
    });

    return {
      gasLimit: fallbackGasLimit,
      gasPrice: gasPrices.gasPrice,
      maxFeePerGas: gasPrices.maxFeePerGas,
      maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
      totalCost: fallbackGasLimit * gasPrices.maxFeePerGas,
      estimatedAt: Date.now(),
    };
  }

  /**
   * Generate cache key for opportunity
   */
  private getCacheKey(opportunity: ArbitrageOpportunity): string {
    const routeKey = opportunity.route.pools.join('-');
    const fallbackKey = opportunity.fallbackRoutes.map(r => r.pools.join('-')).join('|');
    return `${opportunity.type}-${routeKey}-${fallbackKey}`;
  }

  /**
   * Check if gas prices are acceptable
   */
  isGasPriceAcceptable(gasPrice: bigint): boolean {
    return gasPrice <= this.maxGasPriceGwei;
  }

  /**
   * Get gas price statistics
   */
  getGasPriceStats(): {
    current: GasPriceData | undefined;
    maxAllowed: bigint;
    fallback: bigint;
    isTracking: boolean;
    cacheSize: number;
  } {
    return {
      current: this.currentGasPrices,
      maxAllowed: this.maxGasPriceGwei,
      fallback: this.fallbackGasPriceGwei,
      isTracking: this.isTracking,
      cacheSize: this.estimationCache.size,
    };
  }

  /**
   * Clear estimation cache
   */
  clearCache(): void {
    this.estimationCache.clear();
    this.emit('cacheCleared');
  }
}
