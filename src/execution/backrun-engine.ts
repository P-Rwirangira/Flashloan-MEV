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
import { RelayProvider } from '../types/private-relay';
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
    transactionManager: TransactionLifecycleManager,
    privateRelayManager?: import('../types/private-relay').IPrivateRelayManager
  ) {
    super();
    this.config = config;
    this.flashLoanManager = flashLoanManager;
    this.transactionManager = transactionManager;
    (this as any).privateRelayManager = privateRelayManager;

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

      // Check for private mempool submission patterns with explicit signal
      const zeroTip =
        tx.maxPriorityFeePerGas != null &&
        ((): boolean => {
          try {
            return BigInt(tx.maxPriorityFeePerGas as any) === 0n;
          } catch {
            return false;
          }
        })();
      const explicitPrivate =
        (tx as any).isPrivate === true ||
        (tx as any).mempoolSource === 'private' ||
        !!(tx as any).bundleSignature;
      if (zeroTip && explicitPrivate) {
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

      // Convert USD threshold to ETH amount first, then to wei using centralized config
      try {
        const { validateProfitThreshold } = await import('../config/profit-thresholds');
        const { ChainlinkPriceOracleImpl } = await import('../oracles/chainlink-oracle');
        const cm = { getProvider: () => this.transactionManager.getProvider() } as any;
        const oracle = new ChainlinkPriceOracleImpl(cm);
        const ethPriceUsd = await oracle.getEthUsdPrice();
        const currentProfitUsd = (Number(currentProfit) / 1e18) * ethPriceUsd;
        const profitMarginBps =
          Number(opportunity.backrunAmount || 0n) > 0
            ? (currentProfitUsd /
                ((Number(opportunity.backrunAmount || 0n) / 1e18) * ethPriceUsd)) *
              10000
            : 0;

        const validation = validateProfitThreshold('backrun', currentProfitUsd, profitMarginBps);
        if (!validation.valid) {
          this.logger.warn('Backrun not profitable enough', {
            opportunityId: opportunity.id,
            currentProfitUsd,
            profitMarginBps,
            reason: validation.reason,
          });
          return false;
        }
      } catch (e) {
        // Fallback to original threshold logic
        try {
          const { ChainlinkPriceOracleImpl } = await import('../oracles/chainlink-oracle');
          const cm = { getProvider: () => this.transactionManager.getProvider() } as any;
          const oracle = new ChainlinkPriceOracleImpl(cm);
          const ethPriceUsd = await oracle.getEthUsdPrice();
          const minProfitEth = this.config.minProfitThresholdUsd / Math.max(ethPriceUsd, 1e-9);
          const minProfitThreshold = ethers.parseEther(minProfitEth.toString());
          if (currentProfit < minProfitThreshold) {
            this.logger.warn('Backrun not profitable enough (fallback)', {
              opportunityId: opportunity.id,
              currentProfit: currentProfit.toString(),
              minProfitThreshold: minProfitThreshold.toString(),
            });
            return false;
          }
        } catch (fallbackError) {
          // No fallback: require oracle availability for accurate thresholding
          return false;
        }
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

      // If PrivateRelayManager is available, submit as a bundle (single-tx bundle for now)
      let transactionHash: string;
      const prm = (this as any).privateRelayManager as
        | import('../types/private-relay').IPrivateRelayManager
        | undefined;
      if (prm) {
        // Try to include the target transaction in the bundle if raw is available
        let rawTarget: string | null = null;
        try {
          const raw = await (this.transactionManager.getProvider() as any).send(
            'eth_getRawTransactionByHash',
            [opportunity.targetTransaction]
          );
          if (typeof raw === 'string' && raw.startsWith('0x')) rawTarget = raw;
        } catch (_) {}

        const currentBlock = await this.transactionManager.getProvider().getBlockNumber();
        const blockOffset = Number(process.env['BACKRUN_BUNDLE_BLOCK_OFFSET'] || '1');
        const targetBlock = currentBlock + Math.max(1, isNaN(blockOffset) ? 1 : blockOffset);
        const minTsEnv = process.env['BACKRUN_BUNDLE_MIN_TS'];
        const maxTsEnv = process.env['BACKRUN_BUNDLE_MAX_TS'];
        const minTs = minTsEnv ? Number(minTsEnv) : undefined;
        const maxTs = maxTsEnv ? Number(maxTsEnv) : undefined;
        let res: import('../types/private-relay').BundleSubmissionResult;
        if (rawTarget) {
          // Prefer provider-specific raw bundle if supported
          const bundleReq: any = { rawTransactions: [rawTarget], targetBlockNumber: targetBlock };
          if (minTs !== undefined) bundleReq.minTimestamp = minTs;
          if (maxTs !== undefined) bundleReq.maxTimestamp = maxTs;
          res = await prm.submitProviderRawBundle(RelayProvider.FLASHBOTS_PROTECT, bundleReq);
          if (!res.success) {
            // Fallback to generic raw submission flow
            {
              const opts: any = {
                urgency: 'critical',
                simulateFirst: true,
                bundleTransactions: [backrunTx],
              };
              const mbEnv = process.env['BACKRUN_MAX_BRIBE_WEI'];
              if (mbEnv !== undefined) opts.maxBribe = BigInt(mbEnv);
              res = await prm.submitBundleRaw(
                {
                  rawTransactions: [rawTarget],
                  transactions: [backrunTx],
                  targetBlockNumber: targetBlock,
                },
                opts
              );
            }
          } else {
            // After sending bundle, submit our backrun tx raw as well to ensure inclusion (some relays expect only bundle)
            {
              const opts2: any = {
                urgency: 'critical',
                simulateFirst: true,
                bundleTransactions: [backrunTx],
              };
              const mbEnv2 = process.env['BACKRUN_MAX_BRIBE_WEI'];
              if (mbEnv2 !== undefined) opts2.maxBribe = BigInt(mbEnv2);
              const appended = await prm.submitBundleRaw(
                { rawTransactions: [], transactions: [backrunTx], targetBlockNumber: targetBlock },
                opts2
              );
              // Do not override res success, but try to derive tx hash from append
              if (
                appended.success &&
                appended.transactionHashes &&
                appended.transactionHashes.length > 0
              ) {
                res.transactionHashes = appended.transactionHashes;
              }
            }
            // Do not override res success, but try to derive tx hash from append
          }
        } else {
          {
            const opts3: any = {
              urgency: 'critical',
              simulateFirst: true,
              bundleTransactions: [backrunTx],
            };
            const mbEnv3 = process.env['BACKRUN_MAX_BRIBE_WEI'];
            if (mbEnv3 !== undefined) opts3.maxBribe = BigInt(mbEnv3);
            res = await prm.submitBundle(
              { transactions: [backrunTx], targetBlockNumber: targetBlock },
              opts3
            );
          }
        }
        if (rawTarget) {
          this.logger.info(
            'Raw target transaction available for bundle (manager extension required)',
            {
              hasRawTarget: true,
            }
          );
        }
        if (!res.success || !res.transactionHashes || res.transactionHashes.length === 0) {
          throw new Error(res.failureReason || 'Private relay bundle submission failed');
        }
        transactionHash = res.transactionHashes[0] as string;
      } else {
        // Submit transaction through lifecycle manager
        transactionHash = await this.submitTransactionViaManager(backrunTx);
      }

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
    try {
      // Try to get actual gas usage from receipt
      const receipt = await this.transactionManager
        .getProvider()
        .getTransactionReceipt(transactionHash);
      let gasCost: bigint;
      if (receipt && receipt.gasUsed) {
        const effectiveGasPrice =
          (receipt as any).effectiveGasPrice ||
          receipt.gasPrice ||
          (await this.transactionManager.getProvider().getFeeData()).maxFeePerGas ||
          20_000_000_000n;
        gasCost = BigInt(receipt.gasUsed.toString()) * BigInt(effectiveGasPrice.toString());
      } else {
        // Fallback to current network fee data with route estimate
        const feeData = await this.transactionManager.getProvider().getFeeData();
        const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 20_000_000_000n;
        gasCost = route.gasEstimate * gasPrice;
      }

      // Try to compute tokenOut delta from Swap events (Uniswap V3 / Aerodrome); fallback to Transfer logs
      let netProfit = route.estimatedProfit > gasCost ? route.estimatedProfit - gasCost : 0n;
      let tokenOutForMetrics: string | undefined;
      try {
        const tokenOut = (opportunity as any).tokenOut as Address | undefined;
        tokenOutForMetrics = tokenOut;
        if (tokenOut) {
          const provider = this.transactionManager.getProvider();
          const receipt = await provider.getTransactionReceipt(transactionHash);
          if (receipt && receipt.logs) {
            const ourAddrs: string[] = [];
            const execAddr = process.env['EXECUTION_WALLET_ADDRESS'];
            const flashExec = process.env['FLASH_EXECUTOR_ADDRESS'];
            if (execAddr) ourAddrs.push(execAddr.toLowerCase());
            if (flashExec) ourAddrs.push(flashExec.toLowerCase());
            // Uniswap V3
            const uniIface = new ethers.Interface([
              'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
              'function token0() view returns (address)',
              'function token1() view returns (address)',
            ]);
            // Aerodrome
            const aeroIface = new ethers.Interface([
              'event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)',
              'function token0() view returns (address)',
              'function token1() view returns (address)',
            ]);
            const tokenOutAddr = (tokenOut as string).toLowerCase();
            const tokenDeltas = new Map<string, bigint>();
            const addDelta = (token: string, amt: bigint) => {
              const key = token.toLowerCase();
              const prev = tokenDeltas.get(key) || 0n;
              tokenDeltas.set(key, prev + amt);
            };

            for (const log of receipt.logs) {
              try {
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
                  if (amount0 < 0n) addDelta(t0l, -amount0);
                  if (amount1 < 0n) addDelta(t1l, -amount1);
                  continue;
                }
              } catch {}
              try {
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

            // If no swap-based delta, fallback to Transfer logs
            if ((tokenDeltas.get(tokenOutAddr) || 0n) === 0n) {
              const erc20TransferSig =
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
              for (const log of receipt.logs) {
                if (
                  log.address?.toLowerCase() === tokenOutAddr &&
                  log.topics?.[0] === erc20TransferSig
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

            // Convert ETH delta + token delta to net tokenOut units
            const { ChainlinkPriceOracleImpl } = await import('../oracles/chainlink-oracle');
            const cm = { getProvider: () => provider } as any;
            const oracle = new ChainlinkPriceOracleImpl(cm);
            const ethUsd = await oracle.getEthUsdPrice();
            const tokenOutUsd = await oracle.getTokenUsdPrice(tokenOut);
            const erc20 = new ethers.Contract(
              tokenOut as string,
              ['function decimals() view returns (uint8)'],
              provider
            );
            const decimals = Number((await (erc20 as any)?.['decimals']?.()) ?? 18);

            let totalPre = 0n;
            let totalPost = 0n;
            const ourAddrsEth: string[] = [];
            const execAddrEth = process.env['EXECUTION_WALLET_ADDRESS'];
            const flashExecEth = process.env['FLASH_EXECUTOR_ADDRESS'];
            if (execAddrEth) ourAddrsEth.push(execAddrEth.toLowerCase());
            if (flashExecEth) ourAddrsEth.push(flashExecEth.toLowerCase());
            for (const a of ourAddrsEth) {
              const pre = await provider.getBalance(a, receipt.blockNumber - 1);
              const post = await provider.getBalance(a, receipt.blockNumber);
              totalPre += BigInt(pre.toString());
              totalPost += BigInt(post.toString());
            }
            const ethDelta = totalPost - totalPre; // includes gas effects
            const ethDeltaUsd = (Number(ethDelta) / 1e18) * ethUsd;
            const ethDeltaTokenOutUnits = BigInt(
              Math.floor((ethDeltaUsd / Math.max(tokenOutUsd, 1e-9)) * Math.pow(10, decimals))
            );

            // Combine token delta + ETH delta
            netProfit = (tokenDeltas.get(tokenOutAddr) || 0n) + ethDeltaTokenOutUnits;
          }
        }
      } catch (_) {}

      // Emit PnL metrics if metrics emitter is available
      try {
        (this as any).metrics?.emit?.('strategyPnLComputed', {
          type: 'BACKRUN',
          netProfit: netProfit.toString(),
          tokenOut: tokenOutForMetrics || 'unknown',
          txHash: transactionHash,
          ts: Date.now(),
        });
      } catch {}

      this.logger.debug('Calculating backrun profit', {
        opportunity: opportunity.id,
        transactionHash,
        estimatedProfit: route.estimatedProfit.toString(),
        gasCost: gasCost.toString(),
        netProfit: netProfit.toString(),
      });

      return netProfit;
    } catch (error) {
      // Conservative fallback
      const feeData = await this.transactionManager.getProvider().getFeeData();
      const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 20_000_000_000n;
      const gasCost = route.gasEstimate * gasPrice;
      return route.estimatedProfit > gasCost ? route.estimatedProfit - gasCost : 0n;
    }
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
    // Addresses configurable via env RELAYER_REFUND_ADDRESSES (comma-separated)
    let knownRelayerAddresses: string[] = [];
    try {
      const fromEnv = process.env['RELAYER_REFUND_ADDRESSES'];
      if (fromEnv) {
        knownRelayerAddresses = fromEnv
          .split(',')
          .map(a => a.trim().toLowerCase())
          .filter(a => /^0x[a-f0-9]{40}$/.test(a));
      }
    } catch (_) {}

    // Fallback to built-in known relayer/builder addresses if none provided (can be extended via config)
    if (knownRelayerAddresses.length === 0) {
      knownRelayerAddresses = [
        // Flashbots Protect relayer (example; replace with up-to-date addresses in config)
        '0xc89ce4735882c9f0f0fe26686c53074e09b0d550',
      ];
    }

    return transactions.some(tx => {
      try {
        const to = (tx.to || '').toLowerCase();
        if (!to || !knownRelayerAddresses.includes(to)) return false;
        if (!tx.value) return false;
        const val = BigInt(tx.value);
        return val > 0n;
      } catch (_) {
        return false;
      }
    });
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
      if (
        tx.maxPriorityFeePerGas != null &&
        BigInt(tx.maxPriorityFeePerGas as any) === 0n &&
        tx.maxFeePerGas
      ) {
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
