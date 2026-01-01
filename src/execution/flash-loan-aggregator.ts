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
      await this.updateProviderCapacities();
    }, this.config.capacityRefreshIntervalMs);

    this.logger.info('Capacity monitoring started');
  }

  /**
   * Update provider capacities
   */
  private async updateProviderCapacities(): Promise<void> {
    try {
      for (const [_providerName, provider] of this.providers) {
        // In production, query actual protocol contracts for capacity
        const mockCapacityUpdate = (provider.maxCapacity * 8n) / 10n;
        provider.availableCapacity = mockCapacityUpdate;
        provider.lastUpdated = Date.now();
      }
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
