/**
 * Cross-DEX Arbitrage Scanner
 *
 * Detects arbitrage opportunities between Uniswap V3 and Aerodrome pools on Base.
 * Implements spread detection, profit calculation, and threshold enforcement.
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { Address } from '../types/common';
import { ArbitrageOpportunity, OpportunityStatus, Route } from '../types/opportunity';
import { PoolManager } from './pool-manager';
import {
  UniswapV3PoolState,
  AerodromeVolatilePoolState,
  AerodromeStablePoolState,
  PoolType,
} from '../types/pool';
import { ArbitrageConfig } from '../types/config';
import { RpcConnectionManager } from '../rpc/connection-manager';

export interface ArbitrageScannerOptions {
  readonly poolManager: PoolManager;
  readonly connectionManager: RpcConnectionManager;
  readonly config: ArbitrageConfig;
  readonly scanIntervalMs?: number;
  readonly priceOracle?: IPriceOracle;
}

export interface IPriceOracle {
  getEthUsdPrice(): Promise<number>;
}

// Enhanced price oracle implementation with real Chainlink integration
export class EnhancedPriceOracle implements IPriceOracle {
  private cachedPrice?: { price: number; timestamp: number };
  private readonly cacheTimeMs = 60000; // 1 minute cache
  private readonly chainlinkOracle?: any; // Will be injected if available

  constructor(chainlinkOracle?: any) {
    this.chainlinkOracle = chainlinkOracle;
  }

  async getEthUsdPrice(): Promise<number> {
    // Check cache first
    if (this.cachedPrice && Date.now() - this.cachedPrice.timestamp < this.cacheTimeMs) {
      return this.cachedPrice.price;
    }

    try {
      // Try Chainlink oracle first if available
      if (this.chainlinkOracle) {
        const price = await this.chainlinkOracle.getEthUsdPrice();
        this.cachedPrice = { price, timestamp: Date.now() };
        return price;
      }

      // Fallback to external price API (CoinGecko, etc.)
      const price = await this.fetchEthPriceFromApi();
      this.cachedPrice = { price, timestamp: Date.now() };
      return price;
    } catch (error) {
      // Return cached price if available
      if (this.cachedPrice) {
        return this.cachedPrice.price;
      }

      // Ultimate fallback with warning
      console.warn('Failed to get ETH price from all sources');
      throw new Error('ETH/USD price unavailable from all sources');
    }
  }

  /**
   * Fetch ETH price from external API
   */
  private async fetchEthPriceFromApi(): Promise<number> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    try {
      // Use CoinGecko API as fallback
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as any;

      if (!data.ethereum || typeof data.ethereum.usd !== 'number' || !isFinite(data.ethereum.usd)) {
        throw new Error('Invalid API response: missing or invalid ethereum.usd price');
      }

      return data.ethereum.usd;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('CoinGecko API request timed out after 5 seconds');
        }
        throw new Error(`CoinGecko API error: ${error.message}`);
      }

      throw new Error('Unknown error fetching ETH price from CoinGecko API');
    }
  }
}

/**
 * Calculate square root of a BigInt using Newton's method
 */
function bigintSqrt(value: bigint): bigint {
  if (value < 0n) {
    throw new Error('Square root of negative number');
  }
  if (value < 2n) {
    return value;
  }

  // Newton's method for square root
  let x = value;
  let y = (x + 1n) / 2n;

  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }

  return x;
}

export interface ArbitrageSpread {
  tokenPair: [Address, Address];
  uniswapV3Pool: Address;
  aerodromePool: Address;
  readonly uniswapV3Price: bigint;
  readonly aerodromePrice: bigint;
  readonly spread: number; // in basis points
  readonly direction: 'uni_to_aero' | 'aero_to_uni';
}

export interface ArbitrageRoute {
  readonly id: string;
  readonly uniV3Pool: UniswapV3PoolState;
  readonly aeroPool: AerodromeVolatilePoolState | AerodromeStablePoolState;
  readonly spread: ArbitrageSpread;
  readonly optimalAmount: bigint;
  readonly expectedProfit: bigint;
  readonly profitMargin: number;
  readonly gasEstimate: bigint;
  readonly priority: number; // 1-10 scale based on profitability
}

export interface RouteOptimizationResult {
  readonly primaryRoute: ArbitrageRoute;
  readonly fallbackRoutes: ArbitrageRoute[];
  readonly totalRoutes: number;
  readonly bestProfitMargin: number;
}

export interface ProfitCalculation {
  readonly grossProfit: bigint;
  readonly flashLoanFee: bigint;
  readonly gasEstimate: bigint;
  readonly gasCost: bigint;
  readonly slippageCost: bigint;
  readonly netProfit: bigint;
  readonly profitMargin: number; // percentage
  readonly isViable: boolean;
}

export class ArbitrageScanner extends EventEmitter {
  private readonly poolManager: PoolManager;
  private readonly connectionManager: RpcConnectionManager;
  private readonly config: ArbitrageConfig;
  private readonly scanIntervalMs: number;
  private readonly priceOracle: IPriceOracle;
  private readonly logger = console; // Simple logger for now

  // Scanning state
  private isScanning = false;
  private scanInterval: ReturnType<typeof setInterval> | undefined;

  // Token pair tracking
  private monitoredPairs: Map<string, { token0: Address; token1: Address }> = new Map();
  private poolPairings: Map<string, { uniV3Pools: Address[]; aeroPools: Address[] }> = new Map();

  // Opportunity tracking
  private activeOpportunities: Map<string, ArbitrageOpportunity> = new Map();
  private opportunityCounter = 0;

  constructor(options: ArbitrageScannerOptions) {
    super();

    this.poolManager = options.poolManager;
    this.connectionManager = options.connectionManager;
    this.config = options.config;
    this.scanIntervalMs = options.scanIntervalMs ?? 1000; // 1s default for fast arbitrage detection
    this.priceOracle = options.priceOracle ?? new EnhancedPriceOracle();

    this.initializeTokenPairs();
  }

  /**
   * Start scanning for arbitrage opportunities
   */
  async startScanning(): Promise<void> {
    if (this.isScanning) {
      throw new Error('Scanner is already running');
    }

    try {
      // Initial scan
      await this.scanForOpportunities();

      // Set flag immediately after successful initial scan to prevent race condition
      this.isScanning = true;

      // Start periodic scanning
      this.scanInterval = setInterval(async () => {
        try {
          await this.scanForOpportunities();
        } catch (error) {
          this.emit('scanError', error);
        }
      }, this.scanIntervalMs);

      this.emit('scanningStarted');
    } catch (error) {
      this.emit('scanError', error);
      throw error;
    }
  }

  /**
   * Stop scanning
   */
  stopScanning(): void {
    this.isScanning = false;

    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }

    // Clear active opportunities
    this.activeOpportunities.clear();

    this.emit('scanningStopped');
  }

  /**
   * Get all active arbitrage opportunities
   */
  getActiveOpportunities(): ArbitrageOpportunity[] {
    return Array.from(this.activeOpportunities.values());
  }

  /**
   * Get opportunity by ID
   */
  getOpportunity(opportunityId: string): ArbitrageOpportunity | undefined {
    return this.activeOpportunities.get(opportunityId);
  }

  /**
   * Force a single scan for opportunities
   */
  async scanForOpportunities(): Promise<void> {
    const scanStartTime = Date.now();

    try {
      // Get all current pool states
      const allPoolStates = this.poolManager.getAllPoolStates();

      // Scan each monitored token pair
      for (const [pairKey, tokenPair] of this.monitoredPairs) {
        const poolPairing = this.poolPairings.get(pairKey);
        if (!poolPairing) continue;

        await this.scanTokenPair(tokenPair, poolPairing, allPoolStates);
      }

      // Clean up expired opportunities
      this.cleanupExpiredOpportunities();

      const scanDuration = Date.now() - scanStartTime;
      this.emit('scanCompleted', {
        duration: scanDuration,
        opportunitiesFound: this.activeOpportunities.size,
        timestamp: scanStartTime,
      });
    } catch (error) {
      this.emit('scanError', error);
      throw error;
    }
  }

  /**
   * Initialize monitored token pairs from configuration
   */
  private initializeTokenPairs(): void {
    // Discover token pairs from existing pools since config uses string pairs
    this.updatePoolPairings();

    // Listen for pool updates to rebuild pairings
    this.poolManager.on('poolUpdated', () => {
      this.updatePoolPairings();
    });
  }

  /**
   * Update pool pairings based on current pool states
   */
  private updatePoolPairings(): void {
    const allPoolStates = this.poolManager.getAllPoolStates();

    // Clear existing pairings
    this.monitoredPairs.clear();
    this.poolPairings.clear();

    // Build pairings from current pools
    const pairMap = new Map<string, { uniV3Pools: Address[]; aeroPools: Address[] }>();

    for (const [poolAddress, poolState] of allPoolStates) {
      const pairKey = this.getPairKey(poolState.token0, poolState.token1);

      // Initialize pair if not exists
      if (!pairMap.has(pairKey)) {
        pairMap.set(pairKey, { uniV3Pools: [], aeroPools: [] });
        this.monitoredPairs.set(pairKey, { token0: poolState.token0, token1: poolState.token1 });
      }

      const pairing = pairMap.get(pairKey)!;

      if (poolState.type === PoolType.UNISWAP_V3) {
        pairing.uniV3Pools.push(poolAddress);
      } else if (
        poolState.type === PoolType.AERODROME_VOLATILE ||
        poolState.type === PoolType.AERODROME_STABLE
      ) {
        pairing.aeroPools.push(poolAddress);
      }
    }

    // Only keep pairs that have pools on both DEXs
    for (const [pairKey, pairing] of pairMap) {
      if (pairing.uniV3Pools.length > 0 && pairing.aeroPools.length > 0) {
        this.poolPairings.set(pairKey, pairing);
      } else {
        // Remove from monitored pairs if no cross-DEX opportunity
        this.monitoredPairs.delete(pairKey);
      }
    }
  }

  /**
   * Scan a specific token pair for arbitrage opportunities with route optimization
   */
  private async scanTokenPair(
    tokenPair: { token0: Address; token1: Address },
    poolPairing: { uniV3Pools: Address[]; aeroPools: Address[] },
    allPoolStates: Map<Address, any>
  ): Promise<void> {
    // Need at least one pool from each DEX
    if (poolPairing.uniV3Pools.length === 0 || poolPairing.aeroPools.length === 0) {
      return;
    }

    // Try route optimization first
    const routeOptimization = await this.optimizeRoutes(tokenPair, poolPairing, allPoolStates);

    if (routeOptimization) {
      // Create arbitrage opportunity with optimized routes
      const opportunity = await this.createArbitrageOpportunityWithRoutes(
        tokenPair,
        routeOptimization
      );

      // Check if this is a new or updated opportunity
      const existingOpportunity = this.findExistingOpportunity(
        tokenPair,
        routeOptimization.primaryRoute.spread.direction
      );

      if (existingOpportunity) {
        // Update existing opportunity if profit improved
        if (
          routeOptimization.primaryRoute.expectedProfit >
          BigInt(existingOpportunity.expectedProfit.toString())
        ) {
          this.activeOpportunities.set(existingOpportunity.id, opportunity);
          this.emit('opportunityUpdated', opportunity);
        }
      } else {
        // New opportunity
        this.activeOpportunities.set(opportunity.id, opportunity);
        this.emit('opportunityDetected', opportunity);
      }
    } else {
      // Fallback to simple pool selection if route optimization fails
      await this.scanTokenPairSimple(tokenPair, poolPairing, allPoolStates);
    }
  }

  /**
   * Optimize routes by evaluating all pool combinations and selecting the best ones
   */
  private async optimizeRoutes(
    tokenPair: { token0: Address; token1: Address },
    poolPairing: { uniV3Pools: Address[]; aeroPools: Address[] },
    allPoolStates: Map<Address, any>
  ): Promise<RouteOptimizationResult | undefined> {
    const candidateRoutes: ArbitrageRoute[] = [];

    // Evaluate all possible pool combinations
    for (const uniV3PoolAddress of poolPairing.uniV3Pools) {
      const uniV3Pool = allPoolStates.get(uniV3PoolAddress) as UniswapV3PoolState;
      if (!uniV3Pool || !uniV3Pool.isActive) continue;

      for (const aeroPoolAddress of poolPairing.aeroPools) {
        const aeroPool = allPoolStates.get(aeroPoolAddress) as
          | AerodromeVolatilePoolState
          | AerodromeStablePoolState;
        if (!aeroPool || !aeroPool.isActive) continue;

        // Evaluate this route combination
        const route = await this.evaluateRoute(uniV3Pool, aeroPool, tokenPair);
        if (route) {
          candidateRoutes.push(route);
        }
      }
    }

    if (candidateRoutes.length === 0) {
      return undefined;
    }

    // Sort routes by profitability (highest profit first)
    candidateRoutes.sort((a, b) => {
      // Primary sort: expected profit (using BigInt comparison to avoid precision loss)
      const profitDiff = b.expectedProfit - a.expectedProfit;
      if (profitDiff !== 0n) {
        return profitDiff > 0n ? 1 : -1;
      }

      // Secondary sort: profit margin
      return b.profitMargin - a.profitMargin;
    });

    // Select primary route and up to maxRoutes-1 fallback routes
    const maxRoutes = Math.min(this.config.maxRoutes, candidateRoutes.length);
    const primaryRoute = candidateRoutes[0];

    if (!primaryRoute) {
      return undefined;
    }

    const fallbackRoutes = candidateRoutes.slice(1, maxRoutes);

    return {
      primaryRoute,
      fallbackRoutes,
      totalRoutes: candidateRoutes.length,
      bestProfitMargin: primaryRoute.profitMargin,
    };
  }

  /**
   * Evaluate a specific route combination
   */
  private async evaluateRoute(
    uniV3Pool: UniswapV3PoolState,
    aeroPool: AerodromeVolatilePoolState | AerodromeStablePoolState,
    tokenPair: { token0: Address; token1: Address }
  ): Promise<ArbitrageRoute | undefined> {
    try {
      // Calculate prices on both DEXs
      const uniV3Price = this.calculateUniswapV3Price(uniV3Pool);
      const aeroPrice = this.calculateAerodromePrice(aeroPool);

      if (!uniV3Price || !aeroPrice) {
        return undefined;
      }

      // Calculate spread and direction
      const spread = this.calculateSpread(uniV3Price, aeroPrice);
      spread.tokenPair = [tokenPair.token0, tokenPair.token1];
      spread.uniswapV3Pool = uniV3Pool.address;
      spread.aerodromePool = aeroPool.address;

      if (spread.spread < this.config.minSpreadBps) {
        return undefined; // Spread too small
      }

      // Calculate optimal trade amount for this specific route
      const optimalAmount = await this.calculateOptimalTradeAmount(uniV3Pool, aeroPool, spread);
      if (optimalAmount === 0n) {
        return undefined; // No viable trade amount
      }

      // Calculate profitability for this route
      const profitCalc = await this.calculateProfitability(
        spread,
        optimalAmount,
        uniV3Pool,
        aeroPool
      );

      if (!profitCalc.isViable) {
        return undefined; // Not profitable after costs
      }

      // Calculate priority based on profit margin and spread
      const priority = Math.min(
        10,
        Math.max(1, Math.floor((profitCalc.profitMargin * spread.spread) / 100))
      );

      const routeId = `${uniV3Pool.address}-${aeroPool.address}-${Date.now()}`;

      return {
        id: routeId,
        uniV3Pool,
        aeroPool,
        spread,
        optimalAmount,
        expectedProfit: profitCalc.netProfit,
        profitMargin: profitCalc.profitMargin,
        gasEstimate: profitCalc.gasEstimate,
        priority,
      };
    } catch (error) {
      // Log error and continue with other routes
      return undefined;
    }
  }

  /**
   * Create arbitrage opportunity with optimized routes
   */
  private async createArbitrageOpportunityWithRoutes(
    tokenPair: { token0: Address; token1: Address },
    routeOptimization: RouteOptimizationResult
  ): Promise<ArbitrageOpportunity> {
    const primaryRoute = routeOptimization.primaryRoute;
    const opportunityId = `arb_${++this.opportunityCounter}_${Date.now()}`;
    const now = Date.now();

    // Determine source and target based on direction
    const isAeroToUni = primaryRoute.spread.direction === 'aero_to_uni';
    const sourcePool = isAeroToUni ? primaryRoute.aeroPool.address : primaryRoute.uniV3Pool.address;
    const targetPool = isAeroToUni ? primaryRoute.uniV3Pool.address : primaryRoute.aeroPool.address;
    const sourceDex = isAeroToUni ? 'aerodrome' : 'uniswap-v3';
    const targetDex = isAeroToUni ? 'uniswap-v3' : 'aerodrome';

    // Create primary route
    const route: Route = {
      pools: [sourcePool, targetPool],
      fees: [primaryRoute.uniV3Pool.fee, 0], // Aerodrome fees are dynamic
      directions: [true, false], // Simplified
      expectedGas: Number(primaryRoute.gasEstimate),
      priceImpact: primaryRoute.spread.spread, // Use spread as price impact estimate
    };

    // Create fallback routes
    const fallbackRoutes: Route[] = routeOptimization.fallbackRoutes.map(fallbackRoute => {
      const isFallbackAeroToUni = fallbackRoute.spread.direction === 'aero_to_uni';
      const fallbackSourcePool = isFallbackAeroToUni
        ? fallbackRoute.aeroPool.address
        : fallbackRoute.uniV3Pool.address;
      const fallbackTargetPool = isFallbackAeroToUni
        ? fallbackRoute.uniV3Pool.address
        : fallbackRoute.aeroPool.address;

      return {
        pools: [fallbackSourcePool, fallbackTargetPool],
        fees: [fallbackRoute.uniV3Pool.fee, 0],
        directions: [true, false],
        expectedGas: Number(fallbackRoute.gasEstimate),
        priceImpact: fallbackRoute.spread.spread,
      };
    });

    // Get current ETH price and use it for profit calculation
    const ethUsdPrice = await this.priceOracle.getEthUsdPrice();
    const minProfitWei = await this.calculateMinProfitWei(ethUsdPrice);

    return {
      id: opportunityId,
      timestamp: now,
      type: 'arbitrage',
      status: OpportunityStatus.DETECTED,

      // Route information
      tokenIn: tokenPair.token0,
      tokenOut: tokenPair.token1,
      amountIn: primaryRoute.optimalAmount,
      expectedAmountOut: primaryRoute.optimalAmount + primaryRoute.expectedProfit,

      // DEX routing with fallbacks
      route,
      fallbackRoutes,

      // Profitability
      flashFee: (primaryRoute.optimalAmount * 5n) / 10000n, // 0.05% flash loan fee
      gasEstimate: primaryRoute.gasEstimate,
      expectedProfit: primaryRoute.expectedProfit,
      minProfit: minProfitWei,
      profitMargin: primaryRoute.profitMargin,

      // Execution parameters
      slippageTolerance: this.config.maxSlippageBps / 100, // Convert to percentage
      deadline: now + 30000, // 30s default
      maxBribe: ethers.parseEther('0.01'), // 0.01 ETH max bribe
      priority: primaryRoute.priority,

      // Metadata
      detectedAt: now,
      expiresAt: now + 30000, // 30s default
      source: 'arbitrage-scanner',

      // Arbitrage-specific fields
      sourcePool,
      targetPool,
      sourceDex,
      targetDex,
      spread: primaryRoute.spread.spread,
      spreadAfterCosts: Math.max(
        0,
        primaryRoute.spread.spread -
          Number(
            (primaryRoute.gasEstimate * (await this.getCurrentGasPrice()) * 10000n) /
              primaryRoute.optimalAmount
          )
      ),
    };
  }

  /**
   * Get optimized routes for a specific token pair (public method for external access)
   */
  async getOptimizedRoutes(tokenPair: {
    token0: Address;
    token1: Address;
  }): Promise<RouteOptimizationResult | undefined> {
    const pairKey = this.getPairKey(tokenPair.token0, tokenPair.token1);
    const poolPairing = this.poolPairings.get(pairKey);

    if (!poolPairing) {
      return undefined;
    }

    const allPoolStates = this.poolManager.getAllPoolStates();
    return this.optimizeRoutes(tokenPair, poolPairing, allPoolStates);
  }

  /**
   * Get the best route for a specific token pair
   */
  async getBestRoute(tokenPair: {
    token0: Address;
    token1: Address;
  }): Promise<ArbitrageRoute | undefined> {
    const optimization = await this.getOptimizedRoutes(tokenPair);
    return optimization?.primaryRoute;
  }

  /**
   * Get all viable routes for a specific token pair, sorted by profitability
   */
  async getAllViableRoutes(tokenPair: {
    token0: Address;
    token1: Address;
  }): Promise<ArbitrageRoute[]> {
    const optimization = await this.getOptimizedRoutes(tokenPair);
    if (!optimization) {
      return [];
    }

    return [optimization.primaryRoute, ...optimization.fallbackRoutes];
  }

  /**
   * Calculate Uniswap V3 price from pool state
   */
  private calculateUniswapV3Price(poolState: UniswapV3PoolState): bigint | undefined {
    try {
      const sqrtPriceX96 = BigInt(poolState.sqrtPriceX96.toString());

      // Convert sqrtPriceX96 to price
      // price = (sqrtPriceX96 / 2^96)^2
      const Q96 = 2n ** 96n;
      const price = (sqrtPriceX96 * sqrtPriceX96) / (Q96 * Q96);

      return price;
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Find the best Uniswap V3 pool (highest liquidity)
   */
  private findBestUniswapV3Pool(
    poolAddresses: Address[],
    allPoolStates: Map<Address, any>
  ): UniswapV3PoolState | undefined {
    let bestPool: UniswapV3PoolState | undefined;
    let highestLiquidity = 0n;

    for (const poolAddress of poolAddresses) {
      const poolState = allPoolStates.get(poolAddress) as UniswapV3PoolState;
      if (!poolState || !poolState.isActive) continue;

      const liquidity = BigInt(poolState.liquidity.toString());
      if (liquidity > highestLiquidity) {
        highestLiquidity = liquidity;
        bestPool = poolState;
      }
    }

    return bestPool;
  }

  /**
   * Find the best Aerodrome pool (highest TVL using geometric mean)
   */
  private findBestAerodromePool(
    poolAddresses: Address[],
    allPoolStates: Map<Address, any>
  ): AerodromeVolatilePoolState | AerodromeStablePoolState | undefined {
    let bestPool: AerodromeVolatilePoolState | AerodromeStablePoolState | undefined;
    let highestTvl = 0n;

    for (const poolAddress of poolAddresses) {
      const poolState = allPoolStates.get(poolAddress) as
        | AerodromeVolatilePoolState
        | AerodromeStablePoolState;
      if (!poolState || !poolState.isActive) continue;

      // Calculate TVL using geometric mean: sqrt(reserve0 * reserve1)
      const reserve0 = BigInt(poolState.reserve0.toString());
      const reserve1 = BigInt(poolState.reserve1.toString());

      if (reserve0 === 0n || reserve1 === 0n) {
        continue; // Skip pools with zero reserves
      }

      // Handle potential overflow by scaling down if necessary
      let tvl: bigint;
      try {
        const product = reserve0 * reserve1;
        tvl = bigintSqrt(product);
      } catch (error) {
        // If overflow occurs, scale down and try again
        const scaledReserve0 = reserve0 / 1000n;
        const scaledReserve1 = reserve1 / 1000n;
        if (scaledReserve0 > 0n && scaledReserve1 > 0n) {
          tvl = bigintSqrt(scaledReserve0 * scaledReserve1) * 1000n;
        } else {
          continue; // Skip if reserves too small after scaling
        }
      }

      if (tvl > highestTvl) {
        highestTvl = tvl;
        bestPool = poolState;
      }
    }

    return bestPool;
  }

  /**
   * Calculate Aerodrome price from pool state
   */
  private calculateAerodromePrice(
    poolState: AerodromeVolatilePoolState | AerodromeStablePoolState
  ): bigint | undefined {
    try {
      const reserve0 = BigInt(poolState.reserve0.toString());
      const reserve1 = BigInt(poolState.reserve1.toString());

      if (reserve0 === 0n || reserve1 === 0n) {
        return undefined;
      }

      if (poolState.type === PoolType.AERODROME_STABLE) {
        const stableState = poolState as AerodromeStablePoolState;
        // Adjust for decimals in stable pools
        const decimals0 = BigInt(10 ** stableState.decimals0);

        // Normalize reserves by decimals
        const normalizedReserve1 = reserve1 * decimals0;

        return normalizedReserve1 / reserve0;
      } else {
        // Simple ratio for volatile pools
        return reserve1 / reserve0;
      }
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Calculate spread between two prices
   */
  private calculateSpread(uniV3Price: bigint, aeroPrice: bigint): ArbitrageSpread {
    const priceDiff = uniV3Price > aeroPrice ? uniV3Price - aeroPrice : aeroPrice - uniV3Price;
    const basePrice = uniV3Price > aeroPrice ? aeroPrice : uniV3Price;

    // Calculate spread in basis points
    const spreadBps = basePrice > 0n ? Number((priceDiff * 10000n) / basePrice) : 0;

    return {
      tokenPair: ['0x', '0x'] as [Address, Address], // Will be filled by caller
      uniswapV3Pool: '0x' as Address, // Will be filled by caller
      aerodromePool: '0x' as Address, // Will be filled by caller
      uniswapV3Price: uniV3Price,
      aerodromePrice: aeroPrice,
      spread: spreadBps,
      direction: uniV3Price > aeroPrice ? 'aero_to_uni' : 'uni_to_aero',
    };
  }

  /**
   * Calculate optimal trade amount using mathematical optimization
   */
  private async calculateOptimalTradeAmount(
    uniV3Pool: UniswapV3PoolState,
    aeroPool: AerodromeVolatilePoolState | AerodromeStablePoolState,
    spread: ArbitrageSpread
  ): Promise<bigint> {
    try {
      // Import optimization utilities
      const { calculateOptimalTradeSize } = await import('../utils/swap-simulation');

      // Build swap route for optimization
      const route: any[] = [];
      const poolStates = new Map();

      if (spread.direction === 'uni_to_aero') {
        route.push({
          poolAddress: uniV3Pool.address,
          tokenIn: uniV3Pool.token0,
          tokenOut: uniV3Pool.token1,
          protocol: 'uniswap-v3',
        });
        route.push({
          poolAddress: aeroPool.address,
          tokenIn: uniV3Pool.token1,
          tokenOut: uniV3Pool.token0,
          protocol: 'aerodrome',
        });
        poolStates.set(uniV3Pool.address, uniV3Pool);
        poolStates.set(aeroPool.address, aeroPool);
      } else {
        route.push({
          poolAddress: aeroPool.address,
          tokenIn: aeroPool.token0,
          tokenOut: aeroPool.token1,
          protocol: 'aerodrome',
        });
        route.push({
          poolAddress: uniV3Pool.address,
          tokenIn: aeroPool.token1,
          tokenOut: aeroPool.token0,
          protocol: 'uniswap-v3',
        });
        poolStates.set(aeroPool.address, aeroPool);
        poolStates.set(uniV3Pool.address, uniV3Pool);
      }

      // Calculate maximum trade size based on available liquidity
      const uniV3TokenAmount = this.estimateUniV3TokenAmount(uniV3Pool);
      const aeroTokenAmount = this.getAerodromeTokenAmount(aeroPool);
      const maxTradeSize = uniV3TokenAmount < aeroTokenAmount ? uniV3TokenAmount : aeroTokenAmount;

      if (maxTradeSize === 0n) {
        return 0n;
      }

      // Cap at 5% of available liquidity to prevent excessive price impact
      const cappedMaxSize = (maxTradeSize * 5n) / 100n;

      // Get current gas price for optimization
      const gasPrice = await this.getCurrentGasPrice();

      // Use mathematical optimization to find optimal size
      const optimization = calculateOptimalTradeSize(
        route,
        poolStates,
        cappedMaxSize,
        0.0005, // 0.05% flash loan fee
        gasPrice
      );

      // Ensure minimum viable size ($50 equivalent for Base L2)
      const minAmountWei = ethers.parseEther('0.02'); // ~$50 at $2500 ETH

      if (optimization.optimalSize < minAmountWei) {
        return optimization.maxProfit > 0n ? minAmountWei : 0n;
      }

      return optimization.optimalSize;
    } catch (error) {
      // Fallback to conservative sizing if optimization fails
      return this.calculateConservativeTradeAmount(uniV3Pool, aeroPool, spread);
    }
  }

  /**
   * Fallback conservative trade amount calculation
   */
  private calculateConservativeTradeAmount(
    uniV3Pool: UniswapV3PoolState,
    aeroPool: AerodromeVolatilePoolState | AerodromeStablePoolState,
    spread: ArbitrageSpread
  ): bigint {
    const uniV3TokenAmount = this.estimateUniV3TokenAmount(uniV3Pool);
    const aeroTokenAmount = this.getAerodromeTokenAmount(aeroPool);

    const availableTokenAmount =
      uniV3TokenAmount > 0n && aeroTokenAmount > 0n
        ? uniV3TokenAmount < aeroTokenAmount
          ? uniV3TokenAmount
          : aeroTokenAmount
        : uniV3TokenAmount > 0n
          ? uniV3TokenAmount
          : aeroTokenAmount;

    if (availableTokenAmount === 0n) {
      return 0n;
    }

    // Conservative sizing: 1% of available liquidity
    const baseAmount = availableTokenAmount / 100n;

    // Adjust based on spread (higher spread = larger size)
    const spreadMultiplier = Math.min(2, Math.max(0.5, spread.spread / 100));
    const adjustedAmount = BigInt(Math.floor(Number(baseAmount) * spreadMultiplier));

    // Minimum viable size for Base L2
    const minAmountWei = ethers.parseEther('0.02');

    return adjustedAmount > minAmountWei ? adjustedAmount : minAmountWei;
  }

  /**
   * Estimate token amount available in Uniswap V3 pool with conservative approach
   */
  private estimateUniV3TokenAmount(poolState: UniswapV3PoolState): bigint {
    try {
      const liquidity = BigInt(poolState.liquidity.toString());
      const sqrtPriceX96 = BigInt(poolState.sqrtPriceX96.toString());

      if (liquidity === 0n || sqrtPriceX96 === 0n) {
        return 0n;
      }

      // Conservative estimation: use 1% of liquidity
      const Q96 = 2n ** 96n;

      // Estimate token0 amount from liquidity and price
      const estimatedAmount0 = (liquidity * Q96) / sqrtPriceX96;

      // Use conservative fraction: 1% of liquidity
      const conservativeEstimate = liquidity / 100n; // 1% of liquidity

      return estimatedAmount0 < conservativeEstimate ? estimatedAmount0 : conservativeEstimate;
    } catch (error) {
      // Fallback to conservative estimate: 1% of liquidity
      const liquidity = BigInt(poolState.liquidity.toString());
      if (liquidity === 0n) {
        return 0n; // Zero liquidity safety check
      }
      return liquidity / 100n; // 1% of liquidity as fallback
    }
  }

  /**
   * Get comparable token amount from Aerodrome pool
   */
  private getAerodromeTokenAmount(
    poolState: AerodromeVolatilePoolState | AerodromeStablePoolState
  ): bigint {
    const reserve0 = BigInt(poolState.reserve0.toString());
    const reserve1 = BigInt(poolState.reserve1.toString());

    // Return the smaller of the two reserves as the limiting factor
    return reserve0 < reserve1 ? reserve0 : reserve1;
  }

  /**
   * Calculate profitability using accurate swap simulation
   */
  private async calculateProfitability(
    spread: ArbitrageSpread,
    tradeAmount: bigint,
    uniV3Pool: UniswapV3PoolState,
    aeroPool: AerodromeVolatilePoolState | AerodromeStablePoolState
  ): Promise<ProfitCalculation> {
    try {
      // Import swap simulation utilities
      const { simulateArbitrageRoute } = await import('../utils/swap-simulation');
      const { getProfitThreshold, validateProfitThreshold } =
        await import('../config/profit-thresholds');

      // Build swap route based on arbitrage direction
      const route: any[] = [];
      const poolStates = new Map();

      if (spread.direction === 'uni_to_aero') {
        // Buy on Uniswap V3, sell on Aerodrome
        route.push({
          poolAddress: uniV3Pool.address,
          tokenIn: uniV3Pool.token0,
          tokenOut: uniV3Pool.token1,
          protocol: 'uniswap-v3',
          amountIn: tradeAmount,
        });
        route.push({
          poolAddress: aeroPool.address,
          tokenIn: uniV3Pool.token1,
          tokenOut: uniV3Pool.token0,
          protocol: 'aerodrome',
          amountIn: 0n, // Will be set by simulation
        });
        poolStates.set(uniV3Pool.address, uniV3Pool);
        poolStates.set(aeroPool.address, aeroPool);
      } else {
        // Buy on Aerodrome, sell on Uniswap V3
        route.push({
          poolAddress: aeroPool.address,
          tokenIn: aeroPool.token0,
          tokenOut: aeroPool.token1,
          protocol: 'aerodrome',
          amountIn: tradeAmount,
        });
        route.push({
          poolAddress: uniV3Pool.address,
          tokenIn: aeroPool.token1,
          tokenOut: aeroPool.token0,
          protocol: 'uniswap-v3',
          amountIn: 0n, // Will be set by simulation
        });
        poolStates.set(aeroPool.address, aeroPool);
        poolStates.set(uniV3Pool.address, uniV3Pool);
      }

      // Get real-time gas price
      const gasPrice = await this.getCurrentGasPrice();

      // Simulate the complete arbitrage route
      const simulation = simulateArbitrageRoute(
        route,
        tradeAmount,
        poolStates,
        0.0005, // 0.05% flash loan fee
        gasPrice
      );

      // Calculate profit margin in percentage for validation
      const profitMarginPercent = simulation.profitMarginBps / 100;

      // Get ETH price for USD conversion
      const ethUsdPrice = await this.priceOracle.getEthUsdPrice();
      const netProfitUsd = (Number(simulation.netProfit) / 1e18) * ethUsdPrice;

      // Validate against profit thresholds and use threshold data
      const threshold = getProfitThreshold('arbitrage');
      const validation = validateProfitThreshold(
        'arbitrage',
        netProfitUsd,
        simulation.profitMarginBps
      );

      // Log threshold information for debugging
      if (this.logger?.debug) {
        this.logger.debug('Profit validation', {
          netProfitUsd,
          profitMarginBps: simulation.profitMarginBps,
          thresholdMinUsd: threshold.minProfitUsd,
          thresholdMinMarginBps: threshold.minProfitMarginBps,
          validationPassed: validation.valid,
        });
      }

      return {
        grossProfit:
          simulation.finalAmountOut > tradeAmount ? simulation.finalAmountOut - tradeAmount : 0n,
        flashLoanFee: BigInt(Math.floor(Number(tradeAmount) * 0.0005)),
        gasEstimate: simulation.totalGasEstimate,
        gasCost: simulation.totalGasEstimate * gasPrice,
        slippageCost: BigInt(
          Math.floor((Number(tradeAmount) * simulation.totalPriceImpact) / 10000)
        ),
        netProfit: simulation.netProfit,
        profitMargin: profitMarginPercent,
        isViable: validation.valid && simulation.profitable,
      };
    } catch (error) {
      // Fallback to simplified calculation if simulation fails
      const gasPrice = await this.getCurrentGasPrice();
      const gasEstimate = 300000n;
      const gasCost = gasEstimate * gasPrice;
      const flashLoanFee = (tradeAmount * 5n) / 10000n; // 0.05%

      // Use slippage calculation for more accurate fallback
      const slippageCost = await this.calculateSlippageCost(tradeAmount, uniV3Pool, aeroPool);

      return {
        grossProfit: 0n,
        flashLoanFee,
        gasEstimate,
        gasCost,
        slippageCost,
        netProfit: 0n,
        profitMargin: 0,
        isViable: false,
      };
    }
  }

  /**
   * Get current gas price from the network
   */
  private async getCurrentGasPrice(): Promise<bigint> {
    try {
      const provider = this.connectionManager.getProvider();
      const feeData = await provider.getFeeData();

      // Use maxFeePerGas if available (EIP-1559), otherwise gasPrice
      const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;

      if (gasPrice) {
        return BigInt(gasPrice.toString());
      }
    } catch (error) {
      // Fallback on error
    }

    // Safe fallback: 2 gwei
    return 2000000000n;
  }

  /**
   * Calculate minimum profit in Wei based on USD amount and current ETH price
   */
  private async calculateMinProfitWei(ethUsdPrice: number): Promise<bigint> {
    try {
      const { getProfitThreshold } = await import('../config/profit-thresholds');
      const threshold = getProfitThreshold('arbitrage');
      const minProfitEth = threshold.minProfitUsd / ethUsdPrice;
      return ethers.parseEther(minProfitEth.toString());
    } catch (error) {
      // Fallback calculation using Base L2 optimized threshold
      const fallbackMinProfitUsd = 8.0; // Base L2 optimized
      const minProfitEth = fallbackMinProfitUsd / Math.max(ethUsdPrice, 1000); // Prevent division by very small numbers
      return ethers.parseEther(minProfitEth.toString());
    }
  }

  /**
   * Calculate slippage cost based on pool liquidity and trade size
   * Integrated with new simulation but kept for backward compatibility
   */
  private async calculateSlippageCost(
    tradeAmount: bigint,
    uniV3Pool: UniswapV3PoolState,
    aeroPool: AerodromeVolatilePoolState | AerodromeStablePoolState
  ): Promise<bigint> {
    // This method is now replaced by swap simulation but kept for compatibility
    try {
      // Calculate price impact based on pool liquidity
      const uniV3Impact = this.calculateUniV3PriceImpact(tradeAmount, uniV3Pool);
      const aeroImpact = this.calculateAerodromePriceImpact(tradeAmount, aeroPool);

      // Use the higher of the two impacts
      const maxImpactBps = Math.max(uniV3Impact, aeroImpact);

      // Cap at configured maximum slippage
      const cappedImpactBps = Math.min(maxImpactBps, this.config.maxSlippageBps);

      // Log slippage calculation for monitoring
      if (this.logger?.debug) {
        this.logger.debug('Slippage cost calculated', {
          tradeAmount: tradeAmount.toString(),
          uniV3Impact,
          aeroImpact,
          maxImpactBps,
          cappedImpactBps,
        });
      }

      // Use the calculated slippage cost in fallback profit calculations
      const slippageCost = (tradeAmount * BigInt(cappedImpactBps)) / 10000n;
      return slippageCost;
    } catch (error) {
      // Fallback to configured max slippage
      const slippageBps = BigInt(this.config.maxSlippageBps);
      return (tradeAmount * slippageBps) / 10000n;
    }
  }

  /**
   * Calculate price impact for Uniswap V3 trade
   */
  private calculateUniV3PriceImpact(tradeAmount: bigint, poolState: UniswapV3PoolState): number {
    try {
      const liquidity = BigInt(poolState.liquidity.toString());

      if (liquidity === 0n) {
        return this.config.maxSlippageBps; // Max slippage if no liquidity
      }

      // Simplified price impact calculation
      // impact ≈ tradeAmount / liquidity * 10000 (in basis points)
      const impactRatio = (tradeAmount * 10000n) / liquidity;

      // Cap at reasonable maximum and convert to number
      return Math.min(Number(impactRatio), this.config.maxSlippageBps);
    } catch (error) {
      return this.config.maxSlippageBps / 2; // Conservative fallback
    }
  }

  /**
   * Calculate price impact for Aerodrome trade
   */
  private calculateAerodromePriceImpact(
    tradeAmount: bigint,
    poolState: AerodromeVolatilePoolState | AerodromeStablePoolState
  ): number {
    try {
      const reserve0 = BigInt(poolState.reserve0.toString());
      const reserve1 = BigInt(poolState.reserve1.toString());

      // Use the smaller reserve as the limiting factor
      const limitingReserve = reserve0 < reserve1 ? reserve0 : reserve1;

      if (limitingReserve === 0n) {
        return this.config.maxSlippageBps; // Max slippage if no reserves
      }

      // Simplified price impact calculation
      // impact ≈ tradeAmount / limitingReserve * 10000 (in basis points)
      const impactRatio = (tradeAmount * 10000n) / limitingReserve;

      // Cap at reasonable maximum and convert to number
      return Math.min(Number(impactRatio), this.config.maxSlippageBps);
    } catch (error) {
      return this.config.maxSlippageBps / 2; // Conservative fallback
    }
  }

  /**
   * Create arbitrage opportunity object (alternative method for simple cases)
   */
  private async createArbitrageOpportunity(
    tokenPair: { token0: Address; token1: Address },
    spread: ArbitrageSpread,
    tradeAmount: bigint,
    profitCalc: ProfitCalculation,
    uniV3Pool: UniswapV3PoolState,
    aeroPool: AerodromeVolatilePoolState | AerodromeStablePoolState
  ): Promise<ArbitrageOpportunity> {
    const opportunityId = `arb_${++this.opportunityCounter}_${Date.now()}`;
    const now = Date.now();

    // Determine source and target based on direction
    const isAeroToUni = spread.direction === 'aero_to_uni';
    const sourcePool = isAeroToUni ? aeroPool.address : uniV3Pool.address;
    const targetPool = isAeroToUni ? uniV3Pool.address : aeroPool.address;
    const sourceDex = isAeroToUni ? 'aerodrome' : 'uniswap-v3';
    const targetDex = isAeroToUni ? 'uniswap-v3' : 'aerodrome';

    // Create route
    const route: Route = {
      pools: [sourcePool, targetPool],
      fees: [uniV3Pool.fee, 0], // Aerodrome fees are dynamic
      directions: [true, false], // Simplified
      expectedGas: Number(profitCalc.gasEstimate),
      priceImpact: spread.spread, // Use spread as price impact estimate
    };

    return {
      id: opportunityId,
      timestamp: now,
      type: 'arbitrage',
      status: OpportunityStatus.DETECTED,

      // Route information
      tokenIn: tokenPair.token0,
      tokenOut: tokenPair.token1,
      amountIn: tradeAmount,
      expectedAmountOut: tradeAmount + profitCalc.netProfit,

      // DEX routing
      route,
      fallbackRoutes: [], // Will be populated by route optimization

      // Profitability
      flashFee: profitCalc.flashLoanFee,
      gasEstimate: profitCalc.gasEstimate,
      expectedProfit: profitCalc.netProfit,
      minProfit: await this.calculateMinProfitWei(await this.priceOracle.getEthUsdPrice()),
      profitMargin: profitCalc.profitMargin,

      // Execution parameters
      slippageTolerance: this.config.maxSlippageBps / 100, // Convert to percentage
      deadline: now + 30000, // 30s default
      maxBribe: ethers.parseEther('0.01'), // 0.01 ETH max bribe
      priority: Math.min(10, Math.max(1, Math.floor(spread.spread / 10))), // 1-10 based on spread

      // Metadata
      detectedAt: now,
      expiresAt: now + 30000, // 30s default
      source: 'arbitrage-scanner',

      // Arbitrage-specific fields
      sourcePool,
      targetPool,
      sourceDex,
      targetDex,
      spread: spread.spread,
      spreadAfterCosts: Math.max(
        0,
        spread.spread -
          Number(
            ((profitCalc.flashLoanFee + profitCalc.gasCost + profitCalc.slippageCost) * 10000n) /
              tradeAmount
          )
      ),
    };
  }

  /**
   * Scan token pair using simple pool selection (fallback method)
   */
  private async scanTokenPairSimple(
    tokenPair: { token0: Address; token1: Address },
    poolPairing: { uniV3Pools: Address[]; aeroPools: Address[] },
    allPoolStates: Map<Address, any>
  ): Promise<void> {
    // Use the pool selection methods to find best pools
    const bestUniV3Pool = this.findBestUniswapV3Pool(poolPairing.uniV3Pools, allPoolStates);
    const bestAeroPool = this.findBestAerodromePool(poolPairing.aeroPools, allPoolStates);

    if (!bestUniV3Pool || !bestAeroPool) {
      return; // No suitable pools found
    }

    // Calculate prices on both DEXs
    const uniV3Price = this.calculateUniswapV3Price(bestUniV3Pool);
    const aeroPrice = this.calculateAerodromePrice(bestAeroPool);

    if (!uniV3Price || !aeroPrice) {
      return;
    }

    // Calculate spread and direction
    const spread = this.calculateSpread(uniV3Price, aeroPrice);
    spread.tokenPair = [tokenPair.token0, tokenPair.token1];
    spread.uniswapV3Pool = bestUniV3Pool.address;
    spread.aerodromePool = bestAeroPool.address;

    if (spread.spread < this.config.minSpreadBps) {
      return; // Spread too small
    }

    // Calculate optimal trade amount
    const optimalAmount = await this.calculateOptimalTradeAmount(
      bestUniV3Pool,
      bestAeroPool,
      spread
    );
    if (optimalAmount === 0n) {
      return; // No viable trade amount
    }

    // Calculate profitability
    const profitCalc = await this.calculateProfitability(
      spread,
      optimalAmount,
      bestUniV3Pool,
      bestAeroPool
    );

    if (!profitCalc.isViable) {
      return; // Not profitable after costs
    }

    // Create arbitrage opportunity using the simple method
    const opportunity = await this.createArbitrageOpportunity(
      tokenPair,
      spread,
      optimalAmount,
      profitCalc,
      bestUniV3Pool,
      bestAeroPool
    );

    // Check if this is a new or updated opportunity
    const existingOpportunity = this.findExistingOpportunity(tokenPair, spread.direction);

    if (existingOpportunity) {
      // Update existing opportunity if profit improved
      if (profitCalc.netProfit > BigInt(existingOpportunity.expectedProfit.toString())) {
        this.activeOpportunities.set(existingOpportunity.id, opportunity);
        this.emit('opportunityUpdated', opportunity);
      }
    } else {
      // New opportunity
      this.activeOpportunities.set(opportunity.id, opportunity);
      this.emit('opportunityDetected', opportunity);
    }
  }

  /**
   * Find existing opportunity for the same token pair and direction
   */
  private findExistingOpportunity(
    tokenPair: { token0: Address; token1: Address },
    direction: 'uni_to_aero' | 'aero_to_uni'
  ): ArbitrageOpportunity | undefined {
    for (const opportunity of this.activeOpportunities.values()) {
      if (
        opportunity.tokenIn === tokenPair.token0 &&
        opportunity.tokenOut === tokenPair.token1 &&
        ((direction === 'uni_to_aero' && opportunity.sourceDex === 'uniswap-v3') ||
          (direction === 'aero_to_uni' && opportunity.sourceDex === 'aerodrome'))
      ) {
        return opportunity;
      }
    }
    return undefined;
  }

  /**
   * Clean up expired opportunities
   */
  private cleanupExpiredOpportunities(): void {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, opportunity] of this.activeOpportunities) {
      if (opportunity.expiresAt < now) {
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      const opportunity = this.activeOpportunities.get(id);
      this.activeOpportunities.delete(id);
      if (opportunity) {
        this.emit('opportunityExpired', opportunity);
      }
    }
  }

  /**
   * Generate pair key for token pair
   */
  private getPairKey(token0: Address, token1: Address): string {
    // Ensure consistent ordering
    const [tokenA, tokenB] =
      token0.toLowerCase() < token1.toLowerCase() ? [token0, token1] : [token1, token0];
    return `${tokenA}-${tokenB}`;
  }
}
