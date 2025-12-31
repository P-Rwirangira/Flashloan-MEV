/**
 * Transaction Executor
 *
 * Executes arbitrage transactions with proper error handling and result tracking
 */

import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { RelayManager } from '../bundler/relay-manager';
import { TransactionBuilder } from './transaction-builder';
import { Address } from '../types/common';
import {
  ExecutionResult,
  ArbitrageRoute,
  ExecutionOptions,
  ExecutionMetrics,
} from '../types/execution';

export interface TransactionExecutorOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly relayManager?: RelayManager | undefined;
  readonly transactionBuilder: TransactionBuilder;
  readonly wallet: ethers.Wallet;
  readonly dryRun?: boolean | undefined;
  readonly ethPriceUSD?: number | undefined;
}

export class TransactionExecutor {
  private readonly logger = createComponentLogger('transaction-executor');
  private readonly connectionManager: RpcConnectionManager;
  private readonly relayManager?: RelayManager | undefined;
  private readonly transactionBuilder: TransactionBuilder;
  private readonly wallet: ethers.Wallet;
  private _dryRun: boolean;
  private readonly ethPriceUSD: number;

  private metrics: ExecutionMetrics = {
    totalExecutions: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    totalProfit: 0n,
    totalProfitUSD: 0,
    totalGasCost: 0n,
    averageExecutionTimeMs: 0,
    successRate: 0,
  };

  constructor(options: TransactionExecutorOptions) {
    this.connectionManager = options.connectionManager;
    this.relayManager = options.relayManager;
    this.transactionBuilder = options.transactionBuilder;
    this.wallet = options.wallet;
    this._dryRun = options.dryRun ?? false;
    this.ethPriceUSD = options.ethPriceUSD ?? 3000; // Default fallback price

    this.logger.info('Transaction executor initialized', {
      dryRun: this.dryRun,
      hasRelayManager: !!this.relayManager,
      walletAddress: this.wallet.address,
    });
  }

  /**
   * Execute arbitrage transaction
   */
  async executeArbitrage(
    route: ArbitrageRoute,
    options?: ExecutionOptions
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const operationId = `execute-arbitrage-${startTime}`;

    try {
      this.logger.startPerformanceTracking(operationId);
      this.logger.info('Executing arbitrage', {
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        amountIn: ethers.formatEther(route.amountIn),
        expectedProfit: ethers.formatEther(route.expectedProfit),
        expectedProfitUSD: route.expectedProfitUSD,
        dryRun: this.dryRun || options?.dryRun,
      });

      // Validate route
      const validation = this.transactionBuilder.validateRoute(route);
      if (!validation.valid) {
        throw new Error(`Invalid route: ${validation.reason}`);
      }

      // Build transaction
      const tx = await this.transactionBuilder.buildArbitrageTx(
        route,
        this.wallet.address as Address,
        options
      );

      // Dry run mode - don't actually send transaction
      if (this.dryRun || options?.dryRun) {
        this.logger.info('Dry run mode - transaction not sent', {
          to: tx.to,
          dataLength: tx.data.length,
          gasLimit: tx.gasLimit?.toString(),
        });

        const result: ExecutionResult = {
          success: true,
          executionTimeMs: Date.now() - startTime,
          profit: route.expectedProfit,
          profitUSD: route.expectedProfitUSD,
        };

        this.updateMetrics(result);
        return result;
      }

      // Get current gas price
      const provider = this.connectionManager.getProvider();
      const feeData = await provider.getFeeData();
      const maxFeePerGas = options?.maxGasPrice ?? feeData.maxFeePerGas ?? undefined;
      const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? undefined;

      // Prepare transaction with gas settings
      const txRequest: ethers.TransactionRequest = {
        to: tx.to,
        data: tx.data,
      };

      // Add optional fields only if defined
      if (tx.value !== undefined) {
        txRequest.value = tx.value;
      }
      if (tx.gasLimit !== undefined) {
        txRequest.gasLimit = tx.gasLimit;
      }
      if (maxFeePerGas !== undefined && maxFeePerGas !== null) {
        txRequest.maxFeePerGas = maxFeePerGas;
      }
      if (maxPriorityFeePerGas !== undefined && maxPriorityFeePerGas !== null) {
        txRequest.maxPriorityFeePerGas = maxPriorityFeePerGas;
      }
      if (tx.nonce !== undefined) {
        txRequest.nonce = tx.nonce;
      }

      // Execute transaction
      let txResponse: ethers.TransactionResponse;

      if (options?.usePrivateRelay && this.relayManager) {
        // Use private relay (Flashbots/bloXroute)
        this.logger.info('Submitting via private relay');
        const relayResult = await this.relayManager.submitTransaction(txRequest);

        if (!relayResult.success) {
          throw new Error(`Relay submission failed: ${relayResult.error}`);
        }

        // For relay submissions, we need to wait for the transaction
        if (relayResult.transactionHash) {
          // Poll for transaction with retry logic
          txResponse = await this.pollForTransaction(relayResult.transactionHash, provider);
        } else {
          throw new Error('No transaction hash from relay');
        }
      } else {
        // Send directly via wallet
        this.logger.info('Submitting via direct transaction');
        txResponse = await this.wallet.sendTransaction(txRequest);
      }

      this.logger.info('Transaction sent', {
        hash: txResponse.hash,
        nonce: txResponse.nonce,
      });

      // Wait for confirmation
      const receipt = await txResponse.wait();

      if (!receipt) {
        throw new Error('Transaction receipt not available');
      }

      // Calculate actual profit and gas cost
      const gasUsed = receipt.gasUsed;
      const effectiveGasPrice = receipt.gasPrice;
      const gasCost = gasUsed * effectiveGasPrice;

      // Actual profit = expected profit - gas cost
      const actualProfit = route.expectedProfit - gasCost;
      const gasCostETH = Number(ethers.formatEther(gasCost));
      const actualProfitUSD = route.expectedProfitUSD - gasCostETH * this.ethPriceUSD;

      const result: ExecutionResult = {
        success: receipt.status === 1,
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed,
        effectiveGasPrice,
        profit: actualProfit,
        profitUSD: actualProfitUSD,
        executionTimeMs: Date.now() - startTime,
      };

      this.logger.info('Arbitrage executed successfully', {
        hash: result.transactionHash,
        blockNumber: result.blockNumber,
        gasUsed: result.gasUsed?.toString(),
        profit: ethers.formatEther(actualProfit),
        profitUSD: actualProfitUSD.toFixed(2),
        executionTimeMs: result.executionTimeMs,
      });

      this.updateMetrics(result);
      this.logger.endPerformanceTracking(operationId);

      return result;
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;

      this.logger.logError(error as Error, {
        operation: 'execute-arbitrage',
        route: {
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          amountIn: route.amountIn.toString(),
        },
        executionTimeMs,
      });

      const result: ExecutionResult = {
        success: false,
        executionTimeMs,
        error: (error as Error).message,
        revertReason: this.extractRevertReason(error),
      };

      this.updateMetrics(result);
      this.logger.endPerformanceTracking(operationId);

      return result;
    }
  }

  /**
   * Extract revert reason from error
   */
  private extractRevertReason(error: unknown): string | undefined {
    if (error instanceof Error) {
      // Try to extract revert reason from error message
      const match = error.message.match(/reverted with reason string '(.+?)'/);
      if (match && match[1]) {
        return match[1];
      }

      // Check for custom error
      const customMatch = error.message.match(/reverted with custom error '(.+?)'/);
      if (customMatch && customMatch[1]) {
        return customMatch[1];
      }
    }

    return undefined;
  }

  /**
   * Update execution metrics
   */
  private updateMetrics(result: ExecutionResult): void {
    this.metrics.totalExecutions++;

    if (result.success) {
      this.metrics.successfulExecutions++;
      if (result.profit) {
        this.metrics.totalProfit += result.profit;
      }
      if (result.profitUSD) {
        this.metrics.totalProfitUSD += result.profitUSD;
      }
    } else {
      this.metrics.failedExecutions++;
    }

    if (result.gasUsed && result.effectiveGasPrice) {
      this.metrics.totalGasCost += result.gasUsed * result.effectiveGasPrice;
    }

    // Update average execution time
    const totalTime =
      this.metrics.averageExecutionTimeMs * (this.metrics.totalExecutions - 1) +
      result.executionTimeMs;
    this.metrics.averageExecutionTimeMs = totalTime / this.metrics.totalExecutions;

    // Update success rate
    this.metrics.successRate = this.metrics.successfulExecutions / this.metrics.totalExecutions;

    this.logger.debug('Metrics updated', {
      totalExecutions: this.metrics.totalExecutions,
      successRate: `${(this.metrics.successRate * 100).toFixed(2)}%`,
      totalProfit: ethers.formatEther(this.metrics.totalProfit),
      totalProfitUSD: this.metrics.totalProfitUSD.toFixed(2),
    });
  }

  /**
   * Get execution metrics
   */
  getMetrics(): ExecutionMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      totalProfit: 0n,
      totalProfitUSD: 0,
      totalGasCost: 0n,
      averageExecutionTimeMs: 0,
      successRate: 0,
    };

    this.logger.info('Metrics reset');
  }

  /**
   * Get dry run mode
   */
  get dryRun(): boolean {
    return this._dryRun;
  }

  /**
   * Set dry run mode
   */
  setDryRun(enabled: boolean): void {
    this._dryRun = enabled;
    this.logger.info('Dry run mode updated', { enabled });
  }

  /**
   * Poll for transaction with retry logic
   */
  private async pollForTransaction(
    txHash: string,
    provider: ethers.Provider,
    maxAttempts: number = 10,
    baseDelay: number = 500
  ): Promise<ethers.TransactionResponse> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const tx = await provider.getTransaction(txHash);
        if (tx) {
          return tx;
        }
      } catch (error) {
        this.logger.debug(`Transaction polling attempt ${attempt} failed`, {
          txHash,
          error: (error as Error).message,
        });
      }

      if (attempt < maxAttempts) {
        // Exponential backoff with jitter
        const delay = baseDelay * Math.pow(1.5, attempt - 1) + Math.random() * 100;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error(`Transaction ${txHash} not found after ${maxAttempts} attempts`);
  }
}
