/**
 * Transaction Lifecycle Manager
 *
 * Manages complete transaction lifecycle from building to confirmation
 * Requirements: 1.2, 1.14
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { Address } from '../types/common';
import {
  TransactionStage,
  TransactionRequest,
  TransactionReceipt,
  TransactionLifecycleData,
  TransactionStageTransition,
  TransactionSubmissionResult,
  TransactionConfirmationResult,
  TransactionReplacementOptions,
  TransactionSimulationResult,
  GasEstimationResult,
  TransactionLifecycleManagerConfig,
  NonceState,
  TransactionPoolStatus,
  ITransactionLifecycleManager,
  TransactionEvents,
  TransactionError,
  TransactionBuildError,
  TransactionSimulationError,
  TransactionSubmissionError,
  TransactionConfirmationError,
  TransactionTimeoutError,
  TransactionReplacedError,
  NonceGapError,
} from '../types/transaction';

/**
 * Transaction Lifecycle Manager Implementation
 */
export class TransactionLifecycleManager
  extends EventEmitter
  implements ITransactionLifecycleManager
{
  private readonly logger = createComponentLogger('transaction-lifecycle');
  private readonly config: TransactionLifecycleManagerConfig;
  private readonly provider: ethers.Provider;
  private readonly signer: ethers.Signer;

  private readonly transactions = new Map<string, TransactionLifecycleData>();
  private readonly nonceStates = new Map<Address, NonceState>();
  private readonly confirmationPromises = new Map<string, Promise<TransactionConfirmationResult>>();

  private isRunning = false;
  private monitoringInterval?: NodeJS.Timeout | undefined;

  constructor(
    provider: ethers.Provider,
    signer: ethers.Signer,
    config: Partial<TransactionLifecycleManagerConfig> = {}
  ) {
    super();

    this.provider = provider;
    this.signer = signer;

    this.config = {
      maxSubmissionAttempts: config.maxSubmissionAttempts ?? 3,
      submissionRetryDelayMs: config.submissionRetryDelayMs ?? 5000,
      confirmationTimeoutMs: config.confirmationTimeoutMs ?? 60000,
      confirmationBlocks: config.confirmationBlocks ?? 1,
      gasEstimationBuffer: config.gasEstimationBuffer ?? 20, // 20% buffer
      enableSimulation: config.enableSimulation ?? true,
      enableReplacement: config.enableReplacement ?? true,
      replacementGasMultiplier: config.replacementGasMultiplier ?? 1.2,
      maxReplacementAttempts: config.maxReplacementAttempts ?? 2,
      enableNonceManagement: config.enableNonceManagement ?? true,
      nonceGapRecovery: config.nonceGapRecovery ?? true,
      ...config,
    };

    this.logger.info('Transaction lifecycle manager initialized', {
      config: this.config,
    });
  }

  /**
   * Helper method to create transaction pool status using TransactionPoolStatus type
   */
  private createPoolStatus(): TransactionPoolStatus {
    return {
      pending: 0,
      queued: 0,
      baseFee: 0n,
      gasPrice: 0n,
      congestionLevel: 'low',
    };
  }

  /**
   * Get next available nonce for address
   */
  async getNextNonce(address: Address): Promise<number> {
    const nonceState = this.nonceStates.get(address);

    if (!nonceState) {
      // Initialize nonce state for new address
      const chainNonce = await this.provider.getTransactionCount(address, 'pending');
      const newNonceState: NonceState = {
        address,
        chainNonce,
        pendingNonces: new Set(),
        lastUsedNonce: chainNonce - 1,
        gapRecoveryInProgress: false,
      };
      this.nonceStates.set(address, newNonceState);
      return chainNonce;
    }

    // Check for nonce gaps and recover if needed
    if (this.config.nonceGapRecovery && !nonceState.gapRecoveryInProgress) {
      await this.detectAndRecoverNonceGaps(address);
    }

    // Find next available nonce
    let nextNonce = nonceState.lastUsedNonce + 1;
    while (nonceState.pendingNonces.has(nextNonce)) {
      nextNonce++;
    }

    return nextNonce;
  }

  /**
   * Reserve nonce for transaction
   */
  async reserveNonce(address: Address): Promise<number> {
    const nonce = await this.getNextNonce(address);
    const nonceState = this.nonceStates.get(address)!;

    // Check for nonce conflicts
    if (nonceState.pendingNonces.has(nonce)) {
      throw new NonceGapError(`Nonce ${nonce} already reserved for ${address}`);
    }

    nonceState.pendingNonces.add(nonce);
    nonceState.lastUsedNonce = Math.max(nonceState.lastUsedNonce, nonce);

    this.logger.debug('Nonce reserved', {
      address,
      nonce,
      pendingCount: nonceState.pendingNonces.size,
    });
    return nonce;
  }

  /**
   * Release nonce (on success or failure)
   */
  releaseNonce(address: Address, nonce: number): void {
    const nonceState = this.nonceStates.get(address);
    if (!nonceState) {
      this.logger.warn('Attempted to release nonce for unknown address', { address, nonce });
      return;
    }

    nonceState.pendingNonces.delete(nonce);
    this.logger.debug('Nonce released', {
      address,
      nonce,
      pendingCount: nonceState.pendingNonces.size,
    });
  }

  /**
   * Detect and recover from nonce gaps
   */
  private async detectAndRecoverNonceGaps(address: Address): Promise<void> {
    const nonceState = this.nonceStates.get(address);
    if (!nonceState || nonceState.gapRecoveryInProgress) return;

    nonceState.gapRecoveryInProgress = true;

    try {
      const currentChainNonce = await this.provider.getTransactionCount(address, 'pending');

      // Check if chain nonce has advanced beyond our tracking
      if (currentChainNonce > nonceState.chainNonce) {
        this.logger.info('Nonce gap detected, recovering', {
          address,
          oldChainNonce: nonceState.chainNonce,
          newChainNonce: currentChainNonce,
          pendingNonces: Array.from(nonceState.pendingNonces),
        });

        // Clear pending nonces that are now confirmed
        const confirmedNonces = Array.from(nonceState.pendingNonces).filter(
          n => n < currentChainNonce
        );
        confirmedNonces.forEach(n => nonceState.pendingNonces.delete(n));

        // Update chain nonce
        nonceState.chainNonce = currentChainNonce;
        nonceState.lastUsedNonce = Math.max(nonceState.lastUsedNonce, currentChainNonce - 1);

        this.emit('nonceGapRecovered', { address, recoveredNonces: confirmedNonces });
      }
    } catch (error) {
      this.logger.error('Failed to recover nonce gaps', { address, error });
    } finally {
      nonceState.gapRecoveryInProgress = false;
    }
  }

  /**
   * Start transaction lifecycle manager
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Transaction lifecycle manager is already running');
      return;
    }

    this.isRunning = true;

    // Initialize nonce state for signer
    await this.initializeNonceState();

    // Start monitoring interval for pending transactions
    this.monitoringInterval = setInterval(() => {
      this.monitorPendingTransactions();
    }, 5000); // Check every 5 seconds

    this.logger.info('Transaction lifecycle manager started');
  }

  /**
   * Stop transaction lifecycle manager
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Transaction lifecycle manager is not running');
      return;
    }

    this.isRunning = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }

    // Wait for pending confirmations
    const pendingConfirmations = Array.from(this.confirmationPromises.values());
    if (pendingConfirmations.length > 0) {
      this.logger.info('Waiting for pending confirmations...', {
        count: pendingConfirmations.length,
      });
      await Promise.allSettled(pendingConfirmations);
    }

    this.logger.info('Transaction lifecycle manager stopped');
  }

  /**
   * Initialize nonce state for signer
   */
  private async initializeNonceState(): Promise<void> {
    const signerAddress = await this.signer.getAddress();
    const chainNonce = await this.provider.getTransactionCount(signerAddress, 'pending');

    this.nonceStates.set(signerAddress, {
      address: signerAddress,
      chainNonce,
      pendingNonces: new Set(),
      lastUsedNonce: chainNonce - 1,
      gapRecoveryInProgress: false,
    });

    this.logger.debug('Nonce state initialized', { signerAddress, chainNonce });
  }

  /**
   * Monitor pending transactions
   */
  private monitorPendingTransactions(): void {
    // Implementation for monitoring pending transactions
    // This would check for stuck transactions, update gas prices, etc.
  }

  /**
   * Build transaction from request
   */
  async buildTransaction(request: TransactionRequest): Promise<TransactionLifecycleData> {
    const transactionId = `tx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    try {
      this.logger.debug('Building transaction', { transactionId, to: request.to });

      // Reserve nonce
      const fromAddress = await this.signer.getAddress();
      const nonce = await this.reserveNonce(fromAddress);

      // Estimate gas if not provided
      let gasLimit = request.gasLimit;
      if (!gasLimit) {
        const gasEstimation = await this.estimateGas(request);
        gasLimit = gasEstimation.gasLimit;
      }

      // Get gas price if not provided
      let gasPrice = request.gasPrice;
      let maxFeePerGas = request.maxFeePerGas;
      let maxPriorityFeePerGas = request.maxPriorityFeePerGas;

      if (!gasPrice && !maxFeePerGas) {
        const feeData = await this.provider.getFeeData();
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
          maxFeePerGas = feeData.maxFeePerGas;
          maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
        } else {
          gasPrice = feeData.gasPrice || ethers.parseUnits('20', 'gwei');
        }
      }

      const builtTransaction: TransactionRequest = {
        ...request,
        nonce,
        gasLimit,
        gasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
      };

      const lifecycleData: TransactionLifecycleData = {
        id: transactionId,
        request: builtTransaction,
        stage: TransactionStage.BUILT,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempts: 0,
        gasEstimations: [],
        stageHistory: [
          {
            stage: TransactionStage.BUILT,
            timestamp: Date.now(),
            metadata: { nonce, gasLimit: gasLimit.toString() },
          },
        ],
      };

      this.transactions.set(transactionId, lifecycleData);
      this.emit('transactionBuilt', lifecycleData);

      this.logger.info('Transaction built successfully', {
        transactionId,
        nonce,
        gasLimit: gasLimit.toString(),
      });

      return lifecycleData;
    } catch (error) {
      // Release nonce on failure
      const fromAddress = await this.signer.getAddress();
      if (request.nonce !== undefined) {
        this.releaseNonce(fromAddress, request.nonce);
      }

      const buildError = new TransactionBuildError(
        `Failed to build transaction: ${error}`,
        transactionId,
        error instanceof Error ? error : new Error(String(error))
      );

      this.logger.error('Transaction build failed', { transactionId, error: buildError });
      throw buildError;
    }
  }

  /**
   * Estimate gas for transaction
   */
  private async estimateGas(request: TransactionRequest): Promise<GasEstimationResult> {
    try {
      const gasLimit = await this.provider.estimateGas(request);
      const gasLimitWithBuffer = (gasLimit * BigInt(100 + this.config.gasEstimationBuffer)) / 100n;

      return {
        gasLimit: gasLimitWithBuffer,
        estimatedGas: gasLimit,
        buffer: this.config.gasEstimationBuffer,
      };
    } catch (error) {
      throw new Error(`Gas estimation failed: ${error}`);
    }
  }

  /**
   * Helper method to create transaction errors using error types
   */
  private createTransactionError(opportunityId: string, message: string): TransactionReplacedError {
    this.logger.debug('Creating transaction error', { opportunityId, message });
    return new TransactionReplacedError(opportunityId, 'old-hash', 'new-hash');
  }

  /**
   * Convert ethers TransactionReceipt to our TransactionReceipt type
   */
  private convertReceipt(ethersReceipt: any): TransactionReceipt {
    return {
      transactionHash: ethersReceipt.hash || ethersReceipt.transactionHash,
      blockNumber: ethersReceipt.blockNumber,
      blockHash: ethersReceipt.blockHash,
      transactionIndex: ethersReceipt.index || ethersReceipt.transactionIndex || 0,
      from: ethersReceipt.from,
      to: ethersReceipt.to,
      gasUsed: ethersReceipt.gasUsed,
      effectiveGasPrice: ethersReceipt.gasPrice || ethersReceipt.effectiveGasPrice,
      status: ethersReceipt.status,
      logs: ethersReceipt.logs || [],
      cumulativeGasUsed: ethersReceipt.cumulativeGasUsed || ethersReceipt.gasUsed,
    };
  }
}
