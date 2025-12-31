/**
 * Private Relay Manager
 *
 * Manages private relay integration for MEV protection
 * Requirements: 1.3
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { TransactionRequest } from '../types/transaction';
import {
  RelayProvider,
  RelayProviderConfig,
  RelayAuthentication,
  RelayMetrics,
  SubmissionOptions,
  RelaySubmissionResult,
  BundleSubmission,
  BundleSubmissionResult,
  RelaySelectionCriteria,
  PrivateRelayManagerConfig,
  IPrivateRelayManager,
  RelayEvents,
  RelayError,
  RelayUnavailableError,
  BundleSubmissionError,
} from '../types/private-relay';

/**
 * Private Relay Manager Implementation
 */
export class PrivateRelayManager extends EventEmitter implements IPrivateRelayManager {
  private readonly logger = createComponentLogger('private-relay-manager');
  private readonly config: PrivateRelayManagerConfig;
  private readonly provider: ethers.Provider;
  private readonly signer: ethers.Signer;

  private readonly relayConfigs = new Map<RelayProvider, RelayProviderConfig>();
  private readonly relayMetrics = new Map<RelayProvider, RelayMetrics>();
  private readonly activeSubmissions = new Map<string, Promise<RelaySubmissionResult>>();

  private isRunning = false;
  private metricsCleanupInterval: NodeJS.Timeout | undefined;

  constructor(
    provider: ethers.Provider,
    signer: ethers.Signer,
    config: Partial<PrivateRelayManagerConfig> = {}
  ) {
    super();

    this.provider = provider;
    this.signer = signer;

    this.config = {
      defaultRelay: config.defaultRelay ?? RelayProvider.FLASHBOTS_PROTECT,
      enableFallback: config.enableFallback ?? true,
      maxConcurrentSubmissions: config.maxConcurrentSubmissions ?? 10,
      selectionStrategy: config.selectionStrategy ?? 'balanced',
      enableMetrics: config.enableMetrics ?? true,
      metricsRetentionMs: config.metricsRetentionMs ?? 24 * 60 * 60 * 1000, // 24 hours
      enableBundles: config.enableBundles ?? true,
      maxBundleSize: config.maxBundleSize ?? 5,
      relayProviders: config.relayProviders ?? this.getDefaultRelayConfigs(),
      ...config,
    };

    this.initializeRelayConfigs();
    this.initializeMetrics();

    this.logger.info('Private relay manager initialized', {
      defaultRelay: this.config.defaultRelay,
      enabledRelays: this.config.relayProviders.filter(r => r.enabled).map(r => r.provider),
      selectionStrategy: this.config.selectionStrategy,
    });
  }

  /**
   * Start private relay manager
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Private relay manager is already running');
      return;
    }

    this.isRunning = true;

    // Start metrics cleanup interval
    if (this.config.enableMetrics) {
      this.metricsCleanupInterval = setInterval(() => {
        this.cleanupOldMetrics();
      }, 60000); // Every minute
    }

    // Test relay connectivity
    await this.testRelayConnectivity();

    this.logger.info('Private relay manager started');
  }

  /**
   * Stop private relay manager
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Private relay manager is not running');
      return;
    }

    this.isRunning = false;

    if (this.metricsCleanupInterval) {
      clearInterval(this.metricsCleanupInterval);
      this.metricsCleanupInterval = undefined;
    }

    // Wait for active submissions to complete
    const activeSubmissions = Array.from(this.activeSubmissions.values());
    if (activeSubmissions.length > 0) {
      this.logger.info('Waiting for active submissions to complete...', {
        count: activeSubmissions.length,
      });

      await Promise.allSettled(activeSubmissions);
    }

    this.logger.info('Private relay manager stopped');
  }

  /**
   * Submit transaction via optimal relay
   */
  async submitTransaction(
    transaction: TransactionRequest,
    options: SubmissionOptions = {}
  ): Promise<RelaySubmissionResult> {
    const startTime = Date.now();
    const submissionId = `tx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    try {
      // Check if we're at submission limit
      if (this.activeSubmissions.size >= this.config.maxConcurrentSubmissions) {
        throw new RelayError('Maximum concurrent submissions reached', this.config.defaultRelay);
      }

      // Select optimal relay
      const criteria: RelaySelectionCriteria = {
        transaction,
        options,
        currentGasPrice: transaction.maxFeePerGas,
        networkCongestion: await this.assessNetworkCongestion(),
        urgency: options.urgency ?? 'medium',
      };

      const selectedRelay = await this.selectOptimalRelay(criteria);

      // Create submission promise
      const submissionPromise = this.executeSubmission(
        transaction,
        selectedRelay,
        options,
        startTime
      );
      this.activeSubmissions.set(submissionId, submissionPromise);

      try {
        const result = await submissionPromise;
        return result;
      } finally {
        this.activeSubmissions.delete(submissionId);
      }
    } catch (error) {
      this.activeSubmissions.delete(submissionId);

      const failureReason = error instanceof Error ? error.message : String(error);
      const result: RelaySubmissionResult = {
        success: false,
        relayProvider: options.preferredRelay ?? this.config.defaultRelay,
        latency: Date.now() - startTime,
        failureReason,
        retryCount: 0,
        timestamp: Date.now(),
      };

      this.logger.error('Transaction submission failed', {
        error: failureReason,
        latency: result.latency,
      });

      return result;
    }
  }

  /**
   * Submit bundle of transactions
   */
  async submitBundle(
    bundle: BundleSubmission,
    options: SubmissionOptions = {}
  ): Promise<BundleSubmissionResult> {
    if (!this.config.enableBundles) {
      throw new RelayError('Bundle submission is disabled', this.config.defaultRelay);
    }

    if (bundle.transactions.length > this.config.maxBundleSize) {
      throw new RelayError(
        `Bundle size ${bundle.transactions.length} exceeds maximum ${this.config.maxBundleSize}`,
        this.config.defaultRelay
      );
    }

    const startTime = Date.now();

    try {
      // Find relay that supports bundles
      const bundleCapableRelay = this.config.relayProviders.find(
        relay => relay.enabled && relay.capabilities.supportsBundle
      );

      if (!bundleCapableRelay) {
        throw new BundleSubmissionError(
          this.config.defaultRelay,
          'No relay supports bundle submission'
        );
      }

      const result = await this.executeBundleSubmission(
        bundle,
        bundleCapableRelay,
        options,
        startTime
      );

      this.emit('bundleSubmitted', {
        relayProvider: bundleCapableRelay.provider,
        bundleHash: result.bundleHash,
        transactionCount: bundle.transactions.length,
        timestamp: Date.now(),
      } satisfies RelayEvents['bundleSubmitted']);

      return result;
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);

      this.logger.error('Bundle submission failed', {
        transactionCount: bundle.transactions.length,
        error: failureReason,
      });

      return {
        success: false,
        relayProvider: this.config.defaultRelay,
        latency: Date.now() - startTime,
        failureReason,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Select optimal relay for transaction
   */
  async selectOptimalRelay(criteria: RelaySelectionCriteria): Promise<RelayProviderConfig> {
    const availableRelays = this.config.relayProviders.filter(relay => {
      if (!relay.enabled) return false;

      // Check if relay is healthy
      const metrics = this.relayMetrics.get(relay.provider);
      if (metrics && metrics.consecutiveFailures >= 3) return false;

      return true;
    });

    if (availableRelays.length === 0) {
      throw new RelayUnavailableError(this.config.defaultRelay, 'No healthy relays available');
    }

    // Prefer specified relay if available and healthy
    if (criteria.options.preferredRelay) {
      const preferredRelay = availableRelays.find(
        r => r.provider === criteria.options.preferredRelay
      );
      if (preferredRelay) {
        return preferredRelay;
      }
    }

    // Select based on strategy
    switch (this.config.selectionStrategy) {
      case 'cost':
        return this.selectByCost(availableRelays, criteria);
      case 'speed':
        return this.selectBySpeed(availableRelays, criteria);
      case 'reliability':
        return this.selectByReliability(availableRelays, criteria);
      case 'balanced':
      default:
        return this.selectBalanced(availableRelays, criteria);
    }
  }

  /**
   * Get relay metrics
   */
  getRelayMetrics(provider?: RelayProvider): RelayMetrics | Record<RelayProvider, RelayMetrics> {
    if (provider) {
      return this.relayMetrics.get(provider) || this.createEmptyMetrics();
    }

    const allMetrics: Record<RelayProvider, RelayMetrics> = {} as any;
    for (const [relayProvider, metrics] of this.relayMetrics) {
      allMetrics[relayProvider] = { ...metrics };
    }

    return allMetrics;
  }

  /**
   * Check relay health
   */
  async checkRelayHealth(provider: RelayProvider): Promise<boolean> {
    const config = this.relayConfigs.get(provider);
    if (!config || !config.enabled) {
      return false;
    }

    try {
      // Simple health check - attempt to connect to relay endpoint
      const response = await fetch(config.endpoint, {
        method: 'GET',
        headers: this.buildAuthHeaders(config.authentication),
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      return response.ok;
    } catch (error) {
      this.logger.debug('Relay health check failed', {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Update relay configuration
   */
  updateRelayConfig(provider: RelayProvider, config: Partial<RelayProviderConfig>): void {
    const existingConfig = this.relayConfigs.get(provider);
    if (!existingConfig) {
      throw new RelayError(`Relay ${provider} not found`, provider);
    }

    const updatedConfig = { ...existingConfig, ...config };
    this.relayConfigs.set(provider, updatedConfig);

    this.logger.info('Relay configuration updated', {
      provider,
      changes: Object.keys(config),
    });
  }

  /**
   * Execute transaction submission
   */
  private async executeSubmission(
    transaction: TransactionRequest,
    relayConfig: RelayProviderConfig,
    options: SubmissionOptions,
    startTime: number
  ): Promise<RelaySubmissionResult> {
    let retryCount = 0;
    let lastError: Error | undefined;

    while (retryCount <= relayConfig.maxRetries) {
      try {
        const result = await this.submitToRelay(transaction, relayConfig, options);

        // Update metrics on success
        this.updateRelayMetrics(relayConfig.provider, true, Date.now() - startTime);

        // Emit success event
        this.emit('transactionSubmitted', {
          relayProvider: relayConfig.provider,
          transactionHash: result.transactionHash,
          latency: result.latency,
          timestamp: Date.now(),
        } satisfies RelayEvents['transactionSubmitted']);

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retryCount++;

        // Update metrics on failure
        this.updateRelayMetrics(relayConfig.provider, false, Date.now() - startTime);

        // Emit failure event
        this.emit('transactionFailed', {
          relayProvider: relayConfig.provider,
          reason: lastError.message,
          retryCount,
          timestamp: Date.now(),
        } satisfies RelayEvents['transactionFailed']);

        // Check if we should retry
        if (
          retryCount <= relayConfig.maxRetries &&
          error instanceof RelayError &&
          error.retryable
        ) {
          this.logger.warn('Relay submission failed, retrying...', {
            provider: relayConfig.provider,
            attempt: retryCount,
            maxRetries: relayConfig.maxRetries,
            error: lastError.message,
          });

          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
          continue;
        }

        break;
      }
    }

    // All retries failed, try fallback if enabled
    if (this.config.enableFallback && options.enableFallback !== false) {
      return await this.tryFallbackSubmission(transaction, relayConfig, options, startTime);
    }

    // No fallback or fallback disabled
    throw lastError || new RelayError('Submission failed after all retries', relayConfig.provider);
  }

  /**
   * Submit transaction to specific relay
   */
  private async submitToRelay(
    transaction: TransactionRequest,
    relayConfig: RelayProviderConfig,
    options: SubmissionOptions
  ): Promise<RelaySubmissionResult> {
    const startTime = Date.now();

    try {
      let result: RelaySubmissionResult;

      switch (relayConfig.provider) {
        case RelayProvider.FLASHBOTS_PROTECT:
          result = await this.submitToFlashbots(transaction, relayConfig, options);
          break;
        case RelayProvider.BLOXROUTE:
          result = await this.submitToBloxroute(transaction, relayConfig, options);
          break;
        case RelayProvider.LOCAL_NODE:
          result = await this.submitToLocalNode(transaction, relayConfig, options);
          break;
        default:
          throw new RelayError(
            `Unsupported relay provider: ${relayConfig.provider}`,
            relayConfig.provider
          );
      }

      result.latency = Date.now() - startTime;
      result.timestamp = Date.now();

      return result;
    } catch (error) {
      if (error instanceof RelayError) {
        throw error;
      }

      throw new RelayError(
        `Relay submission failed: ${error instanceof Error ? error.message : String(error)}`,
        relayConfig.provider,
        true
      );
    }
  }

  /**
   * Submit to Flashbots Protect
   */
  private async submitToFlashbots(
    transaction: TransactionRequest,
    relayConfig: RelayProviderConfig,
    _options: SubmissionOptions
  ): Promise<RelaySubmissionResult> {
    // Sign transaction
    const signedTx = await this.signer.signTransaction(transaction);

    const requestBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendRawTransaction',
      params: [signedTx],
    };

    const response = await fetch(relayConfig.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.buildAuthHeaders(relayConfig.authentication),
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(relayConfig.timeoutMs),
    });

    if (!response.ok) {
      throw new RelayError(
        `Flashbots request failed: ${response.statusText}`,
        RelayProvider.FLASHBOTS_PROTECT,
        true
      );
    }

    const data = (await response.json()) as { error?: { message: string }; result?: string };

    if (data.error) {
      throw new RelayError(
        `Flashbots error: ${data.error.message}`,
        RelayProvider.FLASHBOTS_PROTECT,
        true
      );
    }

    return {
      success: true,
      relayProvider: RelayProvider.FLASHBOTS_PROTECT,
      transactionHash: data.result || '',
      latency: 0, // Will be set by caller
      gasPriceUsed: transaction.maxFeePerGas,
      retryCount: 0,
      timestamp: 0, // Will be set by caller
    };
  }

  /**
   * Submit to bloXroute
   */
  private async submitToBloxroute(
    transaction: TransactionRequest,
    relayConfig: RelayProviderConfig,
    _options: SubmissionOptions
  ): Promise<RelaySubmissionResult> {
    // Sign transaction
    const signedTx = await this.signer.signTransaction(transaction);

    const requestBody = {
      transaction: signedTx,
      blockchain_network: 'Base-Mainnet',
    };

    const response = await fetch(`${relayConfig.endpoint}/tx`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.buildAuthHeaders(relayConfig.authentication),
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(relayConfig.timeoutMs),
    });

    if (!response.ok) {
      throw new RelayError(
        `bloXroute request failed: ${response.statusText}`,
        RelayProvider.BLOXROUTE,
        true
      );
    }

    const data = (await response.json()) as { tx_hash?: string };

    if (!data.tx_hash) {
      throw new RelayError(
        'bloXroute did not return transaction hash',
        RelayProvider.BLOXROUTE,
        true
      );
    }

    return {
      success: true,
      relayProvider: RelayProvider.BLOXROUTE,
      transactionHash: data.tx_hash,
      latency: 0, // Will be set by caller
      gasPriceUsed: transaction.maxFeePerGas,
      retryCount: 0,
      timestamp: 0, // Will be set by caller
    };
  }

  /**
   * Submit to local node (fallback)
   */
  private async submitToLocalNode(
    transaction: TransactionRequest,
    _relayConfig: RelayProviderConfig,
    _options: SubmissionOptions
  ): Promise<RelaySubmissionResult> {
    const txResponse = await this.signer.sendTransaction(transaction);

    return {
      success: true,
      relayProvider: RelayProvider.LOCAL_NODE,
      transactionHash: txResponse.hash,
      latency: 0, // Will be set by caller
      gasPriceUsed: transaction.maxFeePerGas,
      retryCount: 0,
      timestamp: 0, // Will be set by caller
    };
  }

  /**
   * Execute bundle submission
   */
  private async executeBundleSubmission(
    bundle: BundleSubmission,
    relayConfig: RelayProviderConfig,
    options: SubmissionOptions,
    _startTime: number
  ): Promise<BundleSubmissionResult> {
    // For now, implement basic bundle submission for Flashbots
    if (relayConfig.provider === RelayProvider.FLASHBOTS_PROTECT) {
      return await this.submitBundleToFlashbots(bundle, relayConfig, options);
    }

    throw new BundleSubmissionError(
      relayConfig.provider,
      'Bundle submission not implemented for this relay'
    );
  }

  /**
   * Submit bundle to Flashbots
   */
  private async submitBundleToFlashbots(
    bundle: BundleSubmission,
    relayConfig: RelayProviderConfig,
    _options: SubmissionOptions
  ): Promise<BundleSubmissionResult> {
    // Sign all transactions
    const signedTxs = await Promise.all(
      bundle.transactions.map(tx => this.signer.signTransaction(tx))
    );

    const requestBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'mev_sendBundle',
      params: [
        {
          txs: signedTxs,
          blockNumber: bundle.targetBlockNumber
            ? `0x${bundle.targetBlockNumber.toString(16)}`
            : undefined,
          minTimestamp: bundle.minTimestamp,
          maxTimestamp: bundle.maxTimestamp,
        },
      ],
    };

    const response = await fetch(relayConfig.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.buildAuthHeaders(relayConfig.authentication),
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(relayConfig.timeoutMs),
    });

    if (!response.ok) {
      throw new BundleSubmissionError(
        RelayProvider.FLASHBOTS_PROTECT,
        `Request failed: ${response.statusText}`
      );
    }

    const data = (await response.json()) as {
      error?: { message: string };
      result?: { bundleHash?: string; submissionId?: string };
    };

    if (data.error) {
      throw new BundleSubmissionError(RelayProvider.FLASHBOTS_PROTECT, data.error.message);
    }

    return {
      success: true,
      relayProvider: RelayProvider.FLASHBOTS_PROTECT,
      bundleHash: data.result?.bundleHash,
      submissionId: data.result?.submissionId,
      transactionHashes: bundle.transactions.map(tx =>
        ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(tx)))
      ),
      latency: 0, // Will be set by caller
      timestamp: Date.now(),
    };
  }

  /**
   * Try fallback submission
   */
  private async tryFallbackSubmission(
    transaction: TransactionRequest,
    failedRelayConfig: RelayProviderConfig,
    options: SubmissionOptions,
    startTime: number
  ): Promise<RelaySubmissionResult> {
    // Find next best relay
    const fallbackRelays = this.config.relayProviders
      .filter(relay => relay.enabled && relay.provider !== failedRelayConfig.provider)
      .sort((a, b) => a.priority - b.priority);

    if (fallbackRelays.length === 0) {
      throw new RelayUnavailableError(this.config.defaultRelay, 'No fallback relays available');
    }

    const fallbackRelay = fallbackRelays[0];
    if (!fallbackRelay) {
      throw new RelayUnavailableError(this.config.defaultRelay, 'No fallback relays available');
    }

    this.logger.info('Activating fallback relay', {
      originalRelay: failedRelayConfig.provider,
      fallbackRelay: fallbackRelay.provider,
    });

    this.emit('fallbackActivated', {
      originalRelay: failedRelayConfig.provider,
      fallbackRelay: fallbackRelay.provider,
      reason: 'Primary relay failed',
      timestamp: Date.now(),
    } satisfies RelayEvents['fallbackActivated']);

    return await this.executeSubmission(transaction, fallbackRelay, options, startTime);
  }

  /**
   * Selection strategies
   */
  private selectByCost(
    relays: RelayProviderConfig[],
    criteria: RelaySelectionCriteria
  ): RelayProviderConfig {
    return relays.reduce((best, current) => {
      const bestCost = this.calculateRelayCost(best, criteria);
      const currentCost = this.calculateRelayCost(current, criteria);
      return currentCost < bestCost ? current : best;
    });
  }

  private selectBySpeed(
    relays: RelayProviderConfig[],
    _criteria: RelaySelectionCriteria
  ): RelayProviderConfig {
    return relays.reduce((best, current) => {
      const bestSpeed = best.capabilities.estimatedInclusionTime;
      const currentSpeed = current.capabilities.estimatedInclusionTime;
      return currentSpeed < bestSpeed ? current : best;
    });
  }

  private selectByReliability(
    relays: RelayProviderConfig[],
    _criteria: RelaySelectionCriteria
  ): RelayProviderConfig {
    return relays.reduce((best, current) => {
      const bestMetrics = this.relayMetrics.get(best.provider) || this.createEmptyMetrics();
      const currentMetrics = this.relayMetrics.get(current.provider) || this.createEmptyMetrics();
      return currentMetrics.successRate > bestMetrics.successRate ? current : best;
    });
  }

  private selectBalanced(
    relays: RelayProviderConfig[],
    criteria: RelaySelectionCriteria
  ): RelayProviderConfig {
    return relays.reduce((best, current) => {
      const bestScore = this.calculateBalancedScore(best, criteria);
      const currentScore = this.calculateBalancedScore(current, criteria);
      return currentScore > bestScore ? current : best;
    });
  }

  /**
   * Helper methods
   */
  private calculateRelayCost(relay: RelayProviderConfig, criteria: RelaySelectionCriteria): number {
    const baseCost = Number(relay.costs.baseFee);
    const gasCost = Number(criteria.currentGasPrice) * relay.costs.priorityFeeMultiplier;
    return baseCost + gasCost;
  }

  private calculateBalancedScore(
    relay: RelayProviderConfig,
    criteria: RelaySelectionCriteria
  ): number {
    const metrics = this.relayMetrics.get(relay.provider) || this.createEmptyMetrics();
    const cost = this.calculateRelayCost(relay, criteria);
    const speed = relay.capabilities.estimatedInclusionTime;
    const reliability = metrics.successRate;

    // Balanced scoring: 40% reliability, 30% cost (inverted), 30% speed (inverted)
    const costScore = Math.max(0, 1 - cost / 100000); // Normalize cost
    const speedScore = Math.max(0, 1 - speed / 60000); // Normalize speed (1 minute max)

    return reliability * 0.4 + costScore * 0.3 + speedScore * 0.3;
  }

  private buildAuthHeaders(auth: RelayAuthentication): Record<string, string> {
    const headers: Record<string, string> = {};

    switch (auth.type) {
      case 'api-key':
        if (auth.apiKey) {
          headers['X-API-Key'] = auth.apiKey;
        }
        break;
      case 'bearer':
        if (auth.bearerToken) {
          headers['Authorization'] = `Bearer ${auth.bearerToken}`;
        }
        break;
      case 'none':
      default:
        break;
    }

    if (auth.customHeaders) {
      Object.assign(headers, auth.customHeaders);
    }

    return headers;
  }

  /**
   * Update relay metrics
   */
  private updateRelayMetrics(provider: RelayProvider, success: boolean, latency: number): void {
    if (!this.config.enableMetrics) return;

    const metrics = this.relayMetrics.get(provider) || this.createEmptyMetrics();

    metrics.totalSubmissions++;
    if (success) {
      metrics.successfulSubmissions++;
      metrics.lastSuccessAt = Date.now();
      metrics.consecutiveFailures = 0;
    } else {
      metrics.failedSubmissions++;
      metrics.lastFailureAt = Date.now();
      metrics.consecutiveFailures++;
    }

    // Update rolling average latency
    const totalLatency = metrics.avgLatency * (metrics.totalSubmissions - 1) + latency;
    metrics.avgLatency = totalLatency / metrics.totalSubmissions;

    // Update success rate
    metrics.successRate = metrics.successfulSubmissions / metrics.totalSubmissions;

    this.relayMetrics.set(provider, metrics);
  }

  /**
   * Create empty metrics
   */
  private createEmptyMetrics(): RelayMetrics {
    return {
      totalSubmissions: 0,
      successfulSubmissions: 0,
      failedSubmissions: 0,
      avgLatency: 0,
      successRate: 0,
      consecutiveFailures: 0,
    };
  }

  /**
   * Assess network congestion
   */
  private async assessNetworkCongestion(): Promise<'low' | 'medium' | 'high'> {
    try {
      const feeData = await this.provider.getFeeData();
      const gasPrice = feeData.gasPrice || BigInt(0);

      // Base network thresholds (in gwei)
      const lowThreshold = BigInt(1e9); // 1 gwei
      const highThreshold = BigInt(5e9); // 5 gwei

      if (gasPrice < lowThreshold) return 'low';
      if (gasPrice > highThreshold) return 'high';
      return 'medium';
    } catch (error) {
      this.logger.warn('Failed to assess network congestion', { error });
      return 'medium'; // Default to medium
    }
  }

  /**
   * Test relay connectivity
   */
  private async testRelayConnectivity(): Promise<void> {
    const testPromises = this.config.relayProviders
      .filter(relay => relay.enabled)
      .map(async relay => {
        try {
          const isHealthy = await this.checkRelayHealth(relay.provider);
          if (!isHealthy) {
            this.logger.warn('Relay health check failed', { provider: relay.provider });
            this.emit('relayUnavailable', {
              relayProvider: relay.provider,
              reason: 'Health check failed',
              timestamp: Date.now(),
            } satisfies RelayEvents['relayUnavailable']);
          }
        } catch (error) {
          this.logger.error('Relay connectivity test failed', {
            provider: relay.provider,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

    await Promise.allSettled(testPromises);
  }

  /**
   * Clean up old metrics
   */
  private cleanupOldMetrics(): void {
    if (!this.config.enableMetrics) return;

    const cutoffTime = Date.now() - this.config.metricsRetentionMs;

    for (const [provider, metrics] of this.relayMetrics) {
      // Reset metrics if they're too old
      if (
        metrics.lastSuccessAt &&
        metrics.lastSuccessAt < cutoffTime &&
        metrics.lastFailureAt &&
        metrics.lastFailureAt < cutoffTime
      ) {
        this.relayMetrics.set(provider, this.createEmptyMetrics());
        this.logger.debug('Cleaned up old metrics', { provider });
      }
    }
  }

  /**
   * Initialize relay configurations
   */
  private initializeRelayConfigs(): void {
    for (const relayConfig of this.config.relayProviders) {
      this.relayConfigs.set(relayConfig.provider, relayConfig);
    }
  }

  /**
   * Initialize metrics
   */
  private initializeMetrics(): void {
    if (!this.config.enableMetrics) return;

    for (const relayConfig of this.config.relayProviders) {
      this.relayMetrics.set(relayConfig.provider, this.createEmptyMetrics());
    }
  }

  /**
   * Get default relay configurations
   */
  private getDefaultRelayConfigs(): RelayProviderConfig[] {
    return [
      {
        name: 'Flashbots Protect',
        provider: RelayProvider.FLASHBOTS_PROTECT,
        endpoint: 'https://rpc.flashbots.net',
        authentication: { type: 'none' },
        capabilities: {
          supportsBundle: true,
          supportsCancellation: false,
          supportsReplacement: true,
          supportsSimulation: true,
          maxTransactionsPerBundle: 25,
          estimatedInclusionTime: 12000, // 12 seconds
          supportedChains: [8453], // Base mainnet
        },
        costs: {
          baseFee: BigInt(0),
          priorityFeeMultiplier: 1.0,
          bundleFee: BigInt(0),
        },
        enabled: true,
        priority: 1,
        maxRetries: 2,
        timeoutMs: 30000,
      },
      {
        name: 'bloXroute',
        provider: RelayProvider.BLOXROUTE,
        endpoint: 'https://api.bloxroute.com',
        authentication: { type: 'api-key' },
        capabilities: {
          supportsBundle: false,
          supportsCancellation: true,
          supportsReplacement: true,
          supportsSimulation: false,
          maxTransactionsPerBundle: 1,
          estimatedInclusionTime: 8000, // 8 seconds
          supportedChains: [8453], // Base mainnet
        },
        costs: {
          baseFee: BigInt(1e15), // 0.001 ETH
          priorityFeeMultiplier: 1.1,
        },
        enabled: false, // Disabled by default (requires API key)
        priority: 2,
        maxRetries: 1,
        timeoutMs: 20000,
      },
      {
        name: 'Local Node',
        provider: RelayProvider.LOCAL_NODE,
        endpoint: 'http://localhost:8545',
        authentication: { type: 'none' },
        capabilities: {
          supportsBundle: false,
          supportsCancellation: false,
          supportsReplacement: true,
          supportsSimulation: false,
          maxTransactionsPerBundle: 1,
          estimatedInclusionTime: 15000, // 15 seconds
          supportedChains: [8453], // Base mainnet
        },
        costs: {
          baseFee: BigInt(0),
          priorityFeeMultiplier: 1.0,
        },
        enabled: true,
        priority: 99, // Lowest priority (fallback)
        maxRetries: 0,
        timeoutMs: 10000,
      },
    ];
  }
}
