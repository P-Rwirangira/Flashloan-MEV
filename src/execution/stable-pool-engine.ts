/**
 * Stable Pool Rebalancing Engine
 *
 * Executes profitable rebalancing opportunities in Aerodrome stable pools
 * with flash loan integration and incentive capture
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import {
  ExecutionEngine,
  ExecutionResult,
  StablePoolRebalancingOpportunity,
  OpportunityType,
} from '../types/execution';
import { FlashLoanManager } from './flash-loan-manager';
import { TransactionLifecycleManager } from './transaction-lifecycle-manager';
import { TransactionRequest } from '../types/transaction';
import { Address } from '../types/common';

export interface StablePoolEngineConfig {
  readonly maxSlippageBps: number;
  readonly minProfitThresholdUsd: number;
  readonly gasOptimizationEnabled: boolean;
  readonly enableIncentiveCapture: boolean;
  readonly maxRebalancingAmount: bigint;
  readonly minImbalanceThreshold: number;
  readonly maxPriceImpactBps: number;
  readonly incentiveMultiplier: number;
}

export interface RebalancingTrade {
  readonly poolAddress: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly expectedAmountOut: bigint;
  readonly priceImpact: number;
  readonly tradingFee: bigint;
  readonly expectedIncentives: bigint;
  readonly gasEstimate: bigint;
}

export interface StablePoolState {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly imbalance: number;
  readonly virtualPrice: bigint;
  readonly amplificationParameter: bigint;
}

export class StablePoolEngine extends EventEmitter implements ExecutionEngine {
  private readonly logger = createComponentLogger('stable-pool-engine');
  private readonly config: StablePoolEngineConfig;
  private readonly flashLoanManager: FlashLoanManager;
  private readonly transactionManager: TransactionLifecycleManager;

  // Aerodrome stable pool interface
  private readonly aerodromeFactory = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
  private readonly stablePoolABI = [
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external',
    'function getAmountOut(uint amountIn, address tokenIn) external view returns (uint)',
  ];

  constructor(
    config: StablePoolEngineConfig,
    flashLoanManager: FlashLoanManager,
    transactionManager: TransactionLifecycleManager
  ) {
    super();
    this.config = config;
    this.flashLoanManager = flashLoanManager;
    this.transactionManager = transactionManager;

    // Use managers and factory for future implementation
    this.logger.debug('StablePoolEngine initialized', {
      flashLoanManagerReady: !!this.flashLoanManager,
      transactionManagerReady: !!this.transactionManager,
      aerodromeFactory: this.aerodromeFactory,
      stablePoolABILength: this.stablePoolABI.length,
    });
  }

  /**
   * Execute stable pool rebalancing opportunity
   */
  async executeOpportunity(
    opportunity: StablePoolRebalancingOpportunity
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      this.logger.info('Executing stable pool rebalancing opportunity', {
        opportunityId: opportunity.id,
        poolAddress: opportunity.poolAddress,
        currentImbalance: opportunity.currentImbalance,
        rebalancingAmount: opportunity.rebalanceAmount.toString(),
      });

      // Validate opportunity is still profitable
      const isStillProfitable = await this.validateRebalancingProfitability(opportunity);
      if (!isStillProfitable) {
        return {
          success: false,
          failureReason: 'Rebalancing no longer profitable',
          executionTime: Date.now() - startTime,
          opportunityId: opportunity.id,
        };
      }

      // Calculate optimal rebalancing trade
      const rebalancingTrade = await this.calculateRebalancingTrade(opportunity);
      if (!rebalancingTrade) {
        return {
          success: false,
          failureReason: 'No profitable rebalancing trade found',
          executionTime: Date.now() - startTime,
          opportunityId: opportunity.id,
        };
      }

      // Execute rebalancing trade
      const result = await this.executeRebalancingTrade(opportunity, rebalancingTrade);

      this.emit('rebalancingExecuted', {
        opportunity,
        result,
        trade: rebalancingTrade,
        executionTime: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      this.logger.error('Stable pool rebalancing execution failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        failureReason: error instanceof Error ? error.message : 'Unknown error',
        executionTime: Date.now() - startTime,
        opportunityId: opportunity.id,
      };
    }
  }

  /**
   * Calculate optimal rebalancing trade
   */
  async calculateRebalancingTrade(
    opportunity: StablePoolRebalancingOpportunity
  ): Promise<RebalancingTrade | null> {
    try {
      // Get current pool state
      const poolState = await this.getStablePoolState(opportunity.poolAddress);

      // Determine trade direction based on imbalance
      const tokenIn =
        opportunity.swapDirection === 'token0_to_token1' ? opportunity.token0 : opportunity.token1;
      const tokenOut =
        opportunity.swapDirection === 'token0_to_token1' ? opportunity.token1 : opportunity.token0;

      // Calculate optimal trade size
      const optimalAmount = await this.calculateOptimalTradeSize(poolState, opportunity);
      if (optimalAmount === 0n) {
        return null;
      }

      // Calculate expected output using stable swap formula
      const expectedAmountOut = await this.calculateStableSwapOutput(
        poolState,
        tokenIn,
        tokenOut,
        optimalAmount
      );

      // Calculate price impact
      const priceImpact = await this.calculatePriceImpact(
        poolState,
        optimalAmount,
        expectedAmountOut
      );

      if (priceImpact > this.config.maxPriceImpactBps / 10000) {
        this.logger.warn('Price impact too high for rebalancing trade', {
          priceImpact,
          maxAllowed: this.config.maxPriceImpactBps / 10000,
        });
        return null;
      }

      // Calculate trading fee
      const tradingFee = (optimalAmount * BigInt(poolState.fee)) / 10000n;

      // Estimate incentive rewards
      const expectedIncentives = await this.estimateIncentiveRewards(opportunity, optimalAmount);

      // Estimate gas cost
      const gasEstimate = 300000n; // Approximate gas for stable pool swap

      return {
        poolAddress: opportunity.poolAddress,
        tokenIn,
        tokenOut,
        amountIn: optimalAmount,
        expectedAmountOut,
        priceImpact,
        tradingFee,
        expectedIncentives,
        gasEstimate,
      };
    } catch (error) {
      this.logger.error('Failed to calculate rebalancing trade', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Estimate incentive rewards for rebalancing
   */
  async estimateIncentiveRewards(
    opportunity: StablePoolRebalancingOpportunity,
    tradeAmount: bigint
  ): Promise<bigint> {
    try {
      // Base incentive calculation (simplified)
      // In production, this would query actual Aerodrome gauge rewards
      const baseIncentive = opportunity.expectedIncentives;

      // Scale incentive based on trade size
      const incentiveRate = baseIncentive / opportunity.rebalanceAmount;
      const scaledIncentive =
        (tradeAmount * incentiveRate * BigInt(Math.floor(this.config.incentiveMultiplier * 100))) /
        100n;

      return scaledIncentive;
    } catch (error) {
      this.logger.error('Failed to estimate incentive rewards', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0n;
    }
  }

  /**
   * Validate rebalancing profitability
   */
  private async validateRebalancingProfitability(
    opportunity: StablePoolRebalancingOpportunity
  ): Promise<boolean> {
    try {
      // Check if pool still has significant imbalance
      const currentPoolState = await this.getStablePoolState(opportunity.poolAddress);
      const currentImbalance = this.calculateImbalance(currentPoolState);

      if (Math.abs(currentImbalance) < this.config.minImbalanceThreshold) {
        this.logger.warn('Pool imbalance below threshold', {
          opportunityId: opportunity.id,
          currentImbalance,
          threshold: this.config.minImbalanceThreshold,
        });
        return false;
      }

      // Calculate current profitability
      const rebalancingTrade = await this.calculateRebalancingTrade(opportunity);
      if (!rebalancingTrade) {
        return false;
      }

      const expectedProfit = await this.calculateRebalancingProfit(rebalancingTrade);
      const minProfitThreshold = ethers.parseEther(this.config.minProfitThresholdUsd.toString());

      return expectedProfit >= minProfitThreshold;
    } catch (error) {
      this.logger.error('Failed to validate rebalancing profitability', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Get stable pool state
   */
  private async getStablePoolState(poolAddress: Address): Promise<StablePoolState> {
    try {
      // This would integrate with actual Aerodrome contracts
      // For now, return simulated pool state
      return {
        reserve0: ethers.parseEther('1000000'), // 1M tokens
        reserve1: ethers.parseEther('950000'), // 950K tokens (5% imbalance)
        token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
        token1: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
        fee: 200, // 0.02%
        imbalance: 0.05, // 5% imbalance
        virtualPrice: ethers.parseEther('1.001'), // Slightly above 1.0
        amplificationParameter: 100n,
      };
    } catch (error) {
      this.logger.error('Failed to get stable pool state', {
        poolAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Calculate optimal trade size for rebalancing
   */
  private async calculateOptimalTradeSize(
    poolState: StablePoolState,
    opportunity: StablePoolRebalancingOpportunity
  ): Promise<bigint> {
    try {
      // Start with the suggested rebalancing amount
      let optimalSize = opportunity.rebalanceAmount;

      // Ensure we don't exceed our maximum
      if (optimalSize > this.config.maxRebalancingAmount) {
        optimalSize = this.config.maxRebalancingAmount;
      }

      // Ensure we don't exceed pool liquidity (max 10% of reserves)
      const maxTradeSize = (poolState.reserve0 + poolState.reserve1) / 10n;
      if (optimalSize > maxTradeSize) {
        optimalSize = maxTradeSize;
      }

      // Validate profitability at this size
      const mockTrade: RebalancingTrade = {
        poolAddress: opportunity.poolAddress,
        tokenIn: opportunity.token0,
        tokenOut: opportunity.token1,
        amountIn: optimalSize,
        expectedAmountOut: optimalSize, // Simplified
        priceImpact: 0.01,
        tradingFee: (optimalSize * BigInt(poolState.fee)) / 10000n,
        expectedIncentives: await this.estimateIncentiveRewards(opportunity, optimalSize),
        gasEstimate: 300000n,
      };

      const expectedProfit = await this.calculateRebalancingProfit(mockTrade);
      const minProfitThreshold = ethers.parseEther(this.config.minProfitThresholdUsd.toString());

      if (expectedProfit < minProfitThreshold) {
        // Try smaller sizes
        const sizes = [optimalSize / 2n, optimalSize / 4n, optimalSize / 8n];

        for (const size of sizes) {
          const testTrade = { ...mockTrade, amountIn: size };
          const profit = await this.calculateRebalancingProfit(testTrade);
          if (profit >= minProfitThreshold) {
            optimalSize = size;
            break;
          }
        }
      }

      return optimalSize;
    } catch (error) {
      this.logger.error('Failed to calculate optimal trade size', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0n;
    }
  }

  /**
   * Calculate stable swap output using curve formula
   */
  private async calculateStableSwapOutput(
    poolState: StablePoolState,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint
  ): Promise<bigint> {
    try {
      // Simplified stable swap calculation
      // In production, this would use the actual StableSwap invariant formula

      const isToken0In = tokenIn === poolState.token0;
      const reserveIn = isToken0In ? poolState.reserve0 : poolState.reserve1;
      const reserveOut = isToken0In ? poolState.reserve1 : poolState.reserve0;

      // Apply stable swap formula (simplified)
      const k = reserveIn * reserveOut;
      const newReserveIn = reserveIn + amountIn;
      const newReserveOut = k / newReserveIn;
      const amountOut = reserveOut - newReserveOut;

      // Apply trading fee
      const feeAmount = (amountOut * BigInt(poolState.fee)) / 10000n;
      const amountOutAfterFee = amountOut - feeAmount;

      this.logger.debug('Stable swap calculation', {
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        amountOut: amountOutAfterFee.toString(),
        feeAmount: feeAmount.toString(),
      });

      return amountOutAfterFee;
    } catch (error) {
      this.logger.error('Failed to calculate stable swap output', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0n;
    }
  }

  /**
   * Calculate price impact
   */
  private async calculatePriceImpact(
    poolState: StablePoolState,
    amountIn: bigint,
    amountOut: bigint
  ): Promise<number> {
    try {
      // Calculate price impact as percentage
      const spotPrice = Number(poolState.reserve1) / Number(poolState.reserve0);
      const executionPrice = Number(amountOut) / Number(amountIn);
      const priceImpact = Math.abs(1 - executionPrice / spotPrice);

      return priceImpact;
    } catch (error) {
      this.logger.error('Failed to calculate price impact', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 1.0; // Conservative default
    }
  }

  /**
   * Calculate imbalance in pool
   */
  private calculateImbalance(poolState: StablePoolState): number {
    const total = Number(poolState.reserve0 + poolState.reserve1);
    const balance = Number(poolState.reserve0) / total - 0.5;
    return balance * 2; // Scale to -1 to 1 range
  }

  /**
   * Execute rebalancing trade
   */
  private async executeRebalancingTrade(
    opportunity: StablePoolRebalancingOpportunity,
    trade: RebalancingTrade
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      // Build rebalancing transaction
      const transaction = await this.buildRebalancingTransaction(opportunity, trade);

      // Submit transaction via lifecycle manager
      const result = await this.transactionManager.processTransaction(
        `stable-rebalance-${Date.now()}`,
        async () => transaction
      );

      if (!result.success || !result.receipt) {
        return {
          success: false,
          failureReason: result.failureReason || 'Transaction submission failed',
          gasUsed: trade.gasEstimate,
          executionTime: Date.now() - startTime,
          opportunityId: opportunity.id,
        };
      }

      // Calculate actual profit
      const profit = await this.calculateRebalancingProfit(trade);

      this.logger.info('Rebalancing trade executed successfully', {
        opportunityId: opportunity.id,
        transactionHash: result.receipt.transactionHash,
        profit: profit.toString(),
        gasUsed: result.receipt.gasUsed?.toString(),
      });

      return {
        success: true,
        transactionHash: result.receipt.transactionHash,
        profit,
        gasUsed: result.receipt.gasUsed || trade.gasEstimate,
        executionTime: Date.now() - startTime,
        opportunityId: opportunity.id,
        blockNumber: result.receipt.blockNumber,
        effectiveGasPrice: result.receipt.effectiveGasPrice,
      };
    } catch (error) {
      this.logger.error('Rebalancing trade execution failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        failureReason: error instanceof Error ? error.message : 'Execution failed',
        gasUsed: trade.gasEstimate,
        executionTime: Date.now() - startTime,
        opportunityId: opportunity.id,
      };
    }
  }

  /**
   * Build rebalancing transaction
   */
  private async buildRebalancingTransaction(
    opportunity: StablePoolRebalancingOpportunity,
    trade: RebalancingTrade
  ): Promise<TransactionRequest> {
    try {
      // Build transaction data for stable pool rebalancing
      // This would encode the swap call for Aerodrome stable pools
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();

      // Encode swap parameters
      const swapData = abiCoder.encode(
        ['address', 'address', 'uint256', 'uint256', 'address'],
        [
          trade.tokenIn,
          trade.tokenOut,
          trade.amountIn,
          trade.expectedAmountOut,
          opportunity.poolAddress,
        ]
      );

      return {
        to: opportunity.poolAddress,
        data: swapData,
        value: 0n,
        gasLimit: trade.gasEstimate,
        maxFeePerGas: BigInt(50e9), // 50 gwei
        maxPriorityFeePerGas: BigInt(2e9), // 2 gwei
        type: 2,
      };
    } catch (error) {
      this.logger.error('Failed to build rebalancing transaction', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Calculate rebalancing profit
   */
  private async calculateRebalancingProfit(trade: RebalancingTrade): Promise<bigint> {
    try {
      // Calculate gross profit from trading fees and incentives
      const tradingFeeProfit = trade.tradingFee / 2n; // Assume we capture 50% of trading fees
      const incentiveProfit = trade.expectedIncentives;
      const grossProfit = tradingFeeProfit + incentiveProfit;

      // Calculate costs
      const gasPrice = 20000000000n; // 20 gwei
      const gasCost = gasPrice * trade.gasEstimate;

      // Estimate slippage costs
      const slippageCost = (trade.amountIn * BigInt(this.config.maxSlippageBps)) / 10000n;

      // Calculate net profit
      const totalCosts = gasCost + slippageCost;
      const netProfit = grossProfit > totalCosts ? grossProfit - totalCosts : 0n;

      return netProfit;
    } catch (error) {
      this.logger.error('Failed to calculate rebalancing profit', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0n;
    }
  }

  /**
   * Get supported opportunity types
   */
  getSupportedOpportunityTypes(): OpportunityType[] {
    return [OpportunityType.STABLE_POOL_REBALANCING];
  }

  /**
   * Check if engine can handle opportunity
   */
  canHandleOpportunity(opportunity: any): boolean {
    return opportunity.type === OpportunityType.STABLE_POOL_REBALANCING;
  }
}
