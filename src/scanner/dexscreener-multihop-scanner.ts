/**
 * DexScreener Multi-Hop Arbitrage Scanner
 * Detects multi-hop arbitrage opportunities across multiple pools
 */

import { DexScreenerMonitor, NormalizedPoolData } from './dexscreener-monitor.js';
import { logger } from '../utils/logger.js';
import type { ArbitrageOpportunity } from '../types/opportunity.js';
import { OpportunityStatus } from '../types/opportunity.js';

export interface MultiHopConfig {
  maxHops: number;
  minSpreadPercent: number;
  minProfitUsd: number;
  minConfidenceScore: number;
  maxPriceImpactPercent: number;
  scanIntervalMs: number;
  enabledTokens: string[];
}

export interface MultiHopPath {
  pools: NormalizedPoolData[];
  tokens: string[];
  buyPrice: number;
  sellPrice: number;
  spread: number;
  spreadPercent: number;
  estimatedProfitUsd: number;
  maxTradeSize: number;
  confidenceScore: number;
  priceImpact: number;
}

export interface MultiHopOpportunity {
  type: 'multi-hop';
  path: MultiHopPath;
  hops: number;
  totalGas: number;
  netProfitUsd: number;
  timestamp: number;
}

export class DexScreenerMultiHopScanner {
  private readonly monitor: DexScreenerMonitor;
  private readonly config: MultiHopConfig;
  private scanInterval: NodeJS.Timeout | undefined;
  private isScanning = false;
  private lastScanTime = 0;
  private opportunitiesFound = 0;

  constructor(monitor: DexScreenerMonitor, config: MultiHopConfig) {
    this.monitor = monitor;
    this.config = config;
  }

  /**
   * Start scanning for multi-hop opportunities
   */
  async start(): Promise<void> {
    if (this.isScanning) {
      logger.warn('Multi-hop scanner already running');
      return;
    }

    this.isScanning = true;
    logger.info('Starting multi-hop arbitrage scanner', {
      maxHops: this.config.maxHops,
      minSpread: this.config.minSpreadPercent,
      minProfit: this.config.minProfitUsd
    });

    await this.scan();

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
    logger.info('Multi-hop scanner stopped', {
      totalOpportunities: this.opportunitiesFound
    });
  }

  /**
   * Scan for multi-hop arbitrage opportunities
   */
  async scan(): Promise<MultiHopOpportunity[]> {
    const scanStart = Date.now();
    this.lastScanTime = scanStart;

    try {
      const pools = this.monitor.getAllPools();

      if (pools.length < 2) {
        logger.debug('Not enough pools for multi-hop', { poolCount: pools.length });
        return [];
      }

      // Build token graph
      const graph = this.buildTokenGraph(pools);

      // Find profitable paths for each enabled token
      const opportunities: MultiHopOpportunity[] = [];

      for (const startToken of this.config.enabledTokens) {
        const paths = this.findArbitragePaths(graph, startToken, this.config.maxHops);
        
        for (const path of paths) {
          const opportunity = this.evaluatePath(path);
          if (opportunity) {
            opportunities.push(opportunity);
          }
        }
      }

      // Filter by profitability
      const profitable = opportunities.filter(opp =>
        opp.netProfitUsd >= this.config.minProfitUsd &&
        opp.path.confidenceScore >= this.config.minConfidenceScore
      );

      profitable.sort((a, b) => b.netProfitUsd - a.netProfitUsd);

      const scanDuration = Date.now() - scanStart;
      this.opportunitiesFound += profitable.length;

      if (profitable.length > 0) {
        logger.info('Multi-hop opportunities found', {
          total: opportunities.length,
          profitable: profitable.length,
          bestProfit: profitable[0]?.netProfitUsd,
          scanDuration
        });
      } else {
        logger.debug('No profitable multi-hop opportunities', {
          scannedTokens: this.config.enabledTokens.length,
          scanDuration
        });
      }

      return profitable;
    } catch (error) {
      logger.error('Error scanning for multi-hop arbitrage', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return [];
    }
  }

  /**
   * Build token adjacency graph
   */
  private buildTokenGraph(pools: NormalizedPoolData[]): Map<string, NormalizedPoolData[]> {
    const graph = new Map<string, NormalizedPoolData[]>();

    for (const pool of pools) {
      const token0 = pool.token0.address.toLowerCase();
      const token1 = pool.token1.address.toLowerCase();

      // Add edges for both directions
      if (!graph.has(token0)) {
        graph.set(token0, []);
      }
      if (!graph.has(token1)) {
        graph.set(token1, []);
      }

      graph.get(token0)!.push(pool);
      graph.get(token1)!.push(pool);
    }

    return graph;
  }

  /**
   * Find all arbitrage paths starting from a token
   */
  private findArbitragePaths(
    graph: Map<string, NormalizedPoolData[]>,
    startToken: string,
    maxHops: number
  ): MultiHopPath[] {
    const paths: MultiHopPath[] = [];
    const startTokenLower = startToken.toLowerCase();

    // DFS to find cycles back to start token
    const visited = new Set<string>();
    const currentPath: NormalizedPoolData[] = [];
    const currentTokens: string[] = [startTokenLower];

    const dfs = (token: string, depth: number) => {
      if (depth > maxHops) {
        return;
      }

      // Check if we can return to start token
      if (depth > 1 && token === startTokenLower) {
        const path = this.constructPath(currentPath, currentTokens);
        if (path && path.spreadPercent > this.config.minSpreadPercent) {
          paths.push(path);
        }
        return;
      }

      if (depth >= maxHops) {
        return;
      }

      const edges = graph.get(token);
      if (!edges) {
        return;
      }

      for (const pool of edges) {
        // Determine next token
        const nextToken = pool.token0.address.toLowerCase() === token
          ? pool.token1.address.toLowerCase()
          : pool.token0.address.toLowerCase();

        // Skip if we've already visited this pool
        const poolId = pool.address.toLowerCase();
        if (visited.has(poolId)) {
          continue;
        }

        // Skip if price is invalid
        if (pool.priceUsd <= 0) {
          continue;
        }

        visited.add(poolId);
        currentPath.push(pool);
        currentTokens.push(nextToken);

        dfs(nextToken, depth + 1);

        currentTokens.pop();
        currentPath.pop();
        visited.delete(poolId);
      }
    };

    dfs(startTokenLower, 0);

    return paths;
  }

  /**
   * Construct path details from pool sequence
   */
  private constructPath(
    pools: NormalizedPoolData[],
    tokens: string[]
  ): MultiHopPath | null {
    if (pools.length === 0) {
      return null;
    }

    // Calculate cumulative price
    let price = 1;
    let minLiquidity = Infinity;
    let totalVolume = 0;

    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i]!;
      const currentToken = tokens[i]!.toLowerCase();

      // Determine if we're buying token0 or token1
      const buyingToken0 = currentToken === pool.token1.address.toLowerCase();
      
      // Apply price (simplified - assumes priceUsd is for token0)
      if (buyingToken0) {
        price *= pool.priceUsd;
      } else {
        price /= pool.priceUsd;
      }

      minLiquidity = Math.min(minLiquidity, pool.liquidity.usd);
      totalVolume += pool.volume.h1;
    }

    // Calculate spread (should be positive for profitable arb)
    const spread = price - 1;
    const spreadPercent = spread * 100;

    if (spreadPercent <= 0) {
      return null;
    }

    // Calculate max trade size
    const maxTradeSize = this.calculateMaxTradeSize(pools, minLiquidity);

    // Calculate estimated profit
    const estimatedProfit = this.estimateMultiHopProfit(pools, maxTradeSize, spreadPercent);

    // Calculate confidence
    const confidence = this.calculateMultiHopConfidence(pools, totalVolume, minLiquidity);

    // Calculate price impact
    const priceImpact = this.estimatePriceImpact(pools, maxTradeSize);

    return {
      pools,
      tokens,
      buyPrice: 1,
      sellPrice: price,
      spread,
      spreadPercent,
      estimatedProfitUsd: estimatedProfit,
      maxTradeSize,
      confidenceScore: confidence,
      priceImpact
    };
  }

  /**
   * Calculate maximum trade size for multi-hop path
   */
  private calculateMaxTradeSize(pools: NormalizedPoolData[], minLiquidity: number): number {
    // Conservative: 0.5% of minimum liquidity
    const maxByLiquidity = minLiquidity * 0.005;
    
    // Also check hourly volume
    const minVolumeH1 = Math.min(...pools.map(p => p.volume.h1));
    const maxByVolume = minVolumeH1 * 0.05;
    
    return Math.min(maxByLiquidity, maxByVolume, 5000); // Cap at $5k for multi-hop
  }

  /**
   * Estimate profit for multi-hop path
   */
  private estimateMultiHopProfit(
    pools: NormalizedPoolData[],
    tradeSize: number,
    spreadPercent: number
  ): number {
    const grossProfit = tradeSize * (spreadPercent / 100);
    
    // Fee per hop (0.3% typical)
    const totalFees = pools.length * tradeSize * 0.003;
    
    // Flash loan fee (free for Uniswap V3)
    const flashLoanFee = 0;
    
    // Gas cost increases with hops
    const gasCostUsd = 0.5 + (pools.length * 0.2);
    
    const netProfit = grossProfit - totalFees - flashLoanFee - gasCostUsd;
    
    return netProfit;
  }

  /**
   * Calculate confidence score for multi-hop path
   */
  private calculateMultiHopConfidence(
    pools: NormalizedPoolData[],
    totalVolume: number,
    minLiquidity: number
  ): number {
    let score = 0;

    // Liquidity score (max 25 points)
    if (minLiquidity > 1000000) score += 25;
    else if (minLiquidity > 500000) score += 20;
    else if (minLiquidity > 100000) score += 15;
    else score += 10;

    // Volume score (max 25 points)
    if (totalVolume > 1000000) score += 25;
    else if (totalVolume > 500000) score += 20;
    else if (totalVolume > 100000) score += 15;
    else score += 10;

    // Path length penalty (max 20 points)
    const hops = pools.length;
    if (hops === 2) score += 20; // Prefer shorter paths
    else if (hops === 3) score += 15;
    else if (hops === 4) score += 10;
    else score += 5;

    // Pool quality score (max 30 points)
    const avgTxns = pools.reduce((sum, p) => 
      sum + p.txns.h1.buys + p.txns.h1.sells, 0) / pools.length;
    if (avgTxns > 300) score += 30;
    else if (avgTxns > 150) score += 20;
    else if (avgTxns > 50) score += 10;
    else score += 5;

    return Math.min(score, 100);
  }

  /**
   * Estimate price impact for multi-hop path
   */
  private estimatePriceImpact(pools: NormalizedPoolData[], tradeSize: number): number {
    let totalImpact = 0;

    for (const pool of pools) {
      // Rough estimate: impact = tradeSize / liquidity * 100
      const impact = (tradeSize / pool.liquidity.usd) * 100;
      totalImpact += impact;
    }

    return totalImpact;
  }

  /**
   * Evaluate path and create opportunity
   */
  private evaluatePath(path: MultiHopPath): MultiHopOpportunity | null {
    // Check price impact
    if (path.priceImpact > this.config.maxPriceImpactPercent) {
      return null;
    }

    // Calculate total gas
    const totalGas = 200000 + (path.pools.length * 100000); // Base + per hop

    // Calculate net profit
    const netProfit = path.estimatedProfitUsd;

    if (netProfit < this.config.minProfitUsd) {
      return null;
    }

    return {
      type: 'multi-hop',
      path,
      hops: path.pools.length,
      totalGas,
      netProfitUsd: netProfit,
      timestamp: Date.now()
    };
  }

  /**
   * Convert to standard ArbitrageOpportunity format
   */
  toArbitrageOpportunity(multiHop: MultiHopOpportunity): ArbitrageOpportunity {
    const now = Date.now();
    const path = multiHop.path;
    const firstPool = path.pools[0]!;
    const lastPool = path.pools[path.pools.length - 1]!;
    
    return {
      id: `multihop-${now}-${Math.random().toString(36).slice(2)}`,
      type: 'arbitrage',
      timestamp: now,
      status: OpportunityStatus.DETECTED,
      
      // Tokens
      tokenIn: path.tokens[0] as `0x${string}`,
      tokenOut: path.tokens[path.tokens.length - 1] as `0x${string}`,
      amountIn: BigInt(Math.floor(path.maxTradeSize * 1e6)),
      expectedAmountOut: BigInt(Math.floor(path.maxTradeSize * 1e6 * (1 + path.spreadPercent / 100))),
      
      // Arbitrage specific
      sourcePool: firstPool.address as `0x${string}`,
      targetPool: lastPool.address as `0x${string}`,
      sourceDex: firstPool.dex,
      targetDex: lastPool.dex,
      spread: Math.floor(path.spreadPercent * 100),
      spreadAfterCosts: Math.floor((multiHop.netProfitUsd / path.maxTradeSize) * 10000),
      
      // Route
      route: {
        pools: path.pools.map(p => p.address as `0x${string}`),
        fees: path.pools.map(() => 3000), // Default 0.3%
        directions: path.pools.map(() => true),
        expectedGas: multiHop.totalGas,
        priceImpact: Math.floor(path.priceImpact * 100)
      },
      fallbackRoutes: [],
      
      // Profitability
      flashFee: BigInt(0),
      gasEstimate: BigInt(multiHop.totalGas),
      expectedProfit: BigInt(Math.floor(multiHop.netProfitUsd * 1e6)),
      minProfit: BigInt(Math.floor(this.config.minProfitUsd * 1e6)),
      profitMargin: (multiHop.netProfitUsd / path.maxTradeSize) * 100,
      
      // Execution parameters
      slippageTolerance: this.config.maxPriceImpactPercent / 100,
      deadline: Math.floor(now / 1000) + 60,
      maxBribe: BigInt(0),
      priority: Math.min(10, Math.floor(path.confidenceScore / 10)),
      
      // Metadata
      detectedAt: now,
      expiresAt: now + 20000, // 20 seconds (shorter for multi-hop)
      source: 'dexscreener-multihop'
    };
  }

  /**
   * Get scanner statistics
   */
  getStats(): {
    isScanning: boolean;
    lastScanTime: number;
    opportunitiesFound: number;
    config: MultiHopConfig;
  } {
    return {
      isScanning: this.isScanning,
      lastScanTime: this.lastScanTime,
      opportunitiesFound: this.opportunitiesFound,
      config: this.config
    };
  }
}
