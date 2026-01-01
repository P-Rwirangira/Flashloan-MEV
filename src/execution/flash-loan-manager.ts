/**
 * Flash Loan Manager
 *
 * Manages flash loan sourcing and execution across multiple providers
 * Requirements: 1.1, 1.7
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { Address } from '../types/common';
import {
  FlashLoanProvider,
  FlashLoanSource,
  FlashLoanRequest,
  FlashLoanResult,
  FlashLoanCapacity,
  FlashLoanSplit,
  FlashLoanManagerConfig,
  IFlashLoanManager,
  IFlashLoanProvider,
  FlashLoanError,
  InsufficientCapacityError,
  FlashLoanCostEstimate,
} from '../types/flash-loan';

/**
 * Flash Loan Manager Implementation
 */
export class FlashLoanManager extends EventEmitter implements IFlashLoanManager {
  private readonly logger = createComponentLogger('flash-loan-manager');
  private readonly config: FlashLoanManagerConfig;
  private readonly providers = new Map<FlashLoanProvider, IFlashLoanProvider>();
  private readonly capacityCache = new Map<
    string,
    { capacity: FlashLoanCapacity; timestamp: number }
  >();
  private readonly sourceCache = new Map<
    string,
    { sources: FlashLoanSource[]; timestamp: number }
  >();

  private capacityRefreshInterval?: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(config: Partial<FlashLoanManagerConfig> = {}) {
    super();

    this.config = {
      preferredProvider: config.preferredProvider ?? FlashLoanProvider.UNISWAP_V3,
      maxBorrowAmountUsd: config.maxBorrowAmountUsd ?? 100000,
      enableSplitting: config.enableSplitting ?? true,
      maxSplits: config.maxSplits ?? 3,
      feeThresholdBps: config.feeThresholdBps ?? 50, // 0.5%
      capacityRefreshIntervalMs: config.capacityRefreshIntervalMs ?? 30000, // 30 seconds
      enableFallback: config.enableFallback ?? true,
      providers: {
        ...config.providers,
        [FlashLoanProvider.UNISWAP_V3]: {
          enabled: config.providers?.[FlashLoanProvider.UNISWAP_V3]?.enabled ?? true,
          feeRate: config.providers?.[FlashLoanProvider.UNISWAP_V3]?.feeRate ?? 0.0005, // 0.05%
          factoryAddress:
            config.providers?.[FlashLoanProvider.UNISWAP_V3]?.factoryAddress ??
            ('0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as Address), // Base Uniswap V3 Factory
          quoterAddress:
            config.providers?.[FlashLoanProvider.UNISWAP_V3]?.quoterAddress ??
            ('0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as Address), // Base Uniswap V3 Quoter
        },
        [FlashLoanProvider.BALANCER]: {
          enabled: config.providers?.[FlashLoanProvider.BALANCER]?.enabled ?? true,
          feeRate: config.providers?.[FlashLoanProvider.BALANCER]?.feeRate ?? 0.0, // No fee
          vaultAddress:
            config.providers?.[FlashLoanProvider.BALANCER]?.vaultAddress ??
            ('0xBA12222222228d8Ba445958a75a0704d566BF2C8' as Address), // Balancer Vault (if available on Base)
        },
        [FlashLoanProvider.AAVE]: {
          enabled: config.providers?.[FlashLoanProvider.AAVE]?.enabled ?? false, // Disabled by default on Base
          feeRate: config.providers?.[FlashLoanProvider.AAVE]?.feeRate ?? 0.0009, // 0.09%
          poolAddress:
            config.providers?.[FlashLoanProvider.AAVE]?.poolAddress ??
            ('0x0000000000000000000000000000000000000000' as Address), // Not available on Base yet
        },
      },
    };

    this.logger.info('Flash loan manager initialized', {
      preferredProvider: this.config.preferredProvider,
      enabledProviders: Object.entries(this.config.providers)
        .filter(([, config]) => config.enabled)
        .map(([provider]) => provider),
    });
  }

  /**
   * Register flash loan provider
   */
  registerProvider(provider: IFlashLoanProvider): void {
    this.providers.set(provider.provider, provider);
    this.logger.info('Flash loan provider registered', {
      provider: provider.provider,
    });
  }

  /**
   * Start flash loan manager
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Flash loan manager is already running');
      return;
    }

    this.isRunning = true;

    // Start capacity refresh interval
    this.capacityRefreshInterval = setInterval(() => {
      this.refreshCapacityCache();
    }, this.config.capacityRefreshIntervalMs);

    this.logger.info('Flash loan manager started');
  }

  /**
   * Stop flash loan manager
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Flash loan manager is not running');
      return;
    }

    this.isRunning = false;

    if (this.capacityRefreshInterval) {
      clearInterval(this.capacityRefreshInterval);
      this.capacityRefreshInterval = undefined;
    }

    this.logger.info('Flash loan manager stopped');
  }

  /**
   * Get available flash loan sources for token
   */
  async getAvailableSources(token: Address, amount: bigint): Promise<FlashLoanSource[]> {
    const cacheKey = `${token}-${amount.toString()}`;
    const cached = this.sourceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < 30000) {
      return cached.sources;
    }

    const sources: FlashLoanSource[] = [];

    for (const [providerType, config] of Object.entries(this.config.providers)) {
      if (!config.enabled) continue;

      try {
        const capacity = await this.getProviderCapacity(providerType as FlashLoanProvider, token);

        if (capacity.availableCapacity >= amount) {
          sources.push({
            provider: providerType as FlashLoanProvider,
            poolAddress: '0x0000000000000000000000000000000000000000' as Address, // Mock address
            token,
            fee: (amount * BigInt(Math.floor(config.feeRate * 1e18))) / BigInt(1e18),
            gasOverhead: BigInt(50000), // Mock gas overhead
            maxAmount: capacity.availableCapacity,
            available: true,
            lastUpdated: Date.now(),
          });
        }
      } catch (error) {
        this.logger.warn('Failed to get capacity for provider', {
          provider: providerType,
          token,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Sort by cost (lowest first)
    sources.sort((a, b) => Number(a.fee - b.fee));

    // Cache results
    this.sourceCache.set(cacheKey, {
      sources,
      timestamp: Date.now(),
    });

    return sources;
  }

  /**
   * Get optimal flash loan source
   */
  async getOptimalSource(token: Address, amount: bigint): Promise<FlashLoanSource> {
    const sources = await this.getAvailableSources(token, amount);

    if (sources.length === 0) {
      throw new InsufficientCapacityError(FlashLoanProvider.UNISWAP_V3, token, amount, 0n);
    }

    // Prefer configured provider if available and cost-effective
    const preferredSource = sources.find(s => s.provider === this.config.preferredProvider);
    if (preferredSource) {
      return preferredSource;
    }

    // Otherwise return cheapest option
    const cheapestSource = sources[0];
    if (!cheapestSource) {
      throw new InsufficientCapacityError(FlashLoanProvider.UNISWAP_V3, token, amount, 0n);
    }

    return cheapestSource;
  }

  /**
   * Get split sources for large amounts
   */
  async getSplitSources(token: Address, amount: bigint): Promise<FlashLoanSplit[]> {
    const sources = await this.getAvailableSources(token, amount);
    return this.calculateOptimalSplits(amount, sources);
  }

  /**
   * Execute flash loan with optimal routing
   */
  async executeFlashLoan(request: FlashLoanRequest): Promise<FlashLoanResult> {
    try {
      this.logger.info('Processing flash loan request', {
        token: request.token,
        amount: request.amount.toString(),
        recipient: request.recipient,
      });

      // Validate request
      if (request.amount <= 0n) {
        throw new FlashLoanError(
          'Invalid loan amount',
          FlashLoanProvider.UNISWAP_V3,
          request.token,
          request.amount
        );
      }

      if (request.amount > BigInt(this.config.maxBorrowAmountUsd * 1e18)) {
        throw new FlashLoanError(
          'Amount exceeds maximum borrow limit',
          FlashLoanProvider.UNISWAP_V3,
          request.token,
          request.amount
        );
      }

      // Get optimal source
      const source = await this.getOptimalSource(request.token, request.amount);

      // Check if splitting is beneficial
      if (this.config.enableSplitting && request.amount > source.maxAmount) {
        return await this.executeSplitFlashLoan(request);
      }

      // Execute single flash loan
      return await this.executeSingleFlashLoan(request, source);
    } catch (error) {
      this.logger.error('Flash loan request failed', {
        token: request.token,
        amount: request.amount.toString(),
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        feesPaid: 0n,
        failureReason: error instanceof Error ? error.message : String(error),
        executionTime: 0,
      };
    }
  }

  /**
   * Get cost estimates from all providers
   */
  async getCostEstimates(token: Address, amount: bigint): Promise<FlashLoanCostEstimate[]> {
    const estimates: FlashLoanCostEstimate[] = [];

    for (const [providerType, config] of Object.entries(this.config.providers)) {
      if (!config.enabled) continue;

      try {
        const fee = (amount * BigInt(Math.floor(config.feeRate * 1e18))) / BigInt(1e18);
        const gasOverhead = BigInt(50000); // Mock gas overhead
        const gasPrice = BigInt(2000000000); // 2 gwei default
        const gasCost = gasOverhead * gasPrice;
        const totalCost = fee + gasCost;

        estimates.push({
          provider: providerType as FlashLoanProvider,
          poolAddress: '0x0000000000000000000000000000000000000000' as Address,
          token,
          amount,
          fee,
          gasOverhead,
          totalCost,
          costPercentage: amount > 0n ? Number((totalCost * BigInt(10000)) / amount) / 100 : 0, // Percentage with 2 decimals
        });
      } catch (error) {
        this.logger.warn('Failed to estimate cost for provider', {
          provider: providerType,
          token,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return estimates.sort((a, b) => Number(a.totalCost - b.totalCost));
  }

  /**
   * Get total capacity for token across all providers
   */
  async getTotalCapacity(token: Address): Promise<FlashLoanCapacity> {
    let totalCapacity = 0n;
    let availableCapacity = 0n;
    const sources: FlashLoanSource[] = [];

    for (const [providerType, config] of Object.entries(this.config.providers)) {
      if (!config.enabled) continue;

      try {
        const capacity = await this.getProviderCapacity(providerType as FlashLoanProvider, token);
        totalCapacity += capacity.totalCapacity;
        availableCapacity += capacity.availableCapacity;
        sources.push(...capacity.sources);
      } catch (error) {
        this.logger.warn('Failed to get capacity for provider', {
          provider: providerType,
          token,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      token,
      totalCapacity,
      availableCapacity,
      utilizationRate:
        totalCapacity > 0n ? Number(totalCapacity - availableCapacity) / Number(totalCapacity) : 0,
      sources,
    };
  }

  /**
   * Get provider-specific capacity
   */
  private async getProviderCapacity(
    provider: FlashLoanProvider,
    token: Address
  ): Promise<FlashLoanCapacity> {
    const cacheKey = `${provider}-${token}`;
    const cached = this.capacityCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.config.capacityRefreshIntervalMs) {
      return cached.capacity;
    }

    // For now, return mock capacity data
    // In production, this would query actual provider contracts
    const mockCapacity: FlashLoanCapacity = {
      token,
      totalCapacity: BigInt(1000000) * BigInt(1e18), // 1M tokens
      availableCapacity: BigInt(800000) * BigInt(1e18), // 800K available
      utilizationRate: 0.2, // 20% utilized
      sources: [],
    };

    this.capacityCache.set(cacheKey, {
      capacity: mockCapacity,
      timestamp: Date.now(),
    });

    return mockCapacity;
  }

  /**
   * Execute single flash loan
   */
  private async executeSingleFlashLoan(
    _request: FlashLoanRequest,
    source: FlashLoanSource
  ): Promise<FlashLoanResult> {
    const startTime = Date.now();

    try {
      // For now, return success result
      // In production, this would interact with actual flash loan contracts
      return {
        success: true,
        transactionHash: ethers.hexlify(ethers.randomBytes(32)),
        gasUsed: BigInt(200000),
        feesPaid: source.fee,
        profit: BigInt(0),
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        feesPaid: 0n,
        failureReason: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute split flash loan across multiple providers
   */
  private async executeSplitFlashLoan(request: FlashLoanRequest): Promise<FlashLoanResult> {
    const startTime = Date.now();

    try {
      const sources = await this.getAvailableSources(request.token, request.amount);
      const splits = this.calculateOptimalSplits(request.amount, sources);

      if (splits.length === 0) {
        throw new InsufficientCapacityError(
          FlashLoanProvider.UNISWAP_V3,
          request.token,
          request.amount,
          0n
        );
      }

      // For now, return success result for first split
      // In production, this would execute multiple flash loans
      const primarySplit = splits[0];
      if (!primarySplit) {
        throw new Error('No splits available');
      }

      return {
        success: true,
        transactionHash: ethers.hexlify(ethers.randomBytes(32)),
        gasUsed: BigInt(300000),
        feesPaid: primarySplit.fee,
        profit: BigInt(0),
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        feesPaid: 0n,
        failureReason: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Calculate optimal splits for large amounts
   */
  private calculateOptimalSplits(
    totalAmount: bigint,
    sources: FlashLoanSource[]
  ): FlashLoanSplit[] {
    const splits: FlashLoanSplit[] = [];
    let remainingAmount = totalAmount;

    // Sort sources by cost efficiency
    const sortedSources = [...sources].sort((a, b) => Number(a.fee - b.fee));

    for (const source of sortedSources) {
      if (remainingAmount <= 0n || splits.length >= this.config.maxSplits) {
        break;
      }

      const splitAmount = remainingAmount > source.maxAmount ? source.maxAmount : remainingAmount;

      // Calculate fee proportionally based on the fee rate
      const feeRate = source.maxAmount > 0n ? Number(source.fee) / Number(source.maxAmount) : 0;
      const splitFee = BigInt(Math.floor(Number(splitAmount) * feeRate));

      splits.push({
        source,
        amount: splitAmount,
        fee: splitFee,
        gasOverhead: source.gasOverhead,
      });

      remainingAmount -= splitAmount;
    }

    return splits;
  }

  /**
   * Refresh capacity cache
   */
  private async refreshCapacityCache(): Promise<void> {
    try {
      // Clear old cache entries
      const now = Date.now();
      for (const [key, cached] of this.capacityCache.entries()) {
        if (now - cached.timestamp > this.config.capacityRefreshIntervalMs * 2) {
          this.capacityCache.delete(key);
        }
      }

      // Clear old source cache entries
      for (const [key, cached] of this.sourceCache.entries()) {
        if (now - cached.timestamp > 60000) {
          // 1 minute
          this.sourceCache.delete(key);
        }
      }

      this.logger.debug('Capacity cache refreshed');
    } catch (error) {
      this.logger.error('Failed to refresh capacity cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
