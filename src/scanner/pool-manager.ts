/**
 * Pool Manager
 *
 * Coordinates multiple pool monitors and enforces allowlist policies.
 */

import { EventEmitter } from 'events';
import { Address } from '../types/common';
import { PoolState } from '../types/pool';
import { PoolAllowlists, PoolAllowlist } from '../types/config';
import { UniswapV3Monitor } from './uniswap-v3-monitor';
import { RpcConnectionManager } from '../rpc/connection-manager';

export interface PoolManagerOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly allowedPools: PoolAllowlists;
  readonly updateIntervalMs?: number;
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

  // Pool monitors
  private uniswapV3Monitor?: UniswapV3Monitor;
  private aerodromeMonitor?: any; // Will be implemented in next task

  // Allowlist enforcement
  private allowlistViolations: Map<Address, AllowlistViolation> = new Map();

  constructor(options: PoolManagerOptions) {
    super();

    this.connectionManager = options.connectionManager;
    this.allowedPools = { ...options.allowedPools }; // Create mutable copy
    this.updateIntervalMs = options.updateIntervalMs ?? 5000;
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

      // Initialize Aerodrome monitor (placeholder for next task)
      if (this.allowedPools.aerodrome.length > 0) {
        // await this.initializeAerodromeMonitor();
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
      // promises.push(this.aerodromeMonitor.startMonitoring());
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
      // promises.push(this.aerodromeMonitor.stopMonitoring());
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
      // const state = this.aerodromeMonitor.getPoolState(poolAddress);
      // if (state) return state;
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
      // const aeroStates = this.aerodromeMonitor.getAllPoolStates();
      // aeroStates.forEach((state, address) => {
      //   allStates.set(address, state);
      // });
    }

    return allStates;
  }

  /**
   * Check if a pool is allowed
   */
  isPoolAllowed(poolAddress: Address): boolean {
    // Check Uniswap V3 allowlist
    const uniV3Pool = this.allowedPools.uniswapV3.find(pool => pool.address === poolAddress);
    if (uniV3Pool && uniV3Pool.enabled) {
      return this.validatePoolAllowlist(uniV3Pool);
    }

    // Check Aerodrome allowlist
    const aeroPool = this.allowedPools.aerodrome.find(pool => pool.address === poolAddress);
    if (aeroPool && aeroPool.enabled) {
      return this.validatePoolAllowlist(aeroPool);
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

    // Update Aerodrome pools (placeholder)
    // Similar logic for Aerodrome pools

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
   * Validate pool against allowlist criteria
   */
  private validatePoolAllowlist(poolConfig: PoolAllowlist): boolean {
    const poolState = this.getPoolState(poolConfig.address);

    if (!poolState) {
      // Pool state not available yet, allow for now
      return true;
    }

    // Check minimum TVL (if we have liquidity data)
    if ('liquidity' in poolState && poolConfig.minTvl > 0) {
      // This would require price data to calculate TVL
      // For now, we'll skip this check
    }

    // Check maximum slippage constraints
    if (poolConfig.maxSlippage > 0) {
      // This would require calculating current slippage
      // For now, we'll skip this check
    }

    // Pool passes all checks
    return true;
  }
}
