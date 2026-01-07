/**
 * DexScreener Trending Pair Discovery
 * Automatically discovers new high-volume pairs
 */

import { DexScreenerClient, DexScreenerPair } from './dexscreener-client.js';
import { logger } from '../utils/logger.js';

export interface DiscoveryConfig {
  chain: string;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  minVolume1hUsd: number;
  maxPoolAge: number; // in seconds
  scanIntervalMs: number;
  maxNewPoolsPerScan: number;
  whitelistedTokens: string[];
  blacklistedTokens: string[];
}

export interface DiscoveredPool {
  address: string;
  dex: string;
  token0: {
    address: string;
    symbol: string;
    name: string;
  };
  token1: {
    address: string;
    symbol: string;
    name: string;
  };
  liquidity: number;
  volume24h: number;
  volume1h: number;
  priceChange24h: number;
  txCount24h: number;
  createdAt: number;
  discoveredAt: number;
  score: number;
  reason: string;
}

export class DexScreenerDiscovery {
  private readonly client: DexScreenerClient;
  private readonly config: DiscoveryConfig;
  private discoveryInterval: NodeJS.Timeout | undefined;
  private isDiscovering = false;
  private discoveredPools = new Map<string, DiscoveredPool>();
  private totalDiscovered = 0;

  constructor(client: DexScreenerClient, config: DiscoveryConfig) {
    this.client = client;
    this.config = config;
  }

  /**
   * Start automatic discovery
   */
  async start(): Promise<void> {
    if (this.isDiscovering) {
      logger.warn('Discovery already running');
      return;
    }

    this.isDiscovering = true;
    logger.info('Starting trending pair discovery', {
      chain: this.config.chain,
      minLiquidity: this.config.minLiquidityUsd,
      minVolume24h: this.config.minVolume24hUsd,
      scanInterval: this.config.scanIntervalMs
    });

    await this.discover();

    this.discoveryInterval = setInterval(
      () => this.discover(),
      this.config.scanIntervalMs
    );
  }

  /**
   * Stop discovery
   */
  stop(): void {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = undefined;
    }
    this.isDiscovering = false;
    logger.info('Discovery stopped', {
      totalDiscovered: this.totalDiscovered
    });
  }

  /**
   * Discover new trending pairs
   */
  async discover(): Promise<DiscoveredPool[]> {
    const discoverStart = Date.now();

    try {
      // Search for trending Base pairs
      const searchQuery = `${this.config.chain} high volume`;
      const pairs = await this.client.searchPairs(searchQuery);

      logger.debug('Discovery search completed', {
        query: searchQuery,
        pairsFound: pairs.length
      });

      const newPools: DiscoveredPool[] = [];

      for (const pair of pairs) {
        // Skip if already discovered
        if (this.discoveredPools.has(pair.pairAddress.toLowerCase())) {
          continue;
        }

        // Filter by criteria
        if (!this.meetsDiscoveryCriteria(pair)) {
          continue;
        }

        // Check token whitelist/blacklist
        if (!this.isTokenAllowed(pair)) {
          continue;
        }

        const discovered = this.createDiscoveredPool(pair);
        
        if (discovered.score >= 50) { // Minimum quality score
          newPools.push(discovered);
          this.discoveredPools.set(discovered.address.toLowerCase(), discovered);
          this.totalDiscovered++;
        }

        if (newPools.length >= this.config.maxNewPoolsPerScan) {
          break;
        }
      }

      // Sort by score
      newPools.sort((a, b) => b.score - a.score);

      const discoverDuration = Date.now() - discoverStart;

      if (newPools.length > 0) {
        logger.info('New trending pairs discovered', {
          count: newPools.length,
          totalDiscovered: this.totalDiscovered,
          topPool: {
            address: newPools[0]?.address,
            pair: `${newPools[0]?.token0.symbol}/${newPools[0]?.token1.symbol}`,
            score: newPools[0]?.score,
            reason: newPools[0]?.reason
          },
          duration: discoverDuration
        });
      } else {
        logger.debug('No new pools discovered', {
          scanned: pairs.length,
          duration: discoverDuration
        });
      }

      return newPools;
    } catch (error) {
      logger.error('Error during discovery', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return [];
    }
  }

  /**
   * Check if pair meets discovery criteria
   */
  private meetsDiscoveryCriteria(pair: DexScreenerPair): boolean {
    // Must have liquidity data
    if (!pair.liquidity || pair.liquidity.usd < this.config.minLiquidityUsd) {
      return false;
    }

    // Must have 24h volume
    if (pair.volume.h24 < this.config.minVolume24hUsd) {
      return false;
    }

    // Must have recent activity (1h volume)
    if (pair.volume.h1 < this.config.minVolume1hUsd) {
      return false;
    }

    // Must have price
    if (!pair.priceUsd || parseFloat(pair.priceUsd) <= 0) {
      return false;
    }

    // Check if pool is not too old (if we want new pools only)
    if (this.config.maxPoolAge > 0 && pair.pairCreatedAt) {
      const ageSeconds = Date.now() / 1000 - pair.pairCreatedAt;
      if (ageSeconds > this.config.maxPoolAge) {
        return false;
      }
    }

    // Must have transaction activity
    const txCount24h = pair.txns.h24.buys + pair.txns.h24.sells;
    if (txCount24h < 50) {
      return false;
    }

    return true;
  }

  /**
   * Check if tokens are allowed
   */
  private isTokenAllowed(pair: DexScreenerPair): boolean {
    const token0 = pair.baseToken.address.toLowerCase();
    const token1 = pair.quoteToken.address.toLowerCase();

    // Check blacklist first
    if (this.config.blacklistedTokens.length > 0) {
      const blacklistedLower = this.config.blacklistedTokens.map(t => t.toLowerCase());
      if (blacklistedLower.includes(token0) || blacklistedLower.includes(token1)) {
        return false;
      }
    }

    // If whitelist is empty, allow all (that aren't blacklisted)
    if (this.config.whitelistedTokens.length === 0) {
      return true;
    }

    // Check if at least one token is whitelisted
    const whitelistedLower = this.config.whitelistedTokens.map(t => t.toLowerCase());
    return whitelistedLower.includes(token0) || whitelistedLower.includes(token1);
  }

  /**
   * Create discovered pool entry
   */
  private createDiscoveredPool(pair: DexScreenerPair): DiscoveredPool {
    const score = this.calculateDiscoveryScore(pair);
    const reason = this.getDiscoveryReason(pair);

    return {
      address: pair.pairAddress,
      dex: pair.dexId,
      token0: {
        address: pair.baseToken.address,
        symbol: pair.baseToken.symbol,
        name: pair.baseToken.name
      },
      token1: {
        address: pair.quoteToken.address,
        symbol: pair.quoteToken.symbol,
        name: pair.quoteToken.name
      },
      liquidity: pair.liquidity?.usd || 0,
      volume24h: pair.volume.h24,
      volume1h: pair.volume.h1,
      priceChange24h: pair.priceChange.h24,
      txCount24h: pair.txns.h24.buys + pair.txns.h24.sells,
      createdAt: pair.pairCreatedAt || 0,
      discoveredAt: Date.now(),
      score,
      reason
    };
  }

  /**
   * Calculate discovery score (0-100)
   */
  private calculateDiscoveryScore(pair: DexScreenerPair): number {
    let score = 0;

    // Liquidity score (max 25 points)
    const liquidity = pair.liquidity?.usd || 0;
    if (liquidity > 10000000) score += 25;
    else if (liquidity > 5000000) score += 20;
    else if (liquidity > 1000000) score += 15;
    else if (liquidity > 500000) score += 10;
    else score += 5;

    // Volume score (max 30 points)
    const volume24h = pair.volume.h24;
    if (volume24h > 10000000) score += 30;
    else if (volume24h > 5000000) score += 25;
    else if (volume24h > 1000000) score += 20;
    else if (volume24h > 500000) score += 15;
    else if (volume24h > 100000) score += 10;
    else score += 5;

    // Recent activity score (max 20 points)
    const volume1h = pair.volume.h1;
    const volumeRatio = volume1h / (volume24h / 24);
    if (volumeRatio > 2) score += 20; // 2x average = high activity
    else if (volumeRatio > 1.5) score += 15;
    else if (volumeRatio > 1) score += 10;
    else score += 5;

    // Transaction count score (max 15 points)
    const txCount = pair.txns.h24.buys + pair.txns.h24.sells;
    if (txCount > 1000) score += 15;
    else if (txCount > 500) score += 12;
    else if (txCount > 200) score += 9;
    else if (txCount > 100) score += 6;
    else score += 3;

    // Price momentum score (max 10 points)
    const priceChange = pair.priceChange.h24;
    const absChange = Math.abs(priceChange);
    if (absChange > 20) score += 10; // High volatility = potential opportunity
    else if (absChange > 10) score += 7;
    else if (absChange > 5) score += 5;
    else score += 3;

    return Math.min(score, 100);
  }

  /**
   * Get discovery reason
   */
  private getDiscoveryReason(pair: DexScreenerPair): string {
    const reasons: string[] = [];

    const liquidity = pair.liquidity?.usd || 0;
    if (liquidity > 5000000) {
      reasons.push('high-liquidity');
    }

    const volume24h = pair.volume.h24;
    if (volume24h > 1000000) {
      reasons.push('high-volume');
    }

    const volume1h = pair.volume.h1;
    const volumeRatio = volume1h / (volume24h / 24);
    if (volumeRatio > 1.5) {
      reasons.push('surging-volume');
    }

    const priceChange = pair.priceChange.h24;
    if (Math.abs(priceChange) > 10) {
      reasons.push('high-volatility');
    }

    const txCount = pair.txns.h24.buys + pair.txns.h24.sells;
    if (txCount > 500) {
      reasons.push('high-activity');
    }

    if (pair.pairCreatedAt && Date.now() / 1000 - pair.pairCreatedAt < 86400) {
      reasons.push('newly-created');
    }

    return reasons.join(', ') || 'meets-criteria';
  }

  /**
   * Get all discovered pools
   */
  getAllDiscovered(): DiscoveredPool[] {
    return Array.from(this.discoveredPools.values());
  }

  /**
   * Get top discovered pools by score
   */
  getTopDiscovered(limit: number): DiscoveredPool[] {
    return this.getAllDiscovered()
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Get recently discovered pools
   */
  getRecentDiscovered(maxAgeMs: number): DiscoveredPool[] {
    const cutoff = Date.now() - maxAgeMs;
    return this.getAllDiscovered()
      .filter(pool => pool.discoveredAt >= cutoff)
      .sort((a, b) => b.discoveredAt - a.discoveredAt);
  }

  /**
   * Check if pool is already discovered
   */
  isDiscovered(address: string): boolean {
    return this.discoveredPools.has(address.toLowerCase());
  }

  /**
   * Get discovery statistics
   */
  getStats(): {
    isDiscovering: boolean;
    totalDiscovered: number;
    cachedPools: number;
    topScore: number;
    avgScore: number;
  } {
    const pools = this.getAllDiscovered();
    const scores = pools.map(p => p.score);
    
    return {
      isDiscovering: this.isDiscovering,
      totalDiscovered: this.totalDiscovered,
      cachedPools: pools.length,
      topScore: Math.max(...scores, 0),
      avgScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
    };
  }

  /**
   * Clear discovered pools cache
   */
  clearCache(): void {
    this.discoveredPools.clear();
    logger.info('Discovery cache cleared');
  }
}
