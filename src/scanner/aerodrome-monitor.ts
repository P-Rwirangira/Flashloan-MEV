/**
 * Aerodrome Monitor
 *
 * Monitors Aerodrome pools for state changes and opportunities.
 * Handles both volatile and stable pool types.
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { RpcConnectionManager } from '../rpc/connection-manager';
import { AerodromeVolatilePoolState, AerodromeStablePoolState, PoolType } from '../types/pool';
import { PoolAllowlist } from '../types/config';
import { Address } from '../types/common';
import { createComponentLogger } from '../utils/logger';
import type { DiscoveredPool } from './pool-discovery.js';

export interface AerodromeMonitorOptions {
  readonly connectionManager: RpcConnectionManager;
  readonly allowedPools: PoolAllowlist[];
  readonly updateIntervalMs?: number;
  readonly maxRetries?: number;
}

export interface AerodromePoolUpdateEvent {
  readonly pool: Address;
  readonly oldState: AerodromeVolatilePoolState | AerodromeStablePoolState | undefined;
  readonly newState: AerodromeVolatilePoolState | AerodromeStablePoolState;
  readonly blockNumber: number;
  readonly timestamp: number;
}

// Aerodrome pair ABI (minimal)
const AERODROME_PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function stable() external view returns (bool)',
  'function totalSupply() external view returns (uint256)',
  'function decimals0() external view returns (uint8)',
  'function decimals1() external view returns (uint8)',
  'function kLast() external view returns (uint256)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
];

export class AerodromeMonitor extends EventEmitter {
  private readonly logger = createComponentLogger('aerodrome-monitor');
  private readonly connectionManager: RpcConnectionManager;
  private readonly updateIntervalMs: number;
  private readonly maxRetries: number;

  // Pool tracking
  private monitoredPools: Map<Address, PoolAllowlist> = new Map();
  private poolStates: Map<Address, AerodromeVolatilePoolState | AerodromeStablePoolState> =
    new Map();
  private poolContracts: Map<Address, ethers.Contract> = new Map();

  // Monitoring state
  private isMonitoring = false;
  private updateInterval: ReturnType<typeof setInterval> | undefined;
  private lastUpdateBlock = 0;

  constructor(options: AerodromeMonitorOptions) {
    super();

    this.connectionManager = options.connectionManager;
    this.updateIntervalMs = options.updateIntervalMs ?? 5000; // 5s default
    this.maxRetries = options.maxRetries ?? 3;

    // Initialize pools
    this.initializePools(options.allowedPools);
  }

  /**
   * Initialize pools from allowlist
   */
  private initializePools(allowedPools: PoolAllowlist[]): void {
    for (const poolConfig of allowedPools) {
      // Accept pools if enabled and dex matches (or no dex specified for backwards compat)
      if (poolConfig.enabled && (!poolConfig.dex || poolConfig.dex === 'aerodrome')) {
        this.monitoredPools.set(poolConfig.address, poolConfig);

        // Create contract instance
        const provider = this.connectionManager.getProvider();
        const contract = new ethers.Contract(poolConfig.address, AERODROME_PAIR_ABI, provider);
        this.poolContracts.set(poolConfig.address, contract);

        this.logger.debug('Initialized Aerodrome pool', {
          address: poolConfig.address,
          priority: poolConfig.priority,
        });
      }
    }

    this.logger.info('Aerodrome monitor initialized', {
      poolCount: this.monitoredPools.size,
    });
  }

  /**
   * Add discovered pool dynamically
   */
  async addDiscoveredPool(pool: DiscoveredPool): Promise<void> {
    if (pool.dex !== 'aerodrome') {
      this.logger.warn('Attempted to add non-Aerodrome pool', { address: pool.address, dex: pool.dex });
      return;
    }

    const poolConfig: PoolAllowlist = {
      address: pool.address,
      dex: 'aerodrome',
      enabled: true,
      priority: Math.floor(pool.score / 20), // Score 0-100 -> Priority 0-5
      tags: [
        pool.stable ? 'stable' : 'volatile',
        pool.tvl >= 1000000 ? 'high-tvl' : 'medium-tvl',
        'auto-discovered',
      ],
      minTvl: 10000,
      maxSlippage: pool.stable ? 0.005 : 0.02, // 0.5% for stable, 2% for volatile
    };

    await this.addPool(poolConfig);

    // Create contract instance
    const provider = this.connectionManager.getProvider();
    const contract = new ethers.Contract(pool.address, AERODROME_PAIR_ABI, provider);
    this.poolContracts.set(pool.address, contract);

    this.logger.info('Auto-discovered pool added', {
      address: pool.address,
      token0: pool.token0,
      token1: pool.token1,
      tvl: pool.tvl,
      score: pool.score,
      stable: pool.stable,
    });
  }

  /**
   * Start monitoring pools
   */
  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      this.logger.warn('Monitor is already running');
      return;
    }

    this.logger.info('Starting Aerodrome pool monitoring', {
      poolCount: this.monitoredPools.size,
      updateInterval: this.updateIntervalMs,
    });

    try {
      // Initial state fetch for all pools
      await this.fetchAllPoolStates();

      // Start periodic updates
      this.updateInterval = setInterval(async () => {
        try {
          await this.fetchAllPoolStates();
        } catch (error) {
          this.logger.logError(error as Error, { operation: 'periodic-update' });
          this.emit('monitoringError', error);
        }
      }, this.updateIntervalMs);

      this.isMonitoring = true;
      this.emit('monitoringStarted');
    } catch (error) {
      this.logger.logError(error as Error, { operation: 'start-monitoring' });
      throw error;
    }
  }

  /**
   * Stop monitoring pools
   */
  async stopMonitoring(): Promise<void> {
    if (!this.isMonitoring) {
      this.logger.warn('Monitor is not running');
      return;
    }

    this.logger.info('Stopping Aerodrome pool monitoring');

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }

    this.isMonitoring = false;
    this.emit('monitoringStopped');
  }

  /**
   * Add a new pool to monitoring
   */
  async addPool(poolConfig: PoolAllowlist): Promise<void> {
    // Monitor is already DEX-specific, no need to check dex field
    if (!poolConfig.enabled) {
      this.logger.warn('Attempted to add disabled pool', { address: poolConfig.address });
      return;
    }

    this.monitoredPools.set(poolConfig.address, poolConfig);

    // Create contract instance
    const provider = this.connectionManager.getProvider();
    const contract = new ethers.Contract(poolConfig.address, AERODROME_PAIR_ABI, provider);
    this.poolContracts.set(poolConfig.address, contract);

    // Fetch initial state
    await this.updatePoolState(poolConfig.address);

    this.logger.info('Added pool to Aerodrome monitoring', {
      address: poolConfig.address,
      priority: poolConfig.priority,
    });
  }

  /**
   * Remove a pool from monitoring
   */
  removePool(poolAddress: Address): void {
    this.monitoredPools.delete(poolAddress);
    this.poolStates.delete(poolAddress);
    this.poolContracts.delete(poolAddress);

    this.logger.info('Removed pool from Aerodrome monitoring', {
      address: poolAddress,
    });
  }

  /**
   * Get pool state by address
   */
  getPoolState(
    poolAddress: Address
  ): AerodromeVolatilePoolState | AerodromeStablePoolState | undefined {
    return this.poolStates.get(poolAddress);
  }

  /**
   * Get all pool states
   */
  getAllPoolStates(): Map<Address, AerodromeVolatilePoolState | AerodromeStablePoolState> {
    return new Map(this.poolStates);
  }

  /**
   * Get monitored pool addresses
   */
  getMonitoredPools(): Address[] {
    return Array.from(this.monitoredPools.keys());
  }

  /**
   * Update specific pool state
   */
  async updatePoolState(poolAddress: Address): Promise<void> {
    const contract = this.poolContracts.get(poolAddress);
    if (!contract) {
      throw new Error(`Pool contract not found: ${poolAddress}`);
    }

    let retries = 0;
    while (retries < this.maxRetries) {
      try {
        const oldState = this.poolStates.get(poolAddress);
        const newState = await this.fetchPoolState(poolAddress, contract);

        if (newState) {
          this.poolStates.set(poolAddress, newState);

          // Emit update event if state changed
          if (!oldState || this.hasStateChanged(oldState, newState)) {
            const updateEvent: AerodromePoolUpdateEvent = {
              pool: poolAddress,
              oldState,
              newState,
              blockNumber: newState.blockNumber,
              timestamp: Date.now(),
            };

            this.emit('poolUpdated', updateEvent);
            this.logger.debug('Pool state updated', {
              pool: poolAddress,
              blockNumber: newState.blockNumber,
              reserve0: newState.reserve0.toString(),
              reserve1: newState.reserve1.toString(),
            });
          }
        }

        return; // Success, exit retry loop
      } catch (error) {
        retries++;
        this.logger.logError(error as Error, {
          operation: 'update-pool-state',
          pool: poolAddress,
          attempt: retries,
        });

        if (retries >= this.maxRetries) {
          this.emit('poolUpdateError', poolAddress, error);
          throw error;
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000 * retries));
      }
    }
  }

  /**
   * Fetch all pool states
   */
  private async fetchAllPoolStates(): Promise<void> {
    const provider = this.connectionManager.getProvider();
    const currentBlock = await provider.getBlockNumber();

    // Skip if no new blocks
    if (currentBlock <= this.lastUpdateBlock) {
      return;
    }

    this.lastUpdateBlock = currentBlock;

    // Update all pools in parallel
    const updatePromises = Array.from(this.monitoredPools.keys()).map(poolAddress =>
      this.updatePoolState(poolAddress).catch(error => {
        this.logger.logError(error as Error, {
          operation: 'fetch-all-pool-states',
          pool: poolAddress,
        });
      })
    );

    await Promise.allSettled(updatePromises);
  }

  /**
   * Fetch individual pool state
   */
  private async fetchPoolState(
    poolAddress: Address,
    contract: ethers.Contract
  ): Promise<AerodromeVolatilePoolState | AerodromeStablePoolState | null> {
    try {
      const provider = this.connectionManager.getProvider();
      const currentBlock = await provider.getBlockNumber();

      // Verify contract methods exist
      if (
        !contract['getReserves'] ||
        !contract['token0'] ||
        !contract['token1'] ||
        !contract['stable']
      ) {
        throw new Error(`Contract missing required methods: ${poolAddress}`);
      }

      // Fetch pool data using staticCall for read-only operations
      const [reserves, token0, token1, isStable] = await Promise.all([
        contract['getReserves'].staticCall(),
        contract['token0'].staticCall(),
        contract['token1'].staticCall(),
        contract['stable'].staticCall(),
      ]);
      
      // Try to fetch totalSupply (optional - some pools may not have it)
      let totalSupply = BigInt(0);
      try {
        if (contract['totalSupply']) {
          totalSupply = await contract['totalSupply'].staticCall();
        }
      } catch (error) {
        this.logger.debug('totalSupply not available for pool', { pool: poolAddress });
      }

      const poolConfig = this.monitoredPools.get(poolAddress);
      if (!poolConfig) {
        throw new Error(`Pool config not found: ${poolAddress}`);
      }

      const baseState = {
        address: poolAddress,
        token0: token0 as Address,
        token1: token1 as Address,
        fee: poolConfig.fee ?? 30, // Use actual pool fee or default to 0.3% (30 bps)
        lastUpdated: Date.now(),
        blockNumber: currentBlock,
        isActive: true,
        reserve0: reserves.reserve0.toString(),
        reserve1: reserves.reserve1.toString(),
        totalSupply: totalSupply.toString(),
      };

      if (isStable) {
        // Verify stable pool methods exist
        if (!contract['decimals0'] || !contract['decimals1']) {
          throw new Error(`Stable pool contract missing decimal methods: ${poolAddress}`);
        }

        // Fetch additional data for stable pools
        const [decimals0, decimals1] = await Promise.all([
          contract['decimals0'].staticCall(),
          contract['decimals1'].staticCall(),
        ]);

        return {
          ...baseState,
          type: PoolType.AERODROME_STABLE,
          decimals0: Number(decimals0),
          decimals1: Number(decimals1),
          stable: true as const,
        };
      } else {
        // Verify volatile pool methods exist
        if (!contract['kLast']) {
          throw new Error(`Volatile pool contract missing kLast method: ${poolAddress}`);
        }

        // Fetch kLast for volatile pools
        const kLast = await contract['kLast'].staticCall();

        return {
          ...baseState,
          type: PoolType.AERODROME_VOLATILE,
          kLast: kLast.toString(),
        };
      }
    } catch (error) {
      this.logger.logError(error as Error, {
        operation: 'fetch-pool-state',
        pool: poolAddress,
      });
      return null;
    }
  }

  /**
   * Check if pool state has changed significantly
   */
  private hasStateChanged(
    oldState: AerodromeVolatilePoolState | AerodromeStablePoolState,
    newState: AerodromeVolatilePoolState | AerodromeStablePoolState
  ): boolean {
    // Check if reserves changed
    if (oldState.reserve0 !== newState.reserve0 || oldState.reserve1 !== newState.reserve1) {
      return true;
    }

    // Check if total supply changed
    if (oldState.totalSupply !== newState.totalSupply) {
      return true;
    }

    // Check type-specific changes
    if (
      oldState.type === PoolType.AERODROME_VOLATILE &&
      newState.type === PoolType.AERODROME_VOLATILE
    ) {
      const oldVolatile = oldState as AerodromeVolatilePoolState;
      const newVolatile = newState as AerodromeVolatilePoolState;
      return oldVolatile.kLast !== newVolatile.kLast;
    }

    return false;
  }

  /**
   * Get monitoring statistics
   */
  getStats() {
    return {
      isMonitoring: this.isMonitoring,
      poolCount: this.monitoredPools.size,
      lastUpdateBlock: this.lastUpdateBlock,
      updateInterval: this.updateIntervalMs,
      poolStates: this.poolStates.size,
    };
  }

  /**
   * Check if monitor is healthy
   */
  isHealthy(): boolean {
    return this.isMonitoring && this.poolStates.size > 0;
  }
}
