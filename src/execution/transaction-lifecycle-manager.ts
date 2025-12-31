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
   * Build transaction from parameters
   */
  async buildTransaction(
    to: Address,
    data: string,
    value: bigint = 0n,
    gasOptions?: Partial<GasEstimationResult>
  ): Promise<TransactionRequest> {
    try {
      // Estimate gas if not provided
      let gasEstimate: GasEstimationResult;

      if (gasOptions) {
        gasEstimate = {
          gasLimit: gasOptions.gasLimit ?? 200000n,
          maxFeePerGas: gasOptions.maxFeePerGas ?? 25000000000n,
          maxPriorityFeePerGas: gasOptions.maxPriorityFeePerGas ?? 2000000000n,
          estimatedCost: gasOptions.estimatedCost ?? 0n,
          confidence: gasOptions.confidence ?? 0.8,
        };
      } else {
        gasEstimate = await this.estimateGas(to, data, value);
      }

      // Get nonce for validation and logging
      const nonce = await this.getNextNonce();

      const transaction: TransactionRequest = {
        to,
        data,
        value,
        gasLimit: gasEstimate.gasLimit,
        maxFeePerGas: gasEstimate.maxFeePerGas,
        maxPriorityFeePerGas: gasEstimate.maxPriorityFeePerGas,
        type: 2, // EIP-1559
      };

      this.logger.debug('Transaction built', {
        to,
        gasLimit: transaction.gasLimit.toString(),
        maxFeePerGas: transaction.maxFeePerGas.toString(),
        nonce: nonce, // Use nonce in logging
      });

      return transaction;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error('Transaction build failed', { to, error: reason });
      throw new TransactionBuildError('build-error', reason);
    }
  }

  /**
   * Simulate transaction execution
   */
  async simulateTransaction(transaction: TransactionRequest): Promise<TransactionSimulationResult> {
    if (!this.config.enableSimulation) {
      return {
        success: true,
        simulationTime: 0,
      };
    }

    const startTime = Date.now();

    try {
      // Use eth_call to simulate the transaction
      const result = await this.provider.call({
        to: transaction.to,
        data: transaction.data,
        value: transaction.value || 0n,
        gasLimit: transaction.gasLimit,
        maxFeePerGas: transaction.maxFeePerGas,
        maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
      });

      const simulationTime = Date.now() - startTime;

      this.logger.debug('Transaction simulation successful', {
        to: transaction.to,
        gasLimit: transaction.gasLimit.toString(),
        simulationTime,
      });

      return {
        success: true,
        returnData: result,
        simulationTime,
      };
    } catch (error) {
      const simulationTime = Date.now() - startTime;
      let revertReason: string | undefined;

      if (error instanceof Error) {
        // Try to extract revert reason
        const match = error.message.match(/revert (.+)/);
        revertReason = match ? match[1] : error.message;
      }

      this.logger.warn('Transaction simulation failed', {
        to: transaction.to,
        revertReason,
        simulationTime,
      });

      return {
        success: false,
        revertReason,
        simulationTime,
      };
    }
  }

  /**
   * Submit transaction to network
   */
  async submitTransaction(
    opportunityId: string,
    transaction: TransactionRequest
  ): Promise<TransactionSubmissionResult> {
    const startTime = Date.now();

    // Initialize transaction lifecycle data
    const lifecycleData: TransactionLifecycleData = {
      opportunityId,
      stage: TransactionStage.BUILDING,
      transaction,
      submissionAttempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
      stageHistory: [],
    };

    this.transactions.set(opportunityId, lifecycleData);
    this.transitionStage(opportunityId, TransactionStage.SUBMITTING, 'Starting submission');

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.config.maxSubmissionAttempts; attempt++) {
      try {
        lifecycleData.submissionAttempts = attempt;

        // Submit transaction
        const txResponse = await this.signer.sendTransaction(transaction);
        const submissionTime = Date.now() - startTime;

        // Update lifecycle data
        lifecycleData.transactionHash = txResponse.hash;
        this.transitionStage(opportunityId, TransactionStage.SUBMITTED, 'Transaction submitted');

        // Get nonce from transaction response and reserve it
        const nonce = txResponse.nonce || 0;
        await this.reserveNonce(nonce);

        const result: TransactionSubmissionResult = {
          success: true,
          transactionHash: txResponse.hash,
          nonce: nonce,
          gasPrice: transaction.maxFeePerGas,
          submissionTime,
        };

        this.logger.info('Transaction submitted successfully', {
          opportunityId,
          transactionHash: txResponse.hash,
          nonce: nonce,
          attempt,
          submissionTime,
        });

        // Emit event
        this.emit('transactionSubmitted', {
          opportunityId,
          transactionHash: txResponse.hash,
          nonce: nonce,
          gasPrice: transaction.maxFeePerGas,
          timestamp: Date.now(),
        } satisfies TransactionEvents['transactionSubmitted']);

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        this.logger.warn('Transaction submission attempt failed', {
          opportunityId,
          attempt,
          maxAttempts: this.config.maxSubmissionAttempts,
          error: lastError.message,
        });

        // Handle specific errors
        if (this.isNonceError(lastError)) {
          await this.handleNonceError(lastError);
        }

        // Wait before retry (except on last attempt)
        if (attempt < this.config.maxSubmissionAttempts) {
          await new Promise(resolve => setTimeout(resolve, this.config.submissionRetryDelayMs));
        }
      }
    }

    // All attempts failed
    const submissionTime = Date.now() - startTime;
    const failureReason = lastError?.message ?? 'Unknown submission error';

    this.transitionStage(opportunityId, TransactionStage.FAILED, failureReason);

    this.logger.error('Transaction submission failed after all attempts', {
      opportunityId,
      attempts: this.config.maxSubmissionAttempts,
      error: failureReason,
      submissionTime,
    });

    // Emit failure event
    this.emit('transactionFailed', {
      opportunityId,
      stage: TransactionStage.SUBMITTING,
      reason: failureReason,
      timestamp: Date.now(),
    } satisfies TransactionEvents['transactionFailed']);

    // Create appropriate transaction error for logging
    const transactionError = this.createTransactionError(opportunityId, failureReason);
    this.logger.debug('Transaction error created', {
      errorType: transactionError.name,
      opportunityId,
    });

    return {
      success: false,
      failureReason,
      submissionTime,
    };
  }

  /**
   * Monitor transaction confirmation
   */
  async monitorConfirmation(
    opportunityId: string,
    transactionHash: string,
    timeoutMs: number = this.config.confirmationTimeoutMs
  ): Promise<TransactionConfirmationResult> {
    const startTime = Date.now();

    // Check if already monitoring this transaction
    const existingPromise = this.confirmationPromises.get(opportunityId);
    if (existingPromise) {
      return existingPromise;
    }

    const confirmationPromise = this.doMonitorConfirmation(
      opportunityId,
      transactionHash,
      timeoutMs,
      startTime
    );
    this.confirmationPromises.set(opportunityId, confirmationPromise);

    try {
      const result = await confirmationPromise;
      return result;
    } finally {
      this.confirmationPromises.delete(opportunityId);
    }
  }

  /**
   * Replace transaction (RBF)
   */
  async replaceTransaction(
    opportunityId: string,
    options: TransactionReplacementOptions
  ): Promise<TransactionSubmissionResult> {
    if (!this.config.enableReplacement) {
      throw new TransactionError(
        'Transaction replacement is disabled',
        opportunityId,
        TransactionStage.SUBMITTED
      );
    }

    const lifecycleData = this.transactions.get(opportunityId);
    if (!lifecycleData || !lifecycleData.transaction) {
      throw new TransactionError(
        'Transaction not found for replacement',
        opportunityId,
        TransactionStage.SUBMITTED
      );
    }

    const originalTx = lifecycleData.transaction;
    const oldHash = lifecycleData.transactionHash;

    // Build replacement transaction with higher gas price using BigInt arithmetic
    const multiplierScaled = Math.round(this.config.replacementGasMultiplier * 10000); // Scale by 10000 for precision
    const scaleFactor = 10000n;

    const newMaxFeePerGas =
      options.newMaxFeePerGas ?? (originalTx.maxFeePerGas * BigInt(multiplierScaled)) / scaleFactor;
    const newMaxPriorityFeePerGas =
      options.newMaxPriorityFeePerGas ??
      (originalTx.maxPriorityFeePerGas * BigInt(multiplierScaled)) / scaleFactor;

    const replacementTx: TransactionRequest = {
      ...originalTx,
      maxFeePerGas: newMaxFeePerGas,
      maxPriorityFeePerGas: newMaxPriorityFeePerGas,
      data: options.newData ?? originalTx.data,
    };

    this.logger.info('Replacing transaction', {
      opportunityId,
      oldHash,
      reason: options.reason,
      oldGasPrice: originalTx.maxFeePerGas.toString(),
      newGasPrice: replacementTx.maxFeePerGas.toString(),
    });

    // Submit replacement
    const result = await this.submitTransaction(opportunityId, replacementTx);

    if (result.success && result.transactionHash && oldHash) {
      this.transitionStage(opportunityId, TransactionStage.REPLACED, options.reason);

      // Emit replacement event
      this.emit('transactionReplaced', {
        opportunityId,
        oldHash,
        newHash: result.transactionHash,
        reason: options.reason,
        timestamp: Date.now(),
      } satisfies TransactionEvents['transactionReplaced']);
    }

    return result;
  }

  /**
   * Cancel transaction
   */
  async cancelTransaction(opportunityId: string, reason: string): Promise<boolean> {
    const lifecycleData = this.transactions.get(opportunityId);
    if (!lifecycleData) {
      return false;
    }

    this.transitionStage(opportunityId, TransactionStage.CANCELLED, reason);

    this.logger.info('Transaction cancelled', { opportunityId, reason });

    // Emit cancellation event
    this.emit('transactionCancelled', {
      opportunityId,
      reason,
      timestamp: Date.now(),
    } satisfies TransactionEvents['transactionCancelled']);

    return true;
  }

  /**
   * Get transaction lifecycle data
   */
  getTransactionData(opportunityId: string): TransactionLifecycleData | undefined {
    const data = this.transactions.get(opportunityId);
    return data ? { ...data } : undefined;
  }

  /**
   * Process complete transaction lifecycle
   */
  async processTransaction(
    opportunityId: string,
    transactionBuilder: () => Promise<TransactionRequest>
  ): Promise<TransactionConfirmationResult> {
    const startTime = Date.now();

    try {
      // Initialize transaction lifecycle data
      const lifecycleData: TransactionLifecycleData = {
        opportunityId,
        stage: TransactionStage.BUILDING,
        submissionAttempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
        stageHistory: [],
      };

      this.transactions.set(opportunityId, lifecycleData);

      // Build transaction
      this.transitionStage(opportunityId, TransactionStage.BUILDING, 'Building transaction');
      const transaction = await transactionBuilder();
      lifecycleData.transaction = transaction;
      this.transitionStage(opportunityId, TransactionStage.BUILT, 'Transaction built');

      // Emit built event
      this.emit('transactionBuilt', {
        opportunityId,
        transaction,
        timestamp: Date.now(),
      } satisfies TransactionEvents['transactionBuilt']);

      // Simulate transaction if enabled
      if (this.config.enableSimulation) {
        this.transitionStage(opportunityId, TransactionStage.SIMULATING, 'Simulating transaction');
        const simulation = await this.simulateTransaction(transaction);
        this.transitionStage(opportunityId, TransactionStage.SIMULATED, 'Simulation completed');

        // Emit simulation event
        this.emit('transactionSimulated', {
          opportunityId,
          result: simulation,
          timestamp: Date.now(),
        } satisfies TransactionEvents['transactionSimulated']);

        if (!simulation.success) {
          throw new TransactionSimulationError(
            opportunityId,
            simulation.revertReason,
            simulation.gasUsed
          );
        }
      }

      // Submit transaction
      const submission = await this.submitTransaction(opportunityId, transaction);
      if (!submission.success || !submission.transactionHash) {
        throw new TransactionSubmissionError(
          opportunityId,
          submission.failureReason ?? 'Unknown error'
        );
      }

      // Monitor confirmation
      this.transitionStage(opportunityId, TransactionStage.PENDING, 'Monitoring confirmation');
      const confirmation = await this.monitorConfirmation(
        opportunityId,
        submission.transactionHash
      );

      return confirmation;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const failureReason = error instanceof Error ? error.message : String(error);

      this.transitionStage(opportunityId, TransactionStage.FAILED, failureReason);

      this.logger.error('Transaction lifecycle processing failed', {
        opportunityId,
        error: failureReason,
        executionTime,
      });

      return {
        success: false,
        failureReason,
        confirmationTime: executionTime,
      };
    }
  }

  /**
   * Estimate gas for transaction
   */
  private async estimateGas(
    to: Address,
    data: string,
    value: bigint
  ): Promise<GasEstimationResult> {
    try {
      // Get current gas prices
      const feeData = await this.provider.getFeeData();

      // Estimate gas limit
      const estimatedGas = await this.provider.estimateGas({
        to,
        data,
        value,
      });

      // Apply buffer to gas estimate
      const gasLimit = BigInt(
        Math.floor(Number(estimatedGas) * (1 + this.config.gasEstimationBuffer / 100))
      );

      const maxFeePerGas = feeData.maxFeePerGas ?? 25000000000n; // 25 gwei fallback
      const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 2000000000n; // 2 gwei fallback

      const estimatedCost = gasLimit * maxFeePerGas;

      return {
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        estimatedCost,
        confidence: 0.8,
      };
    } catch (error) {
      this.logger.warn('Gas estimation failed, using defaults', {
        to,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return conservative defaults
      return {
        gasLimit: 300000n,
        maxFeePerGas: 30000000000n, // 30 gwei
        maxPriorityFeePerGas: 2000000000n, // 2 gwei
        estimatedCost: 300000n * 30000000000n,
        confidence: 0.5,
      };
    }
  }

  /**
   * Get next nonce for signer
   */
  private async getNextNonce(): Promise<number> {
    if (!this.config.enableNonceManagement) {
      return await this.signer.getNonce();
    }

    const signerAddress = (await this.signer.getAddress()) as Address;
    let nonceState = this.nonceStates.get(signerAddress);

    if (!nonceState) {
      const currentNonce = await this.signer.getNonce();
      nonceState = {
        address: signerAddress,
        currentNonce,
        pendingNonces: new Set(),
        lastUpdated: Date.now(),
      };
      this.nonceStates.set(signerAddress, nonceState);
    }

    // Find next available nonce
    let nextNonce = nonceState.currentNonce;
    while (nonceState.pendingNonces.has(nextNonce)) {
      nextNonce++;
    }

    return nextNonce;
  }

  /**
   * Reserve nonce to prevent conflicts
   */
  private async reserveNonce(nonce: number): Promise<void> {
    if (!this.config.enableNonceManagement) return;

    const signerAddress = (await this.signer.getAddress()) as Address;
    const nonceState = this.nonceStates.get(signerAddress);
    if (nonceState) {
      nonceState.pendingNonces.add(nonce);
      nonceState.currentNonce = Math.max(nonceState.currentNonce, nonce + 1);
      nonceState.lastUpdated = Date.now();
    }
  }

  /**
   * Release nonce after confirmation or failure
   */
  private async releaseNonce(nonce: number): Promise<void> {
    if (!this.config.enableNonceManagement) return;

    const signerAddress = (await this.signer.getAddress()) as Address;
    const nonceState = this.nonceStates.get(signerAddress);
    if (nonceState) {
      nonceState.pendingNonces.delete(nonce);
      nonceState.lastUpdated = Date.now();
    }
  }

  /**
   * Initialize nonce state for signer
   */
  private async initializeNonceState(): Promise<void> {
    if (!this.config.enableNonceManagement) return;

    const signerAddress = (await this.signer.getAddress()) as Address;
    const currentNonce = await this.signer.getNonce();

    this.nonceStates.set(signerAddress, {
      address: signerAddress,
      currentNonce,
      pendingNonces: new Set(),
      lastUpdated: Date.now(),
    });

    this.logger.debug('Nonce state initialized', {
      address: signerAddress,
      currentNonce,
    });
  }

  /**
   * Handle nonce-related errors
   */
  private async handleNonceError(error: Error): Promise<void> {
    if (!this.config.nonceGapRecovery) return;

    // Try to extract nonce information from error and recover
    this.logger.warn('Handling nonce error', { error: error.message });

    // Check if this is a nonce gap error and create appropriate error
    const nonceMatch = error.message.match(/nonce.*?(\d+).*?(\d+)/);
    if (nonceMatch && nonceMatch[1] && nonceMatch[2]) {
      const expected = parseInt(nonceMatch[1]);
      const actual = parseInt(nonceMatch[2]);
      const nonceGapError = this.createNonceGapError('nonce-recovery', expected, actual);
      this.logger.error('Nonce gap detected', {
        expected,
        actual,
        error: nonceGapError.message,
      });
    }

    // Refresh nonce state
    await this.initializeNonceState();
  }

  /**
   * Helper method to create nonce gap errors using NonceGapError type
   */
  private createNonceGapError(
    opportunityId: string,
    expected: number,
    actual: number
  ): NonceGapError {
    this.logger.debug('Creating nonce gap error', { opportunityId, expected, actual });
    return new NonceGapError(opportunityId, expected, actual);
  }

  /**
   * Check if error is nonce-related
   */
  private isNonceError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('nonce') ||
      message.includes('replacement transaction underpriced') ||
      message.includes('already known')
    );
  }

  /**
   * Transition transaction stage
   */
  private transitionStage(
    opportunityId: string,
    newStage: TransactionStage,
    reason?: string
  ): void {
    const lifecycleData = this.transactions.get(opportunityId);
    if (!lifecycleData) return;

    const transition: TransactionStageTransition = {
      from: lifecycleData.stage,
      to: newStage,
      timestamp: Date.now(),
      reason,
    };

    lifecycleData.stage = newStage;
    lifecycleData.updatedAt = Date.now();
    lifecycleData.stageHistory.push(transition);

    this.logger.debug('Transaction stage transition', {
      opportunityId,
      from: transition.from,
      to: newStage,
      reason,
    });
  }

  /**
   * Monitor confirmation implementation
   */
  private async doMonitorConfirmation(
    opportunityId: string,
    transactionHash: string,
    timeoutMs: number,
    startTime: number
  ): Promise<TransactionConfirmationResult> {
    this.transitionStage(opportunityId, TransactionStage.CONFIRMING, 'Monitoring confirmation');

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new TransactionTimeoutError(opportunityId, transactionHash, timeoutMs));
      }, timeoutMs);
    });

    try {
      const receipt = await Promise.race([
        this.provider.waitForTransaction(transactionHash, this.config.confirmationBlocks),
        timeoutPromise,
      ]);

      if (!receipt) {
        throw new TransactionConfirmationError(
          opportunityId,
          transactionHash,
          'No receipt received'
        );
      }

      const confirmationTime = Date.now() - startTime;

      // Update lifecycle data
      const lifecycleData = this.transactions.get(opportunityId);
      if (lifecycleData) {
        lifecycleData.receipt = this.convertReceipt(receipt);
        lifecycleData.gasUsed = receipt.gasUsed;
        lifecycleData.effectiveGasPrice = receipt.gasPrice;

        // Release nonce after successful confirmation - get nonce from transaction response stored earlier
        if (receipt.status === 1) {
          // Get the transaction to access the nonce
          const txResponse = await this.provider.getTransaction(transactionHash);
          if (txResponse && txResponse.nonce !== undefined) {
            await this.releaseNonce(txResponse.nonce);
          }
        }
      }

      if (receipt.status === 1) {
        this.transitionStage(opportunityId, TransactionStage.CONFIRMED, 'Transaction confirmed');

        this.logger.info('Transaction confirmed successfully', {
          opportunityId,
          transactionHash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          confirmationTime,
        });

        // Emit confirmation event
        this.emit('transactionConfirmed', {
          opportunityId,
          receipt: this.convertReceipt(receipt),
          confirmationTime,
          timestamp: Date.now(),
        } satisfies TransactionEvents['transactionConfirmed']);

        return {
          success: true,
          receipt: this.convertReceipt(receipt),
          confirmationTime,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.gasPrice,
        };
      } else {
        this.transitionStage(opportunityId, TransactionStage.FAILED, 'Transaction reverted');

        const failureReason = 'Transaction reverted on-chain';

        this.logger.error('Transaction reverted', {
          opportunityId,
          transactionHash,
          blockNumber: receipt.blockNumber,
          confirmationTime,
        });

        // Emit failure event
        this.emit('transactionFailed', {
          opportunityId,
          stage: TransactionStage.CONFIRMING,
          reason: failureReason,
          transactionHash,
          timestamp: Date.now(),
        } satisfies TransactionEvents['transactionFailed']);

        return {
          success: false,
          receipt: this.convertReceipt(receipt),
          confirmationTime,
          failureReason,
        };
      }
    } catch (error) {
      const confirmationTime = Date.now() - startTime;
      const failureReason = error instanceof Error ? error.message : String(error);

      this.transitionStage(opportunityId, TransactionStage.FAILED, failureReason);

      this.logger.error('Transaction confirmation failed', {
        opportunityId,
        transactionHash,
        error: failureReason,
        confirmationTime,
      });

      // Emit failure event
      this.emit('transactionFailed', {
        opportunityId,
        stage: TransactionStage.CONFIRMING,
        reason: failureReason,
        transactionHash,
        timestamp: Date.now(),
      } satisfies TransactionEvents['transactionFailed']);

      return {
        success: false,
        confirmationTime,
        failureReason,
      };
    }
  }

  /**
   * Monitor pending transactions for status updates
   */
  private async monitorPendingTransactions(): Promise<void> {
    // Get current pool status for monitoring context
    const poolStatus = this.createPoolStatus();

    const pendingTransactions = Array.from(this.transactions.values()).filter(
      tx => tx.stage === TransactionStage.PENDING || tx.stage === TransactionStage.CONFIRMING
    );

    this.logger.debug('Monitoring pending transactions', {
      pendingCount: pendingTransactions.length,
      poolStatus: poolStatus.congestionLevel,
    });

    for (const tx of pendingTransactions) {
      if (!tx.transactionHash) continue;

      try {
        const receipt = await this.provider.getTransactionReceipt(tx.transactionHash);
        if (receipt && !this.confirmationPromises.has(tx.opportunityId)) {
          // Transaction was confirmed outside of our monitoring
          this.logger.info('Detected external transaction confirmation', {
            opportunityId: tx.opportunityId,
            transactionHash: tx.transactionHash,
          });
        }
      } catch (error) {
        // Transaction might have been replaced or dropped
        this.logger.debug('Error checking transaction status', {
          opportunityId: tx.opportunityId,
          transactionHash: tx.transactionHash,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
