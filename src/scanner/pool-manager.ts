/**
 * Pool Manager
 *
 * Coordinates multiple pool monitors and enforces allowlist policies.
 */

import { EventEmitter } from 'events';
import { BigNumberish } from 'ethers';
import { Address } from '../types/common';
import { PoolState } from '../types/pool';
import { PoolAllowlists, PoolAllowlist } from '../types/config';
import { ChainlinkPriceOracleImpl } from '../oracles/chainlink-oracle';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { createComponentLogger } from '../utils/logger';
import { UniswapV3Monitor } from './uniswap-v3-monitor';
import { AerodromeMonitor } from './aerodrome-monitor';

export interface PoolManagerOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly allowedPools: PoolAllowlists;
  readonly updateIntervalMs?: number;
  readonly priceOracle?: ChainlinkPriceOracleImpl;
}

export interface AllowlistViolation {
  readonly poolAddress: Address;
  readonly reason: string;
  readonly timestamp: number;
}

export class PoolManager extends EventEmitter {
  private readonly connectionManager: RpcConnectionManager;
  private allowedPools: PoolAllowlists;
  private readonly updateIntervalMs: number;
  private readonly logger = createComponentLogger('pool-manager');
  private readonly priceOracle?: ChainlinkPriceOracleImpl;

  // Pool monitors
  private uniswapV3Monitor?: UniswapV3Monitor;
  private aerodromeMonitor?: AerodromeMonitor;

  // Allowlist enforcement
  private allowlistViolations: Map<Address, AllowlistViolation> = new Map();

  constructor(options: PoolManagerOptions) {
    super();

    this.connectionManager = options.connectionManager;
    this.allowedPools = { ...options.allowedPools }; // Create mutable copy
    this.updateIntervalMs = options.updateIntervalMs ?? 5000;
    this.priceOracle =
      options.priceOracle || new ChainlinkPriceOracleImpl(options.connectionManager);
  }

  /**
   * Initialize all pool monitors
   */
  async initialize(): Promise<void> {
    try {
      // Initialize Uniswap V3 monitor
      if (this.allowedPools.uniswapV3.length > 0) {
        await this.initializeUniswapV3Monitor();
      }

      // Initialize Aerodrome monitor
      if (this.allowedPools.aerodrome.length > 0) {
        await this.initializeAerodromeMonitor();
      }

      this.emit('initialized');
    } catch (error) {
      this.emit('initializationError', error);
      throw error;
    }
  }

  /**
   * Start monitoring all pools
   */
  async startMonitoring(): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.uniswapV3Monitor) {
      promises.push(this.uniswapV3Monitor.startMonitoring());
    }

    if (this.aerodromeMonitor) {
      promises.push(this.aerodromeMonitor.startMonitoring());
    }

    await Promise.all(promises);
    this.emit('monitoringStarted');
  }

  /**
   * Stop monitoring all pools
   */
  async stopMonitoring(): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.uniswapV3Monitor) {
      promises.push(this.uniswapV3Monitor.stopMonitoring());
    }

    if (this.aerodromeMonitor) {
      promises.push(this.aerodromeMonitor.stopMonitoring());
    }

    await Promise.all(promises);
    this.emit('monitoringStopped');
  }

  /**
   * Get pool state by address (checks all monitors)
   */
  getPoolState(poolAddress: Address): PoolState | undefined {
    // Check Uniswap V3 pools
    if (this.uniswapV3Monitor) {
      const state = this.uniswapV3Monitor.getPoolState(poolAddress);
      if (state) return state;
    }

    // Check Aerodrome pools
    if (this.aerodromeMonitor) {
      const state = this.aerodromeMonitor.getPoolState(poolAddress);
      if (state) return state;
    }

    return undefined;
  }

  /**
   * Get all monitored pools
   */
  getAllPoolStates(): Map<Address, PoolState> {
    const allStates = new Map<Address, PoolState>();

    // Add Uniswap V3 pools
    if (this.uniswapV3Monitor) {
      const uniV3States = this.uniswapV3Monitor.getAllPoolStates();
      uniV3States.forEach((state, address) => {
        allStates.set(address, state);
      });
    }

    // Add Aerodrome pools
    if (this.aerodromeMonitor) {
      const aeroStates = this.aerodromeMonitor.getAllPoolStates();
      aeroStates.forEach((state, address) => {
        allStates.set(address, state);
      });
    }

    return allStates;
  }

  /**
   * Check if a pool is allowed
   */
  async isPoolAllowed(poolAddress: Address): Promise<boolean> {
    // Check Uniswap V3 allowlist
    const uniV3Pool = this.allowedPools.uniswapV3.find(pool => pool.address === poolAddress);
    if (uniV3Pool && uniV3Pool.enabled) {
      return await this.validatePoolAllowlist(uniV3Pool);
    }

    // Check Aerodrome allowlist
    const aeroPool = this.allowedPools.aerodrome.find(pool => pool.address === poolAddress);
    if (aeroPool && aeroPool.enabled) {
      return await this.validatePoolAllowlist(aeroPool);
    }

    return false;
  }

  /**
   * Get allowlist violations
   */
  getAllowlistViolations(): AllowlistViolation[] {
    return Array.from(this.allowlistViolations.values());
  }

  /**
   * Update pool allowlists
   */
  async updateAllowlists(newAllowlists: PoolAllowlists): Promise<void> {
    // Update Uniswap V3 pools
    if (this.uniswapV3Monitor) {
      // Remove pools no longer in allowlist
      const currentUniV3Pools = this.uniswapV3Monitor.getMonitoredPools();
      const newUniV3Addresses = new Set(newAllowlists.uniswapV3.map(p => p.address));

      for (const poolAddress of currentUniV3Pools) {
        if (!newUniV3Addresses.has(poolAddress)) {
          this.uniswapV3Monitor.removePool(poolAddress);
        }
      }

      // Add new pools
      for (const poolConfig of newAllowlists.uniswapV3) {
        if (poolConfig.enabled && !currentUniV3Pools.includes(poolConfig.address)) {
          await this.uniswapV3Monitor.addPool(poolConfig);
        }
      }
    }

    // Update Aerodrome pools
    if (this.aerodromeMonitor) {
      // Remove pools no longer in allowlist
      const currentAeroPools = this.aerodromeMonitor.getMonitoredPools();
      const newAeroAddresses = new Set(newAllowlists.aerodrome.map(p => p.address));

      for (const poolAddress of currentAeroPools) {
        if (!newAeroAddresses.has(poolAddress)) {
          this.aerodromeMonitor.removePool(poolAddress);
        }
      }

      // Add new pools
      for (const poolConfig of newAllowlists.aerodrome) {
        if (poolConfig.enabled && !currentAeroPools.includes(poolConfig.address)) {
          await this.aerodromeMonitor.addPool(poolConfig);
        }
      }
    }

    // Update internal allowlists
    this.allowedPools = { ...newAllowlists }; // Create new mutable copy

    this.emit('allowlistsUpdated', newAllowlists);
  }

  /**
   * Initialize Uniswap V3 monitor
   */
  private async initializeUniswapV3Monitor(): Promise<void> {
    this.uniswapV3Monitor = new UniswapV3Monitor({
      connectionManager: this.connectionManager,
      allowedPools: this.allowedPools.uniswapV3,
      updateIntervalMs: this.updateIntervalMs,
    });

    // Forward events
    this.uniswapV3Monitor.on('poolUpdated', event => {
      this.emit('poolUpdated', event);
    });

    this.uniswapV3Monitor.on('poolUpdateError', (poolAddress, error) => {
      this.emit('poolFetchError', poolAddress, error);
    });

    this.uniswapV3Monitor.on('monitoringError', error => {
      this.emit('monitoringError', error);
    });
  }

  /**
   * Initialize Aerodrome monitor
   */
  private async initializeAerodromeMonitor(): Promise<void> {
    this.aerodromeMonitor = new AerodromeMonitor({
      connectionManager: this.connectionManager,
      allowedPools: this.allowedPools.aerodrome,
      updateIntervalMs: this.updateIntervalMs,
    });

    // Forward events
    this.aerodromeMonitor.on('poolUpdated', event => {
      this.emit('poolUpdated', event);
    });

    this.aerodromeMonitor.on('poolUpdateError', (poolAddress, error) => {
      this.emit('poolFetchError', poolAddress, error);
    });

    this.aerodromeMonitor.on('monitoringError', error => {
      this.emit('monitoringError', error);
    });
  }

  /**
   * Validate pool against allowlist criteria
   */
  private async validatePoolAllowlist(poolConfig: PoolAllowlist): Promise<boolean> {
    const poolState = this.getPoolState(poolConfig.address);

    if (!poolState) {
      // Pool state not available yet, allow for now
      return true;
    }

    // Check minimum TVL (if we have liquidity data)
    if ('liquidity' in poolState) {
      const minTvl = this.safeConvertToBigInt(poolConfig.minTvl);
      if (minTvl > 0n) {
        try {
          const actualTvl = await this.calculatePoolTvl(poolState, poolConfig);

          if (actualTvl < minTvl) {
            this.logger.warn('Pool TVL below minimum threshold', {
              poolAddress: poolConfig.address,
              actualTvl: actualTvl.toString(),
              minTvl: minTvl.toString(),
              shortfall: (minTvl - actualTvl).toString(),
            });
            return false;
          }

          this.logger.debug('Pool TVL validation passed', {
            poolAddress: poolConfig.address,
            actualTvl: actualTvl.toString(),
            minTvl: minTvl.toString(),
          });
        } catch (error) {
          this.logger.logError(error as Error, {
            operation: 'tvl-validation',
            poolAddress: poolConfig.address,
          });

          // On price data error, allow pool but log warning
          this.logger.warn('TVL validation failed due to price data error - allowing pool', {
            poolAddress: poolConfig.address,
            minTvl: minTvl.toString(),
            error: (error as Error).message,
          });
        }
      }
    }

    // Check maximum slippage constraints
    if (poolConfig.maxSlippage > 0) {
      // This would require calculating current slippage
      // For now, we'll skip this check
    }

    // Pool passes all checks
    return true;
  }

  /**
   * Calculate pool TVL using price oracle data
   */
  private async calculatePoolTvl(poolState: PoolState, poolConfig: PoolAllowlist): Promise<bigint> {
    if (!this.priceOracle) {
      throw new Error('Price oracle not available for TVL calculation');
    }

    try {
      // Handle different pool types
      if ('liquidity' in poolState) {
        // Uniswap V3 pool
        return await this.calculateUniswapV3Tvl(poolState as any);
      } else if ('reserve0' in poolState && 'reserve1' in poolState) {
        // Aerodrome pool (AMM style)
        return await this.calculateAerodromeTvl(poolState as any);
      } else {
        throw new Error(`Unsupported pool type for TVL calculation: ${poolConfig.address}`);
      }
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'calculate-pool-tvl',
        poolAddress: poolConfig.address,
      });
      throw error;
    }
  }

  /**
   * Calculate TVL for Uniswap V3 pools
   */
  private async calculateUniswapV3Tvl(poolState: any): Promise<bigint> {
    try {
      // For Uniswap V3, we need to estimate TVL from liquidity and current price
      // This is a simplified calculation - real implementation would need tick data

      const [token0Price, token1Price] = await Promise.all([
        this.priceOracle!.getTokenUsdPrice(poolState.token0),
        this.priceOracle!.getTokenUsdPrice(poolState.token1),
      ]);

      // Simplified TVL estimation using liquidity
      // In reality, this would require complex tick math and position analysis
      const liquidityValue = BigInt(poolState.liquidity.toString());

      // Rough approximation: assume equal value split and use geometric mean of prices
      const avgPrice = Math.sqrt(token0Price * token1Price);
      const estimatedTvlUsd = (Number(liquidityValue) * avgPrice) / 1e18; // Normalize for 18 decimals

      // Convert back to wei (assuming USD with 18 decimals for consistency)
      return BigInt(Math.floor(estimatedTvlUsd * 1e18));
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'calculate-uniswap-v3-tvl',
        poolAddress: poolState.address,
      });
      throw error;
    }
  }

  /**
   * Calculate TVL for Aerodrome pools
   */
  private async calculateAerodromeTvl(poolState: any): Promise<bigint> {
    try {
      const [token0Price, token1Price] = await Promise.all([
        this.priceOracle!.getTokenUsdPrice(poolState.token0),
        this.priceOracle!.getTokenUsdPrice(poolState.token1),
      ]);

      // Get reserve amounts
      const reserve0 = BigInt(poolState.reserve0.toString());
      const reserve1 = BigInt(poolState.reserve1.toString());

      // Calculate USD values for each reserve
      // Assume 18 decimals for simplicity - real implementation would fetch token decimals
      const reserve0ValueUsd = (Number(reserve0) * token0Price) / 1e18;
      const reserve1ValueUsd = (Number(reserve1) * token1Price) / 1e18;

      const totalTvlUsd = reserve0ValueUsd + reserve1ValueUsd;

      // Convert to wei (18 decimals)
      return BigInt(Math.floor(totalTvlUsd * 1e18));
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'calculate-aerodrome-tvl',
        poolAddress: poolState.address,
      });
      throw error;
    }
  }
  private safeConvertToBigInt(value: BigNumberish): bigint {
    if (value === null || value === undefined) {
      return 0n;
    }

    if (typeof value === 'bigint') {
      return value;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) {
        return 0n;
      }
      return BigInt(Math.floor(value));
    }

    if (typeof value === 'string') {
      try {
        if (!/^\d+$/.test(value)) {
          return 0n;
        }
        return BigInt(value);
      } catch {
        return 0n;
      }
    }

    return 0n;
  }
}
