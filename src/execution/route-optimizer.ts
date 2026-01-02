/**
 * Advanced Route Optimization System
 *
 * Discovers optimal multi-hop arbitrage routes up to 4 hops
 * with gas cost consideration and liquidity depth analysis
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createComponentLogger } from '../utils/logger';
import { Address } from '../types/common';
import { DEXInfo, PoolInfo } from '../types/dex';

export interface RouteOptimizerConfig {
  readonly maxHops: number;
  readonly maxRoutesToEvaluate: number;
  readonly minProfitThresholdUsd: number;
  readonly gasPrice: bigint;
  readonly slippageTolerance: number;
  readonly cacheExpirationMs: number;
  readonly liquidityDepthThreshold: number;
  readonly executionProbabilityThreshold: number;
}

export interface ArbitrageRoute {
  readonly id: string;
  readonly path: Address[];
  readonly pools: PoolInfo[];
  readonly dexes: DEXInfo[];
  readonly inputToken: Address;
  readonly outputToken: Address;
  readonly inputAmount: bigint;
  readonly expectedOutput: bigint;
  readonly minOutput: bigint;
  readonly gasEstimate: bigint;
  readonly gasCost: bigint;
  readonly grossProfit: bigint;
  readonly netProfit: bigint;
  readonly profitUsd: number;
  readonly executionProbability: number;
  readonly liquidityScore: number;
  readonly routeType: 'simple' | 'triangular' | 'complex';
  readonly hops: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface RouteDiscoveryRequest {
  readonly inputToken: Address;
  readonly outputToken?: Address; // Optional for triangular arbitrage
  readonly inputAmount: bigint;
  readonly maxHops: number;
  readonly includeTriangular: boolean;
  readonly minProfitUsd: number;
  readonly urgency: 'low' | 'medium' | 'high';
}

export interface RouteOptimizationResult {
  readonly request: RouteDiscoveryRequest;
  readonly routes: ArbitrageRoute[];
  readonly bestRoute: ArbitrageRoute | null;
  readonly totalRoutesEvaluated: number;
  readonly optimizationTimeMs: number;
  readonly cacheHits: number;
  readonly discoveredAt: number;
}

export interface LiquidityDepthAnalysis {
  readonly token: Address;
  readonly pool: Address;
  readonly availableLiquidity: bigint;
  readonly priceImpact: number;
  readonly slippageEstimate: number;
  readonly liquidityScore: number;
  readonly depthRating: 'excellent' | 'good' | 'fair' | 'poor';
}

export interface CachedRoute {
  route: ArbitrageRoute;
  hitCount: number;
  lastUsed: number;
  readonly profitHistory: number[];
  readonly averageProfit: number;
  readonly successRate: number;
}

export class RouteOptimizer extends EventEmitter {
  private readonly logger = createComponentLogger('route-optimizer');
  private readonly config: RouteOptimizerConfig;
  private readonly provider: ethers.Provider;

  // Route caching
  private readonly routeCache = new Map<string, CachedRoute>();
  private readonly liquidityCache = new Map<string, LiquidityDepthAnalysis>();

  // Pool and DEX data
  private readonly availablePools = new Map<string, PoolInfo>();
  private readonly dexRegistry = new Map<string, DEXInfo>();

  // Performance tracking
  private routeDiscoveryCount = 0;
  private cacheHitCount = 0;
  private totalOptimizationTime = 0;

  constructor(provider: ethers.Provider, config: RouteOptimizerConfig) {
    super();
    this.provider = provider;
    this.config = config;

    this.initializeDEXRegistry();
    this.startCacheCleanup();

    this.logger.info('Route optimizer initialized', {
      maxHops: this.config.maxHops,
      maxRoutesToEvaluate: this.config.maxRoutesToEvaluate,
      minProfitThresholdUsd: this.config.minProfitThresholdUsd,
    });
  }

  /**
   * Discover optimal arbitrage routes
   */
  async discoverRoutes(request: RouteDiscoveryRequest): Promise<RouteOptimizationResult> {
    const startTime = Date.now();
    this.routeDiscoveryCount++;

    try {
      this.logger.debug('Discovering arbitrage routes', {
        inputToken: request.inputToken,
        outputToken: request.outputToken,
        inputAmount: request.inputAmount.toString(),
        maxHops: request.maxHops,
        includeTriangular: request.includeTriangular,
      });

      // Check cache first
      const cachedRoutes = await this.getCachedRoutes(request);
      let cacheHits = 0;

      const allRoutes: ArbitrageRoute[] = [];

      // Add valid cached routes
      for (const cachedRoute of cachedRoutes) {
        if (this.isRouteValid(cachedRoute.route)) {
          allRoutes.push(cachedRoute.route);
          cacheHits++;
        }
      }

      // Discover new routes if needed
      if (allRoutes.length < this.config.maxRoutesToEvaluate) {
        const newRoutes = await this.discoverNewRoutes(request);
        allRoutes.push(...newRoutes);

        // Cache new routes
        for (const route of newRoutes) {
          await this.cacheRoute(route);
        }
      }

      // Optimize and rank routes
      const optimizedRoutes = await this.optimizeRoutes(allRoutes, request);

      // Select best route
      const bestRoute: ArbitrageRoute | null =
        optimizedRoutes.length > 0 ? optimizedRoutes[0]! : null;

      const optimizationTime = Date.now() - startTime;
      this.totalOptimizationTime += optimizationTime;

      const result: RouteOptimizationResult = {
        request,
        routes: optimizedRoutes,
        bestRoute,
        totalRoutesEvaluated: allRoutes.length,
        optimizationTimeMs: optimizationTime,
        cacheHits,
        discoveredAt: Date.now(),
      };

      this.emit('routesDiscovered', result);

      this.logger.info('Route discovery completed', {
        totalRoutes: optimizedRoutes.length,
        bestProfitUsd: bestRoute?.profitUsd || 0,
        optimizationTimeMs: optimizationTime,
        cacheHits,
      });

      return result;
    } catch (error) {
      this.logger.error('Route discovery failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Discover new arbitrage routes
   */
  private async discoverNewRoutes(request: RouteDiscoveryRequest): Promise<ArbitrageRoute[]> {
    const routes: ArbitrageRoute[] = [];

    try {
      // Simple arbitrage routes (A -> B -> A)
      if (request.outputToken && request.inputToken !== request.outputToken) {
        const simpleRoutes = await this.discoverSimpleRoutes(request);
        routes.push(...simpleRoutes);
      }

      // Triangular arbitrage routes (A -> B -> C -> A)
      if (request.includeTriangular) {
        const triangularRoutes = await this.discoverTriangularRoutes(request);
        routes.push(...triangularRoutes);
      }

      // Complex multi-hop routes (up to maxHops)
      if (request.maxHops > 2) {
        const complexRoutes = await this.discoverComplexRoutes(request);
        routes.push(...complexRoutes);
      }

      return routes;
    } catch (error) {
      this.logger.error('Failed to discover new routes', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Discover simple arbitrage routes (A -> B -> A)
   */
  private async discoverSimpleRoutes(request: RouteDiscoveryRequest): Promise<ArbitrageRoute[]> {
    const routes: ArbitrageRoute[] = [];

    if (!request.outputToken) return routes;

    try {
      // Find all pools connecting input and output tokens
      const directPools = this.findPoolsBetweenTokens(request.inputToken, request.outputToken);

      for (let i = 0; i < directPools.length; i++) {
        for (let j = i + 1; j < directPools.length; j++) {
          const pool1 = directPools[i];
          const pool2 = directPools[j];

          if (!pool1 || !pool2) continue;

          // Create route: input -> output (pool1) -> input (pool2)
          const route = await this.createRoute({
            path: [request.inputToken, request.outputToken, request.inputToken],
            pools: [pool1, pool2],
            inputAmount: request.inputAmount,
            routeType: 'simple',
          });

          if (route && route.netProfit > 0n) {
            routes.push(route);
          }
        }
      }

      return routes;
    } catch (error) {
      this.logger.error('Failed to discover simple routes', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Discover triangular arbitrage routes (A -> B -> C -> A)
   */
  private async discoverTriangularRoutes(
    request: RouteDiscoveryRequest
  ): Promise<ArbitrageRoute[]> {
    const routes: ArbitrageRoute[] = [];

    try {
      // Get all tokens connected to input token
      const connectedTokens = this.getConnectedTokens(request.inputToken);

      for (const tokenB of connectedTokens) {
        if (tokenB === request.inputToken) continue;

        // Get tokens connected to tokenB
        const secondHopTokens = this.getConnectedTokens(tokenB);

        for (const tokenC of secondHopTokens) {
          if (tokenC === request.inputToken || tokenC === tokenB) continue;

          // Check if tokenC connects back to input token
          const returnPools = this.findPoolsBetweenTokens(tokenC, request.inputToken);
          if (returnPools.length === 0) continue;

          // Find pools for each hop
          const pool1 = this.findBestPoolBetweenTokens(request.inputToken, tokenB);
          const pool2 = this.findBestPoolBetweenTokens(tokenB, tokenC);
          const pool3 = this.findBestPoolBetweenTokens(tokenC, request.inputToken);

          if (!pool1 || !pool2 || !pool3) continue;

          // Create triangular route
          const route = await this.createRoute({
            path: [request.inputToken, tokenB, tokenC, request.inputToken],
            pools: [pool1, pool2, pool3],
            inputAmount: request.inputAmount,
            routeType: 'triangular',
          });

          if (route && route.netProfit > 0n) {
            routes.push(route);
          }
        }
      }

      return routes;
    } catch (error) {
      this.logger.error('Failed to discover triangular routes', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Discover complex multi-hop routes
   */
  private async discoverComplexRoutes(request: RouteDiscoveryRequest): Promise<ArbitrageRoute[]> {
    const routes: ArbitrageRoute[] = [];

    try {
      // Use depth-first search to find profitable paths
      const visited = new Set<Address>();
      const currentPath: Address[] = [request.inputToken];
      const currentPools: PoolInfo[] = [];

      await this.dfsRouteDiscovery(
        request.inputToken,
        request.inputToken, // Target (return to start)
        request.inputAmount,
        currentPath,
        currentPools,
        visited,
        request.maxHops,
        routes
      );

      return routes;
    } catch (error) {
      this.logger.error('Failed to discover complex routes', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Depth-first search for route discovery
   */
  private async dfsRouteDiscovery(
    currentToken: Address,
    targetToken: Address,
    currentAmount: bigint,
    path: Address[],
    pools: PoolInfo[],
    visited: Set<Address>,
    remainingHops: number,
    routes: ArbitrageRoute[]
  ): Promise<void> {
    if (remainingHops <= 0) return;

    // If we're back at target and have made at least 2 hops
    if (currentToken === targetToken && path.length > 2) {
      const route = await this.createRoute({
        path: [...path],
        pools: [...pools],
        inputAmount: currentAmount,
        routeType: 'complex',
      });

      if (route && route.netProfit > 0n) {
        routes.push(route);
      }
      return;
    }

    // Explore connected tokens
    const connectedTokens = this.getConnectedTokens(currentToken);

    for (const nextToken of connectedTokens) {
      // Avoid cycles (except returning to start)
      if (visited.has(nextToken) && nextToken !== targetToken) continue;

      const pool = this.findBestPoolBetweenTokens(currentToken, nextToken);
      if (!pool) continue;

      // Calculate output amount for this hop
      const outputAmount = await this.calculateSwapOutput(
        pool,
        currentToken,
        nextToken,
        currentAmount
      );

      if (outputAmount <= 0n) continue;

      // Add to path and continue search
      visited.add(currentToken);
      path.push(nextToken);
      pools.push(pool);

      await this.dfsRouteDiscovery(
        nextToken,
        targetToken,
        outputAmount,
        path,
        pools,
        visited,
        remainingHops - 1,
        routes
      );

      // Backtrack
      visited.delete(currentToken);
      path.pop();
      pools.pop();
    }
  }

  /**
   * Create arbitrage route with profitability analysis
   */
  private async createRoute(params: {
    path: Address[];
    pools: PoolInfo[];
    inputAmount: bigint;
    routeType: 'simple' | 'triangular' | 'complex';
  }): Promise<ArbitrageRoute | null> {
    try {
      const { path, pools, inputAmount, routeType } = params;

      // Calculate expected output through the route
      let currentAmount = inputAmount;
      const dexes: DEXInfo[] = [];

      for (let i = 0; i < pools.length; i++) {
        const pool = pools[i];
        const inputToken = path[i];
        const outputToken = path[i + 1];

        if (!pool || !inputToken || !outputToken) {
          return null;
        }

        // Get DEX info
        const dex = this.dexRegistry.get(pool.dex);
        if (!dex) return null;

        dexes.push(dex);

        // Calculate swap output
        const outputAmount = await this.calculateSwapOutput(
          pool,
          inputToken,
          outputToken,
          currentAmount
        );

        if (outputAmount <= 0n) return null;

        currentAmount = outputAmount;
      }

      const expectedOutput = currentAmount;

      // Calculate profitability
      const grossProfit = expectedOutput > inputAmount ? expectedOutput - inputAmount : 0n;

      // Estimate gas costs
      const gasEstimate = this.estimateGasCost(routeType, pools.length);
      const currentGasPrice = await this.getCurrentGasPrice();
      const gasCost = gasEstimate * currentGasPrice;

      const netProfit = grossProfit > gasCost ? grossProfit - gasCost : 0n;

      // Convert to USD using oracle (fallback to conservative default if unavailable)
      let profitUsd = 0;
      try {
        const { ChainlinkPriceOracleImpl } = await import('../oracles/chainlink-oracle');
        const cm = {
          getProvider: () =>
            (this as any).transactionManager?.getProvider?.() || (this as any).provider,
        } as any;
        const oracle = new ChainlinkPriceOracleImpl(cm);
        const ethUsd = await oracle.getEthUsdPrice();
        profitUsd = (Number(netProfit) / 1e18) * ethUsd;
      } catch {
        throw new Error('ETH/USD price unavailable from oracle');
      }

      // Calculate execution probability and liquidity score
      const executionProbability = await this.calculateExecutionProbability(pools, inputAmount);
      const liquidityScore = await this.calculateLiquidityScore(pools, path, inputAmount);

      // Apply slippage
      const minOutput =
        (expectedOutput * BigInt(Math.floor((1 - this.config.slippageTolerance) * 10000))) / 10000n;

      const route: ArbitrageRoute = {
        id: this.generateRouteId(path, pools),
        path,
        pools,
        dexes,
        inputToken: path[0]!,
        outputToken: path[path.length - 1]!,
        inputAmount,
        expectedOutput,
        minOutput,
        gasEstimate,
        gasCost,
        grossProfit,
        netProfit,
        profitUsd,
        executionProbability,
        liquidityScore,
        routeType,
        hops: pools.length,
        createdAt: Date.now(),
        expiresAt: Date.now() + this.config.cacheExpirationMs,
      };

      return route;
    } catch (error) {
      this.logger.error('Failed to create route', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Optimize and rank routes by profitability
   */
  private async optimizeRoutes(
    routes: ArbitrageRoute[],
    request: RouteDiscoveryRequest
  ): Promise<ArbitrageRoute[]> {
    // Filter routes by minimum profit threshold
    const profitableRoutes = routes.filter(
      route =>
        route.profitUsd >= request.minProfitUsd &&
        route.executionProbability >= this.config.executionProbabilityThreshold
    );

    // Sort by risk-adjusted profit (profit * execution probability)
    profitableRoutes.sort((a, b) => {
      const aScore = a.profitUsd * a.executionProbability * a.liquidityScore;
      const bScore = b.profitUsd * b.executionProbability * b.liquidityScore;
      return bScore - aScore;
    });

    // Return top routes
    return profitableRoutes.slice(0, this.config.maxRoutesToEvaluate);
  }

  /**
   * Calculate swap output for a pool
   */
  private async calculateSwapOutput(
    pool: PoolInfo,
    _inputToken: Address,
    _outputToken: Address,
    inputAmount: bigint
  ): Promise<bigint> {
    try {
      // Simplified calculation - would use actual pool math in production
      const feeRate = pool.fee || 0.003; // 0.3% default
      const outputAmount = (inputAmount * BigInt(Math.floor((1 - feeRate) * 10000))) / 10000n;

      // Apply price impact (simplified)
      const priceImpact = this.calculatePriceImpact(pool, inputAmount);
      const finalOutput = (outputAmount * BigInt(Math.floor((1 - priceImpact) * 10000))) / 10000n;

      return finalOutput;
    } catch (error) {
      this.logger.error('Failed to calculate swap output', {
        pool: pool.address,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0n;
    }
  }

  /**
   * Calculate price impact for a swap
   */
  private calculatePriceImpact(pool: PoolInfo, inputAmount: bigint): number {
    // Simplified price impact calculation
    const liquidityRatio = Number(inputAmount) / Number(pool.liquidity || 1000000n);
    return Math.min(liquidityRatio * 0.1, 0.05); // Max 5% price impact
  }

  /**
   * Calculate execution probability
   */
  private async calculateExecutionProbability(
    pools: PoolInfo[],
    inputAmount: bigint
  ): Promise<number> {
    let totalProbability = 1.0;

    for (const pool of pools) {
      // Base probability based on pool liquidity
      const liquidityRatio = Number(inputAmount) / Number(pool.liquidity || 1000000n);
      const poolProbability = Math.max(0.5, 1 - liquidityRatio * 2);

      totalProbability *= poolProbability;
    }

    // Account for network congestion and gas price
    const networkProbability = 0.95; // 95% base network success rate

    return Math.max(0.1, totalProbability * networkProbability);
  }

  /**
   * Calculate liquidity score
   */
  private async calculateLiquidityScore(
    pools: PoolInfo[],
    _path: Address[],
    inputAmount: bigint
  ): Promise<number> {
    let totalScore = 0;

    for (const pool of pools) {
      const liquidityRatio = Number(pool.liquidity || 0n) / Number(inputAmount);
      const poolScore = Math.min(1.0, liquidityRatio / 10); // Score based on 10x liquidity
      totalScore += poolScore;
    }

    return totalScore / pools.length;
  }

  /**
   * Get current gas price from provider
   */
  private async getCurrentGasPrice(): Promise<bigint> {
    try {
      const feeData = await this.provider.getFeeData();
      return feeData.gasPrice || this.config.gasPrice;
    } catch (error) {
      this.logger.warn('Failed to get gas price from provider, using config default', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.config.gasPrice;
    }
  }
  private estimateGasCost(routeType: string, hops: number): bigint {
    const baseGas = 100000n; // Base transaction cost
    const hopGas = 80000n; // Per-hop cost

    let multiplier = 1.0;
    switch (routeType) {
      case 'simple':
        multiplier = 1.0;
        break;
      case 'triangular':
        multiplier = 1.2;
        break;
      case 'complex':
        multiplier = 1.5;
        break;
    }

    return baseGas + (hopGas * BigInt(hops) * BigInt(Math.floor(multiplier * 100))) / 100n;
  }

  /**
   * Find pools between two tokens
   */
  private findPoolsBetweenTokens(tokenA: Address, tokenB: Address): PoolInfo[] {
    const pools: PoolInfo[] = [];

    for (const pool of this.availablePools.values()) {
      if (
        (pool.token0 === tokenA && pool.token1 === tokenB) ||
        (pool.token0 === tokenB && pool.token1 === tokenA)
      ) {
        pools.push(pool);
      }
    }

    return pools;
  }

  /**
   * Find best pool between two tokens
   */
  private findBestPoolBetweenTokens(tokenA: Address, tokenB: Address): PoolInfo | null {
    const pools = this.findPoolsBetweenTokens(tokenA, tokenB);

    if (pools.length === 0) return null;

    // Sort by liquidity (highest first)
    pools.sort((a, b) => Number(b.liquidity || 0n) - Number(a.liquidity || 0n));

    return pools[0] || null;
  }

  /**
   * Get tokens connected to a given token
   */
  private getConnectedTokens(token: Address): Address[] {
    const connected = new Set<Address>();

    for (const pool of this.availablePools.values()) {
      if (pool.token0 === token) {
        connected.add(pool.token1);
      } else if (pool.token1 === token) {
        connected.add(pool.token0);
      }
    }

    return Array.from(connected);
  }

  /**
   * Generate unique route ID
   */
  private generateRouteId(path: Address[], pools: PoolInfo[]): string {
    const pathStr = path.join('-');
    const poolStr = pools.map(p => p.address).join('-');
    return `route_${pathStr}_${poolStr}`;
  }

  /**
   * Cache route for future use
   */
  private async cacheRoute(route: ArbitrageRoute): Promise<void> {
    const existing = this.routeCache.get(route.id);

    if (existing) {
      // Update existing cache entry
      const updatedCache: CachedRoute = {
        route,
        hitCount: existing.hitCount,
        lastUsed: Date.now(),
        profitHistory: [...existing.profitHistory, route.profitUsd].slice(-10), // Keep last 10
        averageProfit: (existing.averageProfit + route.profitUsd) / 2,
        successRate: existing.successRate,
      };

      this.routeCache.set(route.id, updatedCache);
    } else {
      // Create new cache entry
      const newCache: CachedRoute = {
        route,
        hitCount: 0,
        lastUsed: Date.now(),
        profitHistory: [route.profitUsd],
        averageProfit: route.profitUsd,
        successRate: 1.0,
      };

      this.routeCache.set(route.id, newCache);
    }
  }

  /**
   * Get cached routes for request
   */
  private async getCachedRoutes(request: RouteDiscoveryRequest): Promise<CachedRoute[]> {
    const cached: CachedRoute[] = [];

    for (const [_routeId, cachedRoute] of this.routeCache) {
      const route = cachedRoute.route;

      // Check if route matches request
      if (
        route.inputToken === request.inputToken &&
        (!request.outputToken || route.outputToken === request.outputToken) &&
        route.hops <= request.maxHops &&
        route.expiresAt > Date.now()
      ) {
        // Update hit count
        cachedRoute.hitCount++;
        cachedRoute.lastUsed = Date.now();
        this.cacheHitCount++;

        cached.push(cachedRoute);
      }
    }

    // Sort by hit count and average profit
    cached.sort((a, b) => {
      const aScore = a.hitCount * a.averageProfit * a.successRate;
      const bScore = b.hitCount * b.averageProfit * b.successRate;
      return bScore - aScore;
    });

    return cached;
  }

  /**
   * Check if route is still valid
   */
  private isRouteValid(route: ArbitrageRoute): boolean {
    return route.expiresAt > Date.now() && route.profitUsd >= this.config.minProfitThresholdUsd;
  }

  /**
   * Initialize DEX registry
   */
  private initializeDEXRegistry(): void {
    // Uniswap V3
    this.dexRegistry.set('uniswap-v3', {
      name: 'Uniswap V3',
      protocol: 'uniswap-v3',
      version: '3',
      factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as Address,
      router: '0x2626664c2603336E57B271c5C0b26F421741e481' as Address,
      fee: 0.003,
      gasEstimate: 150000n,
      enabled: true,
    });

    // Aerodrome
    this.dexRegistry.set('aerodrome', {
      name: 'Aerodrome',
      protocol: 'aerodrome',
      version: '1',
      factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' as Address,
      router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43' as Address,
      fee: 0.002,
      gasEstimate: 120000n,
      enabled: true,
    });

    // BaseSwap
    this.dexRegistry.set('baseswap', {
      name: 'BaseSwap',
      protocol: 'baseswap',
      version: '1',
      factory: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB' as Address,
      router: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86' as Address,
      fee: 0.0025,
      gasEstimate: 130000n,
      enabled: true,
    });

    this.logger.info('DEX registry initialized', {
      dexCount: this.dexRegistry.size,
    });
  }

  /**
   * Start cache cleanup
   */
  private cacheCleanupInterval: NodeJS.Timeout | null = null;

  private startCacheCleanup(): void {
    if (this.cacheCleanupInterval) {
      clearInterval(this.cacheCleanupInterval);
    }
    this.cacheCleanupInterval = setInterval(() => {
      this.cleanupExpiredRoutes();
    }, this.config.cacheExpirationMs / 4); // Clean up every quarter of expiration time

    this.logger.info('Cache cleanup started');
  }

  /**
   * Clean up expired routes
   */
  private cleanupExpiredRoutes(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [routeId, cachedRoute] of this.routeCache) {
      if (
        cachedRoute.route.expiresAt < now ||
        cachedRoute.lastUsed < now - this.config.cacheExpirationMs
      ) {
        this.routeCache.delete(routeId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug('Cleaned up expired routes', { cleanedCount });
    }
  }

  /**
   * Get optimizer statistics
   */
  getOptimizerStats(): {
    totalRouteDiscoveries: number;
    cacheHitRate: number;
    averageOptimizationTime: number;
    cachedRoutes: number;
    availablePools: number;
    registeredDEXs: number;
  } {
    const cacheHitRate =
      this.routeDiscoveryCount > 0 ? this.cacheHitCount / this.routeDiscoveryCount : 0;
    const avgOptimizationTime =
      this.routeDiscoveryCount > 0 ? this.totalOptimizationTime / this.routeDiscoveryCount : 0;

    return {
      totalRouteDiscoveries: this.routeDiscoveryCount,
      cacheHitRate,
      averageOptimizationTime: avgOptimizationTime,
      cachedRoutes: this.routeCache.size,
      availablePools: this.availablePools.size,
      registeredDEXs: this.dexRegistry.size,
    };
  }

  /**
   * Add pool to available pools
   */
  addPool(pool: PoolInfo): void {
    this.availablePools.set(pool.address, pool);
    this.logger.debug('Pool added to optimizer', {
      address: pool.address,
      token0: pool.token0,
      token1: pool.token1,
      dex: pool.dex,
    });
  }

  /**
   * Remove pool from available pools
   */
  removePool(poolAddress: Address): void {
    this.availablePools.delete(poolAddress);
    this.logger.debug('Pool removed from optimizer', { address: poolAddress });
  }

  /**
   * Stop optimizer
   */
  stop(): void {
    if (this.cacheCleanupInterval) {
      clearInterval(this.cacheCleanupInterval);
      this.cacheCleanupInterval = null;
    }
    this.routeCache.clear();
    this.liquidityCache.clear();
    this.logger.info('Route optimizer stopped');
  }
}
