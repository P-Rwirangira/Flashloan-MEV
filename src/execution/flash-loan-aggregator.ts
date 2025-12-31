/**
 * Flash Loan Aggregation and Optimization
 *
 * Implements real-time rate comparison across multiple providers
 * with capacity monitoring and automatic provider fallback
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { Address } from '../types/common';

export interface FlashLoanAggregatorConfig {
  readonly maxBorrowAmountUsd: number;
  readonly enableSplitting: boolean;
  readonly maxSplits: number;
  readonly feeThresholdBps: number;
  readonly capacityRefreshIntervalMs: number;
  readonly enableFallback: boolean;
  readonly performanceTrackingWindowMs: number;
  readonly minProviderReliability: number;
}

export interface FlashLoanProvider {
  readonly name: string;
  readonly protocol: 'uniswap-v3' | 'balancer' | 'aave' | 'compound' | 'dydx';
  readonly enabled: boolean;
  readonly feeRate: number;
  readonly maxCapacity: bigint;
  readonly availableCapacity: bigint;
  readonly contractAddress: Address;
  readonly supportedTokens: Address[];
  readonly reliability: number;
  readonly averageExecutionTime: number;
  readonly lastUpdated: number;
}

export interface FlashLoanQuote {
  readonly provider: FlashLoanProvider;
  readonly token: Address;
  readonly amount: bigint;
  readonly fee: bigint;
  readonly feeRate: number;
  readonly totalCost: bigint;
  readonly executionTime: number;
  readonly reliability: number;
  readonly available: boolean;
  readonly quotedAt: number;
}

export interface FlashLoanRequest {
  readonly token: Address;
  readonly amount: bigint;
  readonly maxFeeRate: number;
  readonly preferredProvider?: string;
  readonly allowSplitting: boolean;
  readonly maxSplits: number;
  readonly urgency: 'low' | 'medium' | 'high';
}

export interface FlashLoanExecution {
  readonly requestId: string;
  readonly quotes: FlashLoanQuote[];
  readonly selectedProvider: FlashLoanProvider;
  readonly splits?: FlashLoanSplit[];
  readonly totalFee: bigint;
  readonly estimatedExecutionTime: number;
  readonly fallbackProviders: FlashLoanProvider[];
  readonly createdAt: number;
}

export interface FlashLoanSplit {
  readonly provider: FlashLoanProvider;
  readonly amount: bigint;
  readonly fee: bigint;
  readonly percentage: number;
}

export interface ProviderPerformanceMetrics {
  readonly provider: string;
  readonly totalRequests: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly averageExecutionTime: number;
  readonly averageFeeRate: number;
  readonly reliability: number;
  readonly capacityUtilization: number;
  readonly lastUpdated: number;
}

export class FlashLoanAggregator extends EventEmitter {
  private readonly logger = createComponentLogger('flash-loan-aggregator');
  private readonly config: FlashLoanAggregatorConfig;
  private readonly provider: ethers.Provider;

  // Provider management
  private readonly providers = new Map<string, FlashLoanProvider>();
  private readonly providerPerformance = new Map<string, ProviderPerformanceMetrics>();

  // Request tracking
  private readonly activeRequests = new Map<string, FlashLoanExecution>();
  private requestCounter = 0;

  // Capacity monitoring
  private capacityUpdateTimer: NodeJS.Timeout | null = null;

  constructor(provider: ethers.Provider, config: FlashLoanAggregatorConfig) {
    super();
    this.provider = provider;
    this.config = config;

    this.initializeProviders();
    this.startCapacityMonitoring();
    this.startPerformanceTracking();

    this.logger.info('Flash loan aggregator initialized', {
      maxBorrowAmountUsd: this.config.maxBorrowAmountUsd,
      enableSplitting: this.config.enableSplitting,
      maxSplits: this.config.maxSplits,
      providerCount: this.providers.size,
    });
  }

  /**
   * Get best flash loan quote
   */
  async getBestQuote(request: FlashLoanRequest): Promise<FlashLoanExecution> {
    const requestId = this.generateRequestId();

    try {
      this.logger.debug('Getting flash loan quotes', {
        requestId,
        token: request.token,
        amount: request.amount.toString(),
        maxFeeRate: request.maxFeeRate,
      });

      // Get quotes from all available providers
      const quotes = await this.getQuotesFromProviders(request);

      if (quotes.length === 0) {
        throw new Error('No flash loan providers available');
      }

      // Filter quotes by fee threshold
      const affordableQuotes = quotes.filter(quote => quote.feeRate <= request.maxFeeRate);

      if (affordableQuotes.length === 0) {
        throw new Error('No affordable flash loan quotes available');
      }

      // Determine optimal execution strategy
      const execution = await this.determineOptimalExecution(requestId, request, affordableQuotes);

      // Track active request
      this.activeRequests.set(requestId, execution);

      this.emit('quoteGenerated', execution);

      return execution;
    } catch (error) {
      this.logger.error('Failed to get flash loan quote', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Execute flash loan with optimal provider
   */
  async executeFlashLoan(execution: FlashLoanExecution): Promise<{
    success: boolean;
    transactionHash?: string;
    actualFee?: bigint;
    executionTime?: number;
    failureReason?: string;
  }> {
    const startTime = Date.now();

    try {
      this.logger.info('Executing flash loan', {
        requestId: execution.requestId,
        provider: execution.selectedProvider.name,
        totalFee: execution.totalFee.toString(),
      });

      // Execute with primary provider
      let result = await this.executeWithProvider(execution, execution.selectedProvider);

      // Try fallback providers if primary fails
      if (!result.success && this.config.enableFallback && execution.fallbackProviders.length > 0) {
        this.logger.warn('Primary provider failed, trying fallbacks', {
          requestId: execution.requestId,
          primaryProvider: execution.selectedProvider.name,
          fallbackCount: execution.fallbackProviders.length,
        });

        for (const fallbackProvider of execution.fallbackProviders) {
          result = await this.executeWithProvider(execution, fallbackProvider);
          if (result.success) {
            this.logger.info('Fallback provider succeeded', {
              requestId: execution.requestId,
              fallbackProvider: fallbackProvider.name,
            });
            break;
          }
        }
      }

      // Record performance metrics
      const executionTime = Date.now() - startTime;
      this.recordProviderPerformance(
        execution.selectedProvider.name,
        result.success,
        executionTime,
        execution.totalFee
      );

      // Clean up
      this.activeRequests.delete(execution.requestId);

      this.emit('flashLoanExecuted', {
        execution,
        result,
        executionTime,
      });

      return {
        ...result,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;

      this.logger.error('Flash loan execution failed', {
        requestId: execution.requestId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Record failure
      this.recordProviderPerformance(
        execution.selectedProvider.name,
        false,
        executionTime,
        execution.totalFee
      );

      this.activeRequests.delete(execution.requestId);

      return {
        success: false,
        failureReason: error instanceof Error ? error.message : 'Unknown error',
        executionTime,
      };
    }
  }

  /**
   * Get quotes from all available providers
   */
  private async getQuotesFromProviders(request: FlashLoanRequest): Promise<FlashLoanQuote[]> {
    const quotes: FlashLoanQuote[] = [];

    for (const [providerName, provider] of this.providers) {
      if (!provider.enabled) continue;

      // Skip if provider doesn't support the token
      if (!provider.supportedTokens.includes(request.token)) continue;

      // Skip if provider doesn't have enough capacity
      if (provider.availableCapacity < request.amount) continue;

      // Skip unreliable providers
      if (provider.reliability < this.config.minProviderReliability) continue;

      try {
        const quote = await this.getQuoteFromProvider(provider, request);
        if (quote) {
          quotes.push(quote);
        }
      } catch (error) {
        this.logger.warn('Failed to get quote from provider', {
          provider: providerName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Sort quotes by total cost (fee + execution cost)
    quotes.sort((a, b) => {
      const aCost = Number(a.totalCost);
      const bCost = Number(b.totalCost);
      return aCost - bCost;
    });

    return quotes;
  }

  /**
   * Get quote from specific provider
   */
  private async getQuoteFromProvider(
    provider: FlashLoanProvider,
    request: FlashLoanRequest
  ): Promise<FlashLoanQuote | null> {
    try {
      // Calculate fee based on provider's fee rate
      const fee = (request.amount * BigInt(Math.floor(provider.feeRate * 10000))) / 10000n;

      // Estimate execution cost (gas cost)
      const gasPrice = (await this.provider.getFeeData()).gasPrice || 20000000000n; // 20 gwei default
      const estimatedGas = this.getProviderGasEstimate(provider.protocol);
      const executionCost = gasPrice * estimatedGas;

      const totalCost = fee + executionCost;

      return {
        provider,
        token: request.token,
        amount: request.amount,
        fee,
        feeRate: provider.feeRate,
        totalCost,
        executionTime: provider.averageExecutionTime,
        reliability: provider.reliability,
        available: provider.availableCapacity >= request.amount,
        quotedAt: Date.now(),
      };
    } catch (error) {
      this.logger.error('Failed to calculate quote', {
        provider: provider.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Determine optimal execution strategy
   */
  private async determineOptimalExecution(
    requestId: string,
    request: FlashLoanRequest,
    quotes: FlashLoanQuote[]
  ): Promise<FlashLoanExecution> {
    // Check if splitting is beneficial and allowed
    if (this.config.enableSplitting && request.allowSplitting && quotes.length > 1) {
      const splitExecution = await this.calculateOptimalSplitting(requestId, request, quotes);
      if (splitExecution) {
        return splitExecution;
      }
    }

    // Use single best provider
    const bestQuote = quotes[0];
    if (!bestQuote) {
      throw new Error('No suitable quotes available');
    }

    // Prepare fallback providers
    const fallbackProviders = quotes
      .slice(1, 4) // Top 3 alternatives
      .map(quote => quote.provider)
      .filter(provider => provider.reliability >= this.config.minProviderReliability);

    return {
      requestId,
      quotes: [bestQuote],
      selectedProvider: bestQuote.provider,
      totalFee: bestQuote.fee,
      estimatedExecutionTime: bestQuote.executionTime,
      fallbackProviders,
      createdAt: Date.now(),
    };
  }

  /**
   * Calculate optimal loan splitting across providers
   */
  private async calculateOptimalSplitting(
    requestId: string,
    request: FlashLoanRequest,
    quotes: FlashLoanQuote[]
  ): Promise<FlashLoanExecution | null> {
    try {
      // Only split if we have multiple good providers
      if (quotes.length < 2) return null;

      // Calculate if splitting reduces total cost
      const singleProviderCost = quotes[0]?.totalCost || 0n;

      // Try different splitting strategies
      const splits = await this.calculateSplits(
        request.amount,
        quotes.slice(0, this.config.maxSplits)
      );

      if (!splits || splits.length === 0) return null;

      const totalSplitFee = splits.reduce((sum, split) => sum + split.fee, 0n);

      // Only use splitting if it saves at least 5% in fees
      if (totalSplitFee >= (singleProviderCost * 95n) / 100n) {
        return null;
      }

      // Select primary provider (largest split)
      const primarySplit = splits.reduce((max, split) => (split.amount > max.amount ? split : max));

      const fallbackProviders = quotes
        .filter(quote => !splits.some(split => split.provider.name === quote.provider.name))
        .slice(0, 2)
        .map(quote => quote.provider);

      return {
        requestId,
        quotes: splits.map(split => quotes.find(q => q.provider.name === split.provider.name)!),
        selectedProvider: primarySplit.provider,
        splits,
        totalFee: totalSplitFee,
        estimatedExecutionTime: Math.max(
          ...splits.map(split => split.provider.averageExecutionTime)
        ),
        fallbackProviders,
        createdAt: Date.now(),
      };
    } catch (error) {
      this.logger.error('Failed to calculate optimal splitting', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Calculate loan splits across providers
   */
  private async calculateSplits(
    totalAmount: bigint,
    quotes: FlashLoanQuote[]
  ): Promise<FlashLoanSplit[] | null> {
    if (quotes.length < 2) return null;

    const splits: FlashLoanSplit[] = [];
    let remainingAmount = totalAmount;

    // Sort quotes by fee rate (lowest first)
    const sortedQuotes = [...quotes].sort((a, b) => a.feeRate - b.feeRate);

    for (let i = 0; i < sortedQuotes.length && remainingAmount > 0n; i++) {
      const quote = sortedQuotes[i];
      if (!quote) continue;

      // Calculate split amount (limited by provider capacity)
      const maxSplitAmount = quote.provider.availableCapacity;
      const splitAmount = remainingAmount > maxSplitAmount ? maxSplitAmount : remainingAmount;

      if (splitAmount > 0n) {
        const splitFee = (splitAmount * BigInt(Math.floor(quote.feeRate * 10000))) / 10000n;
        const percentage = Number((splitAmount * 100n) / totalAmount);

        splits.push({
          provider: quote.provider,
          amount: splitAmount,
          fee: splitFee,
          percentage,
        });

        remainingAmount -= splitAmount;
      }
    }

    // Only return splits if we can cover the full amount
    return remainingAmount === 0n ? splits : null;
  }

  /**
   * Execute flash loan with specific provider
   */
  private async executeWithProvider(
    execution: FlashLoanExecution,
    provider: FlashLoanProvider
  ): Promise<{
    success: boolean;
    transactionHash?: string;
    actualFee?: bigint;
    failureReason?: string;
  }> {
    try {
      // Simulate flash loan execution
      // In production, this would interact with actual flash loan contracts

      this.logger.debug('Executing with provider', {
        requestId: execution.requestId,
        provider: provider.name,
        protocol: provider.protocol,
      });

      // Simulate execution based on provider reliability
      const success = Math.random() < provider.reliability;

      if (success) {
        const transactionHash = '0x' + Math.random().toString(16).slice(2, 66);

        return {
          success: true,
          transactionHash,
          actualFee: execution.totalFee,
        };
      } else {
        return {
          success: false,
          failureReason: 'Provider execution failed',
        };
      }
    } catch (error) {
      return {
        success: false,
        failureReason: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Initialize flash loan providers
   */
  private initializeProviders(): void {
    // Uniswap V3 Flash Loans
    this.providers.set('uniswap-v3', {
      name: 'Uniswap V3',
      protocol: 'uniswap-v3',
      enabled: true,
      feeRate: 0.0005, // 0.05%
      maxCapacity: ethers.parseEther('1000000'), // 1M ETH equivalent
      availableCapacity: ethers.parseEther('800000'), // 800K ETH available
      contractAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as Address,
      supportedTokens: [
        '0x4200000000000000000000000000000000000006', // WETH
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
        '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
      ],
      reliability: 0.95,
      averageExecutionTime: 2000,
      lastUpdated: Date.now(),
    });

    // Balancer Flash Loans
    this.providers.set('balancer', {
      name: 'Balancer',
      protocol: 'balancer',
      enabled: true,
      feeRate: 0.0001, // 0.01%
      maxCapacity: ethers.parseEther('500000'), // 500K ETH equivalent
      availableCapacity: ethers.parseEther('400000'), // 400K ETH available
      contractAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8' as Address,
      supportedTokens: [
        '0x4200000000000000000000000000000000000006', // WETH
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
        '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
      ],
      reliability: 0.92,
      averageExecutionTime: 2500,
      lastUpdated: Date.now(),
    });

    // Aave Flash Loans
    this.providers.set('aave', {
      name: 'Aave V3',
      protocol: 'aave',
      enabled: true,
      feeRate: 0.0009, // 0.09%
      maxCapacity: ethers.parseEther('2000000'), // 2M ETH equivalent
      availableCapacity: ethers.parseEther('1500000'), // 1.5M ETH available
      contractAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address,
      supportedTokens: [
        '0x4200000000000000000000000000000000000006', // WETH
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
        '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
      ],
      reliability: 0.98,
      averageExecutionTime: 3000,
      lastUpdated: Date.now(),
    });

    this.logger.info('Flash loan providers initialized', {
      providerCount: this.providers.size,
      totalCapacity: Array.from(this.providers.values())
        .reduce((sum, p) => sum + p.availableCapacity, 0n)
        .toString(),
    });
  }

  /**
   * Start capacity monitoring
   */
  private startCapacityMonitoring(): void {
    this.capacityUpdateTimer = setInterval(async () => {
      await this.updateProviderCapacities();
    }, this.config.capacityRefreshIntervalMs);

    this.logger.info('Capacity monitoring started');
  }

  /**
   * Update provider capacities
   */
  private async updateProviderCapacities(): Promise<void> {
    try {
      for (const [providerName, provider] of this.providers) {
        // Simulate capacity updates
        // In production, this would query actual protocol contracts

        const utilizationRate = 0.7 + Math.random() * 0.2; // 70-90% utilization
        const newAvailableCapacity = BigInt(
          Math.floor(Number(provider.maxCapacity) * (1 - utilizationRate))
        );

        const updatedProvider: FlashLoanProvider = {
          ...provider,
          availableCapacity: newAvailableCapacity,
          lastUpdated: Date.now(),
        };

        this.providers.set(providerName, updatedProvider);
      }

      this.emit('capacitiesUpdated', {
        providers: Array.from(this.providers.values()),
        timestamp: Date.now(),
      });
    } catch (error) {
      this.logger.error('Failed to update provider capacities', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Start performance tracking
   */
  private startPerformanceTracking(): void {
    // Clean up old performance data periodically
    setInterval(() => {
      this.cleanupOldPerformanceData();
    }, this.config.performanceTrackingWindowMs);

    this.logger.info('Performance tracking started');
  }

  /**
   * Record provider performance metrics
   */
  private recordProviderPerformance(
    providerName: string,
    success: boolean,
    executionTime: number,
    fee: bigint
  ): void {
    const existing = this.providerPerformance.get(providerName);

    if (!existing) {
      this.providerPerformance.set(providerName, {
        provider: providerName,
        totalRequests: 1,
        successfulRequests: success ? 1 : 0,
        failedRequests: success ? 0 : 1,
        averageExecutionTime: executionTime,
        averageFeeRate: Number(fee) / 1e18, // Convert to ETH
        reliability: success ? 1.0 : 0.0,
        capacityUtilization: 0.5, // Default
        lastUpdated: Date.now(),
      });
      return;
    }

    // Update metrics with exponential moving average
    const alpha = 0.1; // Smoothing factor
    const newTotalRequests = existing.totalRequests + 1;
    const newSuccessfulRequests = existing.successfulRequests + (success ? 1 : 0);
    const newFailedRequests = existing.failedRequests + (success ? 0 : 1);

    const updatedMetrics: ProviderPerformanceMetrics = {
      provider: providerName,
      totalRequests: newTotalRequests,
      successfulRequests: newSuccessfulRequests,
      failedRequests: newFailedRequests,
      averageExecutionTime: existing.averageExecutionTime * (1 - alpha) + executionTime * alpha,
      averageFeeRate: existing.averageFeeRate * (1 - alpha) + (Number(fee) / 1e18) * alpha,
      reliability: newSuccessfulRequests / newTotalRequests,
      capacityUtilization: existing.capacityUtilization, // Updated separately
      lastUpdated: Date.now(),
    };

    this.providerPerformance.set(providerName, updatedMetrics);

    // Update provider reliability
    const provider = this.providers.get(providerName);
    if (provider) {
      this.providers.set(providerName, {
        ...provider,
        reliability: updatedMetrics.reliability,
        averageExecutionTime: updatedMetrics.averageExecutionTime,
      });
    }
  }

  /**
   * Clean up old performance data
   */
  private cleanupOldPerformanceData(): void {
    const cutoffTime = Date.now() - this.config.performanceTrackingWindowMs;

    for (const [providerName, metrics] of this.providerPerformance) {
      if (metrics.lastUpdated < cutoffTime) {
        this.providerPerformance.delete(providerName);
        this.logger.debug('Cleaned up old performance data', { provider: providerName });
      }
    }
  }

  /**
   * Get gas estimate for provider protocol
   */
  private getProviderGasEstimate(protocol: string): bigint {
    switch (protocol) {
      case 'uniswap-v3':
        return 200000n;
      case 'balancer':
        return 180000n;
      case 'aave':
        return 250000n;
      case 'compound':
        return 220000n;
      case 'dydx':
        return 300000n;
      default:
        return 200000n;
    }
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `fl_${Date.now()}_${++this.requestCounter}`;
  }

  /**
   * Get aggregator statistics
   */
  getAggregatorStats(): {
    activeProviders: number;
    totalCapacity: bigint;
    availableCapacity: bigint;
    activeRequests: number;
    averageFeeRate: number;
    bestProvider: string | null;
  } {
    const activeProviders = Array.from(this.providers.values()).filter(p => p.enabled).length;
    const totalCapacity = Array.from(this.providers.values()).reduce(
      (sum, p) => sum + p.maxCapacity,
      0n
    );
    const availableCapacity = Array.from(this.providers.values()).reduce(
      (sum, p) => sum + p.availableCapacity,
      0n
    );

    const avgFeeRate =
      Array.from(this.providers.values()).reduce((sum, p) => sum + p.feeRate, 0) /
      this.providers.size;

    const bestProvider =
      Array.from(this.providers.values())
        .filter(p => p.enabled)
        .sort((a, b) => a.feeRate - b.feeRate)[0]?.name || null;

    return {
      activeProviders,
      totalCapacity,
      availableCapacity,
      activeRequests: this.activeRequests.size,
      averageFeeRate: avgFeeRate,
      bestProvider,
    };
  }

  /**
   * Stop aggregator
   */
  stop(): void {
    if (this.capacityUpdateTimer) {
      clearInterval(this.capacityUpdateTimer);
      this.capacityUpdateTimer = null;
    }

    this.logger.info('Flash loan aggregator stopped');
  }
}
