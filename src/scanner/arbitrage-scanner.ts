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

export interface ArbitrageScannerOptions {
  readonly poolManager: PoolManager;
  readonly config: ArbitrageConfig;
  readonly scanIntervalMs?: number;
}

export interface ArbitrageSpread {
  readonly tokenPair: [Address, Address];
  readonly uniswapV3Pool: Address;
  readonly aerodromePool: Address;
  readonly uniswapV3Price: bigint;
  readonly aerodromePrice: bigint;
  readonly spread: number; // in basis points
  readonly direction: 'uni_to_aero' | 'aero_to_uni';
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
  private readonly config: ArbitrageConfig;
  private readonly scanIntervalMs: number;

  // Scanning state
  private isScanning = false;
  private scanInterval?: ReturnType<typeof setInterval>;
  private lastScanTimestamp = 0;

  // Token pair tracking
  private monitoredPairs: Map<string, { token0: Address; token1: Address }> = new Map();
  private poolPairings: Map<string, { uniV3Pools: Address[]; aeroPools: Address[] }> = new Map();

  // Opportunity tracking
  private activeOpportunities: Map<string, ArbitrageOpportunity> = new Map();
  private opportunityCounter = 0;

  constructor(options: ArbitrageScannerOptions) {
    super();

    this.poolManager = options.poolManager;
    this.config = options.config;
    this.scanIntervalMs = options.scanIntervalMs ?? 1000; // 1s default for fast arbitrage detection

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

      // Start periodic scanning
      this.scanInterval = setInterval(async () => {
        try {
          await this.scanForOpportunities();
        } catch (error) {
          this.emit('scanError', error);
        }
      }, this.scanIntervalMs);

      this.isScanning = true;
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
    this.lastScanTimestamp = scanStartTime;

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
   * Scan a specific token pair for arbitrage opportunities
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

    // Find best pools from each DEX (highest liquidity)
    const bestUniV3Pool = this.findBestUniswapV3Pool(poolPairing.uniV3Pools, allPoolStates);
    const bestAeroPool = this.findBestAerodromePool(poolPairing.aeroPools, allPoolStates);

    if (!bestUniV3Pool || !bestAeroPool) {
      return;
    }

    // Calculate prices on both DEXs
    const uniV3Price = this.calculateUniswapV3Price(bestUniV3Pool);
    const aeroPrice = this.calculateAerodromePrice(bestAeroPool);

    if (!uniV3Price || !aeroPrice) {
      return;
    }

    // Detect spread and direction
    const spread = this.calculateSpread(uniV3Price, aeroPrice);
    if (spread.spread < this.config.minSpreadBps) {
      return; // Spread too small
    }

    // Calculate optimal trade amount
    const optimalAmount = this.calculateOptimalTradeAmount(bestUniV3Pool, bestAeroPool, spread);
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

    // Create arbitrage opportunity
    const opportunity = this.createArbitrageOpportunity(
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
   * Find the best Aerodrome pool (highest reserves)
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

      // Calculate TVL as sum of reserves (simplified)
      const reserve0 = BigInt(poolState.reserve0.toString());
      const reserve1 = BigInt(poolState.reserve1.toString());
      const tvl = reserve0 + reserve1; // Simplified TVL calculation

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
   * Calculate optimal trade amount for arbitrage
   */
  private calculateOptimalTradeAmount(
    _uniV3Pool: UniswapV3PoolState,
    _aeroPool: AerodromeVolatilePoolState | AerodromeStablePoolState,
    spread: ArbitrageSpread
  ): bigint {
    // Simplified calculation - use a percentage of available liquidity
    const uniV3Liquidity = BigInt(_uniV3Pool.liquidity.toString());
    const aeroReserve = BigInt(_aeroPool.reserve0.toString());

    // Use smaller of the two liquidities, with a conservative multiplier
    const availableLiquidity = uniV3Liquidity < aeroReserve ? uniV3Liquidity : aeroReserve;

    // Use 1% of available liquidity as starting point
    const baseAmount = availableLiquidity / 100n;

    // Adjust based on spread size (larger spreads allow larger trades)
    const spreadMultiplier = BigInt(Math.max(1, Math.min(10, spread.spread / 10))); // 1x to 10x based on spread

    return baseAmount * spreadMultiplier;
  }

  /**
   * Calculate profitability including all costs
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async calculateProfitability(
    spread: ArbitrageSpread,
    tradeAmount: bigint,
    _uniV3Pool: UniswapV3PoolState,
    _aeroPool: AerodromeVolatilePoolState | AerodromeStablePoolState
  ): Promise<ProfitCalculation> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-unused-vars
    const _unused = [_uniV3Pool, _aeroPool]; // Suppress unused parameter warnings

    // Calculate gross profit from spread
    const grossProfit = (tradeAmount * BigInt(spread.spread)) / 10000n;

    // Calculate flash loan fee (typically 0.05% for Uniswap V3)
    const flashLoanFeeBps = 5n; // 0.05%
    const flashLoanFee = (tradeAmount * flashLoanFeeBps) / 10000n;

    // Estimate gas costs
    const gasEstimate = 300000n; // Estimated gas for flash loan + 2 swaps
    const gasPrice = 1000000000n; // 1 gwei (will be updated from network)
    const gasCost = gasEstimate * gasPrice;

    // Calculate slippage costs (simplified)
    const slippageBps = BigInt(this.config.maxSlippageBps);
    const slippageCost = (tradeAmount * slippageBps) / 10000n;

    // Calculate net profit
    const totalCosts = flashLoanFee + gasCost + slippageCost;
    const netProfit = grossProfit > totalCosts ? grossProfit - totalCosts : 0n;

    // Calculate profit margin
    const profitMargin = tradeAmount > 0n ? Number((netProfit * 100n) / tradeAmount) : 0;

    // Check if viable
    const minProfitWei = ethers.parseEther(this.config.minProfitUSD.toString()) / 3000n; // Assume $3000 ETH
    const isViable = netProfit >= minProfitWei && profitMargin >= 1.0; // 1% minimum margin

    return {
      grossProfit,
      flashLoanFee,
      gasEstimate,
      gasCost,
      slippageCost,
      netProfit,
      profitMargin,
      isViable,
    };
  }

  /**
   * Create arbitrage opportunity object
   */
  private createArbitrageOpportunity(
    tokenPair: { token0: Address; token1: Address },
    spread: ArbitrageSpread,
    tradeAmount: bigint,
    profitCalc: ProfitCalculation,
    uniV3Pool: UniswapV3PoolState,
    aeroPool: AerodromeVolatilePoolState | AerodromeStablePoolState
  ): ArbitrageOpportunity {
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
      fallbackRoutes: [], // TODO: Implement fallback routes

      // Profitability
      flashFee: profitCalc.flashLoanFee,
      gasEstimate: profitCalc.gasEstimate,
      expectedProfit: profitCalc.netProfit,
      minProfit: ethers.parseEther(this.config.minProfitUSD.toString()) / 3000n, // Simplified
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
