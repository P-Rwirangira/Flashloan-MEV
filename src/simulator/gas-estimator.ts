/**
 * Gas Estimator
 *
 * Estimates gas costs for MEV transactions with real-time gas price data.
 */

import { ethers, BigNumberish } from 'ethers';
import { EventEmitter } from 'events';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { ArbitrageOpportunity } from '../types/opportunity';
import { createComponentLogger } from '../utils/logger';

export interface GasEstimatorOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly baseFeeMultiplier?: number;
  readonly priorityFeeGwei?: number;
  readonly maxGasPriceGwei?: number;
  readonly gasLimitBuffer?: number;
  readonly updateIntervalMs?: number;
}

export interface GasEstimate {
  readonly gasLimit: bigint;
  readonly gasPrice: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly totalCost: bigint;
  readonly confidence: number; // 0-1 scale
  readonly estimatedAt: number;
}

export interface GasPriceData {
  readonly baseFee: bigint;
  readonly priorityFee: bigint;
  readonly gasPrice: bigint;
  readonly blockNumber: number;
  readonly timestamp: number;
}

// Gas limits for different operation types
const GAS_LIMITS = {
  SIMPLE_SWAP: 150000n,
  FLASH_LOAN: 300000n,
  ARBITRAGE: 400000n,
  LIQUIDATION: 500000n,
  COMPLEX_ROUTE: 600000n,
} as const;

export class GasEstimator extends EventEmitter {
  private readonly logger = createComponentLogger('gas-estimator');
  private readonly connectionManager: RpcConnectionManager;
  private readonly baseFeeMultiplier: number;
  private readonly priorityFeeGwei: bigint;
  private readonly maxGasPriceGwei: bigint;
  private readonly gasLimitBuffer: number;
  private readonly updateIntervalMs: number;

  // Gas price tracking
  private currentGasData?: GasPriceData;
  private gasPriceHistory: GasPriceData[] = [];
  private updateInterval: ReturnType<typeof setInterval> | undefined;
  private isTracking = false;

  constructor(options: GasEstimatorOptions) {
    super();

    this.connectionManager = options.connectionManager;
    this.baseFeeMultiplier = options.baseFeeMultiplier ?? 1.2;
    this.priorityFeeGwei = ethers.parseUnits((options.priorityFeeGwei ?? 2).toString(), 'gwei');
    this.maxGasPriceGwei = ethers.parseUnits((options.maxGasPriceGwei ?? 100).toString(), 'gwei');
    this.gasLimitBuffer = options.gasLimitBuffer ?? 1.1; // 10% buffer
    this.updateIntervalMs = options.updateIntervalMs ?? 10000; // 10s default
  }

  /**
   * Start tracking gas prices
   */
  async startTracking(): Promise<void> {
    if (this.isTracking) {
      this.logger.warn('Gas price tracking is already active');
      return;
    }

    this.logger.info('Starting gas price tracking', {
      updateInterval: this.updateIntervalMs,
      baseFeeMultiplier: this.baseFeeMultiplier,
      priorityFeeGwei: ethers.formatUnits(this.priorityFeeGwei, 'gwei'),
    });

    try {
      // Initial gas price fetch
      await this.updateGasPrices();

      // Start periodic updates
      this.updateInterval = setInterval(async () => {
        try {
          await this.updateGasPrices();
        } catch (error) {
          this.logger.logError(error as Error, { operation: 'periodic-gas-update' });
          this.emit('gasUpdateError', error);
        }
      }, this.updateIntervalMs);

      this.isTracking = true;
      this.emit('trackingStarted');
    } catch (error) {
      this.logger.logError(error as Error, { operation: 'start-tracking' });
      throw error;
    }
  }

  /**
   * Stop tracking gas prices
   */
  stopTracking(): void {
    if (!this.isTracking) {
      this.logger.warn('Gas price tracking is not active');
      return;
    }

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }

    this.isTracking = false;
    this.emit('trackingStopped');
    this.logger.info('Gas price tracking stopped');
  }

  /**
   * Estimate gas for arbitrage opportunity
   */
  async estimateArbitrageGas(opportunity: ArbitrageOpportunity): Promise<GasEstimate> {
    try {
      // Determine base gas limit based on route complexity
      const routeComplexity = opportunity.route.pools.length + opportunity.fallbackRoutes.length;
      let baseGasLimit: bigint;

      if (routeComplexity > 3) {
        baseGasLimit = 600000n; // Complex route
      } else {
        baseGasLimit = 400000n; // Standard arbitrage
      }

      // Add buffer for safety
      const gasLimit = BigInt(Math.floor(Number(baseGasLimit) * this.gasLimitBuffer));

      // Get current gas prices
      const gasData = await this.getCurrentGasData();

      // Calculate gas prices with EIP-1559
      const maxPriorityFeePerGas = this.priorityFeeGwei;
      const maxFeePerGas =
        (gasData.baseFee * BigInt(Math.floor(this.baseFeeMultiplier * 100))) / 100n +
        maxPriorityFeePerGas;

      // Cap at maximum gas price
      const cappedMaxFeePerGas =
        maxFeePerGas > this.maxGasPriceGwei ? this.maxGasPriceGwei : maxFeePerGas;
      const gasPrice = cappedMaxFeePerGas;

      // Calculate total cost
      const totalCost = gasLimit * gasPrice;

      // Calculate confidence based on gas price stability
      const confidence = this.calculateGasPriceConfidence();

      return {
        gasLimit,
        gasPrice,
        maxFeePerGas: cappedMaxFeePerGas,
        maxPriorityFeePerGas,
        totalCost,
        confidence,
        estimatedAt: Date.now(),
      };
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'estimate-arbitrage-gas',
        opportunityId: opportunity.id,
      });
      throw error;
    }
  }

  /**
   * Estimate gas for liquidation
   */
  async estimateLiquidationGas(
    liquidationAmount: BigNumberish,
    collateralTokens: number = 1
  ): Promise<GasEstimate> {
    try {
      // Base gas for liquidation
      let baseGasLimit = GAS_LIMITS.LIQUIDATION;

      // Adjust for multiple collateral tokens
      if (collateralTokens > 1) {
        baseGasLimit += BigInt(collateralTokens - 1) * 50000n; // 50k per additional token
      }

      // Add buffer
      const gasLimit = BigInt(Math.floor(Number(baseGasLimit) * this.gasLimitBuffer));

      // Get gas prices
      const gasData = await this.getCurrentGasData();
      const maxPriorityFeePerGas = this.priorityFeeGwei;
      const maxFeePerGas =
        (gasData.baseFee * BigInt(Math.floor(this.baseFeeMultiplier * 100))) / 100n +
        maxPriorityFeePerGas;
      const cappedMaxFeePerGas =
        maxFeePerGas > this.maxGasPriceGwei ? this.maxGasPriceGwei : maxFeePerGas;

      const totalCost = gasLimit * cappedMaxFeePerGas;
      const confidence = this.calculateGasPriceConfidence();

      return {
        gasLimit,
        gasPrice: cappedMaxFeePerGas,
        maxFeePerGas: cappedMaxFeePerGas,
        maxPriorityFeePerGas,
        totalCost,
        confidence,
        estimatedAt: Date.now(),
      };
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'estimate-liquidation-gas',
        liquidationAmount: liquidationAmount.toString(),
        collateralTokens,
      });
      throw error;
    }
  }

  /**
   * Get current gas data
   */
  async getCurrentGasData(): Promise<GasPriceData> {
    if (this.currentGasData && Date.now() - this.currentGasData.timestamp < 30000) {
      return this.currentGasData;
    }

    await this.updateGasPrices();

    if (!this.currentGasData) {
      throw new Error('Failed to fetch current gas data');
    }

    return this.currentGasData;
  }

  /**
   * Get gas price statistics
   */
  getGasPriceStats(): {
    current: GasPriceData | undefined;
    average: bigint;
    median: bigint;
    min: bigint;
    max: bigint;
    samples: number;
  } {
    if (this.gasPriceHistory.length === 0) {
      return {
        current: this.currentGasData,
        average: 0n,
        median: 0n,
        min: 0n,
        max: 0n,
        samples: 0,
      };
    }

    const gasPrices = this.gasPriceHistory
      .map(data => data.gasPrice)
      .sort((a, b) => (a < b ? -1 : 1));

    if (gasPrices.length === 0) {
      return {
        current: this.currentGasData,
        average: 0n,
        median: 0n,
        min: 0n,
        max: 0n,
        samples: 0,
      };
    }

    const sum = gasPrices.reduce((acc, price) => acc + price, 0n);
    const average = sum / BigInt(gasPrices.length);

    // Calculate true median
    let median: bigint;
    if (gasPrices.length % 2 === 1) {
      // Odd length: use middle element
      median = gasPrices[Math.floor(gasPrices.length / 2)]!;
    } else {
      // Even length: average of two middle elements
      const mid1 = gasPrices[gasPrices.length / 2 - 1]!;
      const mid2 = gasPrices[gasPrices.length / 2]!;
      median = (mid1 + mid2) / 2n;
    }

    const min = gasPrices[0]!;
    const max = gasPrices[gasPrices.length - 1]!;

    return {
      current: this.currentGasData,
      average,
      median,
      min,
      max,
      samples: this.gasPriceHistory.length,
    };
  }

  /**
   * Update gas prices from network
   */
  private async updateGasPrices(): Promise<void> {
    try {
      const provider = this.connectionManager.getProvider();
      const [feeData, blockNumber] = await Promise.all([
        provider.getFeeData(),
        provider.getBlockNumber(),
      ]);

      if (!feeData.gasPrice) {
        throw new Error('Failed to fetch gas price from provider');
      }

      const baseFee = feeData.maxFeePerGas
        ? feeData.maxFeePerGas - (feeData.maxPriorityFeePerGas || 0n)
        : feeData.gasPrice;

      const gasData: GasPriceData = {
        baseFee: baseFee || feeData.gasPrice,
        priorityFee: feeData.maxPriorityFeePerGas || this.priorityFeeGwei,
        gasPrice: feeData.gasPrice,
        blockNumber,
        timestamp: Date.now(),
      };

      // Update current data
      this.currentGasData = gasData;

      // Add to history (keep last 100 samples)
      this.gasPriceHistory.push(gasData);
      if (this.gasPriceHistory.length > 100) {
        this.gasPriceHistory.shift();
      }

      this.emit('gasPriceUpdated', gasData);

      this.logger.debug('Gas prices updated', {
        baseFee: ethers.formatUnits(gasData.baseFee, 'gwei'),
        priorityFee: ethers.formatUnits(gasData.priorityFee, 'gwei'),
        gasPrice: ethers.formatUnits(gasData.gasPrice, 'gwei'),
        blockNumber,
      });
    } catch (error) {
      this.logger.logError(error as Error, { operation: 'update-gas-prices' });
      throw error;
    }
  }

  /**
   * Calculate confidence in gas price estimates
   */
  private calculateGasPriceConfidence(): number {
    if (this.gasPriceHistory.length < 5) {
      return 0.5; // Low confidence with insufficient data
    }

    // Calculate volatility over recent samples
    const recentSamples = this.gasPriceHistory.slice(-10);
    const prices = recentSamples.map(data => Number(ethers.formatUnits(data.gasPrice, 'gwei')));

    const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const variance =
      prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);

    // Lower volatility = higher confidence
    const volatilityRatio = stdDev / mean;
    const confidence = Math.max(0.1, Math.min(1.0, 1 - volatilityRatio));

    return confidence;
  }

  /**
   * Estimate gas for simple operations
   */
  estimateSimpleGas(operationType: 'swap' | 'transfer' | 'approve'): bigint {
    switch (operationType) {
      case 'swap':
        return GAS_LIMITS.SIMPLE_SWAP;
      case 'transfer':
        return 21000n; // Standard ETH transfer
      case 'approve':
        return 50000n; // ERC20 approval
      default:
        return 100000n; // Default fallback
    }
  }

  /**
   * Check if gas estimator is healthy
   */
  isHealthy(): boolean {
    return (
      this.isTracking && !!this.currentGasData && Date.now() - this.currentGasData.timestamp < 60000
    ); // Data less than 1 minute old
  }

  /**
   * Get estimator statistics
   */
  getStats() {
    return {
      isTracking: this.isTracking,
      hasCurrentData: !!this.currentGasData,
      historySize: this.gasPriceHistory.length,
      lastUpdate: this.currentGasData?.timestamp,
      updateInterval: this.updateIntervalMs,
      baseFeeMultiplier: this.baseFeeMultiplier,
      priorityFeeGwei: ethers.formatUnits(this.priorityFeeGwei, 'gwei'),
      maxGasPriceGwei: ethers.formatUnits(this.maxGasPriceGwei, 'gwei'),
    };
  }
}
