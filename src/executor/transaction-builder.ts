/**
 * Transaction Builder
 *
 * Builds transaction data for arbitrage execution using Flash Executor contract
 */

import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { TransactionRequest, ArbitrageRoute, ExecutionOptions } from '../types/execution';
import { Address } from '../types/common';
import { ContractManager } from '../contracts/contract-manager';

export interface TransactionBuilderOptions {
  readonly contractManager: ContractManager;
  readonly provider: ethers.Provider;
  readonly defaultGasLimit?: bigint | undefined;
  readonly defaultSlippage?: number | undefined;
}

export class TransactionBuilder {
  private readonly logger = createComponentLogger('transaction-builder');
  private readonly contractManager: ContractManager;
  private readonly provider: ethers.Provider;
  private readonly defaultGasLimit: bigint;
  private readonly defaultSlippage: number;
  private flashExecutorInterface: ethers.Interface;

  constructor(options: TransactionBuilderOptions) {
    this.contractManager = options.contractManager;
    this.provider = options.provider;
    this.defaultGasLimit = options.defaultGasLimit ?? 500000n;
    this.defaultSlippage = options.defaultSlippage ?? 0.01; // 1%

    // Initialize Flash Executor contract interface
    this.flashExecutorInterface = new ethers.Interface([
      'function executeArbitrage(address flashPool, uint256 amount0, uint256 amount1, bytes calldata routeData) external',
    ]);

    this.logger.info('Transaction builder initialized', {
      flashExecutorAddress: this.getFlashExecutorAddress(),
      defaultGasLimit: this.defaultGasLimit.toString(),
      defaultSlippage: this.defaultSlippage,
    });
  }

  /**
   * Get Flash Executor contract address
   */
  private getFlashExecutorAddress(): Address {
    const config = this.contractManager.getFlashExecutorConfig();
    if (!config.address) {
      throw new Error('Flash Executor contract not deployed');
    }
    return config.address as Address;
  }

  /**
   * Get current nonce for wallet
   */
  async getNonce(walletAddress: Address): Promise<number> {
    try {
      const nonce = await this.provider.getTransactionCount(walletAddress, 'pending');
      this.logger.debug('Retrieved nonce', { walletAddress, nonce });
      return nonce;
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'get-nonce',
        walletAddress,
      });
      throw new Error(`Failed to get nonce: ${(error as Error).message}`);
    }
  }

  /**
   * Build arbitrage transaction for Flash Executor contract
   */
  async buildArbitrageTx(
    route: ArbitrageRoute,
    walletAddress: Address,
    options?: ExecutionOptions
  ): Promise<TransactionRequest> {
    try {
      this.logger.debug('Building arbitrage transaction', {
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        amountIn: route.amountIn.toString(),
        expectedProfit: route.expectedProfit.toString(),
        steps: route.path.length,
      });

      // Validate route first
      const validation = this.validateRoute(route);
      if (!validation.valid) {
        throw new Error(`Invalid route: ${validation.reason}`);
      }

      // Determine flash loan parameters
      const flashLoanParams = await this.calculateFlashLoanParams(route);

      // Encode route data for Flash Executor contract
      const encodedRouteData = this.encodeSwapRoute(route, options);

      // Build transaction data
      const txData = this.flashExecutorInterface.encodeFunctionData('executeArbitrage', [
        flashLoanParams.flashPool,
        flashLoanParams.amount0,
        flashLoanParams.amount1,
        encodedRouteData,
      ]);

      // Get current nonce for validation
      const nonce = await this.getNonce(walletAddress);

      // Calculate gas limit
      const gasLimit = this.calculateGasLimit(route, options);

      // Calculate priority fee
      let maxPriorityFeePerGas: bigint | undefined;
      if (options?.maxPriorityFeePerGas) {
        maxPriorityFeePerGas = options.maxPriorityFeePerGas;
      } else if (options?.maxGasPrice) {
        // Use the greater of maxGasPrice/10 and minimum 2 gwei
        const minPriorityFee = 2000000000n; // 2 gwei
        const calculatedFee = options.maxGasPrice / 10n;
        maxPriorityFeePerGas = calculatedFee > minPriorityFee ? calculatedFee : minPriorityFee;

        // Ensure it doesn't exceed maxFeePerGas
        if (maxPriorityFeePerGas > options.maxGasPrice) {
          maxPriorityFeePerGas = options.maxGasPrice;
        }
      }

      // Build transaction request
      const tx: TransactionRequest = {
        to: this.getFlashExecutorAddress(),
        data: txData,
        value: 0n, // No ETH value needed for flash loan arbitrage
        gasLimit,
        maxFeePerGas: options?.maxGasPrice || 25000000000n,
        maxPriorityFeePerGas: maxPriorityFeePerGas || 2000000000n,
      };

      this.logger.debug('Arbitrage transaction built', {
        to: tx.to,
        dataLength: tx.data.length,
        gasLimit: tx.gasLimit?.toString(),
        nonce: nonce, // Use nonce in logging
        flashPool: flashLoanParams.flashPool,
        amount0: flashLoanParams.amount0.toString(),
        amount1: flashLoanParams.amount1.toString(),
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
   * Calculate flash loan parameters from arbitrage route
   */
  private async calculateFlashLoanParams(route: ArbitrageRoute): Promise<{
    flashPool: Address;
    amount0: bigint;
    amount1: bigint;
  }> {
    // Use the first pool in the route as the flash loan source
    const firstStep = route.path[0];
    if (!firstStep) {
      throw new Error('Route has no steps');
    }

    const flashPool = firstStep.poolAddress as Address;

    try {
      // Query the pool contract to get token0 and token1 addresses
      const poolContract = new ethers.Contract(
        flashPool,
        ['function token0() view returns (address)', 'function token1() view returns (address)'],
        this.provider
      );

      const [token0Address, token1Address] = await Promise.all([
        (poolContract['token0'] as () => Promise<string>)(),
        (poolContract['token1'] as () => Promise<string>)(),
      ]);

      // Determine which amount field to set based on tokenIn
      let amount0 = 0n;
      let amount1 = 0n;

      if (route.tokenIn.toLowerCase() === token0Address.toLowerCase()) {
        amount0 = route.amountIn;
      } else if (route.tokenIn.toLowerCase() === token1Address.toLowerCase()) {
        amount1 = route.amountIn;
      } else {
        throw new Error(
          `Token ${route.tokenIn} is neither token0 (${token0Address}) nor token1 (${token1Address}) in pool ${flashPool}`
        );
      }

      this.logger.debug('Flash loan parameters calculated', {
        flashPool,
        token0: token0Address,
        token1: token1Address,
        tokenIn: route.tokenIn,
        amount0: amount0.toString(),
        amount1: amount1.toString(),
      });

      return {
        flashPool,
        amount0,
        amount1,
      };
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'calculate-flash-loan-params',
        flashPool,
        tokenIn: route.tokenIn,
      });
      throw new Error(`Failed to calculate flash loan parameters: ${(error as Error).message}`);
    }
  }

  /**
   * Encode swap route for Flash Executor contract
   */
  private encodeSwapRoute(route: ArbitrageRoute, options?: ExecutionOptions): string {
    try {
      // Calculate minimum profit with slippage using basis points for precision
      const slippageTolerance = options?.slippageTolerance ?? this.defaultSlippage;
      const slippageBps = Math.floor(slippageTolerance * 10000); // Convert to basis points (0-10000)

      // Calculate minProfit using integer-safe math
      // minProfit = expectedProfit * (10000 - slippageBps) / 10000
      const minProfit = (route.expectedProfit * BigInt(10000 - slippageBps)) / 10000n;

      // Calculate deadline (default 5 minutes from now)
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

      // Extract pool addresses and directions from route
      const pools: Address[] = [];
      const directions: boolean[] = [];

      for (const step of route.path) {
        pools.push(step.poolAddress as Address);
        // Use the precomputed direction from route discovery
        directions.push(step.direction);
      }

      // Create SwapRoute struct
      const swapRoute = {
        pools,
        directions,
        minProfit,
        deadline,
      };

      // Encode as bytes using ABI encoder
      const encodedRoute = ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(address[] pools, bool[] directions, uint256 minProfit, uint256 deadline)'],
        [swapRoute]
      );

      this.logger.debug('Route encoded successfully', {
        pools: pools.length,
        directions: directions.length,
        slippageBps,
        minProfit: minProfit.toString(),
        deadline: deadline.toString(),
        dataLength: encodedRoute.length,
      });

      return encodedRoute;
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'encode-swap-route',
      });
      throw new Error(`Failed to encode swap route: ${(error as Error).message}`);
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
  async estimateGasCost(
    route: ArbitrageRoute,
    walletAddress: Address,
    gasPrice: bigint,
    options?: ExecutionOptions
  ): Promise<bigint> {
    const gasLimit = this.calculateGasLimit(route, options);

    this.logger.debug('Gas cost estimated', {
      gasLimit: gasLimit.toString(),
      gasPrice: gasPrice.toString(),
      walletAddress, // Use walletAddress in logging
    });

    return gasLimit * gasPrice;
  }

  /**
   * Estimate gas limit using provider simulation
   */
  async estimateGasLimit(
    route: ArbitrageRoute,
    walletAddress: Address,
    options?: ExecutionOptions
  ): Promise<bigint> {
    try {
      // Build transaction for estimation
      const tx = await this.buildArbitrageTx(route, walletAddress, options);

      // Estimate gas using provider
      const estimatedGas = await this.provider.estimateGas({
        to: tx.to,
        data: tx.data,
        from: walletAddress,
        value: tx.value ?? 0n, // Provide default value
      });

      // Add buffer for safety
      const gasBuffer = (estimatedGas * 120n) / 100n; // 20% buffer

      this.logger.debug('Gas estimated via provider', {
        estimated: estimatedGas.toString(),
        withBuffer: gasBuffer.toString(),
        walletAddress, // Use walletAddress in logging
      });

      return gasBuffer;
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'estimate-gas-limit',
        fallbackToCalculated: true,
        walletAddress, // Use walletAddress in error logging
      });

      // Fallback to calculated gas limit
      return this.calculateGasLimit(route, options);
    }
  }

  /**
   * Validate arbitrage route parameters
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

    // Validate pool addresses are authorized
    const authorizedPools = this.contractManager.getAllAuthorizedPoolAddresses();
    for (const step of route.path) {
      if (!authorizedPools.includes(step.poolAddress as Address)) {
        return { valid: false, reason: `Unauthorized pool: ${step.poolAddress}` };
      }
    }

    return { valid: true };
  }

  /**
   * Validate execution options
   */
  validateExecutionOptions(options?: ExecutionOptions): { valid: boolean; reason?: string } {
    if (!options) {
      return { valid: true };
    }

    // Check slippage tolerance
    if (options.slippageTolerance !== undefined) {
      if (options.slippageTolerance < 0 || options.slippageTolerance > 0.1) {
        return { valid: false, reason: 'Slippage tolerance must be between 0 and 10%' };
      }
    }

    // Check gas limit multiplier
    if (options.gasLimitMultiplier !== undefined) {
      if (options.gasLimitMultiplier < 1 || options.gasLimitMultiplier > 3) {
        return { valid: false, reason: 'Gas limit multiplier must be between 1 and 3' };
      }
    }

    // Check max gas price
    if (options.maxGasPrice !== undefined) {
      if (options.maxGasPrice <= 0n) {
        return { valid: false, reason: 'Max gas price must be positive' };
      }
    }

    return { valid: true };
  }
}
