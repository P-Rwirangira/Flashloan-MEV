/**
 * Multi-Hop Arbitrage Analysis Tool
 * Analyzes and validates multi-hop opportunities to identify real vs fake profits
 */

import { DexScreenerMonitor, NormalizedPoolData } from '../scanner/dexscreener-monitor.js';
import { logger } from '../utils/logger.js';

export interface MultiHopAnalysis {
  pathDescription: string;
  inputAmount: number;
  expectedOutput: number;
  actualOutput: number;
  realProfit: number;
  fakeProfit: number;
  profitDiscrepancy: number;
  issues: string[];
  isViable: boolean;
}

export class MultiHopAnalyzer {
  
  /**
   * Analyze a multi-hop path to determine real vs fake profitability
   */
  static analyzePath(
    pools: NormalizedPoolData[],
    startAmount: number = 1000 // $1000 test trade
  ): MultiHopAnalysis {
    const issues: string[] = [];
    const pathTokens: string[] = [];
    
    // Build path description
    const pathDescription = pools.map((pool, i) => {
      if (i === 0) {
        pathTokens.push(pool.token0.symbol, pool.token1.symbol);
        return `${pool.token0.symbol}→${pool.token1.symbol} (${pool.dex})`;
      } else {
        const prevPool = pools[i-1]!;
        const prevToken1 = prevPool.token1.symbol;
        
        // Determine which token we're trading to
        const nextToken = pool.token0.symbol === prevToken1 
          ? pool.token1.symbol 
          : pool.token0.symbol;
        
        pathTokens.push(nextToken);
        return `${prevToken1}→${nextToken} (${pool.dex})`;
      }
    }).join(' → ');

    // Calculate using DexScreener prices (WRONG METHOD)
    let fakeAmount = startAmount;
    for (const pool of pools) {
      // This is what the current scanner does (WRONG!)
      fakeAmount *= pool.priceUsd;
    }
    const fakeProfit = fakeAmount - startAmount;

    // Calculate using realistic exchange rates
    let realAmount = startAmount;
    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i]!;
      
      // Estimate real exchange rate from liquidity data
      const realExchangeRate = this.estimateRealExchangeRate(pool);
      
      if (realExchangeRate === null) {
        issues.push(`Cannot determine real exchange rate for ${pool.token0.symbol}/${pool.token1.symbol}`);
        realAmount = 0;
        break;
      }
      
      // Apply slippage based on trade size vs liquidity
      const slippage = this.calculateSlippage(realAmount, pool.liquidity.usd);
      const effectiveRate = realExchangeRate * (1 - slippage);
      
      realAmount *= effectiveRate;
      
      // Check for unrealistic rates
      if (effectiveRate > 10000 || effectiveRate < 0.0001) {
        issues.push(`Unrealistic exchange rate: ${effectiveRate} for ${pool.dex}`);
      }
    }

    // Calculate fees (0.3% per hop)
    const totalFees = pools.length * startAmount * 0.003;
    const realProfit = realAmount - startAmount - totalFees;
    
    // Gas costs
    const gasCost = 0.5 + (pools.length * 0.2); // Base + per hop
    const netRealProfit = realProfit - gasCost;

    // Validate path makes sense
    if (pathTokens.length > 0) {
      const startToken = pathTokens[0];
      const endToken = pathTokens[pathTokens.length - 1];
      
      if (startToken !== endToken) {
        issues.push(`Path doesn't return to start token: ${startToken} → ${endToken}`);
      }
    }

    // Check for common issues
    if (pools.length > 4) {
      issues.push(`Path too long (${pools.length} hops) - gas costs will be prohibitive`);
    }

    if (fakeProfit > startAmount * 0.1) {
      issues.push(`Fake profit too high (${(fakeProfit/startAmount*100).toFixed(1)}%) - likely calculation error`);
    }

    const profitDiscrepancy = Math.abs(fakeProfit - realProfit);
    const isViable = netRealProfit > 5 && issues.length === 0;

    return {
      pathDescription,
      inputAmount: startAmount,
      expectedOutput: fakeAmount,
      actualOutput: realAmount,
      realProfit: netRealProfit,
      fakeProfit,
      profitDiscrepancy,
      issues,
      isViable
    };
  }

  /**
   * Estimate real exchange rate from pool data
   */
  private static estimateRealExchangeRate(pool: NormalizedPoolData): number | null {
    // Without actual reserves, we can only estimate
    // This is a major limitation of using DexScreener data
    
    // For stablecoin pairs, rate should be close to 1
    const isStablePair = this.isStablecoinPair(pool);
    if (isStablePair) {
      return 1.0 + (Math.random() - 0.5) * 0.01; // ±0.5% variation
    }
    
    // For other pairs, use a more conservative estimate
    // Real rate is usually close to but not exactly the USD price ratio
    const token0Price = pool.priceUsd;
    const token1Price = this.estimateToken1Price(pool);
    
    if (token1Price === null) {
      return null;
    }
    
    return token0Price / token1Price;
  }

  /**
   * Estimate token1 price (this is a major limitation!)
   */
  private static estimateToken1Price(pool: NormalizedPoolData): number | null {
    // This is where the fundamental problem lies:
    // DexScreener only gives us token0 (base) price, not token1 (quote) price
    // We have to guess or use external data
    
    const token1Symbol = pool.token1.symbol.toUpperCase();
    
    // Known stablecoin prices
    if (['USDC', 'USDT', 'DAI', 'USDBC'].includes(token1Symbol)) {
      return 1.0;
    }
    
    // Known token prices (would need real price feed)
    const knownPrices: Record<string, number> = {
      'WETH': 3240, // Would need real-time price
      'CBETH': 3180,
      'CBBTC': 95000,
    };
    
    return knownPrices[token1Symbol] || null;
  }

  /**
   * Check if pair is stablecoin pair
   */
  private static isStablecoinPair(pool: NormalizedPoolData): boolean {
    const stablecoins = ['USDC', 'USDT', 'DAI', 'USDBC', 'FRAX'];
    const token0 = pool.token0.symbol.toUpperCase();
    const token1 = pool.token1.symbol.toUpperCase();
    
    return stablecoins.includes(token0) && stablecoins.includes(token1);
  }

  /**
   * Calculate slippage based on trade size vs liquidity
   */
  private static calculateSlippage(tradeSize: number, liquidityUsd: number): number {
    // Simple slippage model: slippage = (tradeSize / liquidity)^0.5 * 0.01
    const ratio = tradeSize / liquidityUsd;
    return Math.min(Math.sqrt(ratio) * 0.01, 0.05); // Cap at 5%
  }

  /**
   * Analyze all current multi-hop opportunities
   */
  static async analyzeCurrentOpportunities(monitor: DexScreenerMonitor): Promise<MultiHopAnalysis[]> {
    const pools = monitor.getAllPools();
    const analyses: MultiHopAnalysis[] = [];
    
    // Simulate some multi-hop paths (simplified)
    for (let i = 0; i < Math.min(pools.length - 1, 5); i++) {
      for (let j = i + 1; j < Math.min(pools.length, i + 3); j++) {
        const path = [pools[i]!, pools[j]!];
        const analysis = this.analyzePath(path);
        analyses.push(analysis);
      }
    }
    
    return analyses.sort((a, b) => b.realProfit - a.realProfit);
  }
}

/**
 * Run multi-hop analysis and log results
 */
export async function runMultiHopAnalysis(monitor: DexScreenerMonitor): Promise<void> {
  logger.info('🔍 Starting Multi-Hop Arbitrage Analysis');
  
  const analyses = await MultiHopAnalyzer.analyzeCurrentOpportunities(monitor);
  
  logger.info('📊 Multi-Hop Analysis Results', {
    totalPaths: analyses.length,
    viablePaths: analyses.filter(a => a.isViable).length,
    avgFakeProfit: analyses.reduce((sum, a) => sum + a.fakeProfit, 0) / analyses.length,
    avgRealProfit: analyses.reduce((sum, a) => sum + a.realProfit, 0) / analyses.length
  });
  
  // Log top 3 opportunities
  for (let i = 0; i < Math.min(3, analyses.length); i++) {
    const analysis = analyses[i]!;
    
    logger.info(`🎯 Multi-Hop Opportunity #${i + 1}`, {
      path: analysis.pathDescription,
      fakeProfit: `$${analysis.fakeProfit.toFixed(2)}`,
      realProfit: `$${analysis.realProfit.toFixed(2)}`,
      discrepancy: `$${analysis.profitDiscrepancy.toFixed(2)}`,
      viable: analysis.isViable,
      issues: analysis.issues
    });
  }
  
  // Summary of issues
  const allIssues = analyses.flatMap(a => a.issues);
  const issueCount = allIssues.reduce((acc, issue) => {
    acc[issue] = (acc[issue] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  logger.warn('⚠️ Common Multi-Hop Issues Found', issueCount);
}