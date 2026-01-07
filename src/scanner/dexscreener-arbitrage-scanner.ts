/**
 * DexScreener Arbitrage Scanner
 * Detects cross-DEX arbitrage opportunities using DexScreener data
 */

import { DexScreenerMonitor, NormalizedPoolData } from './dexscreener-monitor.js';
import { logger } from '../utils/logger.js';
import type { ArbitrageOpportunity } from '../types/opportunity.js';
import { OpportunityStatus } from '../types/opportunity.js';

export interface ArbitrageScannerConfig {
  minSpreadPercent: number;
  minProfitUsd: number;
  minConfidenceScore: number;
  maxPriceImpactPercent: number;
  scanIntervalMs: number;
}

export interface CrossDexOpportunity {
  type: 'cross-dex';
  tokenPair: string;
  buyPool: {
    address: string;
    dex: string;
    price: number;
    liquidity: number;
  };
  sellPool: {
    address: string;
    dex: string;
    price: number;
    liquidity: number;
  };
  spread: number;
  spreadPercent: number;
  estimatedProfitUsd: number;
  maxTradeSize: number;
  confidenceScore: number;
  timestamp: number;
}

export class DexScreenerArbitrageScanner {
  private readonly monitor: DexScreenerMonitor;
  private readonly config: ArbitrageScannerConfig;
  private scanInterval: NodeJS.Timeout | undefined;
  private isScanning = false;
  private lastScanTime = 0;
  private opportunitiesFound = 0;

  constructor(monitor: DexScreenerMonitor, config: ArbitrageScannerConfig) {
    this.monitor = monitor;
    this.config = config;
  }

  /**
   * Start scanning for arbitrage opportunities
   */
  async start(): Promise<void> {
    if (this.isScanning) {
      logger.warn('DexScreener arbitrage scanner already running');
      return;
    }

    this.isScanning = true;
    logger.info('Starting DexScreener arbitrage scanner', {
      minSpread: this.config.minSpreadPercent,
      minProfit: this.config.minProfitUsd,
      scanInterval: this.config.scanIntervalMs
    });

    // Initial scan
    await this.scan();

    // Set up periodic scanning
    this.scanInterval = setInterval(
      () => this.scan(),
      this.config.scanIntervalMs
    );
  }

  /**
   * Stop scanning
   */
  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }
    this.isScanning = false;
    logger.info('DexScreener arbitrage scanner stopped', {
      totalOpportunities: this.opportunitiesFound
    });
  }

  /**
   * Scan for arbitrage opportunities
   */
  async scan(): Promise<CrossDexOpportunity[]> {
    const scanStart = Date.now();
    this.lastScanTime = scanStart;

    try {
      const pools = this.monitor.getAllPools();

      if (pools.length < 2) {
        logger.debug('Not enough pools for arbitrage detection', {
          poolCount: pools.length
        });
        return [];
      }

      // Group pools by token pair
      const pairGroups = this.groupByTokenPair(pools);

      // Find arbitrage opportunities
      const opportunities: CrossDexOpportunity[] = [];

      for (const [pairKey, poolList] of pairGroups) {
        if (poolList.length < 2) {
          continue; // Need at least 2 pools for cross-DEX arb
        }

        const pairOpportunities = this.findArbitrageInPair(pairKey, poolList);
        opportunities.push(...pairOpportunities);
      }

      // Filter by profitability and confidence
      const profitable = opportunities.filter(opp =>
        opp.estimatedProfitUsd >= this.config.minProfitUsd &&
        opp.confidenceScore >= this.config.minConfidenceScore
      );

      // Sort by estimated profit
      profitable.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);

      const scanDuration = Date.now() - scanStart;
      this.opportunitiesFound += profitable.length;

      if (profitable.length > 0) {
        logger.info('Arbitrage opportunities found', {
          total: opportunities.length,
          profitable: profitable.length,
          bestProfit: profitable[0]?.estimatedProfitUsd,
          scanDuration
        });
      } else {
        logger.debug('No profitable arbitrage opportunities', {
          scannedPairs: pairGroups.size,
          scanDuration
        });
      }

      return profitable;
    } catch (error) {
      logger.error('Error scanning for arbitrage', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return [];
    }
  }

  /**
   * Group pools by token pair
   */
  private groupByTokenPair(pools: NormalizedPoolData[]): Map<string, NormalizedPoolData[]> {
    const groups = new Map<string, NormalizedPoolData[]>();

    for (const pool of pools) {
      // Normalize pair key (alphabetically sorted)
      const tokens = [
        `${pool.token0.symbol}-${pool.token0.address}`,
        `${pool.token1.symbol}-${pool.token1.address}`
      ].sort();
      const pairKey = tokens.join('|');

      if (!groups.has(pairKey)) {
        groups.set(pairKey, []);
      }
      groups.get(pairKey)!.push(pool);
    }

    return groups;
  }

  /**
   * Find arbitrage opportunities within a token pair
   */
  private findArbitrageInPair(
    pairKey: string,
    pools: NormalizedPoolData[]
  ): CrossDexOpportunity[] {
    const opportunities: CrossDexOpportunity[] = [];

    // Compare all pool combinations
    for (let i = 0; i < pools.length; i++) {
      for (let j = i + 1; j < pools.length; j++) {
        const pool1 = pools[i]!;
        const pool2 = pools[j]!;

        // Skip if same DEX
        if (pool1.dex === pool2.dex) {
          continue;
        }

        // Calculate spread
        const price1 = pool1.priceUsd;
        const price2 = pool2.priceUsd;

        if (price1 <= 0 || price2 <= 0) {
          continue;
        }

        const spread = Math.abs(price2 - price1);
        const spreadPercent = (spread / Math.min(price1, price2)) * 100;

        // Check if spread meets minimum
        if (spreadPercent < this.config.minSpreadPercent) {
          continue;
        }

        // Determine buy and sell pools (always defined at this point)
        const isBuyFirst = price1 < price2;
        const buyPool = isBuyFirst ? pool1 : pool2;
        const sellPool = isBuyFirst ? pool2 : pool1;

        // Calculate opportunity metrics
        const maxTradeSize = this.calculateMaxTradeSize(buyPool, sellPool);
        const estimatedProfit = this.estimateProfit(buyPool, sellPool, maxTradeSize);
        const confidence = this.calculateConfidence(buyPool, sellPool);

        opportunities.push({
          type: 'cross-dex',
          tokenPair: pairKey,
          buyPool: {
            address: buyPool.address,
            dex: buyPool.dex,
            price: buyPool.priceUsd,
            liquidity: buyPool.liquidity.usd
          },
          sellPool: {
            address: sellPool.address,
            dex: sellPool.dex,
            price: sellPool.priceUsd,
            liquidity: sellPool.liquidity.usd
          },
          spread,
          spreadPercent,
          estimatedProfitUsd: estimatedProfit,
          maxTradeSize,
          confidenceScore: confidence,
          timestamp: Date.now()
        });
      }
    }

    return opportunities;
  }

  /**
   * Calculate maximum trade size based on liquidity and price impact
   */
  private calculateMaxTradeSize(pool1: NormalizedPoolData, pool2: NormalizedPoolData): number {
    const minLiquidity = Math.min(pool1.liquidity.usd, pool2.liquidity.usd);
    
    // Max trade size is 1% of minimum liquidity to keep price impact low
    const maxByLiquidity = minLiquidity * 0.01;
    
    // Also consider recent volume as a proxy for market depth
    const minVolumeH1 = Math.min(pool1.volume.h1, pool2.volume.h1);
    const maxByVolume = minVolumeH1 * 0.1; // 10% of hourly volume
    
    return Math.min(maxByLiquidity, maxByVolume, 10000); // Cap at $10k
  }

  /**
   * Estimate profit for a given trade size
   */
  private estimateProfit(
    buyPool: NormalizedPoolData,
    sellPool: NormalizedPoolData,
    tradeSize: number
  ): number {
    const buyPrice = buyPool.priceUsd;
    const sellPrice = sellPool.priceUsd;
    
    // Simple profit calculation without price impact
    const grossProfit = (sellPrice - buyPrice) * (tradeSize / buyPrice);
    
    // Estimate fees
    const buyFee = tradeSize * 0.003; // 0.3% typical DEX fee
    const sellFee = (tradeSize + grossProfit) * 0.003;
    const flashLoanFee = 0; // Uniswap V3 flash loans are free
    const gasCostUsd = 0.5; // Estimated gas cost on Base L2
    
    const totalCosts = buyFee + sellFee + flashLoanFee + gasCostUsd;
    const netProfit = grossProfit - totalCosts;
    
    return netProfit;
  }

  /**
   * Calculate confidence score for an opportunity (0-100)
   */
  private calculateConfidence(pool1: NormalizedPoolData, pool2: NormalizedPoolData): number {
    let score = 0;

    // Liquidity score (max 30 points)
    const minLiquidity = Math.min(pool1.liquidity.usd, pool2.liquidity.usd);
    if (minLiquidity > 5000000) score += 30;
    else if (minLiquidity > 1000000) score += 25;
    else if (minLiquidity > 500000) score += 20;
    else if (minLiquidity > 100000) score += 15;
    else score += 10;

    // Volume score (max 30 points)
    const minVolumeH1 = Math.min(pool1.volume.h1, pool2.volume.h1);
    if (minVolumeH1 > 500000) score += 30;
    else if (minVolumeH1 > 100000) score += 25;
    else if (minVolumeH1 > 50000) score += 20;
    else if (minVolumeH1 > 10000) score += 15;
    else score += 10;

    // Transaction activity score (max 20 points)
    const minTxns = Math.min(
      pool1.txns.h1.buys + pool1.txns.h1.sells,
      pool2.txns.h1.buys + pool2.txns.h1.sells
    );
    if (minTxns > 500) score += 20;
    else if (minTxns > 200) score += 15;
    else if (minTxns > 100) score += 10;
    else score += 5;

    // Price stability score (max 20 points)
    const maxVolatility = Math.max(
      Math.abs(pool1.priceChange.h1),
      Math.abs(pool2.priceChange.h1)
    );
    if (maxVolatility < 0.5) score += 20;
    else if (maxVolatility < 1) score += 15;
    else if (maxVolatility < 2) score += 10;
    else if (maxVolatility < 5) score += 5;

    return Math.min(score, 100);
  }

  /**
   * Convert to standard ArbitrageOpportunity format
   */
  toArbitrageOpportunity(crossDex: CrossDexOpportunity): ArbitrageOpportunity {
    const now = Date.now();
    const expectedProfit = BigInt(Math.floor(crossDex.estimatedProfitUsd * 1e6));
    const gasEstimate = BigInt(300000);
    const flashFee = BigInt(0); // Uniswap V3 flash loans are free
    
    return {
      id: `dexscreener-${now}-${Math.random().toString(36).slice(2)}`,
      type: 'arbitrage',
      timestamp: crossDex.timestamp,
      status: OpportunityStatus.DETECTED,
      
      // Tokens
      tokenIn: crossDex.buyPool.address as `0x${string}`,
      tokenOut: crossDex.sellPool.address as `0x${string}`,
      amountIn: BigInt(Math.floor(crossDex.maxTradeSize * 1e6)),
      expectedAmountOut: BigInt(Math.floor(crossDex.maxTradeSize * 1e6 * (1 + crossDex.spreadPercent / 100))),
      
      // Arbitrage specific
      sourcePool: crossDex.buyPool.address as `0x${string}`,
      targetPool: crossDex.sellPool.address as `0x${string}`,
      sourceDex: crossDex.buyPool.dex,
      targetDex: crossDex.sellPool.dex,
      spread: Math.floor(crossDex.spreadPercent * 100), // Convert to basis points
      spreadAfterCosts: Math.floor((crossDex.estimatedProfitUsd / crossDex.maxTradeSize) * 10000),
      
      // Route
      route: {
        pools: [crossDex.buyPool.address as `0x${string}`, crossDex.sellPool.address as `0x${string}`],
        fees: [3000, 3000], // Default 0.3%
        directions: [true, true],
        expectedGas: 300000,
        priceImpact: Math.floor(this.config.maxPriceImpactPercent * 100)
      },
      fallbackRoutes: [],
      
      // Profitability
      flashFee,
      gasEstimate,
      expectedProfit,
      minProfit: BigInt(Math.floor(this.config.minProfitUsd * 1e6)),
      profitMargin: (crossDex.estimatedProfitUsd / crossDex.maxTradeSize) * 100,
      
      // Execution parameters
      slippageTolerance: this.config.maxPriceImpactPercent / 100,
      deadline: Math.floor(now / 1000) + 60,
      maxBribe: BigInt(0),
      priority: Math.min(10, Math.floor(crossDex.confidenceScore / 10)),
      
      // Metadata
      detectedAt: now,
      expiresAt: now + 30000, // 30 seconds
      source: 'dexscreener'
    };
  }

  /**
   * Get scanner statistics
   */
  getStats(): {
    isScanning: boolean;
    lastScanTime: number;
    opportunitiesFound: number;
    config: ArbitrageScannerConfig;
  } {
    return {
      isScanning: this.isScanning,
      lastScanTime: this.lastScanTime,
      opportunitiesFound: this.opportunitiesFound,
      config: this.config
    };
  }
}
