/**
 * Relay Manager
 *
 * Manages MEV relay connections and transaction submission strategies.
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { FlashbotsRelay } from './flashbots-relay';
import { BloXrouteRelay } from './bloxroute-relay';

export enum RelayProvider {
  FLASHBOTS_PROTECT = 'flashbots_protect',
  FLASHBOTS_AUCTION = 'flashbots_auction',
  BLOXROUTE = 'bloxroute',
  EDEN_NETWORK = 'eden_network',
  MANIFOLD_FINANCE = 'manifold_finance',
  SECURERPC = 'securerpc',
  LOCAL_NODE = 'local_node',
}

export interface RelayConfig {
  provider: RelayProvider;
  endpoint: string;
  apiKey?: string | undefined;
  enabled: boolean;
  priority: number; // 1 = highest priority
  maxGasPrice?: bigint | undefined;
  minProfit?: bigint | undefined;
}

export interface RelaySubmissionResult {
  success: boolean;
  relayProvider: RelayProvider;
  transactionHash?: string | undefined;
  bundleHash?: string | undefined;
  error?: string | undefined;
  gasUsed?: bigint | undefined;
  effectiveGasPrice?: bigint | undefined;
  profit?: bigint | undefined;
  latency: number;
  blockNumber?: number | undefined;
  pending?: boolean | undefined;
}

export interface RelayManagerOptions {
  relays: RelayConfig[];
  connectionManager: RpcConnectionManager;
  wallet: ethers.Wallet;
  defaultTimeout?: number | undefined;
  maxConcurrentSubmissions?: number | undefined;
  enableFailover?: boolean | undefined;
  retryAttempts?: number | undefined;
  blockTimeMs?: number | undefined; // Chain-specific block time in milliseconds
}

export class RelayManager extends EventEmitter {
  private readonly logger = createComponentLogger('relay-manager');
  private readonly options: {
    defaultTimeout: number;
    maxConcurrentSubmissions: number;
    enableFailover: boolean;
    retryAttempts: number;
    blockTimeMs: number;
    relays: RelayConfig[];
  };
  private readonly connectionManager: RpcConnectionManager;
  private readonly wallet: ethers.Wallet;
  private readonly blockTimeMs: number;

  private relayConfigs: Map<RelayProvider, RelayConfig> = new Map();
  private activeSubmissions = 0;
  private submissionQueue: Array<() => Promise<void>> = [];

  // Relay implementations
  private flashbotsRelay?: FlashbotsRelay | undefined;
  private bloxrouteRelay?: BloXrouteRelay | undefined;
  private initialized = false;

  constructor(options: RelayManagerOptions) {
    super();
    this.connectionManager = options.connectionManager;
    this.wallet = options.wallet;
    this.blockTimeMs = options.blockTimeMs ?? 2000; // Default to Base L2's ~2s block time
    this.options = {
      defaultTimeout: options.defaultTimeout ?? 30000, // 30 seconds
      maxConcurrentSubmissions: options.maxConcurrentSubmissions ?? 3,
      enableFailover: options.enableFailover ?? true,
      retryAttempts: options.retryAttempts ?? 2,
      blockTimeMs: this.blockTimeMs,
      relays: options.relays,
    };

    // Initialize relay configurations
    for (const config of options.relays) {
      this.relayConfigs.set(config.provider, config);
    }

    this.logger.info('Relay manager initialized', {
      relayCount: this.relayConfigs.size,
      enabledRelays: options.relays.filter(r => r.enabled).length,
      enableFailover: this.options.enableFailover,
    });
  }

  /**
   * Initialize relay implementations
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing relay implementations...');

    // Initialize Flashbots relay if configured
    const flashbotsConfig = Array.from(this.relayConfigs.values()).find(
      c => c.provider === RelayProvider.FLASHBOTS_PROTECT && c.enabled
    );

    if (flashbotsConfig) {
      // Check if Flashbots is supported on current network
      const supportedNetworks = ['mainnet', 'goerli', 'sepolia'];
      const currentNetwork = 'base'; // This should be configurable in a real implementation

      if (!supportedNetworks.includes(currentNetwork)) {
        this.logger.warn(
          `Flashbots not supported on network: ${currentNetwork}. Skipping Flashbots initialization.`,
          {
            supportedNetworks,
            currentNetwork,
          }
        );
      } else {
        // Validate Flashbots auth key
        const flashbotsAuthKey = process.env['FLASHBOTS_AUTH_KEY'];
        if (!flashbotsAuthKey || flashbotsAuthKey.trim() === '') {
          throw new Error(
            'FLASHBOTS_AUTH_KEY environment variable is required but not set or empty'
          );
        }

        this.flashbotsRelay = new FlashbotsRelay({
          connectionManager: this.connectionManager,
          wallet: this.wallet,
          authSignerPrivateKey: flashbotsAuthKey,
          network: currentNetwork,
        });

        await this.flashbotsRelay.initialize();
        this.logger.info('Flashbots relay initialized');
      }
    }

    // Initialize bloXroute relay if configured
    const bloxrouteConfig = Array.from(this.relayConfigs.values()).find(
      c => c.provider === RelayProvider.BLOXROUTE && c.enabled
    );

    if (bloxrouteConfig && bloxrouteConfig.apiKey) {
      this.bloxrouteRelay = new BloXrouteRelay({
        wallet: this.wallet,
        apiKey: bloxrouteConfig.apiKey,
        network: 'base',
      });

      await this.bloxrouteRelay.initialize();
      this.logger.info('bloXroute relay initialized');
    }

    this.initialized = true;
    this.logger.info('Relay implementations initialized successfully');
  }

  /**
   * Submit transaction to relays with failover strategy
   */
  async submitTransaction(
    transaction: ethers.TransactionRequest,
    options?: {
      preferredRelay?: RelayProvider | undefined;
      maxGasPrice?: bigint | undefined;
      minProfit?: bigint | undefined;
      timeout?: number | undefined;
    }
  ): Promise<RelaySubmissionResult> {
    // Check if RelayManager has been initialized
    if (!this.initialized) {
      throw new Error('RelayManager not initialized: call initialize() before submitTransaction');
    }

    const operationId = `relay-submit-${Date.now()}`;
    this.logger.startPerformanceTracking(operationId);

    try {
      this.logger.info('Submitting transaction to relays', {
        to: transaction.to,
        value: transaction.value?.toString(),
        gasLimit: transaction.gasLimit?.toString(),
        preferredRelay: options?.preferredRelay,
      });

      // Get ordered list of relays to try
      const relaysToTry = this.getOrderedRelays(options?.preferredRelay);

      if (relaysToTry.length === 0) {
        throw new Error('No enabled relays available');
      }

      let lastError: Error | null = null;

      // Try each relay in order
      for (const relay of relaysToTry) {
        try {
          this.logger.markPerformance(operationId, `${relay.provider}-attempt`);

          const result = await this.submitToRelay(transaction, relay, options);

          if (result.success) {
            this.logger.info('Transaction submitted successfully', {
              relay: relay.provider,
              transactionHash: result.transactionHash,
              gasUsed: result.gasUsed?.toString(),
              profit: result.profit?.toString(),
            });

            this.emit('transactionSubmitted', result);
            return result;
          } else {
            throw new Error(result.error || 'Submission failed');
          }
        } catch (error) {
          lastError = error as Error;

          this.logger.warn('Relay submission failed', {
            relay: relay.provider,
            error: lastError.message,
          });

          if (!this.options.enableFailover) {
            break; // Don't try other relays if failover is disabled
          }
        }
      }

      // All relays failed
      const failureResult: RelaySubmissionResult = {
        success: false,
        relayProvider:
          relaysToTry.length > 0 ? relaysToTry[0]!.provider : RelayProvider.FLASHBOTS_PROTECT,
        error: lastError?.message || 'All relay submissions failed',
        latency: Date.now() - parseInt(operationId.split('-')[2] || '0'),
      };

      this.emit('transactionFailed', failureResult);
      return failureResult;
    } catch (error) {
      this.logger.logError(error as Error, { operation: 'relay-submission' });
      throw error;
    } finally {
      this.logger.endPerformanceTracking(operationId);
    }
  }

  /**
   * Submit bundle to relays (for MEV bundles)
   */
  async submitBundle(
    transactions: ethers.TransactionRequest[],
    targetBlock: number,
    options?: {
      preferredRelay?: RelayProvider | undefined;
      maxBribe?: bigint | undefined;
      minProfit?: bigint | undefined;
    }
  ): Promise<RelaySubmissionResult> {
    this.logger.info('Submitting bundle to relays', {
      transactionCount: transactions.length,
      targetBlock,
      preferredRelay: options?.preferredRelay,
    });

    const relay = this.getPreferredRelay(options?.preferredRelay);

    if (!relay) {
      throw new Error('No suitable relay found for bundle submission');
    }

    const startTime = Date.now();

    try {
      // Serialize all transactions for bundle
      const serializedTxs = transactions.map(tx => {
        try {
          // Convert TransactionRequest to proper format for ethers.Transaction.from
          const txData: any = {};

          if (tx.to) txData.to = tx.to.toString();
          if (tx.value) txData.value = tx.value.toString();
          if (tx.data) txData.data = tx.data;
          if (tx.gasLimit) txData.gasLimit = tx.gasLimit.toString();
          if (tx.gasPrice) txData.gasPrice = tx.gasPrice.toString();
          if (tx.maxFeePerGas) txData.maxFeePerGas = tx.maxFeePerGas.toString();
          if (tx.maxPriorityFeePerGas)
            txData.maxPriorityFeePerGas = tx.maxPriorityFeePerGas.toString();
          if (tx.nonce !== undefined) txData.nonce = tx.nonce;
          if (tx.type !== undefined) txData.type = tx.type;

          return ethers.Transaction.from(txData).serialized;
        } catch (error) {
          this.logger.logError(error as Error, {
            operation: 'serialize-transaction',
            transaction: tx,
          });
          throw new Error(`Failed to serialize transaction: ${(error as Error).message}`);
        }
      });

      let bundleParams: any;
      let method: string;

      // Different bundle formats for different relays
      switch (relay.provider) {
        case RelayProvider.FLASHBOTS_AUCTION:
        case RelayProvider.FLASHBOTS_PROTECT:
          method = 'eth_sendBundle';
          bundleParams = {
            txs: serializedTxs,
            blockNumber: `0x${targetBlock.toString(16)}`,
            minTimestamp: Math.floor(Date.now() / 1000),
            maxTimestamp: Math.floor(Date.now() / 1000) + 120, // 2 minutes
          };

          // Add bribe if specified
          if (options?.maxBribe) {
            bundleParams.revertingTxHashes = []; // Allow reverting txs
            bundleParams.replacementUuid = `${Date.now()}-${Math.random()}`;
          }
          break;

        case RelayProvider.EDEN_NETWORK:
          method = 'eth_sendBundle';
          bundleParams = {
            transactions: serializedTxs,
            blockNumber: targetBlock,
            minTimestamp: Math.floor(Date.now() / 1000),
            maxTimestamp: Math.floor(Date.now() / 1000) + 120,
          };
          break;

        default:
          // Fallback to standard bundle format
          method = 'eth_sendBundle';
          bundleParams = {
            txs: serializedTxs,
            blockNumber: `0x${targetBlock.toString(16)}`,
          };
      }

      const response = await this.makeRelayRequest(relay.endpoint, {
        method,
        params: [bundleParams],
        timeout: this.options.defaultTimeout,
      });

      const result: RelaySubmissionResult = {
        success: true,
        relayProvider: relay.provider,
        bundleHash: response.result,
        latency: Date.now() - startTime,
        blockNumber: targetBlock,
      };

      this.logger.info('Bundle submitted successfully', {
        relay: relay.provider,
        bundleHash: result.bundleHash,
        targetBlock,
        transactionCount: transactions.length,
        latency: result.latency,
      });

      this.emit('bundleSubmitted', result);
      return result;
    } catch (error) {
      const failureResult: RelaySubmissionResult = {
        success: false,
        relayProvider: relay.provider,
        error: (error as Error).message,
        latency: Date.now() - startTime,
        blockNumber: targetBlock,
      };

      this.logger.logError(error as Error, {
        operation: 'submit-bundle',
        relay: relay.provider,
        targetBlock,
        transactionCount: transactions.length,
      });

      this.emit('bundleFailed', failureResult);
      return failureResult;
    }
  }

  private async submitToRelay(
    transaction: ethers.TransactionRequest,
    relay: RelayConfig,
    options?: {
      maxGasPrice?: bigint | undefined;
      minProfit?: bigint | undefined;
      timeout?: number | undefined;
    }
  ): Promise<RelaySubmissionResult> {
    const startTime = Date.now();
    const timeout: number = options?.timeout ?? this.options.defaultTimeout;

    // Validate transaction against relay constraints
    this.validateTransactionForRelay(transaction, relay, options);

    try {
      // Different submission logic based on relay provider
      switch (relay.provider) {
        case RelayProvider.FLASHBOTS_PROTECT:
          return await this.submitToFlashbotsProtect(transaction, relay, timeout);

        case RelayProvider.FLASHBOTS_AUCTION:
          return await this.submitToFlashbotsAuction(transaction, relay, timeout);

        case RelayProvider.BLOXROUTE:
          return await this.submitToBloXroute(transaction, relay, timeout);

        case RelayProvider.EDEN_NETWORK:
          return await this.submitToEdenNetwork(transaction, relay, timeout);

        case RelayProvider.MANIFOLD_FINANCE:
          return await this.submitToManifoldFinance(transaction, relay, timeout);

        case RelayProvider.SECURERPC:
          return await this.submitToSecureRpc(transaction, relay, timeout);

        case RelayProvider.LOCAL_NODE:
          return await this.submitToLocalNode(transaction, relay, timeout);

        default:
          throw new Error(`Unsupported relay provider: ${relay.provider}`);
      }
    } catch (error) {
      return {
        success: false,
        relayProvider: relay.provider,
        error: (error as Error).message,
        latency: Date.now() - startTime,
      };
    }
  }

  private async submitToFlashbotsProtect(
    transaction: ethers.TransactionRequest,
    relay: RelayConfig,
    timeoutMs: number
  ): Promise<RelaySubmissionResult> {
    const startTime = Date.now();

    try {
      if (!this.flashbotsRelay || !this.flashbotsRelay.isInitialized()) {
        throw new Error('Flashbots relay not initialized');
      }

      // Use timeout for the submission
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Flashbots submission timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      );

      // Use our Flashbots relay implementation with timeout
      const result = await Promise.race([
        this.flashbotsRelay.sendPrivateTransaction(transaction),
        timeoutPromise,
      ]);

      if (!result.success) {
        throw new Error(result.error || 'Flashbots submission failed');
      }

      return {
        success: true,
        relayProvider: relay.provider,
        transactionHash: result.transactionHash ?? undefined,
        latency: Date.now() - startTime,
      };
    } catch (error) {
      throw new Error(`Flashbots Protect submission failed: ${(error as Error).message}`);
    }
  }

  private async submitToFlashbotsAuction(
    transaction: ethers.TransactionRequest,
    relay: RelayConfig,
    timeout: number
  ): Promise<RelaySubmissionResult> {
    const startTime = Date.now();

    try {
      // Flashbots Auction requires bundle submission
      const currentBlock = await this.getCurrentBlockNumber();
      const targetBlock = currentBlock + 1;

      // Serialize transaction for bundle
      const txData: any = {};

      if (transaction.to) txData.to = transaction.to.toString();
      if (transaction.value) txData.value = transaction.value.toString();
      if (transaction.data) txData.data = transaction.data;
      if (transaction.gasLimit) txData.gasLimit = transaction.gasLimit.toString();
      if (transaction.gasPrice) txData.gasPrice = transaction.gasPrice.toString();
      if (transaction.maxFeePerGas) txData.maxFeePerGas = transaction.maxFeePerGas.toString();
      if (transaction.maxPriorityFeePerGas)
        txData.maxPriorityFeePerGas = transaction.maxPriorityFeePerGas.toString();
      if (transaction.nonce !== undefined) txData.nonce = transaction.nonce;
      if (transaction.type !== undefined) txData.type = transaction.type;

      const serializedTx = ethers.Transaction.from(txData).serialized;

      const bundleParams = {
        txs: [serializedTx],
        blockNumber: `0x${targetBlock.toString(16)}`,
        minTimestamp: Math.floor(Date.now() / 1000),
        maxTimestamp: Math.floor(Date.now() / 1000) + 120, // 2 minutes
      };

      const response = await this.makeRelayRequest(relay.endpoint, {
        method: 'eth_sendBundle',
        params: [bundleParams],
        timeout,
      });

      return {
        success: true,
        relayProvider: relay.provider,
        bundleHash: response.result,
        blockNumber: targetBlock,
        latency: Date.now() - startTime,
      };
    } catch (error) {
      throw new Error(`Flashbots Auction submission failed: ${(error as Error).message}`);
    }
  }

  private async submitToBloXroute(
    transaction: ethers.TransactionRequest,
    relay: RelayConfig,
    timeoutMs: number
  ): Promise<RelaySubmissionResult> {
    const startTime = Date.now();

    try {
      if (!this.bloxrouteRelay || !this.bloxrouteRelay.isInitialized()) {
        throw new Error('bloXroute relay not initialized');
      }

      // Use timeout for the submission
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`bloXroute submission timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      );

      // Use our bloXroute relay implementation with timeout
      const result = await Promise.race([
        this.bloxrouteRelay.sendPrivateTransaction(transaction),
        timeoutPromise,
      ]);

      if (!result.success) {
        throw new Error(result.error || 'bloXroute submission failed');
      }

      return {
        success: true,
        relayProvider: relay.provider,
        transactionHash: result.transactionHash ?? undefined,
        latency: result.latency ?? Date.now() - startTime,
      };
    } catch (error) {
      throw new Error(`bloXroute submission failed: ${(error as Error).message}`);
    }
  }

  private async submitToLocalNode(
    transaction: ethers.TransactionRequest,
    relay: RelayConfig,
    timeout: number
  ): Promise<RelaySubmissionResult> {
    const startTime = Date.now();

    try {
      // Submit directly to local node
      const tx = await this.wallet.sendTransaction(transaction);

      // Wait for transaction with timeout - don't cancel on timeout
      let receipt: ethers.TransactionReceipt | null = null;
      try {
        receipt = await Promise.race([
          tx.wait(),
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error('Transaction wait timeout')), timeout)
          ),
        ]);
      } catch (error) {
        if ((error as Error).message.includes('timeout')) {
          // Transaction is still pending, spawn background watcher
          this.spawnBackgroundWatcher(tx);

          // Return success: true with pending: true to indicate submission succeeded but is unconfirmed
          return {
            success: true,
            pending: true,
            relayProvider: relay.provider,
            transactionHash: tx.hash,
            latency: Date.now() - startTime,
          };
        }
        throw error;
      }

      return {
        success: true,
        relayProvider: relay.provider,
        transactionHash: tx.hash,
        gasUsed: receipt?.gasUsed ?? undefined,
        effectiveGasPrice: receipt?.gasPrice ?? undefined,
        blockNumber: receipt?.blockNumber ?? undefined,
        latency: Date.now() - startTime,
      };
    } catch (error) {
      if ((error as Error).message.includes('timeout')) {
        throw new Error(`Local node submission timed out after ${timeout}ms`);
      }
      throw new Error(`Local node submission failed: ${(error as Error).message}`);
    }
  }

  private async submitToEdenNetwork(
    transaction: ethers.TransactionRequest,
    relay: RelayConfig,
    timeout: number
  ): Promise<RelaySubmissionResult> {
    const startTime = Date.now();

    // Simulate Eden Network submission
    try {
      const response = await this.makeRelayRequest(relay.endpoint, {
        method: 'eth_sendTransaction',
        params: [transaction],
        timeout,
      });

      return {
        success: true,
        relayProvider: relay.provider,
        transactionHash: response.result,
        latency: Date.now() - startTime,
      };
    } catch (error) {
      throw new Error(`Eden Network submission failed: ${(error as Error).message}`);
    }
  }

  private async submitToManifoldFinance(
    transaction: ethers.TransactionRequest,
    relay: RelayConfig,
    timeout: number
  ): Promise<RelaySubmissionResult> {
    const startTime = Date.now();

    // Simulate Manifold Finance submission
    try {
      const response = await this.makeRelayRequest(relay.endpoint, {
        method: 'eth_sendTransaction',
        params: [transaction],
        timeout,
      });

      return {
        success: true,
        relayProvider: relay.provider,
        transactionHash: response.result,
        latency: Date.now() - startTime,
      };
    } catch (error) {
      throw new Error(`Manifold Finance submission failed: ${(error as Error).message}`);
    }
  }

  private async submitToSecureRpc(
    transaction: ethers.TransactionRequest,
    relay: RelayConfig,
    timeout: number
  ): Promise<RelaySubmissionResult> {
    const startTime = Date.now();

    // Simulate SecureRPC submission
    try {
      const response = await this.makeRelayRequest(relay.endpoint, {
        method: 'eth_sendTransaction',
        params: [transaction],
        timeout,
      });

      return {
        success: true,
        relayProvider: relay.provider,
        transactionHash: response.result,
        latency: Date.now() - startTime,
      };
    } catch (error) {
      throw new Error(`SecureRPC submission failed: ${(error as Error).message}`);
    }
  }

  private async makeRelayRequest(
    endpoint: string,
    options: {
      method: string;
      params: any[];
      timeout: number;
    }
  ): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout);

    try {
      const requestBody = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: options.method,
        params: options.params,
      };

      this.logger.debug('Making relay request', {
        endpoint,
        method: options.method,
        timeout: options.timeout,
      });

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        jsonrpc: string;
        id: number;
        result?: any;
        error?: {
          code: number;
          message: string;
        };
      };

      if (data.error) {
        throw new Error(`RPC Error ${data.error.code}: ${data.error.message}`);
      }

      this.logger.debug('Relay request completed successfully', {
        endpoint,
        method: options.method,
        responseId: data.id,
      });

      return data;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Request timeout after ${options.timeout}ms`);
        }
        throw error;
      }

      throw new Error(`Unknown error during relay request: ${error}`);
    }
  }

  private validateTransactionForRelay(
    transaction: ethers.TransactionRequest,
    relay: RelayConfig,
    options?: { maxGasPrice?: bigint | undefined; minProfit?: bigint | undefined }
  ): void {
    // Check gas price constraints
    if (relay.maxGasPrice && transaction.gasPrice) {
      const gasPrice = BigInt(transaction.gasPrice.toString());
      if (gasPrice > relay.maxGasPrice) {
        throw new Error(`Gas price ${gasPrice} exceeds relay limit ${relay.maxGasPrice}`);
      }
    }

    // Check profit constraints
    if (relay.minProfit && options?.minProfit) {
      if (options.minProfit < relay.minProfit) {
        throw new Error(`Profit ${options.minProfit} below relay minimum ${relay.minProfit}`);
      }
    }

    // Basic transaction validation
    if (!transaction.to) {
      throw new Error('Transaction must have a recipient');
    }

    if (!transaction.gasLimit) {
      throw new Error('Transaction must have a gas limit');
    }
  }

  private getOrderedRelays(preferredRelay?: RelayProvider): RelayConfig[] {
    const enabledRelays = Array.from(this.relayConfigs.values()).filter(relay => relay.enabled);

    // Sort by priority (lower number = higher priority)
    enabledRelays.sort((a, b) => a.priority - b.priority);

    // Move preferred relay to front if specified
    if (preferredRelay) {
      const preferredIndex = enabledRelays.findIndex(r => r.provider === preferredRelay);
      if (preferredIndex > 0) {
        const preferred = enabledRelays[preferredIndex];
        if (preferred) {
          enabledRelays.splice(preferredIndex, 1);
          enabledRelays.unshift(preferred);
        }
      }
    }

    return enabledRelays;
  }

  private getPreferredRelay(preferredRelay?: RelayProvider): RelayConfig | null {
    if (preferredRelay) {
      const relay = this.relayConfigs.get(preferredRelay);
      if (relay && relay.enabled) {
        return relay;
      }
    }

    // Return highest priority enabled relay
    const enabledRelays = Array.from(this.relayConfigs.values())
      .filter(relay => relay.enabled)
      .sort((a, b) => a.priority - b.priority);

    return enabledRelays[0] || null;
  }

  private async getCurrentBlockNumber(): Promise<number> {
    try {
      const provider = this.connectionManager.getProvider();
      return await provider.getBlockNumber();
    } catch (error) {
      this.logger.logError(error as Error, { operation: 'get-current-block-number' });
      // Fallback to estimated block number based on chain-specific block time
      // Base L2 uses ~2s block time vs Ethereum mainnet's ~12s
      return Math.floor(Date.now() / this.blockTimeMs);
    }
  }

  /**
   * Spawn background watcher for pending transaction
   */
  private spawnBackgroundWatcher(tx: ethers.TransactionResponse): void {
    // Don't block - watch in background
    tx.wait()
      .then(receipt => {
        if (receipt) {
          this.logger.info('Background transaction confirmed', {
            transactionHash: tx.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
          });
        }
      })
      .catch(error => {
        this.logger.warn('Background transaction failed', {
          transactionHash: tx.hash,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
  getStats(): {
    totalRelays: number;
    enabledRelays: number;
    activeSubmissions: number;
    queuedSubmissions: number;
  } {
    const enabledCount = Array.from(this.relayConfigs.values()).filter(
      relay => relay.enabled
    ).length;

    return {
      totalRelays: this.relayConfigs.size,
      enabledRelays: enabledCount,
      activeSubmissions: this.activeSubmissions,
      queuedSubmissions: this.submissionQueue.length,
    };
  }

  /**
   * Update relay configuration
   */
  updateRelayConfig(provider: RelayProvider, updates: Partial<RelayConfig>): void {
    const existing = this.relayConfigs.get(provider);
    if (!existing) {
      throw new Error(`Relay ${provider} not found`);
    }

    const updated = { ...existing, ...updates };
    this.relayConfigs.set(provider, updated);

    this.logger.info('Updated relay configuration', {
      provider,
      updates,
    });
  }

  /**
   * Enable or disable a relay
   */
  toggleRelay(provider: RelayProvider, enabled: boolean): void {
    this.updateRelayConfig(provider, { enabled });
  }
}
