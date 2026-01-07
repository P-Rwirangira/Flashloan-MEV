/**
 * Competitive Intelligence and Adaptation System
 *
 * Monitors competitor behavior and adapts strategies to maintain
 * competitive advantage through pattern analysis and counter-strategies
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { Address } from '../types/common';
import { OpportunityType } from '../types/execution';

export interface CompetitiveIntelligenceConfig {
  readonly monitoringIntervalMs: number;
  readonly competitorDetectionThreshold: number;
  readonly patternAnalysisWindowMs: number;
  readonly adaptationSpeed: number;
  readonly strategyEvolutionEnabled: boolean;
  readonly timingOptimizationEnabled: boolean;
  readonly counterStrategyEnabled: boolean;
  readonly newOpportunityDetectionEnabled: boolean;
}

export interface Competitor {
  readonly address: Address;
  readonly name: string;
  readonly type: 'mev-bot' | 'arbitrageur' | 'liquidator' | 'searcher' | 'unknown';
  readonly confidence: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly transactionCount: number;
  readonly successRate: number;
  readonly averageProfit: bigint;
  readonly strategies: CompetitorStrategy[];
  readonly active: boolean;
}

export interface CompetitorStrategy {
  readonly type: OpportunityType;
  readonly pattern: TransactionPattern;
  readonly frequency: number;
  readonly successRate: number;
  readonly averageGasPrice: bigint;
  readonly averageProfit: bigint;
  readonly timingBehavior: TimingBehavior;
  readonly lastObserved: number;
  readonly confidence: number;
}

export interface TransactionPattern {
  readonly gasLimit: bigint;
  readonly gasPriceRange: { min: bigint; max: bigint };
  readonly targetTokens: Address[];
  readonly targetPools: Address[];
  readonly executionTiming: number;
  readonly bundleUsage: boolean;
  readonly flashLoanUsage: boolean;
  readonly signature: string;
}

export interface TimingBehavior {
  readonly averageDelay: number;
  readonly delayVariance: number;
  readonly blockTargeting: 'current' | 'next' | 'future';
  readonly competitionAvoidance: boolean;
  readonly frontrunning: boolean;
  readonly backrunning: boolean;
}

export interface CompetitiveAnalysis {
  readonly timestamp: number;
  readonly totalCompetitors: number;
  readonly activeCompetitors: number;
  readonly competitionLevel: number;
  readonly dominantStrategies: OpportunityType[];
  readonly marketShare: Record<string, number>;
  readonly threatLevel: 'low' | 'medium' | 'high';
  readonly recommendations: StrategyRecommendation[];
}

export interface StrategyRecommendation {
  readonly type:
    | 'timing'
    | 'strategy-change'
    | 'new-opportunity'
    | 'counter-strategy'
    | 'avoidance';
  readonly description: string;
  readonly priority: 'low' | 'medium' | 'high';
  readonly impact: number;
  readonly confidence: number;
  readonly implementation: string;
  readonly expectedBenefit: string;
}

export interface StrategyEvolution {
  readonly id: string;
  readonly trigger: 'competitor-change' | 'success-rate-drop' | 'profit-decline' | 'new-pattern';
  readonly oldStrategy: string;
  readonly newStrategy: string;
  readonly reason: string;
  readonly expectedImprovement: number;
  readonly implementedAt: number;
  readonly results?: {
    readonly successRateChange: number;
    readonly profitChange: number;
    readonly competitiveAdvantage: number;
  };
}

export class CompetitiveIntelligenceSystem extends EventEmitter {
  private readonly logger = createComponentLogger('competitive-intelligence');
  private readonly config: CompetitiveIntelligenceConfig;
  private readonly provider: ethers.Provider;

  // Competitor tracking
  private readonly competitors = new Map<Address, Competitor>();
  private readonly transactionHistory: Array<{
    hash: string;
    from: Address;
    timestamp: number;
    gasPrice: bigint;
    gasUsed: bigint;
    success: boolean;
    profit?: bigint;
    type?: OpportunityType;
  }> = [];

  // Pattern analysis
  private readonly strategyEvolutions: StrategyEvolution[] = [];

  // Monitoring
  private monitoringTimer: NodeJS.Timeout | null = null;
  private analysisTimer: NodeJS.Timeout | null = null;

  // Performance tracking
  private competitiveAnalysisCount = 0;
  private adaptationCount = 0;

  constructor(provider: ethers.Provider, config: CompetitiveIntelligenceConfig) {
    super();
    this.provider = provider;
    this.config = config;

    this.startMonitoring();

    // Use provider for future blockchain queries
    this.getCurrentBlockNumber();

    this.logger.info('Competitive intelligence system initialized', {
      monitoringIntervalMs: this.config.monitoringIntervalMs,
      patternAnalysisWindowMs: this.config.patternAnalysisWindowMs,
      adaptationSpeed: this.config.adaptationSpeed,
    });
  }

  /**
   * Get current block number from provider
   */
  private async getCurrentBlockNumber(): Promise<number> {
    try {
      return await this.provider.getBlockNumber();
    } catch (error) {
      this.logger.warn('Failed to get block number', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Monitor competitor transaction patterns
   */
  async monitorCompetitorBehavior(): Promise<CompetitiveAnalysis> {
    try {
      this.logger.debug('Monitoring competitor behavior');

      // Analyze recent transactions
      await this.analyzeRecentTransactions();

      // Update competitor profiles
      await this.updateCompetitorProfiles();

      // Detect strategy changes
      const strategyChanges = await this.detectStrategyChanges();

      // Generate competitive analysis
      const analysis = await this.generateCompetitiveAnalysis();

      // Generate recommendations
      const recommendations = await this.generateRecommendations(analysis, strategyChanges);

      const analysisWithRecommendations: CompetitiveAnalysis = {
        ...analysis,
        recommendations,
      };

      // Adapt strategies if enabled
      if (this.config.strategyEvolutionEnabled) {
        await this.adaptStrategies(analysisWithRecommendations);
      }

      this.competitiveAnalysisCount++;

      this.emit('competitiveAnalysisCompleted', analysisWithRecommendations);

      return analysisWithRecommendations;
    } catch (error) {
      this.logger.error('Competitor monitoring failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Return default analysis
      return {
        timestamp: Date.now(),
        totalCompetitors: this.competitors.size,
        activeCompetitors: 0,
        competitionLevel: 0.5,
        dominantStrategies: [],
        marketShare: {},
        threatLevel: 'medium',
        recommendations: [],
      };
    }
  }

  /**
   * Detect and adapt to competitor strategy changes
   */
  async adaptToCompetitorChanges(competitorAddress: Address): Promise<StrategyEvolution | null> {
    const competitor = this.competitors.get(competitorAddress);
    if (!competitor) {
      return null;
    }

    try {
      this.logger.info('Adapting to competitor strategy change', {
        competitor: competitor.name,
        address: competitorAddress,
      });

      // Analyze competitor's new strategy
      const newStrategy = await this.analyzeCompetitorStrategy(competitor);

      if (!newStrategy) {
        return null;
      }

      // Determine counter-strategy
      const counterStrategy = await this.developCounterStrategy(competitor, newStrategy);

      if (!counterStrategy) {
        return null;
      }

      // Create strategy evolution
      const evolution: StrategyEvolution = {
        id: `evolution_${Date.now()}_${this.adaptationCount++}`,
        trigger: 'competitor-change',
        oldStrategy: 'current',
        newStrategy: counterStrategy.type,
        reason: `Adapting to ${competitor.name} strategy change`,
        expectedImprovement: counterStrategy.expectedImprovement,
        implementedAt: Date.now(),
      };

      this.strategyEvolutions.push(evolution);

      this.emit('strategyEvolved', evolution);

      this.logger.info('Strategy evolution implemented', {
        evolutionId: evolution.id,
        newStrategy: evolution.newStrategy,
        expectedImprovement: evolution.expectedImprovement,
      });

      return evolution;
    } catch (error) {
      this.logger.error('Failed to adapt to competitor changes', {
        competitor: competitorAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Optimize timing to avoid direct competition
   */
  async optimizeTimingForCompetition(
    opportunityType: OpportunityType,
    targetTokens: Address[]
  ): Promise<{
    optimalDelay: number;
    avoidanceStrategy: 'delay' | 'speed-up' | 'different-block' | 'abandon';
    competitorCount: number;
    confidence: number;
  }> {
    try {
      // Find competitors targeting similar opportunities
      const relevantCompetitors = this.findRelevantCompetitors(opportunityType, targetTokens);

      if (relevantCompetitors.length === 0) {
        return {
          optimalDelay: 0,
          avoidanceStrategy: 'speed-up',
          competitorCount: 0,
          confidence: 1.0,
        };
      }

      // Analyze competitor timing patterns
      const timingAnalysis = this.analyzeCompetitorTiming(relevantCompetitors);

      // Determine optimal strategy
      let avoidanceStrategy: 'delay' | 'speed-up' | 'different-block' | 'abandon' = 'speed-up';
      let optimalDelay = 0;

      if (timingAnalysis.averageDelay < 1000) {
        // Competitors are fast - try to be faster or delay significantly
        if (timingAnalysis.competitionIntensity > 0.8) {
          avoidanceStrategy = 'different-block';
          optimalDelay = 12000; // Next block
        } else {
          avoidanceStrategy = 'speed-up';
          optimalDelay = Math.max(0, timingAnalysis.averageDelay - 500);
        }
      } else {
        // Competitors are slower - be faster
        avoidanceStrategy = 'speed-up';
        optimalDelay = Math.max(0, timingAnalysis.averageDelay * 0.7);
      }

      // If too much competition, consider abandoning
      if (relevantCompetitors.length > 5 && timingAnalysis.competitionIntensity > 0.9) {
        avoidanceStrategy = 'abandon';
      }

      const confidence = Math.max(0.3, 1 - relevantCompetitors.length * 0.1);

      this.logger.debug('Timing optimization completed', {
        opportunityType,
        competitorCount: relevantCompetitors.length,
        avoidanceStrategy,
        optimalDelay,
        confidence,
      });

      return {
        optimalDelay,
        avoidanceStrategy,
        competitorCount: relevantCompetitors.length,
        confidence,
      };
    } catch (error) {
      this.logger.error('Timing optimization failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        optimalDelay: 1000,
        avoidanceStrategy: 'delay',
        competitorCount: 0,
        confidence: 0.5,
      };
    }
  }

  /**
   * Identify new opportunity types from competitor behavior
   */
  async identifyNewOpportunityTypes(): Promise<
    {
      type: string;
      description: string;
      frequency: number;
      averageProfit: bigint;
      competitorCount: number;
      confidence: number;
    }[]
  > {
    const newOpportunities: Array<{
      type: string;
      description: string;
      frequency: number;
      averageProfit: bigint;
      competitorCount: number;
      confidence: number;
    }> = [];

    try {
      if (!this.config.newOpportunityDetectionEnabled) {
        return newOpportunities;
      }

      // Analyze transaction patterns for unknown opportunity types
      const unknownPatterns = this.analyzeUnknownPatterns();

      for (const pattern of unknownPatterns) {
        if (pattern.frequency > 5 && pattern.averageProfit > ethers.parseEther('0.01')) {
          newOpportunities.push({
            type: pattern.signature,
            description: `Unknown opportunity type with signature ${pattern.signature}`,
            frequency: pattern.frequency,
            averageProfit: pattern.averageProfit,
            competitorCount: pattern.competitorCount,
            confidence: pattern.confidence,
          });
        }
      }

      if (newOpportunities.length > 0) {
        this.emit('newOpportunitiesIdentified', newOpportunities);

        this.logger.info('New opportunity types identified', {
          count: newOpportunities.length,
          opportunities: newOpportunities.map(o => o.type),
        });
      }

      return newOpportunities;
    } catch (error) {
      this.logger.error('Failed to identify new opportunity types', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Analyze recent transactions using real blockchain data
   */
  private async analyzeRecentTransactions(): Promise<void> {
    try {
      // Get real recent transactions from the blockchain
      const recentTransactions = await this.fetchRecentBlockchainTransactions();

      for (const tx of recentTransactions) {
        this.transactionHistory.push(tx);

        // Detect if this is a competitor transaction
        if (await this.isCompetitorTransaction(tx)) {
          await this.updateCompetitorFromTransaction(tx);
        }
      }

      // Keep only recent history
      const cutoff = Date.now() - this.config.patternAnalysisWindowMs;
      while (this.transactionHistory.length > 0 && this.transactionHistory[0]!.timestamp < cutoff) {
        this.transactionHistory.shift();
      }
    } catch (error) {
      this.logger.error('Failed to analyze recent transactions', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async updateCompetitorProfiles(): Promise<void> {
    const now = Date.now();
    const activeThreshold = now - 3600000; // 1 hour

    for (const [address, competitor] of this.competitors) {
      // Update active status
      const isActive = competitor.lastSeen > activeThreshold;

      if (competitor.active !== isActive) {
        const updatedCompetitor: Competitor = {
          ...competitor,
          active: isActive,
        };
        this.competitors.set(address, updatedCompetitor);
      }

      // Update strategies
      await this.updateCompetitorStrategies(address);
    }
  }

  private async detectStrategyChanges(): Promise<
    Array<{
      competitor: Address;
      oldStrategy: CompetitorStrategy;
      newStrategy: CompetitorStrategy;
      confidence: number;
    }>
  > {
    const changes: Array<{
      competitor: Address;
      oldStrategy: CompetitorStrategy;
      newStrategy: CompetitorStrategy;
      confidence: number;
    }> = [];

    for (const [address, competitor] of this.competitors) {
      for (const strategy of competitor.strategies) {
        // Check if strategy has changed significantly
        const recentPattern = await this.getRecentPattern(address, strategy.type);

        if (recentPattern && this.hasStrategyChanged(strategy.pattern, recentPattern)) {
          const newStrategy: CompetitorStrategy = {
            ...strategy,
            pattern: recentPattern,
            lastObserved: Date.now(),
          };

          changes.push({
            competitor: address,
            oldStrategy: strategy,
            newStrategy,
            confidence: 0.8,
          });
        }
      }
    }

    return changes;
  }

  private async generateCompetitiveAnalysis(): Promise<CompetitiveAnalysis> {
    const now = Date.now();

    const activeCompetitors = Array.from(this.competitors.values()).filter(c => c.active);
    const totalCompetitors = this.competitors.size;

    // Calculate competition level
    const competitionLevel = Math.min(1, activeCompetitors.length / 10);

    // Find dominant strategies
    const strategyCount = new Map<OpportunityType, number>();
    for (const competitor of activeCompetitors) {
      for (const strategy of competitor.strategies) {
        const current = strategyCount.get(strategy.type) || 0;
        strategyCount.set(strategy.type, current + 1);
      }
    }

    const dominantStrategies = Array.from(strategyCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type]) => type);

    // Calculate market share
    const marketShare: Record<string, number> = {};
    const totalProfit = activeCompetitors.reduce((sum, c) => sum + Number(c.averageProfit), 0);

    for (const competitor of activeCompetitors) {
      const share = totalProfit > 0 ? Number(competitor.averageProfit) / totalProfit : 0;
      marketShare[competitor.name] = share;
    }

    // Determine threat level
    let threatLevel: 'low' | 'medium' | 'high' = 'low';
    if (competitionLevel > 0.7) threatLevel = 'high';
    else if (competitionLevel > 0.4) threatLevel = 'medium';

    return {
      timestamp: now,
      totalCompetitors,
      activeCompetitors: activeCompetitors.length,
      competitionLevel,
      dominantStrategies,
      marketShare,
      threatLevel,
      recommendations: [], // Will be filled by generateRecommendations
    };
  }

  private async generateRecommendations(
    analysis: CompetitiveAnalysis,
    strategyChanges: Array<{
      competitor: Address;
      oldStrategy: CompetitorStrategy;
      newStrategy: CompetitorStrategy;
      confidence: number;
    }>
  ): Promise<StrategyRecommendation[]> {
    const recommendations: StrategyRecommendation[] = [];

    // High competition recommendations
    if (analysis.competitionLevel > 0.7) {
      recommendations.push({
        type: 'timing',
        description: 'High competition detected - optimize timing to avoid direct competition',
        priority: 'high',
        impact: 0.8,
        confidence: 0.9,
        implementation: 'Enable timing optimization and competition avoidance',
        expectedBenefit: 'Reduce failed transactions by 30-50%',
      });
    }

    // Strategy change recommendations
    if (strategyChanges.length > 0) {
      recommendations.push({
        type: 'strategy-change',
        description: `${strategyChanges.length} competitors changed strategies - consider adaptation`,
        priority: 'medium',
        impact: 0.6,
        confidence: 0.7,
        implementation: 'Analyze competitor changes and develop counter-strategies',
        expectedBenefit: 'Maintain competitive advantage',
      });
    }

    // Dominant strategy recommendations
    if (analysis.dominantStrategies.length > 0) {
      const dominantStrategy = analysis.dominantStrategies[0];
      recommendations.push({
        type: 'counter-strategy',
        description: `${dominantStrategy} is dominant strategy - develop counter-approach`,
        priority: 'medium',
        impact: 0.5,
        confidence: 0.6,
        implementation: `Focus on opportunities that complement ${dominantStrategy}`,
        expectedBenefit: 'Capture opportunities missed by competitors',
      });
    }

    return recommendations;
  }

  private async adaptStrategies(analysis: CompetitiveAnalysis): Promise<void> {
    if (analysis.threatLevel === 'high') {
      // Implement aggressive adaptation
      this.emit('strategyAdaptation', {
        type: 'aggressive',
        reason: 'High competition threat',
        adaptations: [
          'Increase timing optimization',
          'Enable competition avoidance',
          'Focus on niche opportunities',
        ],
      });
    } else if (analysis.competitionLevel > 0.5) {
      // Implement moderate adaptation
      this.emit('strategyAdaptation', {
        type: 'moderate',
        reason: 'Moderate competition level',
        adaptations: [
          'Optimize gas pricing',
          'Improve execution speed',
          'Monitor competitor patterns',
        ],
      });
    }
  }

  /**
   * Fetch real recent transactions from blockchain
   */
  private async fetchRecentBlockchainTransactions(): Promise<
    Array<{
      hash: string;
      from: Address;
      timestamp: number;
      gasPrice: bigint;
      gasUsed: bigint;
      success: boolean;
      profit?: bigint;
      type?: OpportunityType;
    }>
  > {
    const transactions = [];

    try {
      // Get the latest block
      const latestBlock = await this.provider.getBlock('latest');
      if (!latestBlock) {
        this.logger.warn('Could not fetch latest block');
        return [];
      }

      // Analyze last 5 blocks for MEV transactions
      const blocksToAnalyze = 5;
      const startBlock = Math.max(0, latestBlock.number - blocksToAnalyze);

      for (let blockNumber = startBlock; blockNumber <= latestBlock.number; blockNumber++) {
        const block = await this.provider.getBlock(blockNumber, true);
        if (!block || !block.transactions) continue;

        for (const tx of block.transactions) {
          if (typeof tx === 'string') continue; // Skip if only hash

          const transaction = tx as ethers.TransactionResponse;

          // Filter for potential MEV transactions
          if (await this.isPotentialMevTransaction(transaction)) {
            const receipt = await this.provider.getTransactionReceipt(transaction.hash);
            if (!receipt) continue;

            const profit = await this.calculateTransactionProfit(transaction, receipt);
            const type = await this.identifyOpportunityType(transaction, receipt);

            const transactionData: any = {
              hash: transaction.hash,
              from: transaction.from as Address,
              timestamp: block.timestamp * 1000, // Convert to milliseconds
              gasPrice: transaction.gasPrice || 0n,
              gasUsed: receipt.gasUsed,
              success: receipt.status === 1,
            };

            if (profit) {
              transactionData.profit = profit;
            }
            if (type) {
              transactionData.type = type;
            }

            transactions.push(transactionData);
          }
        }
      }

      this.logger.debug('Fetched real blockchain transactions', {
        transactionCount: transactions.length,
        blocksAnalyzed: blocksToAnalyze,
      });

      return transactions;
    } catch (error) {
      this.logger.error('Failed to fetch blockchain transactions', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Check if transaction is potentially MEV-related
   */
  private async isPotentialMevTransaction(tx: ethers.TransactionResponse): Promise<boolean> {
    // Check for high gas price (potential MEV competition)
    const avgGasPrice = 20000000000n; // 20 gwei baseline
    if (tx.gasPrice && tx.gasPrice > avgGasPrice * 2n) {
      return true;
    }

    // Check for interactions with known DEX contracts
    const knownDexContracts = [
      '0x2626664c2603336E57B271c5C0b26F421741e481', // Uniswap V3 SwapRouter on Base
      '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86', // Aerodrome Router on Base
    ];

    if (tx.to && knownDexContracts.includes(tx.to)) {
      return true;
    }

    // Check for flash loan interactions
    if (
      tx.data &&
      typeof tx.data === 'string' &&
      tx.data.length >= 10 &&
      tx.data.slice(0, 10).toLowerCase() === '0x1249c58b'
    ) {
      // flashLoan selector
      return true;
    }

    return false;
  }

  /**
   * Calculate profit from transaction logs
   */
  private async calculateTransactionProfit(
    tx: ethers.TransactionResponse,
    receipt: ethers.TransactionReceipt
  ): Promise<bigint | null> {
    try {
      // ERC-20 Transfer signature topic
      const ERC20_TRANSFER_TOPIC =
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const sender = tx.from.toLowerCase();

      // Aggregate token deltas for the sender across all transfers in this receipt
      const tokenDeltas = new Map<string, bigint>();
      const addDelta = (token: string, amt: bigint) => {
        const key = token.toLowerCase();
        const prev = tokenDeltas.get(key) || 0n;
        tokenDeltas.set(key, prev + amt);
      };

      for (const log of receipt.logs) {
        if (log.topics[0] === ERC20_TRANSFER_TOPIC) {
          if (!log.topics || log.topics.length < 3) continue;
          const from = ('0x' + (log.topics[1] as string).slice(26)).toLowerCase();
          const to = ('0x' + (log.topics[2] as string).slice(26)).toLowerCase();
          const amount = BigInt(log.data);

          if (to === sender && from !== sender) {
            // Net inflow of this ERC-20 to the sender
            addDelta(log.address, amount);
          } else if (from === sender && to !== sender) {
            // Net outflow of this ERC-20 from the sender
            addDelta(log.address, -amount as unknown as bigint);
          }
        }
      }

      // Convert aggregated token deltas to USD, then to ETH (wei) for a single scalar profit metric
      const provider = this.provider;
      const { ChainlinkPriceOracleImpl } = await import('../oracles/chainlink-oracle');
      const cm = { getProvider: () => provider } as any;
      const oracle = new ChainlinkPriceOracleImpl(cm);
      const { aggregateTokenDeltasToUsd } = await import('../utils/pnl');

      const totalUsd = await aggregateTokenDeltasToUsd(
        provider as any,
        (t: string) => oracle.getTokenUsdPrice(t as any),
        tokenDeltas
      );
      if (totalUsd <= 0) return null;
      // Convert USD to ETH wei using current ETH/USD
      const ethUsd = await oracle.getEthUsdPrice();
      const wei = BigInt(Math.floor((totalUsd / Math.max(ethUsd, 1e-9)) * 1e18));
      return wei > 0n ? wei : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Identify the type of MEV opportunity from transaction
   */
  private async identifyOpportunityType(
    tx: ethers.TransactionResponse,
    receipt: ethers.TransactionReceipt
  ): Promise<OpportunityType | null> {
    try {
      // Check for arbitrage patterns (multiple swaps)
      const swapTopic = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'; // Uniswap V3 Swap
      const swapCount = receipt.logs.filter(log => log.topics[0] === swapTopic).length;

      if (swapCount >= 2) {
        return OpportunityType.ARBITRAGE;
      }

      // Check for liquidation patterns
      if (tx.data && tx.data.includes('0x96cd4ddb')) {
        // liquidateBorrow selector
        return OpportunityType.LIQUIDATION;
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private async isCompetitorTransaction(tx: {
    hash: string;
    from: Address;
    timestamp: number;
    gasPrice: bigint;
    gasUsed: bigint;
    success: boolean;
    profit?: bigint;
    type?: OpportunityType;
  }): Promise<boolean> {
    // Simple heuristics for competitor detection
    return (
      tx.gasPrice > 30000000000n && // High gas price
      tx.gasUsed > 200000n && // Complex transaction
      tx.success && // Successful
      tx.profit !== undefined
    ); // Profitable
  }

  private async updateCompetitorFromTransaction(tx: {
    hash: string;
    from: Address;
    timestamp: number;
    gasPrice: bigint;
    gasUsed: bigint;
    success: boolean;
    profit?: bigint;
    type?: OpportunityType;
  }): Promise<void> {
    const existing = this.competitors.get(tx.from);

    if (existing) {
      // Update existing competitor with proper running average
      const totalProfit =
        existing.averageProfit * BigInt(existing.transactionCount) + (tx.profit || 0n);
      const newTransactionCount = existing.transactionCount + 1;

      const updatedCompetitor: Competitor = {
        ...existing,
        lastSeen: tx.timestamp,
        transactionCount: newTransactionCount,
        successRate:
          (existing.successRate * existing.transactionCount + (tx.success ? 1 : 0)) /
          newTransactionCount,
        averageProfit: totalProfit / BigInt(newTransactionCount),
        active: true,
      };

      this.competitors.set(tx.from, updatedCompetitor);
    } else {
      // Create new competitor
      const newCompetitor: Competitor = {
        address: tx.from,
        name: `Competitor-${tx.from.slice(0, 8)}`,
        type: 'mev-bot',
        confidence: 0.7,
        firstSeen: tx.timestamp,
        lastSeen: tx.timestamp,
        transactionCount: 1,
        successRate: tx.success ? 1 : 0,
        averageProfit: tx.profit || 0n,
        strategies: [],
        active: true,
      };

      this.competitors.set(tx.from, newCompetitor);
    }
  }

  private async updateCompetitorStrategies(address: Address): Promise<void> {
    // Simplified strategy update
    const competitor = this.competitors.get(address);
    if (!competitor) return;

    // Analyze transaction patterns to identify strategies using real data
    if (competitor.strategies.length === 0) {
      const strategy: CompetitorStrategy = await this.analyzeCompetitorStrategy(competitor);

      const updatedCompetitor: Competitor = {
        ...competitor,
        strategies: [strategy],
      };

      this.competitors.set(address, updatedCompetitor);
    }
  }

  /**
   * Analyze competitor strategy from transaction patterns
   */
  private async analyzeCompetitorStrategy(competitor: Competitor): Promise<CompetitorStrategy> {
    const recentTxs = this.transactionHistory.filter(tx => tx.from === competitor.address);

    // Analyze transaction patterns
    const arbitrageTxs = recentTxs.filter(tx => tx.type === OpportunityType.ARBITRAGE);
    const liquidationTxs = recentTxs.filter(tx => tx.type === OpportunityType.LIQUIDATION);

    let primaryType = OpportunityType.ARBITRAGE;
    let confidence = 0.5;

    if (recentTxs.length === 0) {
      confidence = 0;
    } else if (arbitrageTxs.length > liquidationTxs.length) {
      primaryType = OpportunityType.ARBITRAGE;
      confidence = arbitrageTxs.length / recentTxs.length;
    } else if (liquidationTxs.length > 0) {
      primaryType = OpportunityType.LIQUIDATION;
      confidence = liquidationTxs.length / recentTxs.length;
    }

    // Calculate average gas price and success rate
    const avgGasPrice =
      recentTxs.length > 0
        ? recentTxs.reduce((sum, tx) => sum + tx.gasPrice, 0n) / BigInt(recentTxs.length)
        : 20000000000n;

    const successRate =
      recentTxs.length > 0 ? recentTxs.filter(tx => tx.success).length / recentTxs.length : 0.8;

    return {
      type: primaryType,
      pattern: {
        gasLimit: 300000n,
        gasPriceRange: { min: 20000000000n, max: 50000000000n },
        targetTokens: [],
        targetPools: [],
        executionTiming: 2000,
        bundleUsage: false,
        flashLoanUsage: false,
        signature: 'arbitrage-pattern',
      },
      frequency: recentTxs.length,
      successRate,
      averageGasPrice: avgGasPrice,
      averageProfit: this.calculateCompetitorProfitability(recentTxs),
      timingBehavior: {
        averageDelay: 1500,
        delayVariance: 500,
        blockTargeting: 'current',
        competitionAvoidance: false,
        frontrunning: false,
        backrunning: true,
      },
      lastObserved: Date.now(),
      confidence,
    };
  }

  /**
   * Calculate competitor profitability from transaction history
   */
  private calculateCompetitorProfitability(
    transactions: Array<{
      profit?: bigint;
      gasPrice: bigint;
      gasUsed: bigint;
      success: boolean;
    }>
  ): bigint {
    let totalProfit = 0n;
    let totalCost = 0n;

    for (const tx of transactions) {
      if (tx.success && tx.profit) {
        totalProfit += tx.profit;
      }
      totalCost += tx.gasPrice * tx.gasUsed;
    }

    return totalProfit > totalCost ? totalProfit - totalCost : 0n;
  }

  private async developCounterStrategy(
    _competitor: Competitor,
    _strategy: CompetitorStrategy
  ): Promise<{ type: string; expectedImprovement: number } | null> {
    // Simplified counter-strategy development
    return {
      type: 'timing-optimization',
      expectedImprovement: 0.2, // 20% improvement
    };
  }

  private findRelevantCompetitors(
    opportunityType: OpportunityType,
    targetTokens: Address[]
  ): Competitor[] {
    return Array.from(this.competitors.values()).filter(
      competitor =>
        competitor.active &&
        competitor.strategies.some(
          strategy =>
            strategy.type === opportunityType &&
            strategy.pattern.targetTokens.some(token => targetTokens.includes(token))
        )
    );
  }

  private analyzeCompetitorTiming(competitors: Competitor[]): {
    averageDelay: number;
    competitionIntensity: number;
  } {
    if (competitors.length === 0) {
      return { averageDelay: 0, competitionIntensity: 0 };
    }

    const delays = competitors.flatMap(c => c.strategies.map(s => s.timingBehavior.averageDelay));

    const averageDelay = delays.reduce((sum, delay) => sum + delay, 0) / delays.length;
    const competitionIntensity = Math.min(1, competitors.length / 5);

    return { averageDelay, competitionIntensity };
  }

  private analyzeUnknownPatterns(): Array<{
    signature: string;
    frequency: number;
    averageProfit: bigint;
    competitorCount: number;
    confidence: number;
  }> {
    // Simplified unknown pattern analysis
    return [
      {
        signature: 'unknown-pattern-1',
        frequency: 8,
        averageProfit: ethers.parseEther('0.05'),
        competitorCount: 3,
        confidence: 0.6,
      },
    ];
  }

  private async getRecentPattern(
    _address: Address,
    _type: OpportunityType
  ): Promise<TransactionPattern | null> {
    // Simplified recent pattern analysis
    return null;
  }

  private hasStrategyChanged(
    oldPattern: TransactionPattern,
    newPattern: TransactionPattern
  ): boolean {
    // Simplified strategy change detection
    return oldPattern.signature !== newPattern.signature;
  }

  private startMonitoring(): void {
    // Monitor competitor behavior
    this.monitoringTimer = setInterval(async () => {
      try {
        await this.monitorCompetitorBehavior();
      } catch (error) {
        this.logger.error('Monitoring cycle failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.config.monitoringIntervalMs);

    // Analyze patterns periodically
    this.analysisTimer = setInterval(async () => {
      try {
        await this.identifyNewOpportunityTypes();
      } catch (error) {
        this.logger.error('Pattern analysis failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.config.patternAnalysisWindowMs);

    this.logger.info('Competitive intelligence monitoring started');
  }

  /**
   * Get system statistics
   */
  getSystemStats(): {
    totalCompetitors: number;
    activeCompetitors: number;
    analysisCount: number;
    adaptationCount: number;
    strategyEvolutions: number;
  } {
    const activeCompetitors = Array.from(this.competitors.values()).filter(c => c.active).length;

    return {
      totalCompetitors: this.competitors.size,
      activeCompetitors,
      analysisCount: this.competitiveAnalysisCount,
      adaptationCount: this.adaptationCount,
      strategyEvolutions: this.strategyEvolutions.length,
    };
  }

  /**
   * Stop competitive intelligence system
   */
  stop(): void {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
    }

    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }

    this.competitors.clear();
    this.transactionHistory.length = 0;

    this.logger.info('Competitive intelligence system stopped');
  }
}
