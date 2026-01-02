/**
 * Flash Loan Aggregator
 *
 * Aggregates flash loan providers and routes requests to optimal sources
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { Address } from '../types/common';

export interface FlashLoanProvider {
  name: string;
  protocol: string;
  enabled: boolean;
  feeRate: number;
  maxCapacity: bigint;
  availableCapacity: bigint;
  contractAddress: Address;
  supportedTokens: string[];
  reliability: number;
  gasOverhead: bigint;
  lastUpdated: number;
}

export interface FlashLoanRequest {
  token: Address;
  amount: bigint;
  recipient: Address;
  callbackData: string;
  maxFeeRate?: number;
  preferredProvider?: string;
}

export interface FlashLoanExecution {
  provider: FlashLoanProvider;
  totalFee: bigint;
  gasEstimate: bigint;
  executionTime: number;
}

export interface FlashLoanResult {
  success: boolean;
  transactionHash?: string;
  actualFee?: bigint;
  failureReason?: string;
}

export interface FlashLoanAggregatorConfig {
  maxBorrowAmountUsd: number;
  capacityRefreshIntervalMs: number;
  performanceTrackingWindowMs: number;
  enableSplitting: boolean;
  maxSplits: number;
}

export interface ProviderPerformanceMetrics {
  provider: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageExecutionTime: number;
  averageFee: bigint;
  reliability: number;
  lastUpdated: number;
}

export class FlashLoanAggregator extends EventEmitter {
  private readonly logger = createComponentLogger('flash-loan-aggregator');
  private readonly config: FlashLoanAggregatorConfig;

  // Provider management
  private readonly providers = new Map<string, FlashLoanProvider>();
  private readonly activeRequests = new Map<string, FlashLoanRequest>();
  private readonly providerPerformance = new Map<string, ProviderPerformanceMetrics>();

  // Monitoring
  private capacityUpdateTimer: NodeJS.Timeout | null = null;
  private performanceCleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: FlashLoanAggregatorConfig) {
    super();
    this.config = config;

    this.initializeProviders();
    this.startCapacityMonitoring();
    this.startPerformanceTracking();

    this.logger.info('Flash loan aggregator initialized', {
      providerCount: this.providers.size,
      enableSplitting: this.config.enableSplitting,
    });
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
      feeRate: 0.0005,
      maxCapacity: ethers.parseEther('1000000'),
      availableCapacity: ethers.parseEther('800000'),
      contractAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as Address,
      supportedTokens: [
        '0x4200000000000000000000000000000000000006',
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
      ],
      reliability: 0.95,
      gasOverhead: 200000n,
      lastUpdated: Date.now(),
    });

    // Balancer Flash Loans
    this.providers.set('balancer', {
      name: 'Balancer',
      protocol: 'balancer',
      enabled: true,
      feeRate: 0.0001,
      maxCapacity: ethers.parseEther('500000'),
      availableCapacity: ethers.parseEther('400000'),
      contractAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8' as Address,
      supportedTokens: [
        '0x4200000000000000000000000000000000000006',
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      ],
      reliability: 0.92,
      gasOverhead: 180000n,
      lastUpdated: Date.now(),
    });

    // Aave Flash Loans
    this.providers.set('aave', {
      name: 'Aave V3',
      protocol: 'aave-v3',
      enabled: true,
      feeRate: 0.0009,
      maxCapacity: ethers.parseEther('2000000'),
      availableCapacity: ethers.parseEther('1500000'),
      contractAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address,
      supportedTokens: [
        '0x4200000000000000000000000000000000000006',
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
      ],
      reliability: 0.98,
      gasOverhead: 250000n,
      lastUpdated: Date.now(),
    });

    this.logger.info('Flash loan providers initialized', {
      providerCount: this.providers.size,
      enabledProviders: Array.from(this.providers.values()).filter(p => p.enabled).length,
      totalCapacity: Array.from(this.providers.values())
        .reduce((sum, p) => sum + p.maxCapacity, 0n)
        .toString(),
    });
  }

  /**
   * Start capacity monitoring
   */
  private startCapacityMonitoring(): void {
    this.capacityUpdateTimer = setInterval(async () => {
      const start = Date.now();
      await this.updateProviderCapacities();
      // Record a synthetic performance tick for capacity refresh
      this.recordProviderPerformance('system-capacity-refresh', {
        totalRequests:
          (this.providerPerformance.get('system-capacity-refresh')?.totalRequests ?? 0) + 1,
        averageExecutionTime: Date.now() - start,
        lastUpdated: Date.now(),
      });
    }, this.config.capacityRefreshIntervalMs);

    this.logger.info('Capacity monitoring started');
  }

  /**
   * Update provider capacities
   */
  private async updateProviderCapacities(): Promise<void> {
    try {
      for (const [providerName, provider] of this.providers) {
        try {
          const capacity = await this.fetchCapacityForProvider(providerName, provider);
          if (capacity > 0n) {
            provider.availableCapacity = capacity;
          } else {
            // Fallback to 80% of max if capacity could not be determined
            provider.availableCapacity = (provider.maxCapacity * 8n) / 10n;
          }
          provider.lastUpdated = Date.now();
        } catch (innerError) {
          this.logger.warn('Capacity fetch failed for provider', {
            provider: providerName,
            error: innerError instanceof Error ? innerError.message : String(innerError),
          });
          provider.availableCapacity = (provider.maxCapacity * 8n) / 10n;
          provider.lastUpdated = Date.now();
        }
      }
    } catch (error) {
      this.logger.error('Failed to update provider capacities', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async fetchCapacityForProvider(
    providerName: string,
    provider: FlashLoanProvider
  ): Promise<bigint> {
    // Timeout wrapper
    const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('capacity-timeout')), ms)),
      ]);
    };

    const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
    const aaveAbi = [
      // Minimal ABI for getReserveData (v2-style). Will be tried and caught if incompatible
      'function getReserveData(address asset) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40)',
    ];

    try {
      switch (provider.protocol) {
        case 'aave-v3': {
          // Sum available liquidity across supported tokens using getReserveData
          let total = 0n;
          const pool = new ethers.Contract(
            provider.contractAddress as string,
            aaveAbi,
            (this as any).provider || ethers.getDefaultProvider()
          );
          for (const token of provider.supportedTokens) {
            try {
              const res = await withTimeout(pool['getReserveData']!(token), 8000);
              // availableLiquidity is first element in v2-style tuple
              const avail = BigInt(res?.[0]?.toString?.() ?? '0');
              total += avail;
            } catch (e) {
              // If call fails for a token, continue with others
              this.logger.debug('Aave reserve query failed for token', {
                provider: providerName,
                token,
                error: e instanceof Error ? e.message : String(e),
              });
              continue;
            }
          }
          return total;
        }
        case 'balancer': {
          // Approximate capacity as sum of supported token balances held by the pool/vault
          let total = 0n;
          for (const token of provider.supportedTokens) {
            try {
              const tokenContract = new ethers.Contract(
                token,
                erc20Abi,
                (this as any).provider || ethers.getDefaultProvider()
              );
              const bal = await withTimeout(
                tokenContract['balanceOf']!(provider.contractAddress as string),
                8000
              );
              total += BigInt(bal?.toString?.() ?? '0');
            } catch (e) {
              this.logger.debug('Balancer token balance query failed', {
                provider: providerName,
                token,
                error: e instanceof Error ? e.message : String(e),
              });
              continue;
            }
          }
          return total;
        }
        case 'uniswap-v3': {
          // No global capacity; approximate by balances of supported tokens at the contract address
          let total = 0n;
          for (const token of provider.supportedTokens) {
            try {
              const tokenContract = new ethers.Contract(
                token,
                erc20Abi,
                (this as any).provider || ethers.getDefaultProvider()
              );
              const bal = await withTimeout(
                tokenContract['balanceOf']!(provider.contractAddress as string),
                8000
              );
              total += BigInt(bal?.toString?.() ?? '0');
            } catch (e) {
              this.logger.debug('Uniswap V3 token balance query failed', {
                provider: providerName,
                token,
                error: e instanceof Error ? e.message : String(e),
              });
              continue;
            }
          }
          return total;
        }
        default: {
          // Generic fallback: sum supported token balances
          let total = 0n;
          for (const token of provider.supportedTokens) {
            try {
              const tokenContract = new ethers.Contract(
                token,
                erc20Abi,
                (this as any).provider || ethers.getDefaultProvider()
              );
              const bal = await withTimeout(
                tokenContract['balanceOf']!(provider.contractAddress as string),
                8000
              );
              total += BigInt(bal?.toString?.() ?? '0');
            } catch (e) {
              this.logger.debug('Generic capacity balance query failed', {
                provider: providerName,
                token,
                error: e instanceof Error ? e.message : String(e),
              });
              continue;
            }
          }
          return total;
        }
      }
    } catch (err) {
      this.logger.warn('fetchCapacityForProvider failed', {
        provider: providerName,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0n;
    }
  }

  /**
   * Start performance tracking
   */
  private startPerformanceTracking(): void {
    this.performanceCleanupInterval = setInterval(() => {
      this.cleanupOldPerformanceData();
    }, this.config.performanceTrackingWindowMs);

    this.logger.info('Performance tracking started');
  }

  /**
   * Stop flash loan aggregator and cleanup resources
   */
  stop(): void {
    if (this.capacityUpdateTimer) {
      clearInterval(this.capacityUpdateTimer);
      this.capacityUpdateTimer = null;
    }

    if (this.performanceCleanupInterval) {
      clearInterval(this.performanceCleanupInterval);
      this.performanceCleanupInterval = null;
    }

    this.activeRequests.clear();
    this.providerPerformance.clear();

    this.logger.info('Flash loan aggregator stopped');
  }

  /**
   * Record provider performance metrics
   */
  private recordProviderPerformance(
    providerName: string,
    metrics: Partial<ProviderPerformanceMetrics>
  ): void {
    const existing = this.providerPerformance.get(providerName);
    const now = Date.now();
    if (existing) {
      const updated: ProviderPerformanceMetrics = {
        ...existing,
        totalRequests: metrics.totalRequests ?? existing.totalRequests,
        successfulRequests: metrics.successfulRequests ?? existing.successfulRequests,
        failedRequests: metrics.failedRequests ?? existing.failedRequests,
        averageExecutionTime: metrics.averageExecutionTime ?? existing.averageExecutionTime,
        averageFee: metrics.averageFee ?? existing.averageFee,
        reliability: metrics.reliability ?? existing.reliability,
        lastUpdated: now,
        provider: existing.provider,
      };
      this.providerPerformance.set(providerName, updated);
    } else {
      const created: ProviderPerformanceMetrics = {
        provider: providerName,
        totalRequests: metrics.totalRequests ?? 0,
        successfulRequests: metrics.successfulRequests ?? 0,
        failedRequests: metrics.failedRequests ?? 0,
        averageExecutionTime: metrics.averageExecutionTime ?? 0,
        averageFee: metrics.averageFee ?? 0n,
        reliability: metrics.reliability ?? 0,
        lastUpdated: now,
      };
      this.providerPerformance.set(providerName, created);
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
      }
    }
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
      this.providers.size > 0
        ? Array.from(this.providers.values()).reduce((sum, p) => sum + p.feeRate, 0) /
          this.providers.size
        : 0;

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
}
