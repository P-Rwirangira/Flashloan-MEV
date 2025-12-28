/**
 * Transaction Bundler
 *
 * Coordinates transaction submission with dynamic bribe optimization
 * and relay failover management
 */

import { ethers, TransactionRequest } from 'ethers';
import { EventEmitter } from 'events';
import { PrivateRelayManager, SubmissionParams, SubmissionResult } from './private-relay';
import { BribeOptimizer, BribeOptimizationParams, CongestionLevel } from './bribe-optimizer';

/**
 * Bundler configuration
 */
export interface BundlerConfig {
  maxBribe: bigint;
  minBribe: bigint;
  bribeIncrement: bigint;
  maxRetries: number;
  retryDelay: number;
  inclusionTimeout: number;
  dynamicBribing: boolean;
}

/**
 * Transaction bundle
 */
export interface TransactionBundle {
  id: string;
  transactions: TransactionRequest[];
  priority: 'high' | 'medium' | 'low';
  deadline: number;
  maxBribe: bigint;
  submitted: boolean;
  txHashes?: string[];
}

/**
 * Bribe optimization parameters
 */
export interface BribeOptimization {
  currentBribe: bigint;
  targetInclusionProbability: number;
  networkCongestion: number;
  timeRemaining: number;
}

/**
 * Transaction Bundler class
 */
export class TransactionBundler extends EventEmitter {
  private readonly relayManager: PrivateRelayManager;
  private readonly provider: ethers.Provider;
  private readonly config: BundlerConfig;
  private readonly bribeOptimizer: BribeOptimizer;

  private readonly pendingBundles: Map<string, TransactionBundle>;
  private readonly submissionHistory: Map<string, SubmissionResult[]>;

  // Bribe optimization state
  private networkGasPrice: bigint = 0n;
  private congestionLevel: CongestionLevel = CongestionLevel.MEDIUM;

  constructor(
    relayManager: PrivateRelayManager,
    provider: ethers.Provider,
    config: BundlerConfig,
    bribeOptimizer?: BribeOptimizer
  ) {
    super();

    this.relayManager = relayManager;
    this.provider = provider;
    this.config = config;
    this.bribeOptimizer = bribeOptimizer || new BribeOptimizer();

    this.pendingBundles = new Map();
    this.submissionHistory = new Map();

    // Start monitoring network conditions
    this.startNetworkMonitoring();
  }

  /**
   * Submit transaction bundle with dynamic bribe optimization
   */
  async submitBundle(bundle: TransactionBundle): Promise<SubmissionResult[]> {
    this.pendingBundles.set(bundle.id, bundle);

    const results: SubmissionResult[] = [];

    for (const transaction of bundle.transactions) {
      // Calculate optimal bribe
      const optimalBribe = this.calculateOptimalBribe(bundle);

      // Prepare submission parameters
      const params: SubmissionParams = {
        transaction,
        bribe: optimalBribe,
        priority: bundle.priority,
        deadline: bundle.deadline,
      };

      // Submit with retry logic
      const result = await this.submitWithRetry(params, bundle.id);
      results.push(result);

      // Track submission history
      this.trackSubmission(bundle.id, result);

      if (!result.success) {
        this.emit('bundleSubmissionFailed', {
          bundleId: bundle.id,
          error: result.error,
        });
        break; // Stop submitting if one transaction fails
      }
    }

    // Update bundle status
    bundle.submitted = true;
    bundle.txHashes = results.filter(r => r.success).map(r => r.txHash!);

    this.emit('bundleSubmitted', {
      bundleId: bundle.id,
      txHashes: bundle.txHashes,
      totalBribe: results.reduce((sum, r) => sum + (r.bribe || 0n), 0n),
    });

    return results;
  }

  /**
   * Submit single transaction with retry logic
   */
  private async submitWithRetry(
    params: SubmissionParams,
    _bundleId: string
  ): Promise<SubmissionResult> {
    let lastError: string = '';
    let currentBribe = params.bribe || 0n;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        // Update bribe for retry attempts
        if (attempt > 0 && this.config.dynamicBribing) {
          currentBribe = this.increaseBribe(currentBribe);
          params.bribe = currentBribe;
        }

        const result = await this.relayManager.submitTransaction(params);

        if (result.success) {
          return result;
        }

        lastError = result.error || 'Unknown error';

        // Wait before retry
        if (attempt < this.config.maxRetries - 1) {
          await this.delay(this.config.retryDelay * (attempt + 1));
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);

        // Wait before retry
        if (attempt < this.config.maxRetries - 1) {
          await this.delay(this.config.retryDelay * (attempt + 1));
        }
      }
    }

    return {
      success: false,
      error: `All retry attempts failed. Last error: ${lastError}`,
    };
  }

  /**
   * Calculate optimal bribe using the bribe optimizer
   */
  private calculateOptimalBribe(bundle: TransactionBundle): bigint {
    const timeRemaining = Math.max(0, bundle.deadline - Date.now());
    const timeUrgency = timeRemaining < 30000 ? 1.0 : Math.max(0, (60000 - timeRemaining) / 60000);

    const optimizationParams: BribeOptimizationParams = {
      baseGasPrice: this.networkGasPrice,
      networkCongestion: this.congestionLevel,
      timeUrgency,
      priority: bundle.priority,
      targetInclusionProbability: 0.8, // 80% target inclusion probability
      maxBribe: bundle.maxBribe,
      minBribe: this.config.minBribe,
    };

    const result = this.bribeOptimizer.calculateOptimalBribe(optimizationParams);

    this.emit('bribeOptimized', {
      bundleId: bundle.id,
      optimalBribe: result.optimalBribe,
      expectedInclusionProbability: result.expectedInclusionProbability,
      reasoning: result.reasoning,
    });

    return result.optimalBribe;
  }

  /**
   * Increase bribe for retry attempts using optimizer
   */
  private increaseBribe(currentBribe: bigint, attemptNumber: number = 1): bigint {
    return this.bribeOptimizer.adjustBribeForRetry(
      currentBribe,
      attemptNumber,
      this.config.maxBribe
    );
  }

  /**
   * Cancel pending bundle
   */
  async cancelBundle(bundleId: string): Promise<boolean> {
    const bundle = this.pendingBundles.get(bundleId);
    if (!bundle || !bundle.txHashes) {
      return false;
    }

    let cancelledCount = 0;

    for (const txHash of bundle.txHashes) {
      try {
        // Calculate higher gas price for cancellation
        const currentGasPrice = await this.provider.getFeeData();
        const cancelGasPrice = (currentGasPrice.gasPrice || 0n) * 2n;

        const result = await this.relayManager.cancelTransaction(txHash, cancelGasPrice);

        if (result.success) {
          cancelledCount++;
        }
      } catch (error) {
        this.emit('cancellationFailed', {
          bundleId,
          txHash,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (cancelledCount > 0) {
      this.pendingBundles.delete(bundleId);
      this.emit('bundleCancelled', { bundleId, cancelledCount });
      return true;
    }

    return false;
  }

  /**
   * Replace pending transaction with higher bribe
   */
  async replaceTransaction(
    originalTxHash: string,
    newTransaction: TransactionRequest,
    additionalBribe: bigint
  ): Promise<SubmissionResult> {
    return this.relayManager.replaceTransaction(originalTxHash, newTransaction, additionalBribe);
  }

  /**
   * Monitor network conditions for bribe optimization
   */
  private startNetworkMonitoring(): void {
    // Update network gas price every 10 seconds
    setInterval(async () => {
      try {
        const feeData = await this.provider.getFeeData();
        this.networkGasPrice = feeData.gasPrice || 0n;

        // Update congestion level using bribe optimizer
        this.bribeOptimizer.updateCongestionLevel(this.networkGasPrice);
        this.congestionLevel = this.bribeOptimizer.getCurrentCongestion();
      } catch (error) {
        this.emit('networkMonitoringError', error);
      }
    }, 10000);
  }

  /**
   * Track submission for analytics
   */
  private trackSubmission(bundleId: string, result: SubmissionResult): void {
    if (!this.submissionHistory.has(bundleId)) {
      this.submissionHistory.set(bundleId, []);
    }

    this.submissionHistory.get(bundleId)!.push(result);
  }

  /**
   * Get bundle status
   */
  getBundleStatus(bundleId: string): TransactionBundle | undefined {
    return this.pendingBundles.get(bundleId);
  }

  /**
   * Get submission history
   */
  getSubmissionHistory(bundleId: string): SubmissionResult[] {
    return this.submissionHistory.get(bundleId) || [];
  }

  /**
   * Get bundler statistics including bribe optimizer stats
   */
  getStats(): {
    pendingBundles: number;
    totalSubmissions: number;
    successRate: number;
    averageBribe: bigint;
    networkGasPrice: bigint;
    congestionLevel: CongestionLevel;
    bribeOptimizerStats: any;
  } {
    const allSubmissions = Array.from(this.submissionHistory.values()).flat();
    const successfulSubmissions = allSubmissions.filter(s => s.success);

    const totalBribes = allSubmissions.reduce((sum, s) => sum + (s.bribe || 0n), 0n);
    const averageBribe =
      allSubmissions.length > 0 ? totalBribes / BigInt(allSubmissions.length) : 0n;

    return {
      pendingBundles: this.pendingBundles.size,
      totalSubmissions: allSubmissions.length,
      successRate:
        allSubmissions.length > 0 ? successfulSubmissions.length / allSubmissions.length : 0,
      averageBribe,
      networkGasPrice: this.networkGasPrice,
      congestionLevel: this.congestionLevel,
      bribeOptimizerStats: this.bribeOptimizer.getStats(),
    };
  }

  /**
   * Check if private relays are preferred
   */
  shouldUsePrivateRelay(): boolean {
    return this.relayManager.hasPrivateRelays();
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clean up expired bundles
   */
  cleanupExpiredBundles(): void {
    const now = Date.now();

    for (const [bundleId, bundle] of this.pendingBundles.entries()) {
      if (bundle.deadline < now) {
        this.pendingBundles.delete(bundleId);
        this.emit('bundleExpired', { bundleId });
      }
    }
  }
}

/**
 * Default bundler configuration
 */
export const DEFAULT_BUNDLER_CONFIG: BundlerConfig = {
  maxBribe: ethers.parseEther('0.01'), // 0.01 ETH max bribe
  minBribe: ethers.parseUnits('1', 'gwei'), // 1 gwei min bribe
  bribeIncrement: ethers.parseUnits('5', 'gwei'), // 5 gwei increment
  maxRetries: 3,
  retryDelay: 2000, // 2 seconds
  inclusionTimeout: 30000, // 30 seconds
  dynamicBribing: true,
};
