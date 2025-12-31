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
  FlashLoanCostEstimate,
  FlashLoanSplit,
  FlashLoanManagerConfig,
  IFlashLoanManager,
  IFlashLoanProvider,
  FlashLoanEvents,
  getFlashLoanTokens,
  FlashLoanError,
  InsufficientCapacityError,
  ProviderUnavailableError,
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
    this.logger.info('Flash loan provider registered', { provider: provider.provider });
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

    // Initial capacity refresh
    await this.refreshCapacityCache();

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

    // Clear caches
    this.capacityCache.clear();
    this.sourceCache.clear();

    this.logger.info('Flash loan manager stopped');
  }

  /**
   * Get optimal flash loan source
   */
  async getOptimalSource(token: Address, amount: bigint): Promise<FlashLoanSource> {
    // Validate amount first
    if (!this.validateAmount(amount)) {
      throw new FlashLoanError(
        'Invalid flash loan amount',
        FlashLoanProvider.UNISWAP_V3,
        token,
        amount
      );
    }

    const estimates = await this.getCostEstimates(token, amount);

    if (estimates.length === 0) {
      throw new FlashLoanError(
        'No flash loan sources available',
        FlashLoanProvider.UNISWAP_V3,
        token,
        amount
      );
    }

    // Sort by total cost (ascending)
    estimates.sort((a, b) => {
      const costA = Number(a.totalCost);
      const costB = Number(b.totalCost);
      return costA - costB;
    });

    const optimal = estimates[0];

    if (!optimal) {
      throw new FlashLoanError(
        'No flash loan sources available',
        FlashLoanProvider.UNISWAP_V3,
        token,
        amount
      );
    }

    // Get the actual source from the provider
    const provider = this.providers.get(optimal.provider);
    if (!provider) {
      throw new ProviderUnavailableError(optimal.provider, 'Provider not registered');
    }

    const sources = await provider.getAvailableSources(token);
    const source = sources.find(s => s.poolAddress === optimal.poolAddress);

    if (!source) {
      throw new FlashLoanError('Optimal source not found', optimal.provider, token, amount);
    }

    // Verify capacity
    if (source.maxAmount < amount) {
      throw new InsufficientCapacityError(optimal.provider, token, amount, source.maxAmount);
    }

    this.logger.debug('Optimal flash loan source selected', {
      provider: optimal.provider,
      token,
      amount: this.formatAmount(amount),
      fee: this.formatAmount(optimal.fee),
      totalCost: this.formatAmount(optimal.totalCost),
    });

    return source;
  }

  /**
   * Get split sources for large loans
   */
  async getSplitSources(token: Address, amount: bigint): Promise<FlashLoanSplit[]> {
    if (!this.config.enableSplitting) {
      throw new FlashLoanError(
        'Flash loan splitting is disabled',
        FlashLoanProvider.UNISWAP_V3,
        token,
        amount
      );
    }

    const allSources: FlashLoanSource[] = [];

    // Collect sources from all providers
    for (const [providerType, provider] of this.providers) {
      if (!this.config.providers[providerType].enabled) continue;

      try {
        const sources = await provider.getAvailableSources(token);
        allSources.push(...sources.filter(s => s.available && s.maxAmount > 0n));
      } catch (error) {
        this.logger.warn('Failed to get sources from provider', {
          provider: providerType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (allSources.length === 0) {
      throw new FlashLoanError(
        'No flash loan sources available for splitting',
        FlashLoanProvider.UNISWAP_V3,
        token,
        amount
      );
    }

    // Sort sources by cost efficiency (fee per unit)
    allSources.sort((a, b) => {
      const efficiencyA = Number(a.fee) / Number(a.maxAmount);
      const efficiencyB = Number(b.fee) / Number(b.maxAmount);
      return efficiencyA - efficiencyB;
    });

    const splits: FlashLoanSplit[] = [];
    let remainingAmount = amount;
    let splitCount = 0;

    for (const source of allSources) {
      if (remainingAmount <= 0n || splitCount >= this.config.maxSplits) {
        break;
      }

      const splitAmount = remainingAmount > source.maxAmount ? source.maxAmount : remainingAmount;
      const splitFee = (source.fee * splitAmount) / source.maxAmount;

      splits.push({
        source,
        amount: splitAmount,
        fee: splitFee,
        gasOverhead: source.gasOverhead,
      });

      remainingAmount -= splitAmount;
      splitCount++;
    }

    if (remainingAmount > 0n) {
      throw new InsufficientCapacityError(
        FlashLoanProvider.UNISWAP_V3,
        token,
        amount,
        amount - remainingAmount
      );
    }

    this.logger.debug('Flash loan split calculated', {
      token,
      totalAmount: this.formatAmount(amount),
      splits: splits.length,
      totalFee: this.formatAmount(splits.reduce((sum, split) => sum + split.fee, 0n)),
    });

    return splits;
  }

  /**
   * Get total capacity for token
   */
  async getTotalCapacity(token: Address): Promise<FlashLoanCapacity> {
    const cacheKey = `capacity:${token}`;
    const cached = this.capacityCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.config.capacityRefreshIntervalMs) {
      return cached.capacity;
    }

    const sources: FlashLoanSource[] = [];
    let totalCapacity = 0n;
    let availableCapacity = 0n;

    // Collect capacity from all providers
    for (const [providerType, provider] of this.providers) {
      if (!this.config.providers[providerType].enabled) continue;

      try {
        const providerSources = await provider.getAvailableSources(token);
        sources.push(...providerSources);

        for (const source of providerSources) {
          totalCapacity += source.maxAmount;
          if (source.available) {
            availableCapacity += source.maxAmount;
          }
        }
      } catch (error) {
        this.logger.warn('Failed to get capacity from provider', {
          provider: providerType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const utilizationRate =
      totalCapacity > 0n ? Number(totalCapacity - availableCapacity) / Number(totalCapacity) : 0;

    const capacity: FlashLoanCapacity = {
      token,
      totalCapacity,
      availableCapacity,
      utilizationRate,
      sources,
    };

    // Cache the result
    this.capacityCache.set(cacheKey, {
      capacity,
      timestamp: Date.now(),
    });

    return capacity;
  }

  /**
   * Execute flash loan with optimal routing
   */
  async executeFlashLoan(request: FlashLoanRequest): Promise<FlashLoanResult> {
    const startTime = Date.now();

    try {
      // Get optimal source or splits
      let source: FlashLoanSource;
      let splits: FlashLoanSplit[] | undefined;

      try {
        source = await this.getOptimalSource(request.token, request.amount);
      } catch (error) {
        if (this.config.enableSplitting && error instanceof InsufficientCapacityError) {
          this.logger.info(
            'Attempting flash loan splitting due to insufficient single source capacity'
          );
          splits = await this.getSplitSources(request.token, request.amount);
          if (!splits || splits.length === 0 || !splits[0]) {
            throw new FlashLoanError(
              'No split sources available',
              FlashLoanProvider.UNISWAP_V3,
              request.token,
              request.amount
            );
          }
          source = splits[0].source; // Use first split as primary source
        } else {
          throw error;
        }
      }

      // Execute flash loan
      const provider = this.providers.get(source.provider);
      if (!provider) {
        throw new ProviderUnavailableError(source.provider, 'Provider not registered');
      }

      let result: FlashLoanResult;

      if (splits && splits.length > 1) {
        // Execute split flash loans (simplified - would need more complex orchestration)
        result = await this.executeSplitFlashLoan(splits, request);
      } else {
        // Execute single flash loan
        result = await provider.executeFlashLoan(request);
      }

      result.executionTime = Date.now() - startTime;

      // Emit success event
      this.emit('flashLoanExecuted', {
        provider: source.provider,
        token: request.token,
        amount: request.amount,
        fee: result.feesPaid,
        success: result.success,
        transactionHash: result.transactionHash,
      } satisfies FlashLoanEvents['flashLoanExecuted']);

      this.logger.info('Flash loan executed', {
        provider: source.provider,
        token: request.token,
        amount: this.formatAmount(request.amount),
        success: result.success,
        fee: this.formatAmount(result.feesPaid),
        executionTime: result.executionTime,
      });

      return result;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const failureReason = error instanceof Error ? error.message : String(error);

      // Emit failure event
      this.emit('flashLoanFailed', {
        provider: this.config.preferredProvider,
        token: request.token,
        amount: request.amount,
        reason: failureReason,
      } satisfies FlashLoanEvents['flashLoanFailed']);

      this.logger.error('Flash loan execution failed', {
        token: request.token,
        amount: this.formatAmount(request.amount),
        error: failureReason,
        executionTime,
      });

      return {
        success: false,
        feesPaid: 0n,
        failureReason,
        executionTime,
      };
    }
  }

  /**
   * Get cost estimates from all providers
   */
  async getCostEstimates(token: Address, amount: bigint): Promise<FlashLoanCostEstimate[]> {
    const estimates: FlashLoanCostEstimate[] = [];

    for (const [providerType, provider] of this.providers) {
      if (!this.config.providers[providerType].enabled) continue;

      try {
        const sources = await provider.getAvailableSources(token);

        for (const source of sources) {
          if (!source.available || source.maxAmount < amount) continue;

          const fee = await provider.calculateFee(token, amount);
          const gasOverhead = await provider.estimateGasOverhead(token, amount);
          const totalCost = fee + gasOverhead;
          const costRatio = Number(totalCost) / Number(amount);

          estimates.push({
            provider: providerType,
            poolAddress: source.poolAddress,
            token,
            amount,
            fee,
            gasOverhead,
            totalCost,
            costPercentage: costRatio,
          });
        }
      } catch (error) {
        this.logger.warn('Failed to get cost estimate from provider', {
          provider: providerType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return estimates;
  }

  /**
   * Execute split flash loan (simplified implementation)
   */
  private async executeSplitFlashLoan(
    splits: FlashLoanSplit[],
    request: FlashLoanRequest
  ): Promise<FlashLoanResult> {
    // This is a simplified implementation
    // In practice, this would require complex orchestration of multiple flash loans
    // For now, we'll execute the largest split and return that result

    const largestSplit = splits.reduce((largest, current) =>
      current.amount > largest.amount ? current : largest
    );

    const provider = this.providers.get(largestSplit.source.provider);
    if (!provider) {
      throw new ProviderUnavailableError(largestSplit.source.provider, 'Provider not registered');
    }

    // Modify request for the largest split
    const splitRequest: FlashLoanRequest = {
      ...request,
      amount: largestSplit.amount,
    };

    const result = await provider.executeFlashLoan(splitRequest);

    // Adjust fees to account for all splits
    const totalFees = splits.reduce((sum, split) => sum + split.fee, 0n);
    result.feesPaid = totalFees;

    return result;
  }

  /**
   * Refresh capacity cache for all tokens
   */
  private async refreshCapacityCache(): Promise<void> {
    const tokens = Object.values(getFlashLoanTokens());

    for (const token of tokens) {
      try {
        await this.getTotalCapacity(token);
      } catch (error) {
        this.logger.warn('Failed to refresh capacity cache', {
          token,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.debug('Capacity cache refreshed', {
      tokens: tokens.length,
      cacheSize: this.capacityCache.size,
    });
  }

  /**
   * Get provider statistics
   */
  getProviderStatistics(): Record<
    FlashLoanProvider,
    {
      enabled: boolean;
      registered: boolean;
      lastCapacityCheck?: number;
    }
  > {
    const stats = {} as Record<FlashLoanProvider, any>;

    for (const provider of Object.values(FlashLoanProvider)) {
      stats[provider] = {
        enabled: this.config.providers[provider].enabled,
        registered: this.providers.has(provider),
        lastCapacityCheck: undefined,
      };
    }

    return stats;
  }

  /**
   * Clear caches
   */
  clearCaches(): void {
    this.capacityCache.clear();
    this.sourceCache.clear();
    this.logger.debug('Flash loan manager caches cleared');
  }

  /**
   * Format flash loan amount for logging and display
   */
  private formatAmount(amount: bigint, decimals: number = 18): string {
    return ethers.formatUnits(amount, decimals);
  }

  /**
   * Validate flash loan amount is within reasonable bounds
   */
  private validateAmount(amount: bigint): boolean {
    // Check if amount is positive and not unreasonably large
    const maxAmount = ethers.parseUnits('1000000', 18); // 1M tokens max
    return amount > 0n && amount <= maxAmount;
  }
}
