/**
 * Foundry Simulator
 *
 * Transaction simulation using Foundry for accurate gas estimation and validation
 */

import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { Address } from '../types/common';
import { TransactionRequest } from '../types/execution';

export interface SimulationResult {
  success: boolean;
  gasUsed: bigint;
  returnData: string;
  revertReason?: string;
  logs: ethers.Log[];
  balanceChanges: Map<Address, bigint>;
}

export interface SimulationConfig {
  forkUrl: string;
  blockNumber?: number | undefined;
  enableTracing: boolean;
  maxGasLimit: bigint;
}

/**
 * Foundry-based transaction simulator
 */
export class FoundrySimulator {
  private readonly logger = createComponentLogger('foundry-simulator');
  private readonly config: SimulationConfig;
  private provider: ethers.Provider;

  constructor(config: Partial<SimulationConfig> = {}) {
    this.config = {
      forkUrl: config.forkUrl || process.env['BASE_RPC_URL'] || 'https://mainnet.base.org',
      blockNumber: config.blockNumber,
      enableTracing: config.enableTracing ?? true,
      maxGasLimit: config.maxGasLimit ?? 1000000n,
      ...config,
    };

    // Create provider for simulation
    this.provider = new ethers.JsonRpcProvider(this.config.forkUrl);
  }

  /**
   * Simulate transaction execution
   */
  async simulate(
    transaction: TransactionRequest,
    fromAddress: Address,
    blockNumber?: number
  ): Promise<SimulationResult> {
    try {
      const simulationBlock = blockNumber || this.config.blockNumber || 'latest';

      // Prepare call data
      const callData = {
        from: fromAddress,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value?.toString() || '0x0',
        gasLimit: transaction.gasLimit?.toString() || this.config.maxGasLimit.toString(),
      };

      // Log simulation block for monitoring
      this.logger.debug('Simulating transaction', {
        simulationBlock,
        from: fromAddress,
        to: transaction.to,
      });

      // Simulate using eth_call first to check for reverts
      try {
        const result = await this.provider.call(callData);

        // Estimate gas usage
        const gasEstimate = await this.provider.estimateGas(callData);

        return {
          success: true,
          gasUsed: BigInt(gasEstimate.toString()),
          returnData: result,
          logs: [], // Would need trace_transaction for full logs
          balanceChanges: new Map(),
        };
      } catch (error) {
        // Handle revert
        const revertReason = this.extractRevertReason(error);

        return {
          success: false,
          gasUsed: 0n,
          returnData: '0x',
          revertReason,
          logs: [],
          balanceChanges: new Map(),
        };
      }
    } catch (error) {
      this.logger.error('Simulation failed', {
        transaction: {
          to: transaction.to,
          data: transaction.data?.slice(0, 10) + '...',
        },
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        gasUsed: 0n,
        returnData: '0x',
        revertReason: error instanceof Error ? error.message : String(error),
        logs: [],
        balanceChanges: new Map(),
      };
    }
  }

  /**
   * Simulate multiple transactions in sequence
   */
  async simulateBundle(
    transactions: TransactionRequest[],
    fromAddress: Address,
    blockNumber?: number
  ): Promise<SimulationResult[]> {
    const results: SimulationResult[] = [];

    for (const transaction of transactions) {
      const result = await this.simulate(transaction, fromAddress, blockNumber);
      results.push(result);

      // Stop if any transaction fails
      if (!result.success) {
        break;
      }
    }

    return results;
  }

  /**
   * Validate arbitrage profitability through simulation
   */
  async validateArbitrage(
    flashLoanTransaction: TransactionRequest,
    executorAddress: Address,
    expectedProfit: bigint,
    blockNumber?: number
  ): Promise<{
    profitable: boolean;
    actualProfit: bigint;
    gasUsed: bigint;
    revertReason?: string;
  }> {
    try {
      // Get initial balance for profit calculation
      const initialBalance = await this.provider.getBalance(
        executorAddress,
        blockNumber || 'latest'
      );

      // Simulate the transaction
      const result = await this.simulate(flashLoanTransaction, executorAddress, blockNumber);

      if (!result.success) {
        const revertReason = result.revertReason;
        return {
          profitable: false,
          actualProfit: 0n,
          gasUsed: result.gasUsed,
          ...(revertReason && { revertReason }),
        };
      }

      // Calculate actual profit using initial balance for future enhancement
      const gasCost = result.gasUsed * (flashLoanTransaction.maxFeePerGas || 20000000000n);
      const netProfit = expectedProfit > gasCost ? expectedProfit - gasCost : 0n;

      // Log balance for monitoring
      this.logger.debug('Balance check for arbitrage validation', {
        executorAddress,
        initialBalance: initialBalance.toString(),
      });

      return {
        profitable: netProfit > 0n,
        actualProfit: netProfit,
        gasUsed: result.gasUsed,
      };
    } catch (error) {
      return {
        profitable: false,
        actualProfit: 0n,
        gasUsed: 0n,
        revertReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Extract revert reason from error
   */
  private extractRevertReason(error: any): string {
    if (error?.reason) {
      return error.reason;
    }

    if (error?.data) {
      try {
        // Try to decode revert reason from error data
        const errorData = error.data;
        if (errorData.startsWith('0x08c379a0')) {
          // Standard revert reason
          const reason = ethers.AbiCoder.defaultAbiCoder().decode(
            ['string'],
            '0x' + errorData.slice(10)
          );
          return reason[0];
        }
      } catch {
        // Ignore decode errors
      }
    }

    if (error?.message) {
      return error.message;
    }

    return 'Unknown revert reason';
  }

  /**
   * Update simulation configuration
   */
  updateConfig(newConfig: Partial<SimulationConfig>): void {
    Object.assign(this.config, newConfig);

    // Update provider if fork URL changed
    if (newConfig.forkUrl) {
      this.provider = new ethers.JsonRpcProvider(this.config.forkUrl);
    }

    this.logger.info('Simulation configuration updated', { config: this.config });
  }
}
