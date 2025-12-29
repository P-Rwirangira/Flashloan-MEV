/**
 * Competition Tracker
 *
 * Tracks competitor MEV bot behavior and optimizes bidding strategies
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { Address } from '../types/common';
import { ArbitrageOpportunity } from '../types/opportunity';
import { RpcConnectionManager } from '../rpc/connection-manager';

export interface CompetitorBehavior {
  readonly address: Address;
  readonly averageBid: bigint;
  readonly successRate: number;
  readonly responseTime: number; // milliseconds
  readonly preferredGasPrice: bigint;
  readonly lastSeen: number;
  readonly transactionCount: number;
  readonly profitability: number; // estimated profit per transaction
}

export interface BidAnalysis {
  readonly competitorBids: bigint[];
  readonly recommendedBid: bigint;
  readonly winProbability: number;
  readonly reasoning: string[];
}

export interface MarketConditions {
  readonly activeCompetitors: number;
  readonly averageCompetition: number; // bids per opportunity
  readonly marketAggression: 'low' | 'medium' | 'high' | 'extreme';
  readonly profitMargins: number[]; // recent profit margins observed
}

export class CompetitionTracker extends EventEmitter {
  private readonly connectionManager: RpcConnectionManager;
  private readonly competitors: Map<Address, CompetitorBehavior> = new Map();
  private readonly recentOpportunities: Map<
    string,
    {
      opportunity: ArbitrageOpportunity;
      bids: Array<{ address: Address; bid: bigint; timestamp: number }>;
      winner?: Address;
      finalGasPrice?: bigint;
    }
  > = new Map();

  // Known MEV bot addresses on Base (to be populated through observation)
  private readonly knownMevBots: Set<Address> = new Set([
    // These would be populated through transaction analysis
    // '0x...' as Address,
  ]);

  private readonly maxHistorySize = 1000;
  private readonly competitorTimeout = 3600000; // 1 hour

  constructor(connectionManager: RpcConnectionManager) {
    super();
    this.connectionManager = connectionManager;
  }

  /**
   * Track competitor bids for an opportunity
   */
  async trackCompetitorBids(opportunity: ArbitrageOpportunity): Promise<bigint[]> {
    const opportunityKey = this.getOpportunityKey(opportunity);

    // Initialize tracking for this opportunity
    if (!this.recentOpportunities.has(opportunityKey)) {
      this.recentOpportunities.set(opportunityKey, {
        opportunity,
        bids: [],
      });
    }

    // Analyze pending transactions for competing bids
    const competingBids = await this.analyzePendingTransactions(opportunity);

    // Update opportunity tracking
    const tracking = this.recentOpportunities.get(opportunityKey)!;
    tracking.bids.push(...competingBids);

    // Update competitor behavior profiles
    for (const bid of competingBids) {
      this.updateCompetitorProfile(bid.address, bid.bid, opportunity);
    }

    // Clean up old opportunities
    this.cleanupOldOpportunities();

    return competingBids.map(bid => bid.bid);
  }

  /**
   * Calculate optimal bid based on competition analysis
   */
  calculateOptimalBid(
    competitorBids: bigint[],
    availableProfit: bigint,
    urgency: number = 0.5
  ): BidAnalysis {
    const reasoning: string[] = [];

    if (competitorBids.length === 0) {
      // No competition detected
      const conservativeBid = availableProfit / 10n; // 10% of profit

      // Ensure minimum viable bid
      const minBid = ethers.parseUnits('0.1', 'gwei');
      const recommendedBid = conservativeBid > minBid ? conservativeBid : minBid;

      reasoning.push('No competition detected, using conservative bid');
      if (recommendedBid === minBid) {
        reasoning.push('Applied minimum bid threshold');
      }

      return {
        competitorBids: [],
        recommendedBid,
        winProbability: 0.9,
        reasoning,
      };
    }

    // Sort bids to analyze distribution
    const sortedBids = [...competitorBids].sort((a, b) => (a > b ? 1 : -1));
    const highestBid = sortedBids[sortedBids.length - 1]!;
    const medianBid = sortedBids[Math.floor(sortedBids.length / 2)]!;

    reasoning.push(`Detected ${competitorBids.length} competing bids`);
    reasoning.push(`Highest competitor bid: ${ethers.formatUnits(highestBid, 'gwei')} gwei`);
    reasoning.push(`Median competitor bid: ${ethers.formatUnits(medianBid, 'gwei')} gwei`);

    // Calculate bid based on strategy
    let recommendedBid: bigint;
    let winProbability: number;

    if (urgency > 0.8) {
      // High urgency: bid above highest competitor
      const premium = this.calculateUrgencyPremium(urgency);
      recommendedBid = (highestBid * (100n + premium)) / 100n;
      winProbability = 0.85;
      reasoning.push(`High urgency: bidding ${premium}% above highest competitor`);
    } else if (urgency < 0.3) {
      // Low urgency: bid conservatively
      recommendedBid = (medianBid * 105n) / 100n; // 5% above median
      winProbability = 0.6;
      reasoning.push('Low urgency: bidding slightly above median');
    } else {
      // Medium urgency: strategic bidding
      const marketAggression = this.assessMarketAggression(competitorBids);
      recommendedBid = this.calculateStrategicBid(sortedBids, marketAggression);
      winProbability = this.estimateWinProbability(recommendedBid, sortedBids);
      reasoning.push(`Strategic bid based on ${marketAggression} market aggression`);
    }

    // Ensure bid doesn't exceed available profit
    const maxAffordableBid = (availableProfit * 80n) / 100n; // Max 80% of profit
    if (recommendedBid > maxAffordableBid) {
      recommendedBid = maxAffordableBid;
      winProbability *= 0.7; // Reduced win probability
      reasoning.push('Bid capped at 80% of available profit');
    }

    // Ensure minimum viable bid
    const minBid = ethers.parseUnits('0.1', 'gwei');
    if (recommendedBid < minBid) {
      recommendedBid = minBid;
      reasoning.push('Applied minimum bid threshold');
    }

    return {
      competitorBids,
      recommendedBid,
      winProbability,
      reasoning,
    };
  }

  /**
   * Analyze pending transactions for competing MEV attempts
   */
  private async analyzePendingTransactions(
    opportunity: ArbitrageOpportunity
  ): Promise<Array<{ address: Address; bid: bigint; timestamp: number }>> {
    try {
      const provider = this.connectionManager.getProvider();

      // Get pending block (if available)
      const pendingBlock = await provider.getBlock('pending').catch(() => null);
      if (!pendingBlock?.transactions) {
        return [];
      }

      const competingBids: Array<{ address: Address; bid: bigint; timestamp: number }> = [];
      const now = Date.now();

      // Analyze transactions that might be competing for the same opportunity
      for (const txHash of pendingBlock.transactions.slice(0, 100)) {
        // Limit analysis
        try {
          const tx = await provider.getTransaction(txHash);
          if (!tx) continue;

          // Check if this looks like a competing MEV transaction
          if (this.isCompetingTransaction(tx, opportunity)) {
            const bid = tx.maxPriorityFeePerGas || tx.gasPrice || 0n;

            competingBids.push({
              address: tx.from as Address,
              bid,
              timestamp: now,
            });

            // Add to known MEV bots if not already tracked
            this.knownMevBots.add(tx.from as Address);
          }
        } catch (error) {
          // Skip failed transaction analysis
          continue;
        }
      }

      return competingBids;
    } catch (error) {
      this.emit('analysisError', error);
      return [];
    }
  }

  /**
   * Check if a transaction is competing for the same opportunity
   */
  private isCompetingTransaction(
    tx: ethers.TransactionResponse,
    opportunity: ArbitrageOpportunity
  ): boolean {
    // Heuristics to identify competing transactions:

    // 1. Check if transaction involves the same tokens
    const txData = tx.data.toLowerCase();
    const tokenIn = opportunity.tokenIn.toLowerCase();
    const tokenOut = opportunity.tokenOut.toLowerCase();

    if (txData.includes(tokenIn.slice(2)) || txData.includes(tokenOut.slice(2))) {
      return true;
    }

    // 2. Check if transaction targets the same pools
    for (const poolAddress of opportunity.route.pools) {
      if (txData.includes(poolAddress.toLowerCase().slice(2))) {
        return true;
      }
    }

    // 3. Check if sender is a known MEV bot
    if (this.knownMevBots.has(tx.from as Address)) {
      return true;
    }

    // 4. Check gas price patterns (MEV bots typically use high gas prices)
    const gasPrice = tx.maxFeePerGas || tx.gasPrice || 0n;
    const highGasThreshold = ethers.parseUnits('10', 'gwei'); // 10 gwei threshold

    if (gasPrice > highGasThreshold && tx.value === 0n) {
      // High gas price with no ETH transfer suggests MEV activity
      return true;
    }

    return false;
  }

  /**
   * Update competitor behavior profile
   */
  private updateCompetitorProfile(
    address: Address,
    bid: bigint,
    opportunity: ArbitrageOpportunity
  ): void {
    const existing = this.competitors.get(address);
    const now = Date.now();

    if (existing) {
      // Update existing profile
      const newTxCount = existing.transactionCount + 1;
      const newAverageBid =
        (existing.averageBid * BigInt(existing.transactionCount) + bid) / BigInt(newTxCount);

      this.competitors.set(address, {
        ...existing,
        averageBid: newAverageBid,
        lastSeen: now,
        transactionCount: newTxCount,
      });
    } else {
      // Create new profile
      this.competitors.set(address, {
        address,
        averageBid: bid,
        successRate: 0.5, // Unknown initially
        responseTime: 1000, // Assume 1s response time initially
        preferredGasPrice: bid,
        lastSeen: now,
        transactionCount: 1,
        profitability: 0, // Unknown initially
      });
    }

    this.emit('competitorUpdated', { address, bid, opportunity: opportunity.id });
  }

  /**
   * Calculate urgency premium for high-priority bids
   */
  private calculateUrgencyPremium(urgency: number): bigint {
    // Convert urgency (0-1) to premium percentage (5-50%)
    const premiumPercent = Math.floor(5 + urgency * 45);
    return BigInt(premiumPercent);
  }

  /**
   * Assess market aggression level
   */
  private assessMarketAggression(bids: bigint[]): 'low' | 'medium' | 'high' | 'extreme' {
    if (bids.length === 0) return 'low';

    const sortedBids = [...bids].sort((a, b) => (a > b ? 1 : -1));
    const highest = sortedBids[sortedBids.length - 1]!;
    const lowest = sortedBids[0]!;

    // Calculate bid spread - handle division by zero
    let spread = 0;
    if (highest > lowest && lowest > 0n) {
      spread = Number(highest - lowest) / Number(lowest);
    } else if (highest > 0n && lowest === 0n) {
      // If lowest is zero but highest isn't, use a large spread value
      spread = 10.0; // Indicates extreme spread
    }

    if (spread > 2.0) return 'extreme'; // >200% spread
    if (spread > 1.0) return 'high'; // >100% spread
    if (spread > 0.5) return 'medium'; // >50% spread
    return 'low';
  }

  /**
   * Calculate strategic bid based on market conditions
   */
  private calculateStrategicBid(
    sortedBids: bigint[],
    aggression: 'low' | 'medium' | 'high' | 'extreme'
  ): bigint {
    const highest = sortedBids[sortedBids.length - 1]!;
    const secondHighest = sortedBids.length > 1 ? sortedBids[sortedBids.length - 2]! : highest;

    switch (aggression) {
      case 'low':
        // Bid slightly above second highest
        return (secondHighest * 102n) / 100n; // 2% above

      case 'medium':
        // Bid between second highest and highest
        return (secondHighest + highest) / 2n;

      case 'high':
        // Bid above highest with moderate premium
        return (highest * 110n) / 100n; // 10% above

      case 'extreme':
        // Bid significantly above highest
        return (highest * 125n) / 100n; // 25% above

      default:
        return highest;
    }
  }

  /**
   * Estimate win probability based on bid and competition
   */
  private estimateWinProbability(bid: bigint, competitorBids: bigint[]): number {
    if (competitorBids.length === 0) return 0.9;

    const higherBids = competitorBids.filter(competitorBid => competitorBid >= bid).length;
    const totalBids = competitorBids.length;

    // Base probability from bid ranking
    const rankProbability = 1 - higherBids / (totalBids + 1);

    // Adjust for bid premium
    const highestCompetitor = Math.max(...competitorBids.map(b => Number(b)));
    let bidPremium: number;

    if (highestCompetitor === 0) {
      // Handle zero competitor bids
      bidPremium = Number(bid) === 0 ? 1 : Number.POSITIVE_INFINITY;
    } else {
      bidPremium = Number(bid) / highestCompetitor;
    }

    let adjustedProbability = rankProbability;
    if (bidPremium > 1.2) {
      adjustedProbability = Math.min(0.95, adjustedProbability * 1.3);
    } else if (bidPremium > 1.1) {
      adjustedProbability = Math.min(0.9, adjustedProbability * 1.15);
    } else if (bidPremium < 0.9) {
      adjustedProbability *= 0.7;
    }

    return Math.max(0.05, Math.min(0.95, adjustedProbability));
  }

  /**
   * Get current market conditions
   */
  getMarketConditions(): MarketConditions {
    const activeCompetitors = Array.from(this.competitors.values()).filter(
      c => Date.now() - c.lastSeen < this.competitorTimeout
    ).length;

    const recentOpportunityEntries = Array.from(this.recentOpportunities.values()).filter(
      o => o.bids.length > 0 && Date.now() - (o.bids[0]?.timestamp || 0) < 300000
    ); // Last 5 minutes

    const recentOpportunityCount = recentOpportunityEntries.length;

    const averageCompetition =
      recentOpportunityCount > 0
        ? recentOpportunityEntries.reduce((sum, o) => sum + o.bids.length, 0) /
          recentOpportunityCount
        : 0;

    // Assess market aggression
    const recentBids = recentOpportunityEntries.flatMap(o => o.bids.map(b => b.bid)).slice(-50); // Last 50 bids

    const marketAggression =
      recentBids.length > 0 ? this.assessMarketAggression(recentBids) : 'low';

    // Calculate recent profit margins (placeholder - would need actual profit data)
    const profitMargins = [0.02, 0.03, 0.015, 0.025, 0.018]; // Mock data

    return {
      activeCompetitors,
      averageCompetition,
      marketAggression,
      profitMargins,
    };
  }

  /**
   * Get competitor profiles
   */
  getCompetitors(): CompetitorBehavior[] {
    return Array.from(this.competitors.values())
      .filter(c => Date.now() - c.lastSeen < this.competitorTimeout)
      .sort((a, b) => b.transactionCount - a.transactionCount);
  }

  /**
   * Generate opportunity key for tracking
   */
  private getOpportunityKey(opportunity: ArbitrageOpportunity): string {
    return `${opportunity.tokenIn}-${opportunity.tokenOut}-${opportunity.route.pools.join('-')}`;
  }

  /**
   * Clean up old opportunity tracking data
   */
  private cleanupOldOpportunities(): void {
    const cutoff = Date.now() - 3600000; // 1 hour ago

    for (const [key, tracking] of this.recentOpportunities) {
      // Use most recent bid timestamp instead of oldest
      const mostRecentBidTimestamp =
        tracking.bids.length > 0 ? tracking.bids[tracking.bids.length - 1]?.timestamp || 0 : 0;

      if (tracking.bids.length === 0 || mostRecentBidTimestamp < cutoff) {
        this.recentOpportunities.delete(key);
      }
    }

    // Keep only recent opportunities
    if (this.recentOpportunities.size > this.maxHistorySize) {
      const entries = Array.from(this.recentOpportunities.entries());
      entries.sort((a, b) => {
        const aTimestamp =
          a[1].bids.length > 0 ? a[1].bids[a[1].bids.length - 1]?.timestamp || 0 : 0;
        const bTimestamp =
          b[1].bids.length > 0 ? b[1].bids[b[1].bids.length - 1]?.timestamp || 0 : 0;
        return bTimestamp - aTimestamp;
      });

      this.recentOpportunities.clear();
      for (const [key, tracking] of entries.slice(0, this.maxHistorySize)) {
        this.recentOpportunities.set(key, tracking);
      }
    }
  }

  /**
   * Get tracking statistics
   */
  getStats(): {
    trackedCompetitors: number;
    recentOpportunities: number;
    averageBidsPerOpportunity: number;
    marketConditions: MarketConditions;
  } {
    const marketConditions = this.getMarketConditions();

    return {
      trackedCompetitors: this.competitors.size,
      recentOpportunities: this.recentOpportunities.size,
      averageBidsPerOpportunity: marketConditions.averageCompetition,
      marketConditions,
    };
  }
}
