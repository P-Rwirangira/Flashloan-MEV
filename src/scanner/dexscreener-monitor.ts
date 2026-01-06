/**
 * DexScreener Pool Monitor
 * Monitors pools and normalizes data for arbitrage detection
 */

import { DexScreenerClient, DexScreenerPair } from './dexscreener-client.js';
import { logger } from '../utils/logger.js';

export interface DexScreenerMonitorConfig {
  chain: string;
  poolAddresses: string[];
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  updateIntervalMs: number;
  enableAutoDiscovery: boolean;
  maxStaleDataMs: number;
}

export interface NormalizedPoolData {
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
  priceUsd: number;
  priceNative: number;
  liquidity: {
    usd: number;
    base: number;
    quote: number;
  };
  volume: {
    h1: number;
    h6: number;
    h24: number;
    m5: number;
  };
  txns: {
    h1: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  priceChange: {
    h1: number;
    h6: number;
    h24: number;
  };
  lastUpdate: number;
  source: 'dexscreener';
}

export class DexScreenerMonitor {
  private readonly client: DexScreenerClient;
  private readonly config: DexScreenerMonitorConfig;
  private poolCache = new Map<string, NormalizedPoolData>();
  private monitoringInterval: NodeJS.Timeout | undefined;
  private isMonitoring = false;

  constructor(client: DexScreenerClient, config: DexScreenerMonitorConfig) {
    this.client = client;
    this.config = config;
  }

  /**
   * Start monitoring pools
   */
  async start(): Promise<void> {
    if (this.isMonitoring) {
      logger.warn('DexScreener monitor already running');
      return;
    }

    this.isMonitoring = true;
    logger.info('Starting DexScreener monitor', {
      chain: this.config.chain,
      pools: this.config.poolAddresses.length,
      updateInterval: this.config.updateIntervalMs
    });

    // Initial fetch
    await this.updatePools();

    // Set up periodic updates
    this.monitoringInterval = setInterval(
      () => this.updatePools(),
      this.config.updateIntervalMs
    );
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
    this.isMonitoring = false;
    logger.info('DexScreener monitor stopped');
  }

  /**
   * Update all monitored pools
   */
  private async updatePools(): Promise<void> {
    try {
      const pairs = await this.client.fetchPairs(
        this.config.chain,
        this.config.poolAddresses
      );

      let updated = 0;
      let filtered = 0;

      for (const pair of pairs) {
        // Filter by quality criteria
        if (!this.meetsQualityCriteria(pair)) {
          filtered++;
          continue;
        }

        const normalized = this.normalizePairData(pair);
        this.poolCache.set(normalized.address.toLowerCase(), normalized);
        updated++;
      }

      logger.debug('Updated pools from DexScreener', {
        total: pairs.length,
        updated,
        filtered,
        cached: this.poolCache.size
      });
    } catch (error) {
      logger.error('Failed to update pools from DexScreener', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get pool data by address
   */
  getPool(address: string): NormalizedPoolData | null {
    const pool = this.poolCache.get(address.toLowerCase());
    
    if (!pool) {
      return null;
    }

    // Check if data is stale
    const age = Date.now() - pool.lastUpdate;
    if (age > this.config.maxStaleDataMs) {
      logger.warn('Pool data is stale', { address, age });
      return null;
    }

    return pool;
  }

  /**
   * Get all monitored pools
   */
  getAllPools(): NormalizedPoolData[] {
    return Array.from(this.poolCache.values()).filter(pool => {
      const age = Date.now() - pool.lastUpdate;
      return age <= this.config.maxStaleDataMs;
    });
  }

  /**
   * Get pools by token
   */
  getPoolsByToken(tokenAddress: string): NormalizedPoolData[] {
    const lowerToken = tokenAddress.toLowerCase();
    return this.getAllPools().filter(pool =>
      pool.token0.address.toLowerCase() === lowerToken ||
      pool.token1.address.toLowerCase() === lowerToken
    );
  }

  /**
   * Get pools by token pair
   */
  getPoolsByPair(token0: string, token1: string): NormalizedPoolData[] {
    const lower0 = token0.toLowerCase();
    const lower1 = token1.toLowerCase();
    
    return this.getAllPools().filter(pool => {
      const poolToken0 = pool.token0.address.toLowerCase();
      const poolToken1 = pool.token1.address.toLowerCase();
      
      return (
        (poolToken0 === lower0 && poolToken1 === lower1) ||
        (poolToken0 === lower1 && poolToken1 === lower0)
      );
    });
  }

  /**
   * Add pool to monitoring list
   */
  addPool(address: string): void {
    const lower = address.toLowerCase();
    if (!this.config.poolAddresses.includes(lower)) {
      this.config.poolAddresses.push(lower);
      logger.info('Added pool to DexScreener monitor', { address });
    }
  }

  /**
   * Remove pool from monitoring
   */
  removePool(address: string): void {
    const lower = address.toLowerCase();
    const index = this.config.poolAddresses.indexOf(lower);
    if (index !== -1) {
      this.config.poolAddresses.splice(index, 1);
      this.poolCache.delete(lower);
      logger.info('Removed pool from DexScreener monitor', { address });
    }
  }

  /**
   * Check if pool meets quality criteria
   */
  private meetsQualityCriteria(pair: DexScreenerPair): boolean {
    // Must have liquidity data
    if (!pair.liquidity || pair.liquidity.usd < this.config.minLiquidityUsd) {
      return false;
    }

    // Must have 24h volume
    if (pair.volume.h24 < this.config.minVolume24hUsd) {
      return false;
    }

    // Must have price
    if (!pair.priceUsd || parseFloat(pair.priceUsd) <= 0) {
      return false;
    }

    return true;
  }

  /**
   * Normalize DexScreener pair data
   */
  private normalizePairData(pair: DexScreenerPair): NormalizedPoolData {
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
      priceUsd: parseFloat(pair.priceUsd || '0'),
      priceNative: parseFloat(pair.priceNative),
      liquidity: {
        usd: pair.liquidity?.usd || 0,
        base: pair.liquidity?.base || 0,
        quote: pair.liquidity?.quote || 0
      },
      volume: {
        h1: pair.volume.h1,
        h6: pair.volume.h6,
        h24: pair.volume.h24,
        m5: pair.volume.m5
      },
      txns: {
        h1: pair.txns.h1,
        h24: pair.txns.h24
      },
      priceChange: {
        h1: pair.priceChange.h1,
        h6: pair.priceChange.h6,
        h24: pair.priceChange.h24
      },
      lastUpdate: Date.now(),
      source: 'dexscreener'
    };
  }


  /**
   * Get monitor statistics
   */
  getStats(): {
    isMonitoring: boolean;
    totalPools: number;
    activePools: number;
    stalePools: number;
    avgLiquidity: number;
    avgVolume24h: number;
  } {
    const allPools = Array.from(this.poolCache.values());
    const now = Date.now();
    
    const activePools = allPools.filter(
      p => now - p.lastUpdate <= this.config.maxStaleDataMs
    );
    
    const stalePools = allPools.length - activePools.length;
    
    const avgLiquidity = activePools.length > 0
      ? activePools.reduce((sum, p) => sum + p.liquidity.usd, 0) / activePools.length
      : 0;
    
    const avgVolume24h = activePools.length > 0
      ? activePools.reduce((sum, p) => sum + p.volume.h24, 0) / activePools.length
      : 0;

    return {
      isMonitoring: this.isMonitoring,
      totalPools: this.config.poolAddresses.length,
      activePools: activePools.length,
      stalePools,
      avgLiquidity,
      avgVolume24h
    };
  }
}
