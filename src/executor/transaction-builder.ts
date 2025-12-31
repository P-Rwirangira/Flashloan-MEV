/**
 * Transaction Builder
 *
 * Builds transaction data for arbitrage execution
 */

import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { TransactionRequest, ArbitrageRoute, ExecutionOptions } from '../types/execution';
import { Address } from '../types/common';

export interface TransactionBuilderOptions {
  readonly flashExecutorAddress: Address;
  readonly defaultGasLimit?: bigint | undefined;
  readonly defaultSlippage?: number | undefined;
}

export class TransactionBuilder {
  private readonly logger = createComponentLogger('transaction-builder');
  private readonly flashExecutorAddress: Address;
  private readonly defaultGasLimit: bigint;
  private readonly defaultSlippage: number;

  constructor(options: TransactionBuilderOptions) {
    this.flashExecutorAddress = options.flashExecutorAddress;
    this.defaultGasLimit = options.defaultGasLimit ?? 500000n;
    this.defaultSlippage = options.defaultSlippage ?? 0.01; // 1%

    this.logger.info('Transaction builder initialized', {
      flashExecutorAddress: this.flashExecutorAddress,
      defaultGasLimit: this.defaultGasLimit.toString(),
      defaultSlippage: this.defaultSlippage,
    });
  }

  /**
   * Build arbitrage transaction
   */
  buildArbitrageTx(route: ArbitrageRoute, options?: ExecutionOptions): TransactionRequest {
    try {
      this.logger.debug('Building arbitrage transaction', {
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        amountIn: route.amountIn.toString(),
        expectedProfit: route.expectedProfit.toString(),
        steps: route.path.length,
      });

      // Encode route data for flash executor contract
      const encodedData = this.encodeArbitrageRoute(route, options);

      // Calculate gas limit
      const gasLimit = this.calculateGasLimit(route, options);

      // Build transaction request
      const tx: TransactionRequest = {
        to: this.flashExecutorAddress,
        data: encodedData,
        value: 0n, // No ETH value needed for flash loan arbitrage
        gasLimit,
        maxFeePerGas: options?.maxGasPrice,
        maxPriorityFeePerGas: options?.maxGasPrice ? options.maxGasPrice / 10n : undefined,
      };

      this.logger.debug('Arbitrage transaction built', {
        to: tx.to,
        dataLength: tx.data.length,
        gasLimit: tx.gasLimit?.toString(),
      });

      return tx;
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'build-arbitrage-tx',
        route: {
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          steps: route.path.length,
        },
      });
      throw error;
    }
  }

  /**
   * Encode arbitrage route for smart contract
   */
  private encodeArbitrageRoute(route: ArbitrageRoute, options?: ExecutionOptions): string {
    try {
      // Calculate minimum output with slippage
      const slippage = options?.slippageTolerance ?? this.defaultSlippage;
      const minAmountOut =
        route.minAmountOut - (route.minAmountOut * BigInt(Math.floor(slippage * 10000))) / 10000n;

      // Encode route steps
      const encodedSteps = route.path.map(step => ({
        protocol: step.protocol,
        pool: step.poolAddress,
        tokenIn: step.tokenIn,
        tokenOut: step.tokenOut,
        amountIn: step.amountIn,
        fee: step.fee ?? 0,
      }));

      // Create function signature for executeArbitrage
      const iface = new ethers.Interface([
        'function executeArbitrage(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bytes calldata routeData) external',
      ]);

      // Encode route data as bytes
      const routeData = ethers.AbiCoder.defaultAbiCoder().encode(
        [
          'tuple(uint8 protocol, address pool, address tokenIn, address tokenOut, uint256 amountIn, uint24 fee)[]',
        ],
        [encodedSteps]
      );

      // Encode function call
      const encodedCall = iface.encodeFunctionData('executeArbitrage', [
        route.tokenIn,
        route.tokenOut,
        route.amountIn,
        minAmountOut,
        routeData,
      ]);

      this.logger.debug('Route encoded successfully', {
        steps: encodedSteps.length,
        minAmountOut: minAmountOut.toString(),
        dataLength: encodedCall.length,
      });

      return encodedCall;
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'encode-arbitrage-route',
      });
      throw new Error(`Failed to encode arbitrage route: ${(error as Error).message}`);
    }
  }

  /**
   * Calculate gas limit for transaction
   */
  private calculateGasLimit(route: ArbitrageRoute, options?: ExecutionOptions): bigint {
    // Base gas cost
    let gasLimit = 200000n; // Base overhead

    // Add gas per swap step
    const gasPerStep = 150000n; // Approximate gas per DEX swap
    gasLimit += BigInt(route.path.length) * gasPerStep;

    // Apply multiplier if specified
    const multiplier = options?.gasLimitMultiplier ?? 1.2;
    gasLimit = (gasLimit * BigInt(Math.floor(multiplier * 100))) / 100n;

    // Ensure minimum gas limit
    if (gasLimit < this.defaultGasLimit) {
      gasLimit = this.defaultGasLimit;
    }

    this.logger.debug('Gas limit calculated', {
      steps: route.path.length,
      gasLimit: gasLimit.toString(),
      multiplier,
    });

    return gasLimit;
  }

  /**
   * Estimate transaction gas cost
   */
  estimateGasCost(route: ArbitrageRoute, gasPrice: bigint, options?: ExecutionOptions): bigint {
    const gasLimit = this.calculateGasLimit(route, options);
    return gasLimit * gasPrice;
  }

  /**
   * Validate arbitrage route
   */
  validateRoute(route: ArbitrageRoute): { valid: boolean; reason?: string } {
    // Check route has steps
    if (route.path.length === 0) {
      return { valid: false, reason: 'Route has no steps' };
    }

    // Check amount is positive
    if (route.amountIn <= 0n) {
      return { valid: false, reason: 'Amount in must be positive' };
    }

    // Check expected profit is positive
    if (route.expectedProfit <= 0n) {
      return { valid: false, reason: 'Expected profit must be positive' };
    }

    // Check route continuity
    for (let i = 0; i < route.path.length - 1; i++) {
      const currentStep = route.path[i];
      const nextStep = route.path[i + 1];

      if (!currentStep || !nextStep) {
        return { valid: false, reason: 'Invalid route step' };
      }

      if (currentStep.tokenOut !== nextStep.tokenIn) {
        return { valid: false, reason: `Route discontinuity at step ${i}` };
      }
    }

    // Check route starts and ends with same token (arbitrage loop)
    const firstStep = route.path[0];
    const lastStep = route.path[route.path.length - 1];

    if (!firstStep || !lastStep) {
      return { valid: false, reason: 'Invalid route steps' };
    }

    if (firstStep.tokenIn !== lastStep.tokenOut) {
      return { valid: false, reason: 'Route must start and end with same token' };
    }

    return { valid: true };
  }
}
