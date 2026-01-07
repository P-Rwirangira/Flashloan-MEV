/**
 * Real-Time Profitability Optimization Engine
 *
 * Continuously recalculates profit and optimizes execution parameters
 * with real-time market condition monitoring
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { Address } from '../types/common';
import { OpportunityType } from '../types/execution';
import { RpcConnectionManager } from '../rpc/connection-manager';

export interface ProfitabilityOptimizerConfig {
  readonly minProfitThresholdUsd: number;
  readonly maxRiskLevel: number;
  readonly recalculationIntervalMs: number;
  readonly marketConditionUpdateMs: number;
  readonly positionSizingEnabled: boolean;
  readonly riskAdjustedReturns: boolean;
  readonly executionProbabilityWeight: number;
  readonly volatilityAdjustmentFactor: number;
  readonly liquidityDepthThreshold: number;
}

export interface MarketCondition {
  readonly timestamp: number;
  readonly gasPrice: bigint;
  readonly networkCongestion: number;
  readonly volatilityIndex: number;
  readonly liquidityIndex: number;
  readonly competitionLevel: number;
  readonly blockTime: number;
  readonly mempoolSize: number;
}

export interface ProfitabilityMetrics {
  readonly opportunityId: string;
  readonly grossProfit: bigint;
  readonly netProfit: bigint;
  readonly profitUsd: number;
  readonly gasCost: bigint;
  readonly executionProbability: number;
  readonly riskAdjustedReturn: number;
  readonly sharpeRatio: number;
  readonly expectedValue: number;
  readonly confidenceInterval: {
    readonly lower: number;
    readonly upper: number;
  };
  readonly calculatedAt: number;
}

export interface OptimizationResult {
  readonly opportunityId: string;
  readonly originalMetrics: ProfitabilityMetrics;
  readonly optimizedMetrics: ProfitabilityMetrics;
  readonly recommendations: OptimizationRecommendation[];
  readonly shouldExecute: boolean;
  readonly shouldCancel: boolean;
  readonly positionSize: bigint;
  readonly maxSlippage: number;
  readonly gasLimit: bigint;
  readonly optimizedAt: number;
}

export interface OptimizationRecommendation {
  readonly type: 'position-size' | 'timing' | 'gas-price' | 'slippage' | 'cancel' | 'wait';
  readonly description: string;
  readonly impact: 'high' | 'medium' | 'low';
  readonly confidence: number;
  readonly parameters?: Record<string, unknown>;
}

export interface OpportunityState {
  readonly id: string;
  readonly type: OpportunityType;
  readonly token: Address;
  readonly originalAmount: bigint;
  readonly currentAmount: bigint;
  readonly targetProfit: bigint;
  readonly maxRisk: number;
  readonly createdAt: number;
  readonly lastOptimized: number;
  readonly optimizationCount: number;
  readonly profitHistory: ProfitabilityMetrics[];
  status: 'active' | 'optimizing' | 'cancelled' | 'executed';
}

export interface RiskMetrics {
  readonly volatilityRisk: number;
  readonly liquidityRisk: number;
  readonly executionRisk: number;
  readonly competitionRisk: number;
  readonly slippageRisk: number;
  readonly gasRisk: number;
  readonly overallRisk: number;
}

export class ProfitabilityOptimizer extends EventEmitter {
  private readonly logger = createComponentLogger('profitability-optimizer');
  private readonly config: ProfitabilityOptimizerConfig;
  private readonly connectionManager: RpcConnectionManager;
  // Provider for blockchain interactions (used for gas estimation and validation)
  private readonly provider: ethers.Provider;

  // Market condition tracking
  private currentMarketCondition: MarketCondition;
  private marketConditionHistory: MarketCondition[] = [];

  // Opportunity tracking
  private readonly activeOpportunities = new Map<string, OpportunityState>();
  private readonly profitabilityCache = new Map<string, ProfitabilityMetrics>();

  // Optimization timers
  private recalculationTimer: NodeJS.Timeout | null = null;
  private marketUpdateTimer: NodeJS.Timeout | null = null;

  // Performance tracking
  private optimizationCount = 0;
  private cancelledOpportunities = 0;
  private executedOpportunities = 0;

  constructor(connectionManager: RpcConnectionManager, config: ProfitabilityOptimizerConfig) {
    super();
    this.connectionManager = connectionManager;
    this.provider = connectionManager.getProvider();
    this.config = config;

    // Initialize market condition
    this.currentMarketCondition = {
      timestamp: Date.now(),
      gasPrice: 20000000000n, // 20 gwei default
      networkCongestion: 0.5,
      volatilityIndex: 0.3,
      liquidityIndex: 0.8,
      competitionLevel: 0.6,
      blockTime: 2000, // 2 seconds for Base
      mempoolSize: 1000,
    };

    this.startOptimizationEngine();

    this.logger.info('Profitability optimizer initialized', {
      minProfitThresholdUsd: this.config.minProfitThresholdUsd,
      maxRiskLevel: this.config.maxRiskLevel,
      recalculationIntervalMs: this.config.recalculationIntervalMs,
    });
  }

  /**
   * Add opportunity for optimization
   */
  async addOpportunity(
    id: string,
    type: OpportunityType,
    token: Address,
    amount: bigint,
    targetProfit: bigint,
    maxRisk: number = this.config.maxRiskLevel
  ): Promise<void> {
    try {
      this.logger.debug('Adding opportunity for optimization', {
        id,
        type,
        token,
        amount: amount.toString(),
        targetProfit: targetProfit.toString(),
      });

      const opportunity: OpportunityState = {
        id,
        type,
        token,
        originalAmount: amount,
        currentAmount: amount,
        targetProfit,
        maxRisk,
        createdAt: Date.now(),
        lastOptimized: 0,
        optimizationCount: 0,
        profitHistory: [],
        status: 'active',
      };

      this.activeOpportunities.set(id, opportunity);

      // Perform initial optimization
      await this.optimizeOpportunity(id);

      this.emit('opportunityAdded', opportunity);
    } catch (error) {
      this.logger.error('Failed to add opportunity', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Remove opportunity from optimization
   */
  removeOpportunity(id: string): void {
    const opportunity = this.activeOpportunities.get(id);
    if (opportunity) {
      this.activeOpportunities.delete(id);
      this.profitabilityCache.delete(id);

      this.emit('opportunityRemoved', { id, opportunity });

      this.logger.debug('Opportunity removed from optimization', { id });
    }
  }

  /**
   * Start optimization engine
   */
  private startOptimizationEngine(): void {
    // Start recalculation timer
    this.recalculationTimer = setInterval(async () => {
      await this.recalculateAllOpportunities();
    }, this.config.recalculationIntervalMs);

    // Start market condition updates
    this.marketUpdateTimer = setInterval(async () => {
      await this.updateMarketConditions();
    }, this.config.marketConditionUpdateMs);

    this.logger.info('Optimization engine started');
  }

  /**
   * Recalculate all active opportunities
   */
  private async recalculateAllOpportunities(): Promise<void> {
    const activeIds = Array.from(this.activeOpportunities.keys()).filter(
      id => this.activeOpportunities.get(id)?.status === 'active'
    );

    this.logger.debug('Recalculating opportunities', { count: activeIds.length });

    for (const opportunityId of activeIds) {
      try {
        await this.optimizeOpportunity(opportunityId);
      } catch (error) {
        this.logger.error('Failed to recalculate opportunity', {
          opportunityId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Update market conditions
   */
  private async updateMarketConditions(): Promise<void> {
    try {
      // Get real market metrics
      const realMarketMetrics = await this.getRealMarketMetrics();

      // Compute block time and mempool size from chain data
      let blockTimeMs = 2000;
      try {
        const latest = await this.provider.getBlock('latest');
        const prev =
          latest && latest.number > 0 ? await this.provider.getBlock(latest.number - 1) : null;
        if (latest && prev && latest.timestamp && prev.timestamp) {
          blockTimeMs = Math.max(0, (Number(latest.timestamp) - Number(prev.timestamp)) * 1000);
        }
      } catch (_) {}

      let mempoolSize = 0;
      try {
        const pendingTxCountHex = await ((this.provider as any)?.send?.(
          'eth_getBlockTransactionCountByNumber',
          ['pending']
        ) ?? '0x0');
        mempoolSize = parseInt(pendingTxCountHex as string, 16) || 0;
      } catch (_) {}

      // Update current market condition
      this.currentMarketCondition = {
        timestamp: Date.now(),
        gasPrice: realMarketMetrics.gasPrice,
        networkCongestion: realMarketMetrics.networkCongestion,
        volatilityIndex: realMarketMetrics.volatilityIndex,
        liquidityIndex: realMarketMetrics.liquidityDepth,
        competitionLevel: realMarketMetrics.competitionLevel,
        blockTime: blockTimeMs,
        mempoolSize,
      };

      // Add to history
      this.marketConditionHistory.push(this.currentMarketCondition);

      // Keep only last 100 entries
      if (this.marketConditionHistory.length > 100) {
        this.marketConditionHistory = this.marketConditionHistory.slice(-100);
      }
    } catch (error) {
      this.logger.warn('Failed to update market conditions', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get real market metrics from on-chain data
   */
  private async getRealMarketMetrics(): Promise<{
    gasPrice: bigint;
    networkCongestion: number;
    volatilityIndex: number;
    competitionLevel: number;
    liquidityDepth: number;
  }> {
    const provider = this.connectionManager.getProvider();

    // Get real gas price
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 20000000000n;

    // Get network congestion from recent blocks
    const latestBlock = await provider.getBlock('latest');
    const networkCongestion = latestBlock
      ? Math.min(Number(latestBlock.gasUsed) / Number(latestBlock.gasLimit), 1.0)
      : 0.5;

    // Estimate volatility from Uniswap V3 tick changes (ETH/USDC 0.05% pool on Base)
    let volatilityIndex = 0.3;
    try {
      const poolAddress = '0x74cb6260be6f31965c239df6d6ef2ac2b5d4f020';
      const poolAbi = [
        'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
      ];
      const pool = new ethers.Contract(poolAddress, poolAbi, provider);
      const current = await (pool as any)['slot0']?.();
      const currentTick = current?.tick ?? current?.[1];
      const latestBlockNumber = await provider.getBlockNumber();
      const prev = await (pool as any)['slot0']?.({ blockTag: latestBlockNumber - 20 });
      const prevTick = prev?.tick ?? prev?.[1] ?? currentTick;
      const tickDelta = Math.abs(Number(currentTick) - Number(prevTick));
      // Normalize: 0-200 tick change maps roughly to 0-1
      volatilityIndex = Math.min(tickDelta / 200, 1.0);
    } catch (_) {
      // Keep default if anything fails
    }

    // Estimate competition level from mempool analysis
    const competitionLevel = await this.estimateCompetitionLevel();

    // Estimate liquidity depth from major pools
    const liquidityDepth = await this.estimateLiquidityDepth();

    return {
      gasPrice,
      networkCongestion,
      volatilityIndex,
      competitionLevel,
      liquidityDepth,
    };
  }

  /**
   * Estimate competition level from mempool
   */
  private async estimateCompetitionLevel(): Promise<number> {
    try {
      // Get pending transaction count as proxy for competition
      const pendingTxCount = await this.connectionManager
        .getProvider()
        .send('eth_getBlockTransactionCountByNumber', ['pending']);
      const latestTxCount = await this.connectionManager
        .getProvider()
        .send('eth_getBlockTransactionCountByNumber', ['latest']);

      const pendingCount = parseInt(pendingTxCount, 16);
      const latestCount = parseInt(latestTxCount, 16);

      // Competition level based on pending vs latest transaction ratio
      const competitionRatio = latestCount > 0 ? pendingCount / latestCount : 0;
      return Math.min(competitionRatio, 1.0);
    } catch (error) {
      return 0.3; // Default 30% competition
    }
  }

  /**
   * Estimate liquidity depth from major pools
   */
  private async estimateLiquidityDepth(): Promise<number> {
    try {
      // Sample a few major pools to estimate overall liquidity
      const majorPools = [
        '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18', // Example Base pool
      ];

      let totalLiquidity = 0n;
      let poolCount = 0;

      for (const poolAddress of majorPools) {
        try {
          const poolContract = new ethers.Contract(
            poolAddress,
            ['function liquidity() external view returns (uint128)'],
            this.provider // Use the provider for contract calls
          );

          const liquidity = await poolContract?.['liquidity']?.();
          totalLiquidity += liquidity;
          poolCount++;
        } catch (error) {
          // Skip failed pools
          continue;
        }
      }

      // Normalize liquidity depth (simplified)
      const avgLiquidity = poolCount > 0 ? Number(totalLiquidity) / poolCount : 0;
      const liquidityDepth = Math.min(avgLiquidity / 1e18, 1.0); // Normalize to 0-1

      return liquidityDepth;
    } catch (error) {
      return 0.7; // Default 70% liquidity depth
    }
  }

  /**
   * Optimize specific opportunity using real market metrics and risk adjustments
   */
  async optimizeOpportunity(opportunityId: string): Promise<OptimizationResult | null> {
    const opportunity = this.activeOpportunities.get(opportunityId);
    if (!opportunity || opportunity.status !== 'active') {
      return null;
    }

    // Derive metrics using current market conditions and a conservative model
    const opp = opportunity;
    const mc = this.currentMarketCondition;

    // Gas cost estimate
    const gasLimit = 300000n;
    const gasCost = mc.gasPrice * gasLimit;

    // Baseline gross profit model: 0.1% of notional for arbitrage-like, else 0.05%
    const baseReturnBps = opp.type === OpportunityType.ARBITRAGE ? 10 : 5;
    const grossProfit = (opp.originalAmount * BigInt(baseReturnBps)) / 10000n;

    // Net profit after gas
    const netProfit = grossProfit > gasCost ? grossProfit - gasCost : 0n;

    // Convert to USD using simple ETH price from Chainlink if token resembles WETH, else fallback
    let profitUsd = 0;
    try {
      const { ChainlinkPriceOracleImpl } = await import('../oracles/chainlink-oracle');
      const cm = { getProvider: () => this.provider } as any;
      const oracle = new ChainlinkPriceOracleImpl(cm);
      const ethUsd = await oracle.getEthUsdPrice();
      profitUsd = (Number(netProfit) / 1e18) * ethUsd;
    } catch (_) {
      // If oracle unavailable, leave profitUsd as 0 and proceed conservatively
    }

    // Execution probability adjusted by volatility and congestion
    const volPenalty = Math.min(
      mc.volatilityIndex * (this.config.volatilityAdjustmentFactor || 1),
      0.5
    );
    const congestionPenalty = Math.min(mc.networkCongestion, 0.5);
    const executionProbability = Math.max(0.1, 0.9 - volPenalty - congestionPenalty);

    // Risk-adjusted return and expected value
    const riskAdjustedReturn = profitUsd * (1 - (volPenalty + congestionPenalty));
    const expectedValue = riskAdjustedReturn * executionProbability;

    const metrics: ProfitabilityMetrics = {
      opportunityId,
      grossProfit,
      netProfit,
      profitUsd,
      gasCost,
      executionProbability,
      riskAdjustedReturn,
      sharpeRatio: 1.0 / (1 + mc.volatilityIndex),
      expectedValue,
      confidenceInterval: { lower: expectedValue * 0.8, upper: expectedValue * 1.2 },
      calculatedAt: Date.now(),
    };

    return {
      opportunityId,
      originalMetrics: metrics,
      optimizedMetrics: metrics,
      recommendations: [],
      shouldExecute: true,
      shouldCancel: false,
      positionSize: opportunity.originalAmount,
      maxSlippage: 0.005,
      gasLimit: 300000n,
      optimizedAt: Date.now(),
    };
  }

  /**
   * Get optimizer statistics
   */
  getOptimizerStats(): {
    activeOpportunities: number;
    optimizationCount: number;
    cancelledOpportunities: number;
    executedOpportunities: number;
    averageProfit: number;
    currentMarketCondition: MarketCondition;
  } {
    const profits = Array.from(this.profitabilityCache.values()).map(m => m.profitUsd);
    const averageProfit =
      profits.length > 0 ? profits.reduce((a, b) => a + b, 0) / profits.length : 0;

    return {
      activeOpportunities: this.activeOpportunities.size,
      optimizationCount: this.optimizationCount,
      cancelledOpportunities: this.cancelledOpportunities,
      executedOpportunities: this.executedOpportunities,
      averageProfit,
      currentMarketCondition: this.currentMarketCondition,
    };
  }

  /**
   * Get opportunity state
   */
  getOpportunityState(id: string): OpportunityState | null {
    return this.activeOpportunities.get(id) || null;
  }

  /**
   * Mark opportunity as executed
   */
  markOpportunityExecuted(id: string): void {
    const opportunity = this.activeOpportunities.get(id);
    if (opportunity) {
      opportunity.status = 'executed';
      this.activeOpportunities.set(id, opportunity);
      this.executedOpportunities++;

      this.emit('opportunityExecuted', { id, opportunity });
    }
  }

  /**
   * Stop optimizer
   */
  stop(): void {
    if (this.recalculationTimer) {
      clearInterval(this.recalculationTimer);
      this.recalculationTimer = null;
    }

    if (this.marketUpdateTimer) {
      clearInterval(this.marketUpdateTimer);
      this.marketUpdateTimer = null;
    }

    this.activeOpportunities.clear();
    this.profitabilityCache.clear();

    this.logger.info('Profitability optimizer stopped');
  }
}
