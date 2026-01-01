/**
 * Bundle Submission System
 *
 * Implements multi-transaction atomic execution with bundle optimization
 * and transaction ordering logic for Flashbots and bloXroute protocols
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { TransactionRequest } from '../types/execution';
import { Address } from '../types/common';

export interface BundleSubmitterConfig {
  readonly maxBundleSize: number;
  readonly maxGasPerBundle: bigint;
  readonly enableOptimization: boolean;
  readonly enableCoinbaseTransfer: boolean;
  readonly maxBribePercentage: number;
  readonly bundleTimeoutMs: number;
  readonly maxResubmissions: number;
  readonly resubmissionDelayMs: number;
}

export interface Bundle {
  readonly id: string;
  readonly transactions: BundleTransaction[];
  readonly targetBlock: number;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly coinbaseTransfer?: CoinbaseTransfer | undefined;
  readonly estimatedProfit: bigint;
  readonly totalGasLimit: bigint;
  readonly createdAt: number;
  readonly minTimestamp?: number;
  readonly maxTimestamp?: number;
}

export interface BundleTransaction {
  readonly to: Address;
  readonly data: string;
  readonly value: bigint;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly nonce: number;
  readonly priority: number;
}

export interface CoinbaseTransfer {
  readonly amount: bigint;
  readonly recipient: Address;
  readonly gasLimit: bigint;
}

export interface BundleSubmissionResult {
  readonly bundleId: string;
  success: boolean;
  bundleHash?: string | undefined;
  blockNumber?: number;
  included: boolean;
  failureReason?: string;
  readonly gasUsed?: bigint;
  readonly effectiveGasPrice?: bigint;
  readonly profit?: bigint;
  readonly submissionTime: number;
  inclusionTime?: number;
  readonly estimatedProfit?: bigint;
  readonly totalGasLimit?: bigint;
}

export interface RelaySubmissionResult {
  readonly relay: string;
  readonly success: boolean;
  readonly bundleHash?: string;
  readonly error?: string;
  readonly submissionTime: number;
}

export class BundleSubmitter extends EventEmitter {
  private readonly logger = createComponentLogger('bundle-submitter');
  private readonly config: BundleSubmitterConfig;
  private readonly provider: ethers.Provider;
  private readonly signer: ethers.Wallet;

  // Bundle tracking
  private readonly activeBundles = new Map<string, Bundle>();
  private readonly submissionHistory = new Map<string, BundleSubmissionResult>();
  private readonly resubmissionQueue = new Map<string, number>();

  // Relay endpoints
  private readonly relayEndpoints = new Map<string, string>();

  constructor(provider: ethers.Provider, signer: ethers.Wallet, config: BundleSubmitterConfig) {
    super();
    this.provider = provider;
    this.signer = signer;
    this.config = config;

    this.initializeRelayEndpoints();
    this.startBundleMonitoring();

    this.logger.info('Bundle submitter initialized', {
      maxBundleSize: this.config.maxBundleSize,
      enableOptimization: this.config.enableOptimization,
      enableCoinbaseTransfer: this.config.enableCoinbaseTransfer,
    });
  }

  /**
   * Submit bundle to multiple relays
   */
  async submitBundle(
    transactions: TransactionRequest[],
    targetBlock?: number,
    estimatedProfit?: bigint
  ): Promise<BundleSubmissionResult> {
    const startTime = Date.now();

    try {
      // Validate bundle size
      if (transactions.length > this.config.maxBundleSize) {
        throw new Error(
          `Bundle size ${transactions.length} exceeds maximum ${this.config.maxBundleSize}`
        );
      }

      // Create optimized bundle
      const bundle = await this.createOptimizedBundle(transactions, targetBlock, estimatedProfit);

      this.logger.info('Submitting bundle', {
        bundleId: bundle.id,
        transactionCount: bundle.transactions.length,
        targetBlock: bundle.targetBlock,
        estimatedProfit: bundle.estimatedProfit.toString(),
      });

      // Submit to all available relays
      const relayResults = await this.submitToRelays(bundle);

      // Track bundle for inclusion monitoring
      this.activeBundles.set(bundle.id, bundle);

      // Determine overall success
      const successfulSubmissions = relayResults.filter(r => r.success);
      const success = successfulSubmissions.length > 0;

      const result: BundleSubmissionResult = {
        bundleId: bundle.id,
        success,
        included: false, // Will be updated by monitoring
        submissionTime: Date.now() - startTime,
        bundleHash: successfulSubmissions[0]?.bundleHash,
        estimatedProfit: bundle.estimatedProfit,
        totalGasLimit: bundle.totalGasLimit,
      };

      if (!success) {
        result.failureReason = 'Failed to submit to any relay';
      }

      this.submissionHistory.set(bundle.id, result);

      this.emit('bundleSubmitted', {
        bundle,
        result,
        relayResults,
      });

      return result;
    } catch (error) {
      const result: BundleSubmissionResult = {
        bundleId: 'unknown',
        success: false,
        included: false,
        failureReason: error instanceof Error ? error.message : 'Unknown error',
        submissionTime: Date.now() - startTime,
      };

      this.logger.error('Bundle submission failed', {
        error: error instanceof Error ? error.message : String(error),
        transactionCount: transactions.length,
      });

      return result;
    }
  }

  /**
   * Create optimized bundle from transactions
   */
  private async createOptimizedBundle(
    transactions: TransactionRequest[],
    targetBlock?: number,
    estimatedProfit?: bigint
  ): Promise<Bundle> {
    const bundleId = this.generateBundleId();
    const currentBlock = await this.provider.getBlockNumber();
    const target = targetBlock || currentBlock + 1;

    // Convert to bundle transactions with optimization
    let bundleTransactions = await this.convertToBundleTransactions(transactions);

    // Apply bundle optimization if enabled
    if (this.config.enableOptimization) {
      bundleTransactions = await this.optimizeBundleTransactions(bundleTransactions);
    }

    // Calculate total gas limit
    const totalGasLimit = bundleTransactions.reduce((total, tx) => total + tx.gasLimit, 0n);

    // Validate gas limit
    if (totalGasLimit > this.config.maxGasPerBundle) {
      throw new Error(
        `Bundle gas limit ${totalGasLimit} exceeds maximum ${this.config.maxGasPerBundle}`
      );
    }

    // Create coinbase transfer if enabled and profitable
    let coinbaseTransfer: CoinbaseTransfer | undefined;
    if (this.config.enableCoinbaseTransfer && estimatedProfit) {
      coinbaseTransfer = await this.createCoinbaseTransfer(estimatedProfit);
    }

    return {
      id: bundleId,
      transactions: bundleTransactions,
      targetBlock: target,
      maxFeePerGas: this.calculateMaxFeePerGas(bundleTransactions),
      maxPriorityFeePerGas: this.calculateMaxPriorityFeePerGas(bundleTransactions),
      coinbaseTransfer,
      estimatedProfit: estimatedProfit || 0n,
      totalGasLimit,
      createdAt: Date.now(),
    };
  }

  /**
   * Convert transaction requests to bundle transactions
   */
  private async convertToBundleTransactions(
    transactions: TransactionRequest[]
  ): Promise<BundleTransaction[]> {
    const bundleTransactions: BundleTransaction[] = [];
    let nonce = await this.signer.getNonce();

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      if (!tx) continue;

      bundleTransactions.push({
        to: tx.to,
        data: tx.data,
        value: tx.value || 0n,
        gasLimit: tx.gasLimit,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        nonce: nonce + i,
        priority: i, // Default priority based on order
      });
    }

    return bundleTransactions;
  }

  /**
   * Optimize bundle transaction ordering
   */
  private async optimizeBundleTransactions(
    transactions: BundleTransaction[]
  ): Promise<BundleTransaction[]> {
    // Sort by priority (higher priority first)
    const optimized = [...transactions].sort((a, b) => b.priority - a.priority);

    // Apply gas optimization
    return this.optimizeGasUsage(optimized);
  }

  /**
   * Optimize gas usage across bundle transactions
   */
  private optimizeGasUsage(transactions: BundleTransaction[]): BundleTransaction[] {
    // Guard against empty transactions array
    if (transactions.length === 0) {
      return transactions;
    }

    // Calculate optimal gas prices based on bundle profitability
    const avgGasLimit =
      transactions.reduce((sum, tx) => sum + tx.gasLimit, 0n) / BigInt(transactions.length);

    return transactions.map(tx => ({
      ...tx,
      gasLimit: this.optimizeTransactionGasLimit(tx.gasLimit, avgGasLimit),
    }));
  }

  /**
   * Optimize individual transaction gas limit
   */
  private optimizeTransactionGasLimit(originalLimit: bigint, avgLimit: bigint): bigint {
    // Apply 10% buffer for safety
    const buffer = originalLimit / 10n;
    const optimizedLimit = originalLimit + buffer;

    // Don't exceed 150% of average
    const maxLimit = (avgLimit * 150n) / 100n;

    return optimizedLimit > maxLimit ? maxLimit : optimizedLimit;
  }

  /**
   * Create coinbase transfer for miner bribe
   */
  private async createCoinbaseTransfer(
    estimatedProfit: bigint
  ): Promise<CoinbaseTransfer | undefined> {
    try {
      // Calculate bribe as percentage of profit
      const maxBribeAmount = (estimatedProfit * BigInt(this.config.maxBribePercentage)) / 100n;

      // Minimum viable bribe (0.001 ETH)
      const minBribe = ethers.parseEther('0.001');

      if (maxBribeAmount < minBribe) {
        this.logger.debug('Profit too low for coinbase transfer', {
          estimatedProfit: estimatedProfit.toString(),
          maxBribeAmount: maxBribeAmount.toString(),
          minBribe: minBribe.toString(),
        });
        return undefined;
      }

      // Use 50% of max bribe for competitive advantage
      const bribeAmount = maxBribeAmount / 2n;

      return {
        amount: bribeAmount,
        recipient: '0x0000000000000000000000000000000000000000', // Will be set to block coinbase
        gasLimit: 21000n, // Standard ETH transfer
      };
    } catch (error) {
      this.logger.error('Failed to create coinbase transfer', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Submit bundle to all available relays
   */
  private async submitToRelays(bundle: Bundle): Promise<RelaySubmissionResult[]> {
    const results: RelaySubmissionResult[] = [];

    // Submit to Flashbots
    if (this.relayEndpoints.has('flashbots')) {
      const flashbotsResult = await this.submitToFlashbots(bundle);
      results.push(flashbotsResult);
    }

    // Submit to bloXroute
    if (this.relayEndpoints.has('bloxroute')) {
      const bloxrouteResult = await this.submitToBloxroute(bundle);
      results.push(bloxrouteResult);
    }

    return results;
  }

  /**
   * Submit bundle to Flashbots relay (REAL IMPLEMENTATION)
   */
  private async submitToFlashbots(bundle: Bundle): Promise<RelaySubmissionResult> {
    const startTime = Date.now();

    try {
      this.logger.debug('Submitting to Flashbots', {
        bundleId: bundle.id,
        targetBlock: bundle.targetBlock,
        transactionCount: bundle.transactions.length,
      });

      // Sign all transactions in bundle - convert to proper ethers.TransactionLike format
      const signedTransactions = await Promise.all(
        bundle.transactions.map(async tx => {
          // Get network info for proper transaction formatting
          const network = await this.provider.getNetwork();

          // Convert BundleTransaction to ethers.TransactionLike
          const ethersTransaction: ethers.TransactionRequest = {
            to: tx.to,
            data: tx.data,
            value: tx.value || 0n,
            gasLimit: tx.gasLimit,
            nonce: tx.nonce,
            type: tx.maxFeePerGas ? 2 : 0, // EIP-1559 if maxFeePerGas present
            chainId: network.chainId,
          };

          // Add EIP-1559 fields if present
          if (tx.maxFeePerGas) {
            ethersTransaction.maxFeePerGas = tx.maxFeePerGas;
          }
          if (tx.maxPriorityFeePerGas) {
            ethersTransaction.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
          }
          // BundleTransaction always uses EIP-1559, no legacy gasPrice

          return await this.signer.signTransaction(ethersTransaction);
        })
      );

      // Store transaction hashes for inclusion tracking
      const txHashes = new Set<string>();
      for (const signedTx of signedTransactions) {
        const txHash = ethers.keccak256(signedTx);
        txHashes.add(txHash);
      }
      this.bundleTransactionHashes.set(bundle.id, txHashes);

      // Prepare Flashbots bundle request
      const bundleRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'mev_sendBundle',
        params: [
          {
            txs: signedTransactions,
            blockNumber: `0x${bundle.targetBlock.toString(16)}`,
            minTimestamp: bundle.minTimestamp,
            maxTimestamp: bundle.maxTimestamp,
          },
        ],
      };

      // Get Flashbots endpoint
      const flashbotsEndpoint =
        this.relayEndpoints.get('flashbots') || 'https://relay.flashbots.net';

      // Prepare headers with authentication
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Flashbots-Signature': await this.signFlashbotsRequest(JSON.stringify(bundleRequest)),
      };

      // Submit bundle
      const response = await fetch(flashbotsEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(bundleRequest),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = (await response.json()) as {
        error?: { message: string };
        result?: { bundleHash: string };
      };

      if (result.error) {
        throw new Error(`Flashbots error: ${result.error.message}`);
      }

      const bundleHash = result.result?.bundleHash;

      if (!bundleHash) {
        throw new Error('No bundle hash returned from Flashbots');
      }

      this.logger.info('Bundle submitted to Flashbots', {
        bundleId: bundle.id,
        bundleHash,
        targetBlock: bundle.targetBlock,
        submissionTime: Date.now() - startTime,
      });

      return {
        relay: 'flashbots',
        success: true,
        bundleHash,
        submissionTime: Date.now() - startTime,
      };
    } catch (error) {
      this.logger.error('Flashbots submission failed', {
        bundleId: bundle.id,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        relay: 'flashbots',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        submissionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Submit bundle to bloXroute relay (REAL IMPLEMENTATION)
   */
  private async submitToBloxroute(bundle: Bundle): Promise<RelaySubmissionResult> {
    const startTime = Date.now();

    try {
      this.logger.debug('Submitting to bloXroute', {
        bundleId: bundle.id,
        targetBlock: bundle.targetBlock,
        transactionCount: bundle.transactions.length,
      });

      // Sign all transactions in bundle
      const signedTransactions = await Promise.all(
        bundle.transactions.map(tx => this.signer.signTransaction(tx))
      );

      // Prepare bloXroute bundle request
      const bundleRequest = {
        transactions: signedTransactions,
        block_number: bundle.targetBlock,
        min_timestamp: bundle.minTimestamp,
        max_timestamp: bundle.maxTimestamp,
        blockchain_network: 'Base',
      };

      // Get bloXroute endpoint and API key
      const bloxrouteEndpoint = this.relayEndpoints.get('bloxroute') || 'https://api.bloxroute.com';
      const apiKey = process.env['BLOXROUTE_API_KEY'];

      if (!apiKey) {
        throw new Error('BLOXROUTE_API_KEY environment variable required');
      }

      const headers = {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      };

      // Submit bundle
      const response = await fetch(`${bloxrouteEndpoint}/v1/bundle`, {
        method: 'POST',
        headers,
        body: JSON.stringify(bundleRequest),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = (await response.json()) as {
        success?: boolean;
        error?: string;
        bundle_hash?: string;
      };

      if (!result.success) {
        throw new Error(`bloXroute error: ${result.error || 'Unknown error'}`);
      }

      const bundleHash = result.bundle_hash;

      if (!bundleHash) {
        throw new Error('No bundle hash returned from bloXroute');
      }

      this.logger.info('Bundle submitted to bloXroute', {
        bundleId: bundle.id,
        bundleHash,
        targetBlock: bundle.targetBlock,
        submissionTime: Date.now() - startTime,
      });

      return {
        relay: 'bloxroute',
        success: true,
        bundleHash,
        submissionTime: Date.now() - startTime,
      };
    } catch (error) {
      this.logger.error('bloXroute submission failed', {
        bundleId: bundle.id,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        relay: 'bloxroute',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        submissionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Sign Flashbots request for authentication
   */
  private async signFlashbotsRequest(body: string): Promise<string> {
    const messageHash = ethers.keccak256(ethers.toUtf8Bytes(body));
    const signature = await this.signer.signMessage(ethers.getBytes(messageHash));
    const signerAddress = await this.signer.getAddress();
    return `${signerAddress}:${signature}`;
  }

  /**
   * Start bundle inclusion monitoring
   */
  private startBundleMonitoring(): void {
    // Create bound handler for block events
    this.blockListener = async (blockNumber: number) => {
      await this.checkBundleInclusion(blockNumber);
    };

    // Monitor for bundle inclusion every block
    this.provider.on('block', this.blockListener);

    // Clean up old bundles periodically
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldBundles();
    }, 60000); // Every minute

    // Handle resubmissions
    this.resubmissionInterval = setInterval(() => {
      this.handleResubmissions();
    }, this.config.resubmissionDelayMs);
  }

  /**
   * Stop bundle monitoring and cleanup resources
   */
  stop(): void {
    // Remove block listener
    if (this.blockListener) {
      this.provider.off('block', this.blockListener);
      this.blockListener = null;
    }

    // Clear intervals
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.resubmissionInterval) {
      clearInterval(this.resubmissionInterval);
      this.resubmissionInterval = null;
    }

    // Clear data structures
    this.activeBundles.clear();
    this.submissionHistory.clear();
    this.resubmissionQueue.clear();
    this.bundleTransactionHashes.clear();

    this.logger.info('Bundle submitter stopped');
  }

  /**
   * Check if any active bundles were included in the block
   */
  private async checkBundleInclusion(blockNumber: number): Promise<void> {
    try {
      const block = await this.provider.getBlock(blockNumber, true);
      if (!block || !block.transactions) return;

      for (const [bundleId, bundle] of this.activeBundles) {
        if (bundle.targetBlock <= blockNumber) {
          const included = await this.isBundleIncluded(bundle, block);

          if (included) {
            await this.handleBundleInclusion(bundleId, bundle, blockNumber);
          } else if (blockNumber > bundle.targetBlock + 2) {
            // Bundle missed, consider resubmission or mark as failed
            await this.handleBundleMiss(bundleId, bundle);
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to check bundle inclusion', {
        blockNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Bundle transaction hash tracking
  private bundleTransactionHashes = new Map<string, Set<string>>();

  // Interval tracking for cleanup
  private blockListener: ((blockNumber: number) => void) | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private resubmissionInterval: NodeJS.Timeout | null = null;

  /**
   * Check if bundle was included in block
   */
  private async isBundleIncluded(bundle: Bundle, block: ethers.Block): Promise<boolean> {
    // Get stored transaction hashes for this bundle
    const bundleTxHashes = this.bundleTransactionHashes.get(bundle.id);
    if (!bundleTxHashes) {
      this.logger.warn('No transaction hashes found for bundle', { bundleId: bundle.id });
      return false;
    }

    for (const txData of block.transactions) {
      let txHash: string;

      if (typeof txData === 'string') {
        txHash = txData;
      } else if (txData && typeof txData === 'object' && 'hash' in txData) {
        txHash = (txData as any).hash;
      } else {
        continue; // Skip invalid transaction data
      }

      if (bundleTxHashes.has(txHash)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Handle successful bundle inclusion
   */
  private async handleBundleInclusion(
    bundleId: string,
    bundle: Bundle,
    blockNumber: number
  ): Promise<void> {
    this.logger.info('Bundle included in block', {
      bundleId,
      blockNumber,
      targetBlock: bundle.targetBlock,
      transactionCount: bundle.transactions.length,
    });

    // Update submission result
    const result = this.submissionHistory.get(bundleId);
    if (result) {
      result.included = true;
      result.blockNumber = blockNumber;
      result.inclusionTime = Date.now();
    }

    // Remove from active bundles
    this.activeBundles.delete(bundleId);

    this.emit('bundleIncluded', {
      bundleId,
      bundle,
      blockNumber,
    });
  }

  /**
   * Handle bundle miss (not included)
   */
  private async handleBundleMiss(bundleId: string, bundle: Bundle): Promise<void> {
    this.logger.warn('Bundle missed inclusion', {
      bundleId,
      targetBlock: bundle.targetBlock,
      transactionCount: bundle.transactions.length,
    });

    // Check if we should resubmit
    const resubmissionCount = this.resubmissionQueue.get(bundleId) || 0;

    if (resubmissionCount < this.config.maxResubmissions) {
      this.resubmissionQueue.set(bundleId, resubmissionCount + 1);
      this.logger.info('Queuing bundle for resubmission', {
        bundleId,
        attempt: resubmissionCount + 1,
      });
    } else {
      // Mark as failed
      const result = this.submissionHistory.get(bundleId);
      if (result) {
        result.failureReason = 'Bundle not included after maximum resubmissions';
      }

      this.activeBundles.delete(bundleId);
      this.resubmissionQueue.delete(bundleId);

      this.emit('bundleFailed', {
        bundleId,
        bundle,
        reason: 'Maximum resubmissions exceeded',
      });
    }
  }

  /**
   * Handle bundle resubmissions
   */
  private async handleResubmissions(): Promise<void> {
    for (const [bundleId, attempt] of this.resubmissionQueue) {
      const bundle = this.activeBundles.get(bundleId);
      if (!bundle) continue;

      try {
        // Update target block for resubmission
        const currentBlock = await this.provider.getBlockNumber();
        const updatedBundle = {
          ...bundle,
          targetBlock: currentBlock + 1,
        };

        this.logger.info('Resubmitting bundle', {
          bundleId,
          attempt,
          newTargetBlock: updatedBundle.targetBlock,
        });

        // Resubmit to relays
        await this.submitToRelays(updatedBundle);

        // Update active bundle
        this.activeBundles.set(bundleId, updatedBundle);
      } catch (error) {
        this.logger.error('Failed to resubmit bundle', {
          bundleId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Clear resubmission queue
    this.resubmissionQueue.clear();
  }

  /**
   * Clean up old bundles and history
   */
  private cleanupOldBundles(): void {
    const now = Date.now();
    const maxAge = this.config.bundleTimeoutMs;

    // Clean up active bundles
    for (const [bundleId, bundle] of this.activeBundles) {
      if (now - bundle.createdAt > maxAge) {
        this.activeBundles.delete(bundleId);
        this.logger.debug('Cleaned up old bundle', { bundleId });
      }
    }

    // Clean up submission history (keep for 1 hour)
    for (const [bundleId, result] of this.submissionHistory) {
      if (now - result.submissionTime > 3600000) {
        // 1 hour
        this.submissionHistory.delete(bundleId);
      }
    }
  }

  /**
   * Calculate maximum fee per gas for bundle
   */
  private calculateMaxFeePerGas(transactions: BundleTransaction[]): bigint {
    return transactions.reduce((max, tx) => (tx.maxFeePerGas > max ? tx.maxFeePerGas : max), 0n);
  }

  /**
   * Calculate maximum priority fee per gas for bundle
   */
  private calculateMaxPriorityFeePerGas(transactions: BundleTransaction[]): bigint {
    return transactions.reduce(
      (max, tx) => (tx.maxPriorityFeePerGas > max ? tx.maxPriorityFeePerGas : max),
      0n
    );
  }

  /**
   * Generate unique bundle ID
   */
  private generateBundleId(): string {
    return 'bundle_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Initialize relay endpoints
   */
  private initializeRelayEndpoints(): void {
    this.relayEndpoints.set(
      'flashbots',
      process.env['FLASHBOTS_RELAY_URL'] || 'https://relay.flashbots.net'
    );
    this.relayEndpoints.set(
      'bloxroute',
      process.env['BLOXROUTE_RELAY_URL'] || 'https://api.bloxroute.com'
    );

    this.logger.info('Relay endpoints initialized', {
      relays: Array.from(this.relayEndpoints.keys()),
    });
  }

  /**
   * Get bundle submission statistics
   */
  getBundleStats(): {
    activeBundles: number;
    totalSubmissions: number;
    successfulInclusions: number;
    failedSubmissions: number;
    inclusionRate: number;
  } {
    const totalSubmissions = this.submissionHistory.size;
    const successfulInclusions = Array.from(this.submissionHistory.values()).filter(
      result => result.included
    ).length;
    const failedSubmissions = Array.from(this.submissionHistory.values()).filter(
      result => !result.success
    ).length;

    return {
      activeBundles: this.activeBundles.size,
      totalSubmissions,
      successfulInclusions,
      failedSubmissions,
      inclusionRate: totalSubmissions > 0 ? successfulInclusions / totalSubmissions : 0,
    };
  }
}
