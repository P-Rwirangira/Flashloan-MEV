/**
 * Flash Loan Arbitrage Engine
 *
 * Core arbitrage execution engine using flash loans for capital-free trading
 * Requirements: 1.1, 1.6, 1.7
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { computeProfit, makeCosts, formatProfitResult } from '../utils/pnl-model';
import { BribeOptimizer } from '../bundler/bribe-optimizer';
import { DEFAULT_BUNDLER_CONFIG } from '../bundler/transaction-bundler';
import { Address } from '../types/common';
import { OpportunityStateMachine } from './opportunity-state-machine';
import { FlashLoanManager } from './flash-loan-manager';
import { TransactionLifecycleManager } from './transaction-lifecycle-manager';
import { RealTransactionValidator } from '../validation/real-transaction-validator';
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
  private readonly transactionValidator: RealTransactionValidator | undefined;

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
    config: Partial<ArbitrageEngineConfig> = {},
    transactionValidator?: RealTransactionValidator
  ) {
    super();

    this.stateMachine = stateMachine;
    this.flashLoanManager = flashLoanManager;
    this.transactionManager = transactionManager;
    this.transactionValidator = transactionValidator;

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

      // Validate opportunity using real transaction validator before execution
      if (this.transactionValidator) {
        const validationResult = await this.transactionValidator.validate(arbOpp as any);
        if (!validationResult.success) {
          throw new Error(`Opportunity validation failed: ${validationResult.error}`);
        }

        this.logger.debug('Opportunity validation passed', {
          opportunityId: opportunity.id,
          actualProfit: validationResult.actualProfit.toString(),
          gasUsed: validationResult.gasUsed.toString(),
        });
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
      // Build ProfitResult for reconciliation and logging

      // Get transaction receipt from transaction manager
      const receipt = await this.getTransactionReceipt(transactionHash);

      // Calculate actual costs from receipt
      const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
      const profitRes = computeProfit(
        { grossProfitWei: actualProfit },
        makeCosts({ gasCostWei: gasCost /* bribe/fees unknown here; bundler should fill later */ }),
        { clampNegative: true }
      );
      const netProfit = profitRes.netProfitWei;
      this.logger.debug('Arbitrage PnL (realized)', {
        breakdown: profitRes.breakdown,
        pretty: formatProfitResult(profitRes),
      });

      const result: ExecutionResult = {
        opportunityId: opportunity.id,
        success: receipt.status === 1,
        profit: netProfit,
        gasCost,
        executionTime,
        transactionHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
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
   * Estimate gas for arbitrage execution using real transaction data
   */
  async estimateGas(opportunity: BaseOpportunity): Promise<bigint> {
    const arbOpp = opportunity as ArbitrageOpportunity;

    try {
      // Use transaction validator for accurate gas estimation if available
      if (this.transactionValidator) {
        const validationResult = await this.transactionValidator.validate(arbOpp as any);
        if (validationResult.success) {
          return validationResult.gasUsed;
        }
      }

      // Fallback to route-based estimation
      let gasEstimate = 200000n; // Base flash loan overhead

      // Add gas per swap based on protocol
      for (const swap of arbOpp.route) {
        if (swap.protocol === 'uniswap-v3') {
          gasEstimate += 150000n; // Uniswap V3 swap
        } else if (swap.protocol === 'aerodrome') {
          gasEstimate += 120000n; // Aerodrome swap (more efficient)
        } else {
          gasEstimate += 100000n; // Generic DEX swap
        }
      }

      // Add complexity overhead for multi-hop routes
      if (arbOpp.route.length > 2) {
        gasEstimate += BigInt(arbOpp.route.length - 2) * 50000n;
      }

      // Add safety buffer (15% for real execution)
      gasEstimate = (gasEstimate * 115n) / 100n;

      return gasEstimate;
    } catch (error) {
      this.logger.warn('Gas estimation failed, using conservative default', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 400000n; // Conservative default for arbitrage
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

      // Estimate bribe using BribeOptimizer
      const feeData = await this.getProvider().getFeeData();
      const baseGasPrice = feeData.gasPrice || context.maxFeePerGas;
      const bribeOptimizer = new BribeOptimizer();
      bribeOptimizer.updateCongestionLevel(baseGasPrice);
      const bribeParams = {
        baseGasPrice,
        networkCongestion: bribeOptimizer.getCurrentCongestion(),
        timeUrgency: 0.8,
        priority: 'high' as const,
        targetInclusionProbability: 0.7,
        maxBribe: DEFAULT_BUNDLER_CONFIG.maxBribe,
        minBribe: DEFAULT_BUNDLER_CONFIG.minBribe,
      };
      const bribeResult = bribeOptimizer.calculateOptimalBribe(bribeParams);
      const bribeWei = bribeResult.optimalBribe;

      // Build execution data for flash loan callback
      const executionData = await this.buildExecutionData(opportunity.route);

      // Calculate expected profit using unified ProfitModel
      const flashLoanFee = flashLoanSource.fee; // Fee is already for the requested amount
      const grossProfitWei = opportunity.estimatedProfit;
      const costs = makeCosts({
        gasCostWei: totalGasCost,
        bribeWei: bribeWei,
        flashLoanFeeWei: flashLoanFee,
        dexFeesWei: 0n, // included implicitly in route quotes if available; else 0
        slippageWei: 0n,
      });
      const profitEval = computeProfit({ grossProfitWei }, costs, { clampNegative: true });

      const plan: RouteExecutionPlan = {
        flashLoanSource,
        swapRoute: opportunity.route,
        expectedProfit: grossProfitWei,
        totalGasCost,
        netProfit: profitEval.netProfitWei,
        executionData,
      };

      // Enforce strict min-profit guardrail in USD if profit validation enabled
      if (this.config.enableProfitValidation) {
        try {
          const { validateProfitThreshold } = await import('../config/profit-thresholds');
          const { OracleAdapter } = await import('../oracles/oracle-adapter');
          const cm = { getProvider: () => this.getProvider() } as any;
          const oa = new OracleAdapter(cm);
          const ethUsd = await oa.getEthUsd();
          const netProfitUsd = (Number(profitEval.netProfitWei) / 1e18) * ethUsd;
          const profitMarginBps =
            Number(opportunity.amountIn) > 0
              ? (netProfitUsd / ((Number(opportunity.amountIn) / 1e18) * ethUsd)) * 10000
              : 0;

          const validation = validateProfitThreshold('arbitrage', netProfitUsd, profitMarginBps);
          if (!validation.valid) {
            throw new Error(`Profit validation failed: ${validation.reason}`);
          }
        } catch (e) {
          // On oracle failure, still require positive netProfit in wei
          if (profitEval.netProfitWei <= 0n) {
            throw new Error('Net profit non-positive');
          }
        }
      }

      this.logger.debug('Execution plan built', {
        opportunityId: opportunity.id,
        flashLoanProvider: flashLoanSource.provider,
        flashLoanFee: flashLoanFee.toString(),
        totalGasCost: totalGasCost.toString(),
        netProfit: profitEval.netProfitWei.toString(),
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

    // Ensure dynamic fee data if context is missing it
    let maxFeePerGas = context.maxFeePerGas;
    let maxPriorityFeePerGas = context.maxPriorityFeePerGas;
    if (!maxFeePerGas || !maxPriorityFeePerGas) {
      const fd = await this.getProvider().getFeeData();
      maxFeePerGas = fd.maxFeePerGas || fd.gasPrice || 50_000_000_000n;
      maxPriorityFeePerGas = fd.maxPriorityFeePerGas || 2_000_000_000n;
    }

    const transaction: TransactionRequest = {
      to: this.config.flashExecutorAddress,
      data: txData,
      value: 0n,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
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
      // Compute net profit using real-time gas pricing and estimated gas cost
      const feeData = await this.getProvider().getFeeData();
      const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 20_000_000_000n;
      const gasEstimate =
        opportunity.estimatedGasCost && opportunity.estimatedGasCost > 0n
          ? opportunity.estimatedGasCost
          : 300000n; // fallback
      const estimatedGasCost = gasEstimate * gasPrice;
      // Try to compute tokenOut delta from Swap events (Uniswap V3 / Aerodrome); fallback to Transfer logs
      let receiptDeltaTokenOut: bigint | null = null;
      try {
        if (arbOpp.tokenOut) {
          const provider = this.getProvider();
          const receipt = await provider.getTransactionReceipt(
            (opportunity as any).lastTxHash || ''
          );
          if (receipt && receipt.logs) {
            const ourAddrs: string[] = [];
            const execAddr = process.env['EXECUTION_WALLET_ADDRESS'];
            const flashExec = process.env['FLASH_EXECUTOR_ADDRESS'];
            if (execAddr) ourAddrs.push(execAddr.toLowerCase());
            if (flashExec) ourAddrs.push(flashExec.toLowerCase());
            // Uniswap V3 Swap event
            const uniIface = new ethers.Interface([
              'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
              'function token0() view returns (address)',
              'function token1() view returns (address)',
            ]);
            // Aerodrome (Velodrome) Swap event
            const aeroIface = new ethers.Interface([
              'event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)',
              'function token0() view returns (address)',
              'function token1() view returns (address)',
            ]);

            const tokenOutAddr = (arbOpp.tokenOut as string).toLowerCase();
            const tokenDeltas = new Map<string, bigint>();
            const addDelta = (token: string, amt: bigint) => {
              const key = token.toLowerCase();
              const prev = tokenDeltas.get(key) || 0n;
              tokenDeltas.set(key, prev + amt);
            };

            for (const log of receipt.logs) {
              try {
                // Try Uniswap V3 swap decode
                const parsed = uniIface.parseLog({
                  topics: log.topics as string[],
                  data: log.data,
                });
                if (parsed && parsed.name === 'Swap') {
                  const recipient = (parsed.args['recipient'] as string).toLowerCase();
                  if (!ourAddrs.includes(recipient)) {
                    continue;
                  }
                  const pool = new ethers.Contract(
                    log.address,
                    [
                      'function token0() view returns (address)',
                      'function token1() view returns (address)',
                    ],
                    provider
                  );
                  const token0Fn = pool['token0'];
                  const token1Fn = pool['token1'];
                  if (!token0Fn || !token1Fn) continue;
                  const [t0, t1] = await Promise.all([token0Fn(), token1Fn()]);
                  const t0l = (t0 as string).toLowerCase();
                  const t1l = (t1 as string).toLowerCase();
                  const amount0: bigint = BigInt(parsed.args['amount0'].toString());
                  const amount1: bigint = BigInt(parsed.args['amount1'].toString());
                  // In Uniswap V3 event, negative amount means tokens were sent from pool to recipient
                  if (amount0 < 0n) addDelta(t0l, -amount0);
                  if (amount1 < 0n) addDelta(t1l, -amount1);
                  continue;
                }
              } catch {}
              try {
                // Try Aerodrome swap decode
                const parsed2 = aeroIface.parseLog({
                  topics: log.topics as string[],
                  data: log.data,
                });
                if (parsed2 && parsed2.name === 'Swap') {
                  const to = (parsed2.args['to'] as string).toLowerCase();
                  if (!ourAddrs.includes(to)) {
                    continue;
                  }
                  const pool = new ethers.Contract(
                    log.address,
                    [
                      'function token0() view returns (address)',
                      'function token1() view returns (address)',
                    ],
                    provider
                  );
                  const token0Fn = pool['token0'];
                  const token1Fn = pool['token1'];
                  if (!token0Fn || !token1Fn) continue;
                  const [t0, t1] = await Promise.all([token0Fn(), token1Fn()]);
                  const t0l = (t0 as string).toLowerCase();
                  const t1l = (t1 as string).toLowerCase();
                  const amount0Out: bigint = BigInt(parsed2.args['amount0Out'].toString());
                  const amount1Out: bigint = BigInt(parsed2.args['amount1Out'].toString());
                  if (amount0Out > 0n) addDelta(t0l, amount0Out);
                  if (amount1Out > 0n) addDelta(t1l, amount1Out);
                  continue;
                }
              } catch {}
            }
            // Fallback to Transfer logs if no delta found
            if ((tokenDeltas.get(tokenOutAddr) || 0n) === 0n) {
              const transferTopic =
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
              for (const log of receipt.logs) {
                if (
                  log.address?.toLowerCase() === tokenOutAddr &&
                  log.topics?.[0] === transferTopic
                ) {
                  if (!log.topics || log.topics.length < 3) {
                    continue;
                  }
                  const from = '0x' + (log.topics[1] as string).slice(26).toLowerCase();
                  const to = '0x' + (log.topics[2] as string).slice(26).toLowerCase();
                  const value = BigInt(log.data);
                  if (ourAddrs.includes(to) && !ourAddrs.includes(from))
                    addDelta(tokenOutAddr, value);
                  if (ourAddrs.includes(from) && !ourAddrs.includes(to))
                    addDelta(tokenOutAddr, -value as unknown as bigint);
                }
              }
            }
            receiptDeltaTokenOut = tokenDeltas.get(tokenOutAddr) || 0n;
          }
        }
      } catch (_) {}

      let netProfit =
        arbOpp.estimatedProfit > estimatedGasCost ? arbOpp.estimatedProfit - estimatedGasCost : 0n;
      if (receiptDeltaTokenOut !== null) {
        try {
          const { OracleAdapter } = await import('../oracles/oracle-adapter');
          const cm = { getProvider: () => this.getProvider() } as any;
          const oa = new OracleAdapter(cm);
          const ethUsd = await oa.getEthUsd();
          const tokenOutUsd = await oa.getTokenUsd(arbOpp.tokenOut as Address);
          const erc20 = new ethers.Contract(
            arbOpp.tokenOut as string,
            ['function decimals() view returns (uint8)'],
            this.getProvider()
          );
          const decimals = Number((await (erc20 as any)?.['decimals']?.()) ?? 18);

          // Compute native ETH delta across our addresses at the receipt block
          let ethDeltaTokenOutUnits = 0n;
          try {
            const receipt = await this.getProvider().getTransactionReceipt(
              (opportunity as any).lastTxHash || ''
            );
            if (receipt) {
              const ourAddrsEth: string[] = [];
              const execAddrEth = process.env['EXECUTION_WALLET_ADDRESS'];
              const flashExecEth = process.env['FLASH_EXECUTOR_ADDRESS'];
              if (execAddrEth) ourAddrsEth.push(execAddrEth.toLowerCase());
              if (flashExecEth) ourAddrsEth.push(flashExecEth.toLowerCase());
              let totalPre = 0n;
              let totalPost = 0n;
              for (const a of ourAddrsEth) {
                const pre = await this.getProvider().getBalance(a, receipt.blockNumber - 1);
                const post = await this.getProvider().getBalance(a, receipt.blockNumber);
                totalPre += BigInt(pre.toString());
                totalPost += BigInt(post.toString());
              }
              const ethDelta = totalPost - totalPre; // includes gas effects
              // Convert ETH delta to tokenOut units
              const ethDeltaUsd = (Number(ethDelta) / 1e18) * ethUsd;
              const toUnits = BigInt(
                Math.floor((ethDeltaUsd / Math.max(tokenOutUsd, 1e-9)) * Math.pow(10, decimals))
              );
              ethDeltaTokenOutUnits = toUnits;
            }
          } catch (_) {}

          // When using receipt deltas, avoid double-counting gas: use token delta + ETH delta
          netProfit = receiptDeltaTokenOut + ethDeltaTokenOutUnits;
        } catch (_) {
          // keep previous netProfit
        }
      }

      // Emit PnL metrics if metrics emitter is available
      try {
        (this as any).metrics?.emit?.('strategyPnLComputed', {
          type: 'ARBITRAGE',
          netProfit: netProfit.toString(),
          tokenOut: arbOpp.tokenOut,
          txHash: (opportunity as any).lastTxHash || undefined,
          ts: Date.now(),
        });
      } catch {}

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

  /**
   * Get transaction receipt from transaction hash
   */
  private async getTransactionReceipt(transactionHash: string): Promise<{
    status: number;
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    blockNumber: number;
  }> {
    try {
      // Get receipt from provider
      const receipt = await this.getProvider().getTransactionReceipt(transactionHash);

      if (!receipt) {
        throw new Error('Transaction receipt not found');
      }

      return {
        status: receipt.status || 0,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: (receipt as any).effectiveGasPrice || (receipt as any).gasPrice || 0n,
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      this.logger.error('Failed to get transaction receipt', {
        transactionHash,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return default values for failed receipt retrieval
      return {
        status: 0,
        gasUsed: 300000n,
        effectiveGasPrice: 50000000000n, // 50 gwei
        blockNumber: 0,
      };
    }
  }

  /**
   * Get ethers provider for blockchain interactions
   */
  private getProvider(): ethers.Provider {
    // Access provider through transaction manager or create new one
    return (
      this.transactionManager.getProvider() ||
      new ethers.JsonRpcProvider(process.env['BASE_RPC_URL'])
    );
  }
}
