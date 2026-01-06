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
import { createComponentLogger } from '../utils/logger';

// Interface definitions for arbitrage scanner
export interface ArbitrageSpread {
  tokenPair: [Address, Address];
  uniswapV3Pool: Address;
  aerodromePool: Address;
  uniswapV3Price: bigint;
  aerodromePrice: bigint;
  spread: number; // in basis points
  direction: 'uni_to_aero' | 'aero_to_uni';
}

export interface ArbitrageRoute {
  id: string;
  uniV3Pool: UniswapV3PoolState;
  aeroPool: AerodromeVolatilePoolState | AerodromeStablePoolState;
  spread: ArbitrageSpread;
  optimalAmount: bigint;
  expectedProfit: bigint;
  profitMargin: number;
  gasEstimate: bigint;
  priority: number;
}

export interface RouteOptimizationResult {
  primaryRoute: ArbitrageRoute;
  fallbackRoutes: ArbitrageRoute[];
  totalRoutes: number;
  bestProfitMargin: number;
}

export interface ProfitCalculation {
  grossProfit: bigint;
  flashLoanFee: bigint;
  gasEstimate: bigint;
  gasCost: bigint;
  slippageCost: bigint;
  netProfit: bigint;
  profitMargin: number;
  isViable: boolean;
}

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

// Enhanced price oracle implementation
export class EnhancedPriceOracle implements IPriceOracle {
  private cachedPrice?: { price: number; timestamp: number };
  private readonly cacheTimeMs = 60000; // 1 minute cache

  async getEthUsdPrice(): Promise<number> {
    // Check cache first
    if (this.cachedPrice && Date.now() - this.cachedPrice.timestamp < this.cacheTimeMs) {
      return this.cachedPrice.price;
    }

    try {
      const price = await this.fetchEthPriceFromApi();
      this.cachedPrice = { price, timestamp: Date.now() };
      return price;
    } catch (error) {
      // Return cached price if available
      if (this.cachedPrice) {
        return this.cachedPrice.price;
      }

      // Ultimate fallback
      console.warn('Failed to get ETH price from all sources');
      return 2500; // Reasonable fallback price
    }
  }

  private async fetchEthPriceFromApi(): Promise<number> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as any;

      if (!data.ethereum || typeof data.ethereum.usd !== 'number') {
        throw new Error('Invalid API response');
      }

      return data.ethereum.usd;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }
}

export class ArbitrageScanner extends EventEmitter {
  private readonly poolManager: PoolManager;
  private readonly connectionManager: RpcConnectionManager;
  private readonly config: ArbitrageConfig;
  private readonly scanIntervalMs: number;
  private readonly priceOracle: IPriceOracle;
  private readonly logger = createComponentLogger('arbitrage-scanner');

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
    this.scanIntervalMs = options.scanIntervalMs ?? 3000; // 3s default for Base L2
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

      if (allPoolStates.size === 0) {
        this.logger.warn('No pool states available for scanning');
        return;
      }

      // Update pool pairings if needed
      if (this.monitoredPairs.size === 0) {
        this.updatePoolPairings();
      }

      let totalOpportunities = 0;

      // Scan each monitored token pair
      for (const [pairKey, tokenPair] of this.monitoredPairs) {
        const poolPairing = this.poolPairings.get(pairKey);
        if (!poolPairing) continue;

        try {
          const opportunities = await this.scanTokenPair(tokenPair, poolPairing, allPoolStates);
          totalOpportunities += opportunities;
        } catch (error) {
          this.logger.warn(`Failed to scan token pair ${pairKey}:`, error);
        }
      }

      // Clean up expired opportunities
      this.cleanupExpiredOpportunities();

      const scanDuration = Date.now() - scanStartTime;

      this.emit('scanCompleted', {
        duration: scanDuration,
        opportunitiesFound: totalOpportunities,
        totalActiveOpportunities: this.activeOpportunities.size,
        timestamp: scanStartTime,
        poolsScanned: allPoolStates.size,
        pairsScanned: this.monitoredPairs.size,
      });

      if (totalOpportunities > 0) {
        this.logger.info(`Found ${totalOpportunities} new opportunities in ${scanDuration}ms`);
      }

    } catch (error) {
      this.emit('scanError', error);
      this.logger.error('Scan failed:', error);
      throw error;
    }
  }

  /**
   * Initialize monitored token pairs from configuration
   */
  private initializeTokenPairs(): void {
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

    if (allPoolStates.size === 0) {
      this.logger.warn('No pool states available for pairing update');
      return;
    }

    // Clear existing pairings
    this.monitoredPairs.clear();
    this.poolPairings.clear();

    // Build pairings from current pools
    const pairMap = new Map<string, { uniV3Pools: Address[]; aeroPools: Address[] }>();

    for (const [poolAddress, poolState] of allPoolStates) {
      try {
        const pairKey = this.getPairKey(poolState.token0, poolState.token1);

        // Initialize pair if not exists
        if (!pairMap.has(pairKey)) {
          pairMap.set(pairKey, { uniV3Pools: [], aeroPools: [] });
          this.monitoredPairs.set(pairKey, { token0: poolState.token0, token1: poolState.token1 });
        }

        const pairing = pairMap.get(pairKey)!;

        // Categorize by pool type
        if (poolState.type === PoolType.UNISWAP_V3) {
          pairing.uniV3Pools.push(poolAddress);
        } else if (
          poolState.type === PoolType.AERODROME_VOLATILE ||
          poolState.type === PoolType.AERODROME_STABLE
        ) {
          pairing.aeroPools.push(poolAddress);
        }
      } catch (error) {
        this.logger.warn(`Failed to process pool ${poolAddress} for pairing:`, error);
      }
    }

    // Filter pairs that have both DEX types
    let crossDexPairs = 0;
    for (const [pairKey, pairing] of pairMap) {
      if (pairing.uniV3Pools.length > 0 && pairing.aeroPools.length > 0) {
        this.poolPairings.set(pairKey, pairing);
        crossDexPairs++;
      } else {
        this.monitoredPairs.delete(pairKey);
      }
    }

    this.logger.info(`Pool pairings updated: ${crossDexPairs} cross-DEX pairs available`);
  }

  /**
   * Scan a specific token pair for arbitrage opportunities
   */
  private async scanTokenPair(
    tokenPair: { token0: Address; token1: Address },
    poolPairing: { uniV3Pools: Address[]; aeroPools: Address[] },
    allPoolStates: Map<Address, any>
  ): Promise<number> {
    if (poolPairing.uniV3Pools.length === 0 || poolPairing.aeroPools.length === 0) {
      return 0;
    }

    // Find best pools from each DEX
    const bestUniV3Pool = this.findBestUniswapV3Pool(poolPairing.uniV3Pools, allPoolStates);
    const bestAeroPool = this.findBestAerodromePool(poolPairing.aeroPools, allPoolStates);

    if (!bestUniV3Pool || !bestAeroPool) {
      return 0;
    }

    // Calculate prices on both DEXs
    const uniV3Price = this.calculateUniswapV3Price(bestUniV3Pool);
    const aeroPrice = this.calculateAerodromePrice(bestAeroPool);

    if (!uniV3Price || !aeroPrice) {
      return 0;
    }

    // Calculate spread and direction
    const spread = this.calculateSpread(
      [tokenPair.token0, tokenPair.token1],
      bestUniV3Pool.address,
      bestAeroPool.address,
      uniV3Price,
      aeroPrice
    );

    if (spread.spread < this.config.minSpreadBps) {
      return 0; // Spread too small
    }

    // Calculate optimal trade amount
    const optimalAmount = await this.calculateOptimalTradeAmount(bestUniV3Pool, bestAeroPool, spread);
    if (optimalAmount === 0n) {
      return 0;
    }

    // Calculate profitability
    const profitCalc = await this.calculateProfitability(spread, optimalAmount, bestUniV3Pool, bestAeroPool);

    if (!profitCalc.isViable) {
      return 0;
    }

    // Create arbitrage opportunity
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
        return 1;
      }
    } else {
      // New opportunity
      this.activeOpportunities.set(opportunity.id, opportunity);
      this.emit('opportunityDetected', opportunity);
      return 1;
    }

    return 0;
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
   * Find the best Aerodrome pool (highest TVL)
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

      // Calculate TVL using geometric mean
      const reserve0 = BigInt(poolState.reserve0.toString());
      const reserve1 = BigInt(poolState.reserve1.toString());

      if (reserve0 === 0n || reserve1 === 0n) continue;

      const tvl = this.bigintSqrt(reserve0 * reserve1);

      if (tvl > highestTvl) {
        highestTvl = tvl;
        bestPool = poolState;
      }
    }

    return bestPool;
  }

  /**
   * Calculate Uniswap V3 price from pool state
   */
  private calculateUniswapV3Price(poolState: UniswapV3PoolState): bigint | undefined {
    try {
      const sqrtPriceX96 = BigInt(poolState.sqrtPriceX96.toString());
      const Q96 = 2n ** 96n;
      const price = (sqrtPriceX96 * sqrtPriceX96) / (Q96 * Q96);
      return price;
    } catch (error) {
      return undefined;
    }
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

      return reserve1 / reserve0;
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Calculate spread between two prices
   */
  private calculateSpread(
    tokenPair: [Address, Address],
    uniswapV3Pool: Address,
    aerodromePool: Address,
    uniV3Price: bigint,
    aeroPrice: bigint
  ): ArbitrageSpread {
    const priceDiff = uniV3Price > aeroPrice ? uniV3Price - aeroPrice : aeroPrice - uniV3Price;
    const basePrice = uniV3Price > aeroPrice ? aeroPrice : uniV3Price;

    const spreadBps = basePrice > 0n ? Number((priceDiff * 10000n) / basePrice) : 0;

    return {
      tokenPair,
      uniswapV3Pool,
      aerodromePool,
      uniswapV3Price: uniV3Price,
      aerodromePrice: aeroPrice,
      spread: spreadBps,
      direction: uniV3Price > aeroPrice ? 'aero_to_uni' : 'uni_to_aero',
    };
  }

  /**
   * Calculate optimal trade amount
   */
  private async calculateOptimalTradeAmount(
    uniV3Pool: UniswapV3PoolState,
    aeroPool: AerodromeVolatilePoolState | AerodromeStablePoolState,
    spread: ArbitrageSpread
  ): Promise<bigint> {
    // Conservative sizing based on available liquidity
    const uniV3TokenAmount = this.estimateUniV3TokenAmount(uniV3Pool);
    const aeroTokenAmount = this.getAerodromeTokenAmount(aeroPool);

    const availableTokenAmount = uniV3TokenAmount < aeroTokenAmount ? uniV3TokenAmount : aeroTokenAmount;

    if (availableTokenAmount === 0n) {
      return 0n;
    }

    // Conservative sizing: 1% of available liquidity
    const baseAmount = availableTokenAmount / 100n;

    // Adjust based on spread
    const spreadMultiplier = Math.min(2, Math.max(0.5, spread.spread / 100));
    const adjustedAmount = BigInt(Math.floor(Number(baseAmount) * spreadMultiplier));

    // Minimum viable size for Base L2
    const minAmountWei = ethers.parseEther('0.02');

    return adjustedAmount > minAmountWei ? adjustedAmount : minAmountWei;
  }

  /**
   * Estimate token amount available in Uniswap V3 pool
   */
  private estimateUniV3TokenAmount(poolState: UniswapV3PoolState): bigint {
    try {
      const liquidity = BigInt(poolState.liquidity.toString());
      if (liquidity === 0n) return 0n;
      return liquidity / 100n; // 1% of liquidity
    } catch (error) {
      return 0n;
    }
  }

  /**
   * Get token amount from Aerodrome pool
   */
  private getAerodromeTokenAmount(
    poolState: AerodromeVolatilePoolState | AerodromeStablePoolState
  ): bigint {
    const reserve0 = BigInt(poolState.reserve0.toString());
    const reserve1 = BigInt(poolState.reserve1.toString());
    return reserve0 < reserve1 ? reserve0 : reserve1;
  }

  /**
   * Calculate profitability
   */
  private async calculateProfitability(
    spread: ArbitrageSpread,
    tradeAmount: bigint,
    _uniV3Pool: UniswapV3PoolState,
    _aeroPool: AerodromeVolatilePoolState | AerodromeStablePoolState
  ): Promise<ProfitCalculation> {
    const gasPrice = await this.getCurrentGasPrice();
    const gasEstimate = 300000n;
    const gasCost = gasEstimate * gasPrice;
    const flashLoanFee = (tradeAmount * 5n) / 10000n; // 0.05%

    // Simple profit estimation
    const grossProfit = (tradeAmount * BigInt(spread.spread)) / 10000n;
    const slippageCost = (tradeAmount * BigInt(this.config.maxSlippageBps)) / 10000n;

    const netProfit = grossProfit > (flashLoanFee + gasCost + slippageCost) 
      ? grossProfit - flashLoanFee - gasCost - slippageCost 
      : 0n;

    const profitMargin = grossProfit > 0n ? Number((netProfit * 10000n) / grossProfit) / 100 : 0;

    // Check minimum profit threshold
    const ethUsdPrice = await this.priceOracle.getEthUsdPrice();
    const minProfitWei = ethers.parseEther((this.config.minProfitUSD / ethUsdPrice).toString());

    return {
      grossProfit,
      flashLoanFee,
      gasEstimate,
      gasCost,
      slippageCost,
      netProfit,
      profitMargin,
      isViable: netProfit >= minProfitWei,
    };
  }

  /**
   * Get current gas price
   */
  private async getCurrentGasPrice(): Promise<bigint> {
    try {
      const provider = this.connectionManager.getProvider();
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
      if (gasPrice) {
        return BigInt(gasPrice.toString());
      }
    } catch (error) {
      // Fallback
    }
    return 2000000000n; // 2 gwei fallback
  }

  /**
   * Create arbitrage opportunity
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
      fees: [uniV3Pool.fee, 0],
      directions: [true, false],
      expectedGas: Number(profitCalc.gasEstimate),
      priceImpact: spread.spread,
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
      fallbackRoutes: [],

      // Profitability
      flashFee: profitCalc.flashLoanFee,
      gasEstimate: profitCalc.gasEstimate,
      expectedProfit: profitCalc.netProfit,
      minProfit: ethers.parseEther('0.008'), // $20 at $2500 ETH
      profitMargin: profitCalc.profitMargin,

      // Execution parameters
      slippageTolerance: this.config.maxSlippageBps / 100,
      deadline: now + 30000,
      maxBribe: ethers.parseEther('0.01'),
      priority: Math.min(10, Math.max(1, Math.floor(spread.spread / 10))),

      // Metadata
      detectedAt: now,
      expiresAt: now + 30000,
      source: 'arbitrage-scanner',

      // Arbitrage-specific fields
      sourcePool,
      targetPool,
      sourceDex,
      targetDex,
      spread: spread.spread,
      spreadAfterCosts: Math.max(0, spread.spread - Number((profitCalc.gasCost * 10000n) / tradeAmount)),
    };
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
    const [tokenA, tokenB] = token0.toLowerCase() < token1.toLowerCase() ? [token0, token1] : [token1, token0];
    return `${tokenA}-${tokenB}`;
  }

  /**
   * Calculate square root of a BigInt using Newton's method
   */
  private bigintSqrt(value: bigint): bigint {
    if (value < 0n) {
      throw new Error('Square root of negative number');
    }
    if (value < 2n) {
      return value;
    }

    let x = value;
    let y = (x + 1n) / 2n;

    while (y < x) {
      x = y;
      y = (x + value / x) / 2n;
    }

    return x;
  }
}