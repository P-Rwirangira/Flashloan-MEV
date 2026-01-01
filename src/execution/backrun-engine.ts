/**
 * Mempool Backrun Engine
 *
 * Executes ethical MEV extraction through safe backrunning of mempool transactions
 * with MEV protection detection and compliance validation
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import {
  ExecutionEngine,
  ExecutionResult,
  MempoolBackrunOpportunity,
  OpportunityType,
} from '../types/execution';
import { TransactionRequest } from '../types/transaction';
import { FlashLoanManager } from './flash-loan-manager';
import { TransactionLifecycleManager } from './transaction-lifecycle-manager';
import { Address } from '../types/common';

export interface BackrunEngineConfig {
  readonly maxSlippageBps: number;
  readonly minProfitThresholdUsd: number;
  readonly gasOptimizationEnabled: boolean;
  readonly enableEthicalValidation: boolean;
  readonly maxBackrunAmount: bigint;
  readonly safetyScoreThreshold: number;
  readonly maxTimingRiskMs: number;
  readonly enableMEVProtectionDetection: boolean;
}

export interface BackrunRoute {
  readonly targetTransaction: string;
  readonly backrunTransaction: BackrunTransaction;
  readonly estimatedProfit: bigint;
  readonly timingRisk: number;
  readonly safetyScore: number;
  readonly gasEstimate: bigint;
  readonly inclusionProbability: number;
}

export interface BackrunTransaction {
  readonly type: 'arbitrage' | 'liquidation' | 'rebalancing';
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly expectedAmountOut: bigint;
  readonly dexProtocol: string;
  readonly poolAddress: Address;
  readonly gasEstimate: bigint;
}

export interface MEVProtectionSignal {
  readonly hasProtection: boolean;
  readonly protectionService: string | null;
  readonly userConsent: boolean;
  readonly slippageTolerance: number;
  readonly protectionLevel: 'none' | 'basic' | 'advanced';
}

export class BackrunEngine extends EventEmitter implements ExecutionEngine {
  private readonly logger = createComponentLogger('backrun-engine');
  private readonly config: BackrunEngineConfig;
  private readonly flashLoanManager: FlashLoanManager;
  private readonly transactionManager: TransactionLifecycleManager;

  // MEV protection detection patterns
  private readonly mevProtectionPatterns = new Map<string, RegExp>();

  constructor(
    config: BackrunEngineConfig,
    flashLoanManager: FlashLoanManager,
    transactionManager: TransactionLifecycleManager
  ) {
    super();
    this.config = config;
    this.flashLoanManager = flashLoanManager;
    this.transactionManager = transactionManager;

    this.initializeMEVProtectionPatterns();

    // Use managers for future implementation
    this.logger.debug('BackrunEngine initialized', {
      flashLoanManagerReady: !!this.flashLoanManager,
      transactionManagerReady: !!this.transactionManager,
    });
  }

  /**
   * Execute mempool backrun opportunity
   */
  async executeOpportunity(opportunity: MempoolBackrunOpportunity): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      this.logger.info('Executing mempool backrun opportunity', {
        opportunityId: opportunity.id,
        targetTx: opportunity.targetTransaction,
        backrunType: opportunity.backrunType,
        estimatedProfit: opportunity.estimatedProfit.toString(),
      });

      // Validate MEV protection and ethical compliance
      const protectionCheck = await this.validateMEVProtection(opportunity);
      if (!protectionCheck.canBackrun) {
        return {
          success: false,
          failureReason: `MEV protection detected: ${protectionCheck.reason}`,
          executionTime: Date.now() - startTime,
          opportunityId: opportunity.id,
        };
      }

      // Validate opportunity is still profitable and safe
      const isStillValid = await this.validateBackrunSafety(opportunity);
      if (!isStillValid) {
        return {
          success: false,
          failureReason: 'Backrun opportunity no longer safe or profitable',
          executionTime: Date.now() - startTime,
          opportunityId: opportunity.id,
        };
      }

      // Calculate optimal backrun parameters
      const backrunRoute = await this.calculateBackrunRoute(opportunity);
      if (!backrunRoute) {
        return {
          success: false,
          failureReason: 'No safe backrun route found',
          executionTime: Date.now() - startTime,
          opportunityId: opportunity.id,
        };
      }

      // Execute backrun transaction
      const result = await this.executeBackrunRoute(opportunity, backrunRoute);

      this.emit('backrunExecuted', {
        opportunity,
        result,
        route: backrunRoute,
        executionTime: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      this.logger.error('Backrun execution failed', {
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
   * Validate MEV protection and ethical compliance
   */
  async validateMEVProtection(opportunity: MempoolBackrunOpportunity): Promise<{
    canBackrun: boolean;
    reason?: string;
    protectionSignal?: MEVProtectionSignal;
  }> {
    try {
      if (!this.config.enableMEVProtectionDetection) {
        return { canBackrun: true };
      }

      // Detect MEV protection signals
      const protectionSignal = await this.detectMEVProtection(opportunity.targetTransaction);

      // If user has MEV protection enabled, respect it
      if (protectionSignal.hasProtection && !protectionSignal.userConsent) {
        this.logger.info('MEV protection detected, respecting user preference', {
          opportunityId: opportunity.id,
          protectionService: protectionSignal.protectionService,
          protectionLevel: protectionSignal.protectionLevel,
        });

        return {
          canBackrun: false,
          reason: `User has MEV protection via ${protectionSignal.protectionService}`,
          protectionSignal,
        };
      }

      // Check if backrun provides better execution for user
      const providesValue = await this.validateUserBenefit(opportunity, protectionSignal);
      if (!providesValue) {
        return {
          canBackrun: false,
          reason: 'Backrun does not provide value to original transaction',
          protectionSignal,
        };
      }

      // Validate ethical guidelines
      const ethicalValidation = await this.validateEthicalGuidelines(opportunity);
      if (!ethicalValidation.isEthical) {
        return {
          canBackrun: false,
          reason: ethicalValidation.reason || 'Ethical validation failed',
          protectionSignal,
        };
      }

      return { canBackrun: true, protectionSignal };
    } catch (error) {
      this.logger.error('Failed to validate MEV protection', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // Err on the side of caution
      return {
        canBackrun: false,
        reason: 'MEV protection validation failed',
      };
    }
  }

  /**
   * Detect MEV protection signals in target transaction
   */
  private async detectMEVProtection(targetTxHash: string): Promise<MEVProtectionSignal> {
    try {
      // Get provider for transaction analysis
      const provider = this.transactionManager.getProvider();

      // Get transaction details
      const tx = await provider.getTransaction(targetTxHash);
      if (!tx) {
        throw new Error('Transaction not found');
      }

      // Analyze transaction for MEV protection patterns
      let hasProtection = false;
      let protectionService: string | null = null;
      let protectionLevel: 'none' | 'basic' | 'advanced' = 'none';

      // Check for Flashbots Protect patterns
      if (tx.to && this.isFlashbotsProtectAddress(null, [tx])) {
        hasProtection = true;
        protectionService = 'Flashbots Protect';
        protectionLevel = 'advanced';
      }

      // Check for CoW Swap patterns
      if (tx.data && this.isCowSwapTransaction(tx.data)) {
        hasProtection = true;
        protectionService = 'CoW Swap';
        protectionLevel = 'advanced';
      }

      // Check for private mempool submission patterns
      if (tx.maxPriorityFeePerGas && tx.maxPriorityFeePerGas === 0n) {
        hasProtection = true;
        protectionService = protectionService || 'Private Mempool';
        protectionLevel = 'basic';
      }

      // Analyze transaction data for protection hints
      const hasProtectionHints = this.analyzeTransactionForProtectionHints(tx.data || '0x');

      return {
        hasProtection: hasProtection || hasProtectionHints,
        protectionService,
        userConsent: false, // Default to no consent for safety
        slippageTolerance: this.estimateSlippageTolerance(tx),
        protectionLevel: hasProtectionHints && !hasProtection ? 'basic' : protectionLevel,
      };
    } catch (error) {
      this.logger.error('Failed to detect MEV protection', {
        targetTxHash,
        error: error instanceof Error ? error.message : String(error),
      });

      // Default to protected for safety
      return {
        hasProtection: true,
        protectionService: 'unknown',
        userConsent: false,
        slippageTolerance: 0.005,
        protectionLevel: 'advanced',
      };
    }
  }

  /**
   * Validate that backrun provides value to original user
   */
  private async validateUserBenefit(
    opportunity: MempoolBackrunOpportunity,
    protectionSignal: MEVProtectionSignal
  ): Promise<boolean> {
    try {
      // Check if our backrun improves price for the original transaction
      // This is a simplified check - in production would be more sophisticated

      const slippageImprovement = opportunity.slippageImprovement || 0;
      const minBenefitThreshold = 0.001; // 0.1% minimum improvement

      if (slippageImprovement < minBenefitThreshold) {
        this.logger.debug('Backrun does not provide sufficient user benefit', {
          opportunityId: opportunity.id,
          slippageImprovement,
          minThreshold: minBenefitThreshold,
          protectionLevel: protectionSignal.protectionLevel,
        });
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error('Failed to validate user benefit', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Validate ethical guidelines for backrunning
   */
  private async validateEthicalGuidelines(opportunity: MempoolBackrunOpportunity): Promise<{
    isEthical: boolean;
    reason?: string;
  }> {
    try {
      if (!this.config.enableEthicalValidation) {
        return { isEthical: true };
      }

      // Check for sandwich attack patterns
      if (opportunity.backrunType === 'sandwich') {
        return {
          isEthical: false,
          reason: 'Sandwich attacks are not permitted',
        };
      }

      // Check for front-running patterns
      if (opportunity.backrunType === 'frontrun') {
        return {
          isEthical: false,
          reason: 'Front-running is not permitted',
        };
      }

      // Validate profit extraction is reasonable
      const maxProfitRatio = 0.1; // Max 10% of transaction value
      const transactionValue = opportunity.targetTransactionValue || 0n;
      const profitRatio =
        transactionValue > 0n ? Number(opportunity.estimatedProfit) / Number(transactionValue) : 0;

      if (profitRatio > maxProfitRatio) {
        return {
          isEthical: false,
          reason: `Profit extraction too high: ${(profitRatio * 100).toFixed(2)}%`,
        };
      }

      // Check timing constraints to avoid harmful MEV
      const timingRisk = opportunity.timingRisk || 0;
      if (timingRisk > this.config.maxTimingRiskMs) {
        return {
          isEthical: false,
          reason: `Timing risk too high: ${timingRisk}ms`,
        };
      }

      return { isEthical: true };
    } catch (error) {
      this.logger.error('Failed to validate ethical guidelines', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // Err on the side of caution
      return {
        isEthical: false,
        reason: 'Ethical validation failed',
      };
    }
  }

  /**
   * Validate backrun safety and profitability
   */
  private async validateBackrunSafety(opportunity: MempoolBackrunOpportunity): Promise<boolean> {
    try {
      // Calculate safety score
      const safetyScore = await this.calculateSafetyScore(opportunity);

      if (safetyScore < this.config.safetyScoreThreshold) {
        this.logger.warn('Backrun safety score below threshold', {
          opportunityId: opportunity.id,
          safetyScore,
          threshold: this.config.safetyScoreThreshold,
        });
        return false;
      }

      // Check if still profitable - convert USD threshold to ETH properly
      const currentProfit = await this.calculateCurrentProfit(opportunity);

      // Convert USD threshold to ETH amount first, then to wei
      // Note: In production, fetch ETH/USD price from oracle
      const ethPriceUsd = 2500; // Placeholder - should be fetched from price oracle
      const minProfitEth = this.config.minProfitThresholdUsd / ethPriceUsd;
      const minProfitThreshold = ethers.parseEther(minProfitEth.toString());

      if (currentProfit < minProfitThreshold) {
        this.logger.debug('Backrun no longer profitable', {
          opportunityId: opportunity.id,
          currentProfit: currentProfit.toString(),
          minThreshold: minProfitThreshold.toString(),
          minProfitUsd: this.config.minProfitThresholdUsd,
          ethPriceUsd,
        });
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error('Failed to validate backrun safety', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Calculate safety score for backrun opportunity
   */
  private async calculateSafetyScore(opportunity: MempoolBackrunOpportunity): Promise<number> {
    try {
      let score = 100; // Start with perfect score

      // Deduct points for timing risk
      const timingRisk = opportunity.timingRisk || 0;
      score -= Math.min((timingRisk / 1000) * 20, 30); // Max 30 points for timing

      // Deduct points for slippage risk
      const slippageRisk = opportunity.slippageRisk || 0;
      score -= Math.min(slippageRisk * 100 * 20, 25); // Max 25 points for slippage

      // Deduct points for gas price volatility
      const gasPriceVolatility = opportunity.gasPriceVolatility || 0;
      score -= Math.min(gasPriceVolatility * 100 * 15, 20); // Max 20 points for gas

      // Deduct points for liquidity risk
      const liquidityRisk = opportunity.liquidityRisk || 0;
      score -= Math.min(liquidityRisk * 100 * 15, 15); // Max 15 points for liquidity

      // Deduct points for competition risk
      const competitionRisk = opportunity.competitionRisk || 0;
      score -= Math.min(competitionRisk * 100 * 10, 10); // Max 10 points for competition

      return Math.max(score, 0); // Ensure non-negative
    } catch (error) {
      this.logger.error('Failed to calculate safety score', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0; // Conservative default
    }
  }

  /**
   * Calculate current profit for backrun opportunity
   */
  private async calculateCurrentProfit(opportunity: MempoolBackrunOpportunity): Promise<bigint> {
    try {
      // Estimate current profit based on market conditions
      const baseProfit = opportunity.estimatedProfit;

      // Adjust for current gas prices
      const currentGasPrice = 20000000000n; // 20 gwei (would be fetched from network)
      const gasEstimate = opportunity.gasEstimate || 200000n;
      const gasCost = currentGasPrice * gasEstimate;

      // Adjust for slippage
      const slippageCost = (baseProfit * BigInt(this.config.maxSlippageBps)) / 10000n;

      // Calculate net profit
      const netProfit =
        baseProfit > gasCost + slippageCost ? baseProfit - gasCost - slippageCost : 0n;

      return netProfit;
    } catch (error) {
      this.logger.error('Failed to calculate current profit', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0n;
    }
  }

  /**
   * Calculate optimal backrun route
   */
  private async calculateBackrunRoute(
    opportunity: MempoolBackrunOpportunity
  ): Promise<BackrunRoute | null> {
    try {
      // Create backrun transaction based on opportunity type
      const backrunTx = await this.createBackrunTransaction(opportunity);
      if (!backrunTx) {
        return null;
      }

      // Calculate timing and safety metrics
      const timingRisk = opportunity.timingRisk || 0;
      const safetyScore = await this.calculateSafetyScore(opportunity);
      const inclusionProbability = this.calculateInclusionProbability(opportunity);

      // Estimate profit
      const estimatedProfit = await this.calculateCurrentProfit(opportunity);

      return {
        targetTransaction: opportunity.targetTransaction,
        backrunTransaction: backrunTx,
        estimatedProfit,
        timingRisk,
        safetyScore,
        gasEstimate: backrunTx.gasEstimate,
        inclusionProbability,
      };
    } catch (error) {
      this.logger.error('Failed to calculate backrun route', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Create backrun transaction
   */
  private async createBackrunTransaction(
    opportunity: MempoolBackrunOpportunity
  ): Promise<BackrunTransaction | null> {
    try {
      // Determine backrun type and parameters
      const backrunType = opportunity.backrunType;

      switch (backrunType) {
        case 'arbitrage':
          return this.createArbitrageBackrun(opportunity);
        case 'liquidation':
          return this.createLiquidationBackrun(opportunity);
        case 'rebalancing':
          return this.createRebalancingBackrun(opportunity);
        default:
          this.logger.warn('Unknown backrun type', {
            opportunityId: opportunity.id,
            backrunType,
          });
          return null;
      }
    } catch (error) {
      this.logger.error('Failed to create backrun transaction', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Create arbitrage backrun transaction
   */
  private async createArbitrageBackrun(
    opportunity: MempoolBackrunOpportunity
  ): Promise<BackrunTransaction | null> {
    try {
      // Validate required fields
      if (!opportunity.tokenIn || !ethers.isAddress(opportunity.tokenIn)) {
        throw new Error('Invalid or missing tokenIn address');
      }
      if (!opportunity.tokenOut || !ethers.isAddress(opportunity.tokenOut)) {
        throw new Error('Invalid or missing tokenOut address');
      }
      if (!opportunity.poolAddress || !ethers.isAddress(opportunity.poolAddress)) {
        throw new Error('Invalid or missing poolAddress');
      }
      if (!opportunity.backrunAmount || opportunity.backrunAmount <= 0n) {
        throw new Error('Invalid or missing backrunAmount');
      }
      if (!opportunity.expectedAmountOut || opportunity.expectedAmountOut <= 0n) {
        throw new Error('Invalid or missing expectedAmountOut');
      }

      return {
        type: 'arbitrage',
        tokenIn: opportunity.tokenIn,
        tokenOut: opportunity.tokenOut,
        amountIn: opportunity.backrunAmount,
        expectedAmountOut: opportunity.expectedAmountOut,
        dexProtocol: opportunity.dexProtocol || 'uniswap-v3',
        poolAddress: opportunity.poolAddress,
        gasEstimate: opportunity.gasEstimate || 200000n,
      };
    } catch (error) {
      this.logger.error('Failed to create arbitrage backrun', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Create liquidation backrun transaction
   */
  private async createLiquidationBackrun(
    opportunity: MempoolBackrunOpportunity
  ): Promise<BackrunTransaction | null> {
    try {
      // Validate required fields
      if (!opportunity.tokenIn || !ethers.isAddress(opportunity.tokenIn)) {
        throw new Error('Invalid or missing tokenIn address');
      }
      if (!opportunity.tokenOut || !ethers.isAddress(opportunity.tokenOut)) {
        throw new Error('Invalid or missing tokenOut address');
      }
      if (!opportunity.poolAddress || !ethers.isAddress(opportunity.poolAddress)) {
        throw new Error('Invalid or missing poolAddress');
      }
      if (!opportunity.backrunAmount || opportunity.backrunAmount <= 0n) {
        throw new Error('Invalid or missing backrunAmount');
      }
      if (!opportunity.expectedAmountOut || opportunity.expectedAmountOut <= 0n) {
        throw new Error('Invalid or missing expectedAmountOut');
      }

      return {
        type: 'liquidation',
        tokenIn: opportunity.tokenIn,
        tokenOut: opportunity.tokenOut,
        amountIn: opportunity.backrunAmount,
        expectedAmountOut: opportunity.expectedAmountOut,
        dexProtocol: opportunity.dexProtocol || 'moonwell',
        poolAddress: opportunity.poolAddress,
        gasEstimate: opportunity.gasEstimate || 350000n,
      };
    } catch (error) {
      this.logger.error('Failed to create liquidation backrun', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Create rebalancing backrun transaction
   */
  private async createRebalancingBackrun(
    opportunity: MempoolBackrunOpportunity
  ): Promise<BackrunTransaction | null> {
    try {
      // Validate required fields
      if (!opportunity.tokenIn || !ethers.isAddress(opportunity.tokenIn)) {
        throw new Error('Invalid or missing tokenIn address');
      }
      if (!opportunity.tokenOut || !ethers.isAddress(opportunity.tokenOut)) {
        throw new Error('Invalid or missing tokenOut address');
      }
      if (!opportunity.poolAddress || !ethers.isAddress(opportunity.poolAddress)) {
        throw new Error('Invalid or missing poolAddress');
      }
      if (!opportunity.backrunAmount || opportunity.backrunAmount <= 0n) {
        throw new Error('Invalid or missing backrunAmount');
      }
      if (!opportunity.expectedAmountOut || opportunity.expectedAmountOut <= 0n) {
        throw new Error('Invalid or missing expectedAmountOut');
      }

      return {
        type: 'rebalancing',
        tokenIn: opportunity.tokenIn,
        tokenOut: opportunity.tokenOut,
        amountIn: opportunity.backrunAmount,
        expectedAmountOut: opportunity.expectedAmountOut,
        dexProtocol: opportunity.dexProtocol || 'aerodrome',
        poolAddress: opportunity.poolAddress,
        gasEstimate: opportunity.gasEstimate || 250000n,
      };
    } catch (error) {
      this.logger.error('Failed to create rebalancing backrun', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Calculate inclusion probability
   */
  private calculateInclusionProbability(opportunity: MempoolBackrunOpportunity): number {
    try {
      let probability = 0.8; // Base 80% probability

      // Adjust based on gas price competitiveness
      const gasPrice = opportunity.gasPrice || 20000000000n;
      const networkGasPrice = 25000000000n; // Simulated network average

      if (gasPrice >= networkGasPrice) {
        probability += 0.15; // Boost for competitive gas
      } else {
        probability -= 0.2; // Penalty for low gas
      }

      // Adjust based on timing
      const timingRisk = opportunity.timingRisk || 0;
      if (timingRisk < 1000) {
        // Less than 1 second
        probability += 0.05;
      } else if (timingRisk > 5000) {
        // More than 5 seconds
        probability -= 0.15;
      }

      return Math.max(0, Math.min(1, probability));
    } catch (error) {
      this.logger.error('Failed to calculate inclusion probability', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0.5; // Conservative default
    }
  }

  /**
   * Execute backrun route (REAL IMPLEMENTATION)
   */
  private async executeBackrunRoute(
    opportunity: MempoolBackrunOpportunity,
    route: BackrunRoute
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      this.logger.info('Executing backrun route', {
        opportunityId: opportunity.id,
        targetTx: route.targetTransaction,
        backrunType: route.backrunTransaction.type,
        estimatedProfit: route.estimatedProfit.toString(),
      });

      // Build backrun transaction
      const backrunTx = await this.buildBackrunTransaction(opportunity, route);

      // Submit transaction through lifecycle manager
      const transactionHash = await this.submitTransactionViaManager(backrunTx);

      // Monitor for inclusion and calculate actual profit
      const actualProfit = await this.calculateBackrunProfit(opportunity, route, transactionHash);

      return {
        success: true,
        transactionHash,
        profit: actualProfit,
        gasCost: BigInt(route.gasEstimate),
        executionTime: Date.now() - startTime,
        opportunityId: opportunity.id,
      };
    } catch (error) {
      this.logger.error('Backrun execution failed', {
        opportunityId: opportunity.id,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        failureReason: error instanceof Error ? error.message : 'Backrun execution failed',
        executionTime: Date.now() - startTime,
        opportunityId: opportunity.id,
      };
    }
  }

  /**
   * Build backrun transaction
   */
  private async buildBackrunTransaction(
    opportunity: MempoolBackrunOpportunity,
    route: BackrunRoute
  ): Promise<TransactionRequest> {
    const backrunTx = route.backrunTransaction;

    this.logger.debug('Building backrun transaction', {
      opportunityId: opportunity.id,
      targetTx: opportunity.targetTransaction,
      backrunType: route.backrunTransaction.type,
    });

    // Validate target address from environment
    const targetAddress = process.env['FLASH_EXECUTOR_ADDRESS'];
    if (!targetAddress || targetAddress.trim() === '') {
      this.logger.error('FLASH_EXECUTOR_ADDRESS environment variable not configured');
      throw new Error('Target contract address not configured - FLASH_EXECUTOR_ADDRESS required');
    }

    // Encode transaction data based on backrun type
    let transactionData: string;

    switch (backrunTx.type) {
      case 'arbitrage':
        transactionData = await this.encodeArbitrageBackrun(backrunTx);
        break;

      case 'liquidation':
        transactionData = await this.encodeLiquidationBackrun(backrunTx);
        break;

      case 'rebalancing':
        transactionData = await this.encodeRebalancingBackrun(backrunTx);
        break;

      default:
        throw new Error(`Unsupported backrun type: ${backrunTx.type}`);
    }

    return {
      to: targetAddress as `0x${string}`,
      data: transactionData,
      value: 0n,
      gasLimit: backrunTx.gasEstimate,
      maxFeePerGas: BigInt(100e9), // Higher gas for MEV competition
      maxPriorityFeePerGas: BigInt(10e9), // Higher priority fee
    };
  }

  /**
   * Encode arbitrage backrun transaction
   */
  private async encodeArbitrageBackrun(backrunTx: BackrunTransaction): Promise<string> {
    const abiCoder = new ethers.AbiCoder();

    return abiCoder.encode(
      ['address', 'address', 'uint256', 'uint256', 'address'],
      [
        backrunTx.tokenIn,
        backrunTx.tokenOut,
        backrunTx.amountIn,
        backrunTx.expectedAmountOut,
        backrunTx.poolAddress,
      ]
    );
  }

  /**
   * Encode liquidation backrun transaction
   */
  private async encodeLiquidationBackrun(backrunTx: BackrunTransaction): Promise<string> {
    const abiCoder = new ethers.AbiCoder();

    return abiCoder.encode(
      ['address', 'address', 'uint256'],
      [
        backrunTx.tokenIn, // Collateral token
        backrunTx.tokenOut, // Debt token
        backrunTx.amountIn, // Liquidation amount
      ]
    );
  }

  /**
   * Encode rebalancing backrun transaction
   */
  private async encodeRebalancingBackrun(backrunTx: BackrunTransaction): Promise<string> {
    const abiCoder = new ethers.AbiCoder();

    return abiCoder.encode(
      ['address', 'address', 'uint256', 'uint256'],
      [backrunTx.tokenIn, backrunTx.tokenOut, backrunTx.amountIn, backrunTx.expectedAmountOut]
    );
  }

  /**
   * Calculate actual backrun profit
   */
  private async calculateBackrunProfit(
    opportunity: MempoolBackrunOpportunity,
    route: BackrunRoute,
    transactionHash: string
  ): Promise<bigint> {
    // In production, this would:
    // 1. Wait for transaction confirmation
    // 2. Get transaction receipt and logs
    // 3. Calculate token balance changes
    // 4. Account for gas costs
    // 5. Return net profit

    // For now, return estimated profit minus gas costs
    const gasCost = route.gasEstimate * BigInt(100e9); // 100 gwei gas price
    const estimatedProfit = route.estimatedProfit;

    this.logger.debug('Calculating backrun profit', {
      opportunity: opportunity.id,
      transactionHash,
      estimatedProfit: estimatedProfit.toString(),
      gasCost: gasCost.toString(),
    });

    return estimatedProfit > gasCost ? estimatedProfit - gasCost : 0n;
  }

  /**
   * Submit transaction via transaction manager (wrapper method)
   */
  private async submitTransactionViaManager(transaction: TransactionRequest): Promise<string> {
    try {
      const result = await this.transactionManager.processTransaction(
        `backrun-${Date.now()}`,
        async () => transaction
      );

      if (!result.success || !result.receipt?.transactionHash) {
        throw new Error(result.failureReason || 'Transaction submission failed');
      }

      return result.receipt.transactionHash;
    } catch (error) {
      this.logger.error('Failed to submit backrun transaction via manager', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Check if transaction shows Flashbots Protect/MEV-Share indicators
   */
  private isFlashbotsProtectAddress(_block: any, transactions: any[]): boolean {
    try {
      // Analyze on-chain signals for Flashbots Protect/MEV-Share

      // 1. Look for refund transfers/payments in the same block
      const hasRefundPatterns = this.detectRefundTransfers(transactions);
      if (hasRefundPatterns) {
        return true;
      }

      // 2. Check for bundle-like transaction ordering
      const hasBundleOrdering = this.detectBundleOrdering(transactions);
      if (hasBundleOrdering) {
        return true;
      }

      // 3. Look for MEV-Share/refund artifacts
      const hasMevShareArtifacts = this.detectMevShareArtifacts(transactions);
      if (hasMevShareArtifacts) {
        return true;
      }

      return false;
    } catch (error) {
      this.logger.warn('Failed to detect Flashbots Protect indicators', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private detectRefundTransfers(transactions: any[]): boolean {
    // Look for transfers that reimburse frontrunners or relayers
    const knownRelayerAddresses = [
      '0x0000000000000000000000000000000000000000', // Placeholder
    ];

    return transactions.some(
      tx =>
        tx.to &&
        knownRelayerAddresses.includes(tx.to.toLowerCase()) &&
        tx.value &&
        BigInt(tx.value) > 0n
    );
  }

  private detectBundleOrdering(transactions: any[]): boolean {
    // Look for contiguous transactions with matching sender/beneficiary patterns
    if (transactions.length < 2) return false;

    let consecutiveRelated = 0;
    for (let i = 1; i < transactions.length; i++) {
      const prev = transactions[i - 1];
      const curr = transactions[i];

      if (prev && curr && prev.from === curr.from) {
        consecutiveRelated++;
      }
    }

    return consecutiveRelated >= 2; // At least 3 consecutive related transactions
  }

  private detectMevShareArtifacts(transactions: any[]): boolean {
    // Look for MEV-Share style refund patterns or metadata
    return transactions.some(tx => {
      // Check for unusual gas patterns typical of MEV-Share
      if (tx.maxPriorityFeePerGas === '0x0' && tx.maxFeePerGas) {
        return true;
      }

      // Check for memo/metadata patterns in transaction data
      if (tx.data && tx.data.includes('mevshare')) {
        return true;
      }

      return false;
    });
  }

  /**
   * Check if transaction data indicates CoW Swap
   */
  private isCowSwapTransaction(data: string): boolean {
    // CoW Swap function selectors
    const cowSwapSelectors = [
      '0x13d79a0b', // settle function
      '0x2e1a7d4d', // withdraw function
    ];

    const selector = data.slice(0, 10);
    return cowSwapSelectors.includes(selector);
  }

  /**
   * Analyze transaction data for protection hints
   */
  private analyzeTransactionForProtectionHints(data: string): boolean {
    // Look for patterns that suggest MEV protection
    // High slippage tolerance, unusual routing, etc.

    if (data.length < 10) return false;

    // Check for unusual function selectors that might indicate protection
    const selector = data.slice(0, 10);
    const protectionSelectors = [
      '0x7ff36ab5', // swapExactETHForTokensSupportingFeeOnTransferTokens
      '0x38ed1739', // swapExactTokensForTokens with high slippage
    ];

    return protectionSelectors.includes(selector);
  }

  /**
   * Estimate slippage tolerance from transaction
   */
  private estimateSlippageTolerance(tx: any): number {
    // Analyze transaction parameters to estimate slippage tolerance
    // This is a simplified implementation

    if (tx.gasPrice && tx.maxFeePerGas) {
      const gasPremium = Number(tx.maxFeePerGas - tx.gasPrice) / Number(tx.gasPrice);
      // Higher gas premium might indicate higher slippage tolerance
      return Math.min(0.05, Math.max(0.001, gasPremium * 0.1)); // 0.1% to 5%
    }

    return 0.005; // 0.5% default
  }

  /**
   * Initialize MEV protection detection patterns
   */
  private initializeMEVProtectionPatterns(): void {
    // Patterns to detect MEV protection services
    this.mevProtectionPatterns.set('flashbots', /flashbots|protect/i);
    this.mevProtectionPatterns.set('cowswap', /cowswap|cow|gnosis/i);
    this.mevProtectionPatterns.set('openmev', /openmev|manifold/i);

    this.logger.info('MEV protection patterns initialized', {
      patternCount: this.mevProtectionPatterns.size,
    });
  }

  /**
   * Get supported opportunity types
   */
  getSupportedOpportunityTypes(): OpportunityType[] {
    return [OpportunityType.MEMPOOL_BACKRUN];
  }

  /**
   * Check if engine can handle opportunity
   */
  canHandleOpportunity(opportunity: any): boolean {
    return (
      opportunity.type === OpportunityType.MEMPOOL_BACKRUN && this.config.enableEthicalValidation
    ); // Only handle if ethical validation is enabled
  }
}
