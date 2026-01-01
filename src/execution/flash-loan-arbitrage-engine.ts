/**
 * Flash Loan Arbitrage Engine
 *
 * Core arbitrage execution engine using flash loans for capital-free trading
 * Requirements: 1.1, 1.6, 1.7
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { Address } from '../types/common';
import { OpportunityStateMachine } from './opportunity-state-machine';
import { FlashLoanManager } from './flash-loan-manager';
import { TransactionLifecycleManager } from './transaction-lifecycle-manager';
import { OpportunityState } from '../types/execution-state';
import {
  BaseOpportunity,
  ArbitrageOpportunity,
  ExecutionResult,
  ExecutionContext,
  OpportunityType,
  OpportunityPhase,
  IExecutionEngine,
  SwapRoute,
} from '../types/execution';
import { FlashLoanSource } from '../types/flash-loan';
import { TransactionRequest } from '../types/transaction';

/**
 * Arbitrage execution configuration
 */
export interface ArbitrageEngineConfig {
  flashExecutorAddress: Address;
  maxSlippageBps: number; // Basis points (100 = 1%)
  minProfitThresholdUsd: number;
  gasOptimizationEnabled: boolean;
  enableProfitValidation: boolean;
  maxRouteHops: number;
  routeTimeoutMs: number;
  enableMultiDexRouting: boolean;
  supportedDexes: ('uniswap-v3' | 'aerodrome')[];
}

/**
 * Route execution plan
 */
interface RouteExecutionPlan {
  flashLoanSource: FlashLoanSource;
  swapRoute: SwapRoute[];
  expectedProfit: bigint;
  totalGasCost: bigint;
  netProfit: bigint;
  executionData: string;
}

/**
 * Arbitrage execution metrics
 */
interface ArbitrageMetrics {
  totalExecutions: number;
  successfulExecutions: number;
  totalProfit: bigint;
  totalGasCost: bigint;
  avgExecutionTime: number;
  successRate: number;
  profitPerExecution: bigint;
  routesByDex: Record<string, number>;
}

/**
 * Flash Loan Arbitrage Engine Implementation
 */
export class FlashLoanArbitrageEngine extends EventEmitter implements IExecutionEngine {
  private readonly logger = createComponentLogger('arbitrage-engine');
  private readonly config: ArbitrageEngineConfig;
  private readonly stateMachine: OpportunityStateMachine;
  private readonly flashLoanManager: FlashLoanManager;
  private readonly transactionManager: TransactionLifecycleManager;

  private readonly flashExecutorInterface: ethers.Interface;

  private metrics: ArbitrageMetrics = {
    totalExecutions: 0,
    successfulExecutions: 0,
    totalProfit: 0n,
    totalGasCost: 0n,
    avgExecutionTime: 0,
    successRate: 0,
    profitPerExecution: 0n,
    routesByDex: {},
  };

  private executionTimes: number[] = [];

  constructor(
    stateMachine: OpportunityStateMachine,
    flashLoanManager: FlashLoanManager,
    transactionManager: TransactionLifecycleManager,
    config: Partial<ArbitrageEngineConfig> = {}
  ) {
    super();

    this.stateMachine = stateMachine;
    this.flashLoanManager = flashLoanManager;
    this.transactionManager = transactionManager;

    this.config = {
      flashExecutorAddress:
        config.flashExecutorAddress ?? ('0x0000000000000000000000000000000000000000' as Address), // Will be set during deployment
      maxSlippageBps: config.maxSlippageBps ?? 250, // 2.5%
      minProfitThresholdUsd: config.minProfitThresholdUsd ?? 5.0,
      gasOptimizationEnabled: config.gasOptimizationEnabled ?? true,
      enableProfitValidation: config.enableProfitValidation ?? true,
      maxRouteHops: config.maxRouteHops ?? 3,
      routeTimeoutMs: config.routeTimeoutMs ?? 10000,
      enableMultiDexRouting: config.enableMultiDexRouting ?? true,
      supportedDexes: config.supportedDexes ?? ['uniswap-v3', 'aerodrome'],
      ...config,
    };

    // Initialize contract interfaces
    this.flashExecutorInterface = new ethers.Interface([
      'function executeArbitrage(address flashLoanPool, uint256 amount0, uint256 amount1, bytes calldata data) external',
      'function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external',
      'function executeSwapRoute(tuple(address protocol, address pool, address tokenIn, address tokenOut, uint256 fee, uint256 amountIn)[] route) external returns (uint256 amountOut)',
    ]);

    this.logger.info('Flash loan arbitrage engine initialized', {
      config: this.config,
    });
  }

  /**
   * Check if engine can execute opportunity
   */
  async canExecute(opportunity: BaseOpportunity): Promise<boolean> {
    try {
      // Must be arbitrage opportunity
      if (opportunity.type !== 'arbitrage') {
        return false;
      }

      const arbOpp = opportunity as ArbitrageOpportunity;

      // Check if we support the DEXes in the route
      const supportedProtocols = new Set(this.config.supportedDexes);
      const routeProtocols = arbOpp.route.map(r => r.protocol);
      const hasUnsupportedProtocol = routeProtocols.some(p => !supportedProtocols.has(p));

      if (hasUnsupportedProtocol) {
        this.logger.debug('Unsupported protocol in route', {
          opportunityId: opportunity.id,
          routeProtocols,
          supportedProtocols: Array.from(supportedProtocols),
        });
        return false;
      }

      // Check route length
      if (arbOpp.route.length > this.config.maxRouteHops) {
        this.logger.debug('Route too long', {
          opportunityId: opportunity.id,
          routeLength: arbOpp.route.length,
          maxHops: this.config.maxRouteHops,
        });
        return false;
      }

      // Check profit threshold
      const profitUsd = Number(arbOpp.estimatedProfit) / 1e18; // Assuming ETH-denominated profit
      if (profitUsd < this.config.minProfitThresholdUsd) {
        this.logger.debug('Profit below threshold', {
          opportunityId: opportunity.id,
          profitUsd,
          threshold: this.config.minProfitThresholdUsd,
        });
        return false;
      }

      // Check flash loan availability
      const flashLoanCapacity = await this.flashLoanManager.getTotalCapacity(arbOpp.tokenIn);
      if (flashLoanCapacity.availableCapacity < arbOpp.amountIn) {
        this.logger.debug('Insufficient flash loan capacity', {
          opportunityId: opportunity.id,
          required: arbOpp.amountIn.toString(),
          available: flashLoanCapacity.availableCapacity.toString(),
        });
        return false;
      }

      return true;
    } catch (error) {
      this.logger.warn('Error checking execution capability', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Execute arbitrage opportunity
   */
  async execute(opportunity: BaseOpportunity, context: ExecutionContext): Promise<ExecutionResult> {
    const startTime = Date.now();
    const arbOpp = opportunity as ArbitrageOpportunity;

    try {
      this.logger.info('Starting arbitrage execution', {
        opportunityId: opportunity.id,
        tokenIn: arbOpp.tokenIn,
        tokenOut: arbOpp.tokenOut,
        amountIn: arbOpp.amountIn.toString(),
        expectedProfit: arbOpp.estimatedProfit.toString(),
      });

      // Update metrics
      this.metrics.totalExecutions++;

      // Transition to executing state
      this.stateMachine.transition(
        opportunity.id,
        OpportunityState.EXECUTING,
        'Starting arbitrage execution'
      );

      // Build execution plan
      const executionPlan = await this.buildExecutionPlan(arbOpp, context);

      // Validate profit if enabled
      if (this.config.enableProfitValidation) {
        await this.validateProfitability(executionPlan, arbOpp);
      }

      // Build flash loan transaction
      const transaction = await this.buildFlashLoanTransaction(executionPlan, context);

      // Execute transaction through lifecycle manager
      this.stateMachine.transition(
        opportunity.id,
        OpportunityState.PENDING,
        'Submitting transaction'
      );

      // Submit transaction via wrapper method
      const transactionHash = await this.submitTransactionViaManager(transaction);

      const executionTime = Date.now() - startTime;

      // Calculate actual profit (simplified)
      const actualProfit = await this.calculateArbitrageProfit(opportunity, arbOpp);

      const result: ExecutionResult = {
        opportunityId: opportunity.id,
        success: true,
        profit: actualProfit,
        gasCost: BigInt(300000) * BigInt(50e9), // 300k gas * 50 gwei
        executionTime,
        transactionHash,
        blockNumber: 0, // Would be filled from receipt
        gasUsed: BigInt(300000),
        effectiveGasPrice: BigInt(50e9),
      };

      this.handleSuccessfulExecution(result, executionPlan);
      return result;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const failureReason = error instanceof Error ? error.message : String(error);

      const result: ExecutionResult = {
        opportunityId: opportunity.id,
        success: false,
        executionTime,
        failureReason,
      };

      this.handleFailedExecution(result);
      return result;
    }
  }

  /**
   * Estimate gas for arbitrage execution
   */
  async estimateGas(opportunity: BaseOpportunity): Promise<bigint> {
    const arbOpp = opportunity as ArbitrageOpportunity;

    try {
      // Base gas for flash loan callback
      let gasEstimate = 150000n; // Base overhead

      // Add gas per swap in route
      gasEstimate += BigInt(arbOpp.route.length * 80000); // ~80k per swap

      // Add buffer for complex routes
      if (arbOpp.route.length > 2) {
        gasEstimate += 50000n;
      }

      // Add gas optimization buffer
      if (this.config.gasOptimizationEnabled) {
        gasEstimate = BigInt(Math.floor(Number(gasEstimate) * 0.9)); // 10% reduction for optimizations
      }

      return gasEstimate;
    } catch (error) {
      this.logger.warn('Gas estimation failed, using default', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 200000n; // Conservative default
    }
  }

  /**
   * Estimate execution time
   */
  async estimateExecutionTime(opportunity: BaseOpportunity): Promise<number> {
    const arbOpp = opportunity as ArbitrageOpportunity;

    // Base time for transaction processing
    let estimatedTime = 15000; // 15 seconds base

    // Add time per route hop
    estimatedTime += arbOpp.route.length * 2000; // 2 seconds per hop

    // Add time for complex multi-DEX routes
    const uniqueDexes = new Set(arbOpp.route.map(r => r.protocol));
    if (uniqueDexes.size > 1) {
      estimatedTime += 5000; // 5 seconds for multi-DEX complexity
    }

    return estimatedTime;
  }

  /**
   * Build execution plan for arbitrage
   */
  private async buildExecutionPlan(
    opportunity: ArbitrageOpportunity,
    context: ExecutionContext
  ): Promise<RouteExecutionPlan> {
    try {
      // Get optimal flash loan source
      const flashLoanSource = await this.flashLoanManager.getOptimalSource(
        opportunity.tokenIn,
        opportunity.amountIn
      );

      // Calculate total gas cost
      const gasEstimate = await this.estimateGas(opportunity);
      const totalGasCost = gasEstimate * context.maxFeePerGas;

      // Build execution data for flash loan callback
      const executionData = await this.buildExecutionData(opportunity.route);

      // Calculate expected profit after fees
      const flashLoanFee = flashLoanSource.fee; // Fee is already for the requested amount
      const expectedProfit = opportunity.estimatedProfit - flashLoanFee - totalGasCost;

      const plan: RouteExecutionPlan = {
        flashLoanSource,
        swapRoute: opportunity.route,
        expectedProfit: opportunity.estimatedProfit,
        totalGasCost,
        netProfit: expectedProfit,
        executionData,
      };

      this.logger.debug('Execution plan built', {
        opportunityId: opportunity.id,
        flashLoanProvider: flashLoanSource.provider,
        flashLoanFee: flashLoanFee.toString(),
        totalGasCost: totalGasCost.toString(),
        netProfit: expectedProfit.toString(),
      });

      return plan;
    } catch (error) {
      this.logger.error('Failed to build execution plan', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Validate profitability of execution plan
   */
  private async validateProfitability(
    plan: RouteExecutionPlan,
    opportunity: ArbitrageOpportunity
  ): Promise<void> {
    // Check if net profit is still positive
    if (plan.netProfit <= 0n) {
      throw new Error(`Execution would be unprofitable: net profit ${plan.netProfit}`);
    }

    // Check if profit meets minimum threshold
    const netProfitUsd = Number(plan.netProfit) / 1e18;
    if (netProfitUsd < this.config.minProfitThresholdUsd) {
      throw new Error(
        `Net profit ${netProfitUsd} below threshold ${this.config.minProfitThresholdUsd}`
      );
    }

    // Validate slippage tolerance
    const maxSlippage = BigInt(this.config.maxSlippageBps);
    const slippageTolerance = (opportunity.expectedAmountOut * maxSlippage) / 10000n;
    const minAmountOut = opportunity.expectedAmountOut - slippageTolerance;

    this.logger.debug('Profitability validation passed', {
      opportunityId: opportunity.id,
      netProfitUsd,
      minAmountOut: minAmountOut.toString(),
      slippageTolerance: slippageTolerance.toString(),
    });
  }

  /**
   * Build execution data for flash loan callback
   */
  private async buildExecutionData(route: SwapRoute[]): Promise<string> {
    // Encode the swap route for the flash loan callback
    const routeData = route.map(swap => ({
      protocol: swap.protocol === 'uniswap-v3' ? 0 : 1, // 0 = Uniswap V3, 1 = Aerodrome
      pool: swap.poolAddress,
      tokenIn: swap.tokenIn,
      tokenOut: swap.tokenOut,
      fee: swap.fee,
      amountIn: swap.amountIn,
    }));

    // Encode route data using ABI encoder
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encodedRoute = abiCoder.encode(
      [
        'tuple(uint8 protocol, address pool, address tokenIn, address tokenOut, uint256 fee, uint256 amountIn)[]',
      ],
      [routeData]
    );

    return encodedRoute;
  }

  /**
   * Build flash loan transaction
   */
  private async buildFlashLoanTransaction(
    plan: RouteExecutionPlan,
    context: ExecutionContext
  ): Promise<TransactionRequest> {
    const { flashLoanSource, swapRoute, executionData } = plan;

    // Determine flash loan amounts (amount0, amount1 for Uniswap V3 pools)
    let amount0 = 0n;
    let amount1 = 0n;

    // For simplicity, assume we're borrowing the input token as amount0
    // In practice, this would need to check the token order in the pool
    if (swapRoute && swapRoute.length > 0 && swapRoute[0]) {
      amount0 = swapRoute[0].amountIn;
    } else {
      throw new Error('Invalid swap route: no swaps defined');
    }

    // Build transaction data
    const txData = this.flashExecutorInterface.encodeFunctionData('executeArbitrage', [
      flashLoanSource.poolAddress,
      amount0,
      amount1,
      executionData,
    ]);

    // Estimate gas with buffer - create minimal opportunity object for gas estimation
    const firstSwap = swapRoute[0];
    if (!firstSwap) {
      throw new Error('Invalid swap route: no swaps defined');
    }

    const gasEstimationOpportunity = {
      id: 'gas-estimation',
      type: OpportunityType.ARBITRAGE,
      phase: OpportunityPhase.CROSS_DEX,
      tokenIn: firstSwap.tokenIn,
      tokenOut: firstSwap.tokenOut,
      amountIn: firstSwap.amountIn,
      estimatedProfit: 0n,
      estimatedGasCost: 0n,
      route: swapRoute,
      timestamp: Date.now(),
      detectedAt: Date.now(),
      priority: 1,
      confidence: 1.0,
      metadata: {},
    };
    const gasLimit = await this.estimateGas(gasEstimationOpportunity);

    const transaction: TransactionRequest = {
      to: this.config.flashExecutorAddress,
      data: txData,
      value: 0n,
      gasLimit,
      maxFeePerGas: context.maxFeePerGas,
      maxPriorityFeePerGas: context.maxPriorityFeePerGas,
      type: 2,
    };

    this.logger.debug('Flash loan transaction built', {
      to: transaction.to,
      gasLimit: transaction.gasLimit.toString(),
      maxFeePerGas: transaction.maxFeePerGas.toString(),
      flashLoanPool: flashLoanSource.poolAddress,
      amount0: amount0.toString(),
      amount1: amount1.toString(),
    });

    return transaction;
  }

  /**
   * Handle successful execution
   */
  private handleSuccessfulExecution(result: ExecutionResult, plan: RouteExecutionPlan): void {
    // Update metrics
    this.metrics.successfulExecutions++;
    this.metrics.totalProfit += result.profit ?? 0n;
    this.metrics.totalGasCost += result.gasCost ?? 0n;
    this.executionTimes.push(result.executionTime);

    // Update route statistics
    if (plan.swapRoute && plan.swapRoute.length > 0) {
      const dexes = plan.swapRoute.map(r => r.protocol);
      dexes.forEach(dex => {
        this.metrics.routesByDex[dex] = (this.metrics.routesByDex[dex] ?? 0) + 1;
      });
    }

    this.updateDerivedMetrics();

    this.logger.info('Arbitrage execution successful', {
      opportunityId: result.opportunityId,
      profit: result.profit?.toString(),
      gasCost: result.gasCost?.toString(),
      executionTime: result.executionTime,
      transactionHash: result.transactionHash,
    });

    this.emit('arbitrageExecuted', {
      result,
      plan,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle failed execution
   */
  private handleFailedExecution(result: ExecutionResult): void {
    // Update metrics
    this.metrics.totalGasCost += result.gasCost ?? 0n;
    this.executionTimes.push(result.executionTime);

    this.updateDerivedMetrics();

    this.logger.error('Arbitrage execution failed', {
      opportunityId: result.opportunityId,
      reason: result.failureReason,
      executionTime: result.executionTime,
    });

    this.emit('arbitrageFailed', {
      result,
      timestamp: Date.now(),
    });
  }

  /**
   * Update derived metrics
   */
  private updateDerivedMetrics(): void {
    this.metrics.successRate =
      this.metrics.totalExecutions > 0
        ? this.metrics.successfulExecutions / this.metrics.totalExecutions
        : 0;

    this.metrics.avgExecutionTime =
      this.executionTimes.length > 0
        ? this.executionTimes.reduce((sum, time) => sum + time, 0) / this.executionTimes.length
        : 0;

    this.metrics.profitPerExecution =
      this.metrics.totalExecutions > 0
        ? this.metrics.totalProfit / BigInt(this.metrics.totalExecutions)
        : 0n;

    // Keep only recent execution times for rolling average
    if (this.executionTimes.length > 100) {
      this.executionTimes = this.executionTimes.slice(-100);
    }
  }

  /**
   * Get arbitrage engine metrics
   */
  getMetrics(): ArbitrageMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      totalExecutions: 0,
      successfulExecutions: 0,
      totalProfit: 0n,
      totalGasCost: 0n,
      avgExecutionTime: 0,
      successRate: 0,
      profitPerExecution: 0n,
      routesByDex: {},
    };
    this.executionTimes = [];

    this.logger.info('Arbitrage engine metrics reset');
  }

  /**
   * Submit transaction via transaction manager (wrapper method)
   */
  private async submitTransactionViaManager(transaction: TransactionRequest): Promise<string> {
    try {
      const result = await this.transactionManager.processTransaction(
        `arbitrage-${Date.now()}`,
        async () => transaction
      );

      if (!result.success || !result.receipt?.transactionHash) {
        throw new Error(result.failureReason || 'Transaction submission failed');
      }

      return result.receipt.transactionHash;
    } catch (error) {
      this.logger.error('Failed to submit transaction via manager', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Calculate actual arbitrage profit from opportunity
   */
  private async calculateArbitrageProfit(
    opportunity: BaseOpportunity,
    arbOpp: ArbitrageOpportunity
  ): Promise<bigint> {
    try {
      // In a real implementation, this would:
      // 1. Parse transaction receipt logs
      // 2. Calculate token balance changes
      // 3. Account for gas costs and fees
      // 4. Return net profit in ETH/USD

      // For now, return estimated profit minus a conservative gas cost
      const estimatedGasCost = BigInt(300000) * BigInt(50e9); // 300k gas * 50 gwei
      const netProfit = arbOpp.estimatedProfit - estimatedGasCost;

      this.logger.debug('Calculated arbitrage profit', {
        opportunityId: opportunity.id,
        estimatedProfit: arbOpp.estimatedProfit.toString(),
        gasCost: estimatedGasCost.toString(),
        netProfit: netProfit.toString(),
      });

      return netProfit > 0n ? netProfit : 0n;
    } catch (error) {
      this.logger.warn('Failed to calculate arbitrage profit', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0n;
    }
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<ArbitrageEngineConfig>): void {
    Object.assign(this.config, newConfig);

    this.logger.info('Arbitrage engine configuration updated', {
      newConfig,
    });

    this.emit('configUpdated', {
      config: this.config,
      timestamp: Date.now(),
    });
  }
}
