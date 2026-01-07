/**
 * Pool State Manager
 *
 * Real-time pool state tracking with WebSocket feeds
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { Address } from '../types/common';
import { createComponentLogger } from '../utils/logger';
import { RpcConnectionManager } from '../rpc/connection-manager';
import {
  UniswapV3PoolState,
  AerodromeVolatilePoolState,
  AerodromeStablePoolState,
  PoolType,
} from '../types/pool';

export interface PoolStateUpdate {
  poolAddress: Address;
  blockNumber: number;
  timestamp: number;
  changes: Partial<UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState>;
}

export interface PoolStateManagerConfig {
  updateIntervalMs: number;
  maxStaleTimeMs: number;
  enableWebSocketUpdates: boolean;
  batchUpdateSize: number;
}

/**
 * Pool State Manager for real-time tracking
 */
export class PoolStateManager extends EventEmitter {
  private readonly logger = createComponentLogger('pool-state-manager');
  private readonly connectionManager: RpcConnectionManager;
  private readonly config: PoolStateManagerConfig;

  private poolStates = new Map<
    Address,
    UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  >();
  private lastUpdated = new Map<Address, number>();
  private updateInterval?: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    connectionManager: RpcConnectionManager,
    config: Partial<PoolStateManagerConfig> = {}
  ) {
    super();

    this.connectionManager = connectionManager;
    this.config = {
      updateIntervalMs: config.updateIntervalMs ?? 5000, // 5 seconds
      maxStaleTimeMs: config.maxStaleTimeMs ?? 30000, // 30 seconds
      enableWebSocketUpdates: config.enableWebSocketUpdates ?? true,
      batchUpdateSize: config.batchUpdateSize ?? 10,
      ...config,
    };
  }

  /**
   * Start pool state tracking
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    // Start periodic updates
    this.updateInterval = setInterval(() => {
      this.updateStalePoolStates();
    }, this.config.updateIntervalMs);

    // Setup WebSocket listeners if enabled
    if (this.config.enableWebSocketUpdates) {
      this.setupWebSocketListeners();
    }

    this.logger.info('Pool state manager started', {
      updateInterval: this.config.updateIntervalMs,
      webSocketEnabled: this.config.enableWebSocketUpdates,
    });
  }

  /**
   * Stop pool state tracking
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }

    this.logger.info('Pool state manager stopped');
  }

  /**
   * Add pool for tracking
   */
  addPool(poolAddress: Address, poolType: PoolType): void {
    if (this.poolStates.has(poolAddress)) {
      return;
    }

    // Initialize with empty state
    const baseState = {
      address: poolAddress,
      type: poolType,
      isActive: false,
      lastUpdated: 0,
    };

    if (poolType === PoolType.UNISWAP_V3) {
      this.poolStates.set(poolAddress, {
        ...baseState,
        token0: '0x' as Address,
        token1: '0x' as Address,
        fee: 0,
        sqrtPriceX96: 0n,
        liquidity: 0n,
        tick: 0,
        tickSpacing: 0,
        blockNumber: 0,
      } as UniswapV3PoolState);
    } else {
      this.poolStates.set(poolAddress, {
        ...baseState,
        token0: '0x' as Address,
        token1: '0x' as Address,
        reserve0: 0n,
        reserve1: 0n,
        decimals0: 18,
        decimals1: 18,
        totalSupply: 0n,
        kLast: 0n,
        fee: 0,
        blockNumber: 0,
      } as AerodromeVolatilePoolState);
    }

    this.lastUpdated.set(poolAddress, 0);
    this.logger.debug('Pool added for tracking', { poolAddress, poolType });
  }

  /**
   * Remove pool from tracking
   */
  removePool(poolAddress: Address): void {
    this.poolStates.delete(poolAddress);
    this.lastUpdated.delete(poolAddress);
    this.logger.debug('Pool removed from tracking', { poolAddress });
  }

  /**
   * Get pool state
   */
  getPoolState(
    poolAddress: Address
  ): UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState | undefined {
    return this.poolStates.get(poolAddress);
  }

  /**
   * Get all pool states
   */
  getAllPoolStates(): Map<
    Address,
    UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState
  > {
    return new Map(this.poolStates);
  }

  /**
   * Update pool state manually
   */
  async updatePoolState(poolAddress: Address): Promise<void> {
    const poolState = this.poolStates.get(poolAddress);
    if (!poolState) {
      this.logger.warn('Attempted to update unknown pool', { poolAddress });
      return;
    }

    try {
      const provider = this.connectionManager.getProvider();
      const updatedState = await this.fetchPoolState(poolAddress, poolState.type, provider);

      if (updatedState) {
        this.poolStates.set(poolAddress, updatedState);
        this.lastUpdated.set(poolAddress, Date.now());

        this.emit('poolStateUpdated', {
          poolAddress,
          blockNumber: await provider.getBlockNumber(),
          timestamp: Date.now(),
          changes: updatedState,
        } as PoolStateUpdate);
      }
    } catch (error) {
      this.logger.error('Failed to update pool state', {
        poolAddress,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update stale pool states
   */
  private async updateStalePoolStates(): Promise<void> {
    const now = Date.now();
    const stalePoolAddresses: Address[] = [];

    for (const [poolAddress, lastUpdate] of this.lastUpdated) {
      if (now - lastUpdate > this.config.maxStaleTimeMs) {
        stalePoolAddresses.push(poolAddress);
      }
    }

    if (stalePoolAddresses.length === 0) {
      return;
    }

    // Update in batches
    const batches = [];
    for (let i = 0; i < stalePoolAddresses.length; i += this.config.batchUpdateSize) {
      batches.push(stalePoolAddresses.slice(i, i + this.config.batchUpdateSize));
    }

    for (const batch of batches) {
      await Promise.allSettled(batch.map(poolAddress => this.updatePoolState(poolAddress)));
    }

    this.logger.debug('Updated stale pool states', {
      count: stalePoolAddresses.length,
      batches: batches.length,
    });
  }

  /**
   * Fetch pool state from blockchain
   */
  private async fetchPoolState(
    poolAddress: Address,
    poolType: PoolType,
    provider: ethers.Provider
  ): Promise<UniswapV3PoolState | AerodromeVolatilePoolState | AerodromeStablePoolState | null> {
    try {
      if (poolType === PoolType.UNISWAP_V3) {
        return await this.fetchUniswapV3State(poolAddress, provider);
      } else {
        return await this.fetchAerodromeState(poolAddress, poolType, provider);
      }
    } catch (error) {
      this.logger.error('Failed to fetch pool state', {
        poolAddress,
        poolType,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Fetch Uniswap V3 pool state
   */
  private async fetchUniswapV3State(
    poolAddress: Address,
    provider: ethers.Provider
  ): Promise<UniswapV3PoolState | null> {
    try {
      const poolContract = new ethers.Contract(
        poolAddress,
        [
          'function token0() view returns (address)',
          'function token1() view returns (address)',
          'function fee() view returns (uint24)',
          'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
          'function liquidity() view returns (uint128)',
        ],
        provider
      );

      const token0 = await (poolContract as any).token0();
      const token1 = await (poolContract as any).token1();
      const fee = await (poolContract as any).fee();
      const slot0 = await (poolContract as any).slot0();
      const liquidity = await (poolContract as any).liquidity();

      return {
        address: poolAddress,
        type: PoolType.UNISWAP_V3,
        token0: token0 as Address,
        token1: token1 as Address,
        fee: Number(fee),
        sqrtPriceX96: BigInt(slot0.sqrtPriceX96.toString()),
        liquidity: BigInt(liquidity.toString()),
        tick: Number(slot0.tick),
        tickSpacing: 0, // Will be determined by fee tier
        blockNumber: 0, // Will be set by caller
        isActive: BigInt(liquidity.toString()) > 0n,
        lastUpdated: Date.now(),
      };
    } catch (error) {
      this.logger.error('Failed to fetch Uniswap V3 state', {
        poolAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Fetch Aerodrome pool state
   */
  private async fetchAerodromeState(
    poolAddress: Address,
    poolType: PoolType,
    provider: ethers.Provider
  ): Promise<AerodromeVolatilePoolState | AerodromeStablePoolState | null> {
    try {
      const poolContract = new ethers.Contract(
        poolAddress,
        [
          'function token0() view returns (address)',
          'function token1() view returns (address)',
          'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
          'function decimals0() view returns (uint8)',
          'function decimals1() view returns (uint8)',
        ],
        provider
      );

      const token0 = await (poolContract as any).token0();
      const token1 = await (poolContract as any).token1();
      const reserves = await (poolContract as any).getReserves();

      let decimals0 = 18;
      let decimals1 = 18;

      try {
        decimals0 = await (poolContract as any).decimals0();
        decimals1 = await (poolContract as any).decimals1();
      } catch {
        // Use defaults if decimals functions don't exist
      }

      const baseState = {
        address: poolAddress,
        type: poolType,
        token0: token0 as Address,
        token1: token1 as Address,
        reserve0: BigInt(reserves.reserve0.toString()),
        reserve1: BigInt(reserves.reserve1.toString()),
        decimals0: Number(decimals0),
        decimals1: Number(decimals1),
        totalSupply: 0n, // Not available from basic interface
        kLast: 0n, // Not available from basic interface
        fee: 0, // Will be determined by pool type
        blockNumber: 0, // Will be set by caller
        isActive:
          BigInt(reserves.reserve0.toString()) > 0n && BigInt(reserves.reserve1.toString()) > 0n,
        lastUpdated: Date.now(),
      };

      if (poolType === PoolType.AERODROME_STABLE) {
        return {
          ...baseState,
          stable: true as const,
        } as AerodromeStablePoolState;
      } else {
        return baseState as AerodromeVolatilePoolState;
      }
    } catch (error) {
      this.logger.error('Failed to fetch Aerodrome state', {
        poolAddress,
        poolType,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Setup WebSocket listeners for real-time updates
   */
  private setupWebSocketListeners(): void {
    try {
      // For now, skip WebSocket setup as it's not implemented in RpcConnectionManager
      // This would be implemented when WebSocket support is added
      this.logger.info('WebSocket listeners setup skipped - not implemented yet');
    } catch (error) {
      this.logger.error('Failed to setup WebSocket listeners', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
