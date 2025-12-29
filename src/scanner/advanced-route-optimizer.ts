/**
 * Advanced Route Optimizer
 *
 * Multi-hop arbitrage detection, triangular arbitrage, and cross-protocol routing
 */

import { EventEmitter } from 'events';
import { Address } from '../types/common';
import { PoolManager } from './pool-manager';
import { PoolType } from '../types/pool';

export interface MultiHopRoute {
  readonly id: string;
  readonly hops: Array<{
    readonly poolAddress: Address;
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly dex: 'uniswap-v3' | 'aerodrome';
    readonly fee: number;
    readonly estimatedGas: bigint;
  }>;
  readonly totalGas: bigint;
  readonly expectedProfit: bigint;
  readonly profitability: number; // profit per gas ratio
  readonly complexity: number; // 1-5 scale
}

export interface TriangularArbitrageRoute {
  readonly tokenA: Address;
  readonly tokenB: Address;
  readonly tokenC: Address;
  readonly routes: [MultiHopRoute, MultiHopRoute, MultiHopRoute]; // A->B, B->C, C->A
  readonly netProfit: bigint;
  readonly totalGas: bigint;
  readonly efficiency: number; // profit per gas
}

export interface CrossProtocolRoute {
  readonly protocols: Array<'uniswap-v2' | 'uniswap-v3' | 'aerodrome' | 'balancer'>;
  readonly route: MultiHopRoute;
  readonly protocolSwitchCost: bigint; // Additional gas for protocol switches
  readonly riskScore: number; // 0-1 scale (higher = riskier)
}

export interface RouteOptimizationConfig {
  readonly maxHops: number;
  readonly maxGasPerRoute: bigint;
  readonly minProfitPerGas: bigint;
  readonly enableTriangularArbitrage: boolean;
  readonly enableCrossProtocol: boolean;
  readonly riskTolerance: number; // 0-1 scale
}

export class AdvancedRouteOptimizer extends EventEmitter {
  private readonly poolManager: PoolManager;
  private readonly config: RouteOptimizationConfig;

  // Route caching
  private readonly routeCache: Map<string, MultiHopRoute[]> = new Map();
  private readonly triangularCache: Map<string, TriangularArbitrageRoute[]> = new Map();
  private readonly cacheTimeout = 60000; // 1 minute

  // Token graph for pathfinding
  private tokenGraph: Map<Address, Set<Address>> = new Map();
  private lastGraphUpdate = 0;
  private readonly graphUpdateInterval = 300000; // 5 minutes

  constructor(poolManager: PoolManager, config: RouteOptimizationConfig) {
    super();
    this.poolManager = poolManager;
    this.config = config;

    this.buildTokenGraph();

    // Listen for pool updates to rebuild graph
    this.poolManager.on('poolUpdated', () => {
      this.scheduleGraphUpdate();
    });
  }

  /**
   * Find optimal multi-hop routes between two tokens
   */
  async findOptimalRoutes(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    maxRoutes: number = 10
  ): Promise<MultiHopRoute[]> {
    const cacheKey = `${tokenIn}-${tokenOut}-${amountIn.toString()}`;
    const cached = this.routeCache.get(cacheKey);

    if (cached && Date.now() - this.lastGraphUpdate < this.cacheTimeout) {
      return cached.slice(0, maxRoutes);
    }

    // Update token graph if needed
    if (Date.now() - this.lastGraphUpdate > this.graphUpdateInterval) {
      this.buildTokenGraph();
    }

    const routes: MultiHopRoute[] = [];

    // Find direct routes (1-hop)
    const directRoutes = await this.findDirectRoutes(tokenIn, tokenOut, amountIn);
    routes.push(...directRoutes);

    // Find multi-hop routes if enabled
    if (this.config.maxHops > 1) {
      const multiHopRoutes = await this.findMultiHopRoutes(tokenIn, tokenOut, amountIn);
      routes.push(...multiHopRoutes);
    }

    // Sort by profitability and filter by constraints
    const filteredRoutes = routes
      .filter(
        route =>
          route.totalGas <= this.config.maxGasPerRoute &&
          route.expectedProfit > 0n &&
          route.profitability >= Number(this.config.minProfitPerGas)
      )
      .sort((a, b) => b.profitability - a.profitability)
      .slice(0, maxRoutes);

    // Cache results
    this.routeCache.set(cacheKey, filteredRoutes);

    this.emit('routesFound', {
      tokenIn,
      tokenOut,
      routeCount: filteredRoutes.length,
      bestProfitability: filteredRoutes[0]?.profitability || 0,
    });

    return filteredRoutes;
  }

  /**
   * Find triangular arbitrage opportunities
   */
  async findTriangularArbitrage(
    baseToken: Address,
    amountIn: bigint
  ): Promise<TriangularArbitrageRoute[]> {
    if (!this.config.enableTriangularArbitrage) {
      return [];
    }

    const cacheKey = `triangular-${baseToken}-${amountIn.toString()}`;
    const cached = this.triangularCache.get(cacheKey);

    if (cached && Date.now() - this.lastGraphUpdate < this.cacheTimeout) {
      return cached;
    }

    const triangularRoutes: TriangularArbitrageRoute[] = [];
    const connectedTokens = this.tokenGraph.get(baseToken) || new Set();

    // Find all possible triangular paths: baseToken -> tokenB -> tokenC -> baseToken
    for (const tokenB of connectedTokens) {
      const tokenBConnections = this.tokenGraph.get(tokenB) || new Set();

      for (const tokenC of tokenBConnections) {
        if (tokenC === baseToken || tokenC === tokenB) continue;

        const tokenCConnections = this.tokenGraph.get(tokenC) || new Set();
        if (!tokenCConnections.has(baseToken)) continue;

        // Found a triangular path, now optimize it
        const triangularRoute = await this.optimizeTriangularRoute(
          baseToken,
          tokenB,
          tokenC,
          amountIn
        );

        if (triangularRoute && triangularRoute.netProfit > 0n) {
          triangularRoutes.push(triangularRoute);
        }
      }
    }

    // Sort by efficiency (profit per gas)
    triangularRoutes.sort((a, b) => b.efficiency - a.efficiency);

    // Cache results
    this.triangularCache.set(cacheKey, triangularRoutes);

    this.emit('triangularRoutesFound', {
      baseToken,
      routeCount: triangularRoutes.length,
      bestEfficiency: triangularRoutes[0]?.efficiency || 0,
    });

    return triangularRoutes.slice(0, 5); // Return top 5 triangular routes
  }

  /**
   * Find cross-protocol routes
   */
  async findCrossProtocolRoutes(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint
  ): Promise<CrossProtocolRoute[]> {
    if (!this.config.enableCrossProtocol) {
      return [];
    }

    const crossProtocolRoutes: CrossProtocolRoute[] = [];

    // This would integrate with other protocols like Uniswap V2, Balancer, etc.
    // For now, we'll focus on optimizing within Uniswap V3 and Aerodrome

    // Example: Uniswap V3 -> Aerodrome -> Uniswap V3 route
    const hybridRoutes = await this.findHybridProtocolRoutes(tokenIn, tokenOut, amountIn);
    crossProtocolRoutes.push(...hybridRoutes);

    return crossProtocolRoutes
      .filter(route => route.riskScore <= this.config.riskTolerance)
      .sort((a, b) => b.route.profitability - a.route.profitability)
      .slice(0, 3); // Return top 3 cross-protocol routes
  }

  /**
   * Find direct routes (single hop)
   */
  private async findDirectRoutes(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint
  ): Promise<MultiHopRoute[]> {
    const directRoutes: MultiHopRoute[] = [];
    const allPools = this.poolManager.getAllPoolStates();

    for (const [poolAddress, poolState] of allPools) {
      if (!poolState.isActive) continue;

      // Check if pool connects our tokens
      const connectsTokens =
        (poolState.token0 === tokenIn && poolState.token1 === tokenOut) ||
        (poolState.token0 === tokenOut && poolState.token1 === tokenIn);

      if (!connectsTokens) continue;

      const route = await this.createSingleHopRoute(
        poolAddress,
        poolState,
        tokenIn,
        tokenOut,
        amountIn
      );

      if (route) {
        directRoutes.push(route);
      }
    }

    return directRoutes;
  }

  /**
   * Find multi-hop routes using pathfinding
   */
  private async findMultiHopRoutes(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint
  ): Promise<MultiHopRoute[]> {
    const multiHopRoutes: MultiHopRoute[] = [];

    // Use breadth-first search to find paths
    const paths = this.findPaths(tokenIn, tokenOut, this.config.maxHops);

    for (const path of paths) {
      if (path.length < 2) continue; // Skip direct paths (already handled)

      const route = await this.createMultiHopRoute(path, amountIn);
      if (route) {
        multiHopRoutes.push(route);
      }
    }

    return multiHopRoutes;
  }

  /**
   * Create a single hop route
   */
  private async createSingleHopRoute(
    poolAddress: Address,
    poolState: any,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint
  ): Promise<MultiHopRoute | null> {
    try {
      // Calculate expected output and gas cost
      const expectedOutput = await this.calculateSwapOutput(poolState, tokenIn, tokenOut, amountIn);
      if (expectedOutput <= 0n) return null;

      const gasEstimate = this.estimateSwapGas(poolState.type);
      const profit = expectedOutput > amountIn ? expectedOutput - amountIn : 0n;

      if (profit <= 0n) return null;

      const profitability = Number(profit) / Number(gasEstimate);

      return {
        id: `single-${poolAddress}-${Date.now()}`,
        hops: [
          {
            poolAddress,
            tokenIn,
            tokenOut,
            dex: poolState.type === PoolType.UNISWAP_V3 ? 'uniswap-v3' : 'aerodrome',
            fee: poolState.fee || 0,
            estimatedGas: gasEstimate,
          },
        ],
        totalGas: gasEstimate,
        expectedProfit: profit,
        profitability,
        complexity: 1,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Create a multi-hop route from a token path
   */
  private async createMultiHopRoute(
    tokenPath: Address[],
    amountIn: bigint
  ): Promise<MultiHopRoute | null> {
    if (tokenPath.length < 2) return null;

    const hops: MultiHopRoute['hops'] = [];
    let totalGas = 0n;
    let currentAmount = amountIn;

    // Build route hop by hop
    for (let i = 0; i < tokenPath.length - 1; i++) {
      const tokenIn = tokenPath[i];
      const tokenOut = tokenPath[i + 1];

      // Validate token addresses
      if (!tokenIn || !tokenOut) {
        return null;
      }

      // Find best pool for this hop
      const bestPool = await this.findBestPoolForPair(tokenIn, tokenOut);
      if (!bestPool) return null;

      const hopGas = this.estimateSwapGas(bestPool.poolState.type);
      const expectedOutput = await this.calculateSwapOutput(
        bestPool.poolState,
        tokenIn,
        tokenOut,
        currentAmount
      );

      if (expectedOutput <= 0n) return null;

      hops.push({
        poolAddress: bestPool.address,
        tokenIn,
        tokenOut,
        dex: bestPool.poolState.type === PoolType.UNISWAP_V3 ? 'uniswap-v3' : 'aerodrome',
        fee: bestPool.poolState.fee || 0,
        estimatedGas: hopGas,
      });

      totalGas += hopGas;
      currentAmount = expectedOutput;
    }

    // Add protocol switching costs
    const protocolSwitchCost = this.calculateProtocolSwitchCost(hops);
    totalGas += protocolSwitchCost;

    const profit = currentAmount > amountIn ? currentAmount - amountIn : 0n;
    if (profit <= 0n) return null;

    const profitability = Number(profit) / Number(totalGas);

    return {
      id: `multi-${tokenPath.join('-')}-${Date.now()}`,
      hops,
      totalGas,
      expectedProfit: profit,
      profitability,
      complexity: hops.length,
    };
  }

  /**
   * Optimize triangular arbitrage route
   */
  private async optimizeTriangularRoute(
    tokenA: Address,
    tokenB: Address,
    tokenC: Address,
    amountIn: bigint
  ): Promise<TriangularArbitrageRoute | null> {
    try {
      // Find best routes for each leg of the triangle
      const routeAB = await this.findOptimalRoutes(tokenA, tokenB, amountIn, 1);
      if (routeAB.length === 0) return null;

      const amountB = amountIn + routeAB[0]!.expectedProfit;
      const routeBC = await this.findOptimalRoutes(tokenB, tokenC, amountB, 1);
      if (routeBC.length === 0) return null;

      const amountC = amountB + routeBC[0]!.expectedProfit;
      const routeCA = await this.findOptimalRoutes(tokenC, tokenA, amountC, 1);
      if (routeCA.length === 0) return null;

      const finalAmount = amountC + routeCA[0]!.expectedProfit;
      const netProfit = finalAmount > amountIn ? finalAmount - amountIn : 0n;

      if (netProfit <= 0n) return null;

      const totalGas = routeAB[0]!.totalGas + routeBC[0]!.totalGas + routeCA[0]!.totalGas;
      const efficiency = Number(netProfit) / Number(totalGas);

      return {
        tokenA,
        tokenB,
        tokenC,
        routes: [routeAB[0]!, routeBC[0]!, routeCA[0]!],
        netProfit,
        totalGas,
        efficiency,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Find hybrid protocol routes (Uniswap V3 + Aerodrome combinations)
   */
  private async findHybridProtocolRoutes(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint
  ): Promise<CrossProtocolRoute[]> {
    const hybridRoutes: CrossProtocolRoute[] = [];

    // Find intermediate tokens that exist on both protocols
    const intermediateTokens = this.findCommonTokens();

    for (const intermediateToken of intermediateTokens) {
      if (intermediateToken === tokenIn || intermediateToken === tokenOut) continue;

      // Try Uniswap V3 -> Aerodrome
      const uniToAeroRoute = await this.createHybridRoute(
        tokenIn,
        intermediateToken,
        tokenOut,
        amountIn,
        ['uniswap-v3', 'aerodrome']
      );

      if (uniToAeroRoute) {
        hybridRoutes.push(uniToAeroRoute);
      }

      // Try Aerodrome -> Uniswap V3
      const aeroToUniRoute = await this.createHybridRoute(
        tokenIn,
        intermediateToken,
        tokenOut,
        amountIn,
        ['aerodrome', 'uniswap-v3']
      );

      if (aeroToUniRoute) {
        hybridRoutes.push(aeroToUniRoute);
      }
    }

    return hybridRoutes;
  }

  /**
   * Create hybrid route across protocols
   */
  private async createHybridRoute(
    tokenIn: Address,
    intermediateToken: Address,
    tokenOut: Address,
    amountIn: bigint,
    protocols: Array<'uniswap-v3' | 'aerodrome'>
  ): Promise<CrossProtocolRoute | null> {
    try {
      const path = [tokenIn, intermediateToken, tokenOut];
      const route = await this.createMultiHopRoute(path, amountIn);

      if (!route) return null;

      // Calculate protocol switch cost (additional gas for switching between protocols)
      const protocolSwitchCost = BigInt(protocols.length - 1) * 10000n; // 10k gas per switch

      // Calculate risk score based on protocol combination
      const riskScore = this.calculateCrossProtocolRisk(protocols);

      return {
        protocols,
        route: {
          ...route,
          totalGas: route.totalGas + protocolSwitchCost,
        },
        protocolSwitchCost,
        riskScore,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Build token connectivity graph
   */
  private buildTokenGraph(): void {
    this.tokenGraph.clear();
    const allPools = this.poolManager.getAllPoolStates();

    for (const [, poolState] of allPools) {
      if (!poolState.isActive) continue;

      const token0 = poolState.token0;
      const token1 = poolState.token1;

      // Add bidirectional connections
      if (!this.tokenGraph.has(token0)) {
        this.tokenGraph.set(token0, new Set());
      }
      if (!this.tokenGraph.has(token1)) {
        this.tokenGraph.set(token1, new Set());
      }

      this.tokenGraph.get(token0)!.add(token1);
      this.tokenGraph.get(token1)!.add(token0);
    }

    this.lastGraphUpdate = Date.now();
    this.emit('tokenGraphUpdated', {
      tokenCount: this.tokenGraph.size,
      connectionCount: Array.from(this.tokenGraph.values()).reduce(
        (sum, connections) => sum + connections.size,
        0
      ),
    });
  }

  /**
   * Find paths between tokens using BFS
   */
  private findPaths(start: Address, end: Address, maxHops: number): Address[][] {
    const paths: Address[][] = [];
    const queue: { path: Address[]; visited: Set<Address> }[] = [
      { path: [start], visited: new Set([start]) },
    ];

    while (queue.length > 0 && paths.length < 50) {
      // Limit to 50 paths
      const { path, visited } = queue.shift()!;

      if (path.length > maxHops) continue;

      const currentToken = path[path.length - 1]!;
      const connections = this.tokenGraph.get(currentToken) || new Set();

      for (const nextToken of connections) {
        if (nextToken === end) {
          // Found a complete path
          paths.push([...path, nextToken]);
          continue;
        }

        if (!visited.has(nextToken) && path.length < maxHops) {
          queue.push({
            path: [...path, nextToken],
            visited: new Set([...visited, nextToken]),
          });
        }
      }
    }

    return paths;
  }

  /**
   * Find best pool for a token pair
   */
  private async findBestPoolForPair(
    tokenIn: Address,
    tokenOut: Address
  ): Promise<{ address: Address; poolState: any } | null> {
    const allPools = this.poolManager.getAllPoolStates();
    let bestPool: { address: Address; poolState: any } | null = null;
    let bestLiquidity = 0n;

    for (const [poolAddress, poolState] of allPools) {
      if (!poolState.isActive) continue;

      const connectsTokens =
        (poolState.token0 === tokenIn && poolState.token1 === tokenOut) ||
        (poolState.token0 === tokenOut && poolState.token1 === tokenIn);

      if (!connectsTokens) continue;

      // Calculate pool liquidity (simplified)
      const liquidity = this.calculatePoolLiquidity(poolState);

      if (liquidity > bestLiquidity) {
        bestLiquidity = liquidity;
        bestPool = { address: poolAddress, poolState };
      }
    }

    return bestPool;
  }

  /**
   * Calculate pool liquidity for comparison
   */
  private calculatePoolLiquidity(poolState: any): bigint {
    if (poolState.type === PoolType.UNISWAP_V3) {
      return BigInt(poolState.liquidity?.toString() || '0');
    } else {
      // Aerodrome pools - use geometric mean of reserves
      const reserve0 = BigInt(poolState.reserve0?.toString() || '0');
      const reserve1 = BigInt(poolState.reserve1?.toString() || '0');

      if (reserve0 === 0n || reserve1 === 0n) return 0n;

      // Simplified geometric mean calculation
      return (reserve0 + reserve1) / 2n;
    }
  }

  /**
   * Calculate swap output (simplified)
   */
  private async calculateSwapOutput(
    poolState: any,
    tokenIn: Address,
    _tokenOut: Address, // Use underscore to indicate intentional unused parameter for future enhancement
    amountIn: bigint
  ): Promise<bigint> {
    // This is a simplified calculation - real implementation would use
    // proper AMM formulas for each pool type
    // tokenOut parameter reserved for future directional calculations

    if (poolState.type === PoolType.UNISWAP_V3) {
      // Simplified Uniswap V3 calculation
      const liquidity = BigInt(poolState.liquidity?.toString() || '0');
      if (liquidity === 0n) return 0n;

      // Very simplified - real implementation needs tick math
      return (amountIn * 997n) / 1000n; // Assume 0.3% fee
    } else {
      // Aerodrome calculation
      const reserve0 = BigInt(poolState.reserve0?.toString() || '0');
      const reserve1 = BigInt(poolState.reserve1?.toString() || '0');

      if (reserve0 === 0n || reserve1 === 0n) return 0n;

      // Simplified constant product formula
      const reserveIn = poolState.token0 === tokenIn ? reserve0 : reserve1;
      const reserveOut = poolState.token0 === tokenIn ? reserve1 : reserve0;

      if (reserveIn === 0n) return 0n; // Prevent division by zero

      const amountInWithFee = amountIn * 997n; // 0.3% fee
      const numerator = amountInWithFee * reserveOut;
      const denominator = reserveIn * 1000n + amountInWithFee;

      return denominator > 0n ? numerator / denominator : 0n;
    }
  }

  /**
   * Estimate gas cost for swap based on pool type
   */
  private estimateSwapGas(poolType: PoolType): bigint {
    switch (poolType) {
      case PoolType.UNISWAP_V3:
        return 120000n; // Uniswap V3 swap
      case PoolType.AERODROME_VOLATILE:
        return 80000n; // Aerodrome volatile swap
      case PoolType.AERODROME_STABLE:
        return 90000n; // Aerodrome stable swap (slightly more complex)
      default:
        return 100000n; // Default estimate
    }
  }

  /**
   * Calculate protocol switching cost
   */
  private calculateProtocolSwitchCost(hops: MultiHopRoute['hops']): bigint {
    let switchCost = 0n;

    for (let i = 1; i < hops.length; i++) {
      const currentHop = hops[i];
      const previousHop = hops[i - 1];

      if (currentHop && previousHop && currentHop.dex !== previousHop.dex) {
        switchCost += 15000n; // Additional gas for protocol switch
      }
    }

    return switchCost;
  }

  /**
   * Find tokens that exist on multiple protocols
   */
  private findCommonTokens(): Address[] {
    const uniswapTokens = new Set<Address>();
    const aerodromeTokens = new Set<Address>();

    const allPools = this.poolManager.getAllPoolStates();

    for (const [, poolState] of allPools) {
      if (poolState.type === PoolType.UNISWAP_V3) {
        uniswapTokens.add(poolState.token0);
        uniswapTokens.add(poolState.token1);
      } else {
        aerodromeTokens.add(poolState.token0);
        aerodromeTokens.add(poolState.token1);
      }
    }

    // Find intersection
    const commonTokens: Address[] = [];
    for (const token of uniswapTokens) {
      if (aerodromeTokens.has(token)) {
        commonTokens.push(token);
      }
    }

    return commonTokens;
  }

  /**
   * Calculate cross-protocol risk score
   */
  private calculateCrossProtocolRisk(protocols: string[]): number {
    // Base risk for cross-protocol operations
    let riskScore = 0.3;

    // Add risk for each protocol switch
    riskScore += (protocols.length - 1) * 0.1;

    // Add risk for specific protocol combinations
    if (protocols.includes('balancer')) {
      riskScore += 0.2; // Balancer has more complex mechanics
    }

    return Math.min(1.0, riskScore);
  }

  /**
   * Schedule graph update
   */
  private scheduleGraphUpdate(): void {
    // Debounce graph updates
    setTimeout(() => {
      if (Date.now() - this.lastGraphUpdate > 30000) {
        // Min 30s between updates
        this.buildTokenGraph();
      }
    }, 5000);
  }

  /**
   * Clear caches
   */
  clearCaches(): void {
    this.routeCache.clear();
    this.triangularCache.clear();
    this.emit('cachesCleared');
  }

  /**
   * Get optimization statistics
   */
  getStats(): {
    tokenGraphSize: number;
    cachedRoutes: number;
    cachedTriangularRoutes: number;
    lastGraphUpdate: number;
  } {
    return {
      tokenGraphSize: this.tokenGraph.size,
      cachedRoutes: this.routeCache.size,
      cachedTriangularRoutes: this.triangularCache.size,
      lastGraphUpdate: this.lastGraphUpdate,
    };
  }
}
